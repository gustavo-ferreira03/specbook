import crypto from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/client";
import { inboxItems, jobActions, jobs } from "../db/schema";

export type Job = typeof jobs.$inferSelect;
export type InboxItem = typeof inboxItems.$inferSelect;
const now = () => new Date().toISOString();

export const jobsRepository = {
    async create(input: Pick<Job, "projectId" | "chatId" | "trigger" | "goal" | "budget"> & Partial<Pick<Job, "id" | "kind" | "specId" | "runId" | "pendingMessage">>): Promise<Job> {
        const [job] = await db.insert(jobs).values({ ...input, id: input.id ?? crypto.randomUUID(), status: "queued", pendingMessage: input.pendingMessage ?? input.goal, createdAt: now(), updatedAt: now() }).returning();
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
    async transition(id: string, from: Job["status"], status: Job["status"]) {
        return (await db.update(jobs).set({ status, updatedAt: now() })
            .where(and(eq(jobs.id, id), eq(jobs.status, from))).returning())[0] ?? null;
    },
    async forRun(runId: string) {
        return (await db.select().from(jobs).where(eq(jobs.runId, runId)))[0] ?? null;
    },
    async update(id: string, patch: Partial<Omit<Job, "id" | "projectId" | "chatId">>) {
        await db.update(jobs).set({ ...patch, updatedAt: now() }).where(eq(jobs.id, id));
    },
    async claim(id: string) {
        const [job] = await db.update(jobs).set({ status: "running", startedAt: now(), updatedAt: now() })
            .where(and(eq(jobs.id, id), eq(jobs.status, "queued"))).returning();
        return job ?? null;
    },
    async log(jobId: string, action: string, detail = "") {
        await db.insert(jobActions).values({ jobId, action, detail, createdAt: now() });
    },
    async actions(jobId: string) {
        return db.select().from(jobActions).where(eq(jobActions.jobId, jobId)).orderBy(asc(jobActions.id));
    },
    async addItem(input: Pick<InboxItem, "jobId" | "projectId" | "kind" | "title" | "body"> & { payload?: Record<string, unknown> }) {
        const [item] = await db.insert(inboxItems).values({ ...input, payload: input.payload ?? {}, id: crypto.randomUUID(), status: "pending", createdAt: now(), updatedAt: now() }).returning();
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
        // changes() ties the Inbox update to the blocked-to-queued transition in this transaction.
        const [resumed] = await db.batch([
            db.update(jobs).set({ status: "queued", updatedAt: now(), pendingMessage: `Human answer to "${item.title}":\n${answer}\nContinue the original goal. Inspect list_inbox before repeating work.` })
                .where(and(eq(jobs.id, item.jobId), eq(jobs.status, "blocked"), inArray(jobs.id,
                    db.select({ jobId: inboxItems.jobId }).from(inboxItems).where(and(eq(inboxItems.id, item.id), eq(inboxItems.status, "applying"))),
                ))).returning({ id: jobs.id }),
            db.update(inboxItems).set({ status: "answered", answer, updatedAt: now() })
                .where(and(eq(inboxItems.id, item.id), eq(inboxItems.status, "applying"), sql`changes() = 1`)),
        ]);
        if (!resumed.length) throw new Error("The job is no longer paused; its answer was not applied");
    },
    async recover() {
        for (const job of await db.select().from(jobs).where(eq(jobs.status, "running"))) {
            const elapsedMs = job.elapsedMs + Math.max(0, Date.now() - Date.parse(job.startedAt ?? now()));
            await this.update(job.id, { status: "queued", elapsedMs, startedAt: null });
            await this.log(job.id, "recovered", "Backend restarted. Reconcile existing Inbox proposals before continuing; do not repeat browser mutations.");
        }
        // An approval may have committed before the process stopped. Require a
        // human to reconcile it rather than silently applying the same change twice.
        await db.update(inboxItems).set({ status: "pending", updatedAt: now() }).where(eq(inboxItems.status, "applying"));
    },
    async cancelProject(projectId: string) {
        await db.update(jobs).set({ status: "cancelled", updatedAt: now() })
            .where(and(eq(jobs.projectId, projectId), inArray(jobs.status, ["queued", "blocked"])));
    },
};
