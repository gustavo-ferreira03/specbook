import crypto from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "../db/client";
import { inboxItems, jobActions, jobs } from "../db/schema";
import { jobLimitsSchema } from "../../core/jobs/schemas";
import { recordAgentMetric } from "../../core/jobs/metrics";

export type Job = typeof jobs.$inferSelect;
export type InboxItem = typeof inboxItems.$inferSelect;
const now = () => new Date().toISOString();

export const jobsRepository = {
    async create(input: Pick<Job, "projectId" | "chatId" | "trigger" | "goal" | "limits"> & Partial<Pick<Job, "id" | "kind" | "specId" | "runId" | "pendingMessage" | "stopReason">> & { status?: "queued" | "blocked" }): Promise<Job> {
        const [job] = await db.insert(jobs).values({ ...input, id: input.id ?? crypto.randomUUID(), status: input.status ?? "queued", pendingMessage: input.pendingMessage ?? input.goal, createdAt: now(), updatedAt: now() }).returning();
        await recordAgentMetric(job!, "created");
        return job!;
    },
    async get(id: string) {
        return (await db.select().from(jobs).where(eq(jobs.id, id)))[0] ?? null;
    },
    async forChat(chatId: string) {
        return (await db.select().from(jobs).where(eq(jobs.chatId, chatId)))[0] ?? null;
    },
    async list(projectId: string) {
        return db.select().from(jobs).where(eq(jobs.projectId, projectId)).orderBy(desc(jobs.createdAt));
    },
    async queued() {
        return db.select().from(jobs).where(eq(jobs.status, "queued")).orderBy(asc(jobs.createdAt));
    },
    async transition(id: string, from: Job["status"], status: Job["status"], patch: Partial<Omit<Job, "id" | "projectId" | "chatId" | "status" | "updatedAt">> = {}) {
        const [job] = await db.update(jobs).set({ ...patch, status, updatedAt: now() })
            .where(and(eq(jobs.id, id), eq(jobs.status, from))).returning();
        if (job) await recordAgentMetric(job, "status_changed");
        return job ?? null;
    },
    async forRun(runId: string) {
        return (await db.select().from(jobs).where(eq(jobs.runId, runId)))[0] ?? null;
    },
    async update(id: string, patch: Partial<Omit<Job, "id" | "projectId" | "chatId">>) {
        const [job] = await db.update(jobs).set({ ...patch, updatedAt: now() }).where(eq(jobs.id, id)).returning();
        if (job && (patch.status !== undefined || patch.classification !== undefined)) {
            await recordAgentMetric(job, patch.classification !== undefined ? "classified" : "status_changed");
        }
    },
    async recordUsage(id: string, tokens: number, wallTimeMs = 0) {
        await db.update(jobs).set({ tokensUsed: sql`${jobs.tokensUsed} + ${tokens}`, elapsedMs: sql`${jobs.elapsedMs} + ${wallTimeMs}`, updatedAt: now() })
            .where(eq(jobs.id, id));
    },
    async heartbeat(id: string, startedAt: string) {
        await db.update(jobs).set({ heartbeatAt: now() }).where(and(eq(jobs.id, id), eq(jobs.startedAt, startedAt)));
    },
    async finishExecution(id: string, startedAt: string, wallTimeMs: number) {
        await db.update(jobs).set({ elapsedMs: sql`${jobs.elapsedMs} + ${wallTimeMs}`, startedAt: null, heartbeatAt: null, updatedAt: now() })
            .where(and(eq(jobs.id, id), eq(jobs.startedAt, startedAt)));
    },
    async claim(id: string) {
        const startedAt = now();
        const [job] = await db.update(jobs).set({ status: "running", startedAt, heartbeatAt: startedAt, updatedAt: startedAt })
            .where(and(eq(jobs.id, id), eq(jobs.status, "queued"))).returning();
        if (job) await recordAgentMetric(job, "started");
        return job ?? null;
    },
    async log(jobId: string, action: string, detail = "") {
        await db.insert(jobActions).values({ jobId, action, detail, createdAt: now() });
        const decision = /^inbox:(approve|reject|answer|dismiss|report_bug|ignore)$/.exec(action)?.[1];
        const verification = action === "proposal:verified" ? /^([a-f0-9-]{36}): (passed|failed|error)$/.exec(detail) : null;
        if (action === "stopped" || decision || verification) {
            const job = await this.get(jobId);
            if (job) await recordAgentMetric(job, decision ? "decision" : verification ? "verified" : "stopped",
                decision ? { decision, actor: "human", itemId: detail } : verification ? { itemId: verification[1], verificationStatus: verification[2] } : {});
        }
    },
    async actions(jobId: string) {
        return db.select().from(jobActions).where(eq(jobActions.jobId, jobId)).orderBy(asc(jobActions.id));
    },
    async addItem(input: Pick<InboxItem, "jobId" | "projectId" | "kind" | "title" | "body"> & { payload?: Record<string, unknown> }) {
        const [item] = await db.insert(inboxItems).values({ ...input, payload: input.payload ?? {}, id: crypto.randomUUID(), status: "pending", createdAt: now(), updatedAt: now() }).returning();
        const job = item?.kind !== "note" ? await this.get(input.jobId) : null;
        if (job) await recordAgentMetric(job, "item_created", { itemId: item!.id, itemKind: item!.kind });
        return item!;
    },
    async inbox(projectId: string) {
        return db.select().from(inboxItems).where(eq(inboxItems.projectId, projectId)).orderBy(desc(inboxItems.createdAt));
    },
    async item(id: string) {
        return (await db.select().from(inboxItems).where(eq(inboxItems.id, id)))[0] ?? null;
    },
    async claimItem(id: string) {
        return (await db.update(inboxItems).set({ status: "applying", updatedAt: now() })
            .where(and(eq(inboxItems.id, id), eq(inboxItems.status, "pending"))).returning())[0] ?? null;
    },
    async updateItem(id: string, patch: Partial<Pick<InboxItem, "status" | "answer" | "commitSha" | "payload">>) {
        await db.update(inboxItems).set({ ...patch, updatedAt: now() }).where(eq(inboxItems.id, id));
    },
    async answer(item: InboxItem, answer: string) {
        const job = await this.get(item.jobId);
        if (!job) throw new Error("The investigation no longer exists");
        const allowance = jobLimitsSchema.parse({});
        const limits = { maxActions: job.actionsUsed + allowance.maxActions, wallTimeMs: job.elapsedMs + allowance.wallTimeMs };
        const deterministic = item.payload.runIntentId === job.id;
        // changes() ties the Inbox update to the job transition in this transaction.
        const [resumed] = await db.batch([
            db.update(jobs).set({ status: deterministic ? "completed" : "queued", limits, safetyRetries: 0, stopReason: null, retryAt: null,
                updatedAt: now(), pendingMessage: `Human answer to "${item.title}":\n${answer}\nContinue the original goal. Inspect list_inbox before repeating work.` })
                .where(and(eq(jobs.id, item.jobId), eq(jobs.status, "blocked"), inArray(jobs.id,
                    db.select({ jobId: inboxItems.jobId }).from(inboxItems).where(and(eq(inboxItems.id, item.id), eq(inboxItems.status, "applying"))),
                ))).returning({ id: jobs.id }),
            db.update(inboxItems).set({ status: "answered", answer, updatedAt: now() })
                .where(and(eq(inboxItems.id, item.id), eq(inboxItems.status, "applying"), sql`changes() = 1`)),
        ]);
        if (!resumed.length) throw new Error("The job is no longer paused; its answer was not applied");
        const updated = await this.get(job.id);
        if (updated) await recordAgentMetric(updated, "status_changed");
    },
    async recover() {
        for (const job of await db.select().from(jobs).where(isNotNull(jobs.startedAt))) {
            const interval = Date.parse(job.heartbeatAt ?? job.startedAt!) - Date.parse(job.startedAt!);
            const activeMs = Number.isFinite(interval) ? Math.max(0, interval) : 0;
            const [recovered] = await db.update(jobs).set({ status: job.status === "running" ? "queued" : job.status,
                elapsedMs: sql`${jobs.elapsedMs} + ${activeMs}`, startedAt: null, heartbeatAt: null, updatedAt: now() })
                .where(and(eq(jobs.id, job.id), eq(jobs.status, job.status), eq(jobs.startedAt, job.startedAt!))).returning();
            if (recovered) {
                await recordAgentMetric(recovered, "status_changed");
                await this.log(job.id, "recovered", "Backend restarted. Reconcile existing Inbox proposals before continuing; do not repeat browser mutations.");
            }
        }
        // An approval may have committed before the process stopped. Require a
        // human to reconcile it rather than silently applying the same change twice.
        await db.update(inboxItems).set({ status: "pending", updatedAt: now() }).where(eq(inboxItems.status, "applying"));
    },
    async cancelProject(projectId: string) {
        await db.update(jobs).set({ status: "cancelled", updatedAt: now() })
            .where(and(eq(jobs.projectId, projectId), inArray(jobs.status, ["queued", "paused", "blocked", "stalled"])));
    },
};
