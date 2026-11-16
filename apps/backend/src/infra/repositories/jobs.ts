import crypto from "node:crypto";

import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
} from "drizzle-orm";

import { currentActor, recordAudit } from "../../core/accounts/audit";
import { publishChatUpdate } from "../../core/chat/chat-registry";
import { recordAgentMetric } from "../../core/jobs/metrics";
import { payloadOf, jobLimitsSchema } from "../../core/jobs/schemas";
import { requireValue } from "../../core/utils/require-value";
import { db } from "../db/client";
import { inboxItems, jobActions, jobs } from "../db/schema";

const notifyChat = function notifyChat(job: Job): void {
  if (job.sourceChatId) {
    publishChatUpdate(job.sourceChatId);
  }
};

const requeuePatch = function requeuePatch(
  job: Job,
  patch: JobPatch & { pendingMessage: string },
  activeMs = 0
): JobPatch {
  const allowance = jobLimitsSchema.parse({});
  return {
    limits: {
      maxActions: job.actionsUsed + allowance.maxActions,
      wallTimeMs: job.elapsedMs + activeMs + allowance.wallTimeMs,
    },
    safetyRetries: 0,
    stopReason: null,
    retryAt: null,
    ...patch,
  };
};

export type Job = typeof jobs.$inferSelect;
export type InboxItem = typeof inboxItems.$inferSelect;
type JobPatch = Partial<
  Omit<Job, "id" | "projectId" | "chatId" | "status" | "updatedAt">
>;
const now = () => new Date().toISOString();

export const jobsRepository = {
  async create(
    input: Pick<Job, "projectId" | "chatId" | "trigger" | "goal" | "limits"> &
      Partial<
        Pick<
          Job,
          | "id"
          | "kind"
          | "specId"
          | "runId"
          | "pendingMessage"
          | "stopReason"
          | "sourceChatId"
          | "errorCode"
        >
      > & { status?: "queued" | "blocked" }
  ): Promise<Job> {
    const [job] = await db
      .insert(jobs)
      .values({
        ...input,
        id: input.id ?? crypto.randomUUID(),
        status: input.status ?? "queued",
        pendingMessage: input.pendingMessage ?? input.goal,
        createdAt: now(),
        updatedAt: now(),
      })
      .returning();
    await recordAgentMetric(requireValue(job), "created");
    notifyChat(requireValue(job));
    return requireValue(job);
  },
  async get(id: string) {
    return (
      (await (async () => {
        const awaitedValue2167 = await db
          .select()
          .from(jobs)
          .where(eq(jobs.id, id));
        return awaitedValue2167[0];
      })()) ?? null
    );
  },
  async forChat(chatId: string) {
    return (
      (await (async () => {
        const awaitedValue2291 = await db
          .select()
          .from(jobs)
          .where(eq(jobs.chatId, chatId));
        return awaitedValue2291[0];
      })()) ?? null
    );
  },
  async list(projectId: string) {
    return await db
      .select()
      .from(jobs)
      .where(eq(jobs.projectId, projectId))
      .orderBy(desc(jobs.createdAt));
  },
  async busyProjects(jobIds: string[]) {
    const rows = await db
      .selectDistinct({ projectId: jobs.projectId })
      .from(jobs)
      .where(
        jobIds.length
          ? or(eq(jobs.status, "running"), inArray(jobs.id, jobIds))
          : eq(jobs.status, "running")
      );
    return new Set(rows.map((row) => row.projectId));
  },
  async queued() {
    return await db
      .select()
      .from(jobs)
      .where(eq(jobs.status, "queued"))
      .orderBy(asc(jobs.createdAt));
  },
  async transition(
    id: string,
    from: Job["status"],
    status: Job["status"],
    patch: JobPatch = {}
  ) {
    const [job] = await db
      .update(jobs)
      .set({ ...patch, status, updatedAt: now() })
      .where(and(eq(jobs.id, id), eq(jobs.status, from)))
      .returning();
    if (job) {
      await recordAgentMetric(job, "status_changed");
      notifyChat(job);
    }
    return job ?? null;
  },
  async requeue(
    job: Job,
    from: Job["status"],
    patch: JobPatch & { pendingMessage: string },
    options: { to?: "queued" | "paused"; activeMs?: number } = {}
  ) {
    return await this.transition(
      job.id,
      from,
      options.to ?? "queued",
      requeuePatch(job, patch, options.activeMs)
    );
  },
  async forRun(runId: string) {
    return (
      (await (async () => {
        const awaitedValue3864 = await db
          .select()
          .from(jobs)
          .where(eq(jobs.runId, runId));
        return awaitedValue3864[0];
      })()) ?? null
    );
  },
  async update(
    id: string,
    patch: Partial<Omit<Job, "id" | "projectId" | "chatId">>
  ) {
    const [job] = await db
      .update(jobs)
      .set({ ...patch, updatedAt: now() })
      .where(eq(jobs.id, id))
      .returning();
    if (
      job &&
      (patch.status !== undefined || patch.classification !== undefined)
    ) {
      await recordAgentMetric(
        job,
        patch.classification === undefined ? "status_changed" : "classified"
      );
    }
    if (job) {
      notifyChat(job);
    }
  },
  async recordUsage(id: string, tokens: number, wallTimeMs = 0) {
    await db
      .update(jobs)
      .set({
        tokensUsed: sql`${jobs.tokensUsed} + ${tokens}`,
        elapsedMs: sql`${jobs.elapsedMs} + ${wallTimeMs}`,
        updatedAt: now(),
      })
      .where(eq(jobs.id, id));
  },
  async heartbeat(id: string, startedAt: string) {
    await db
      .update(jobs)
      .set({ heartbeatAt: now() })
      .where(and(eq(jobs.id, id), eq(jobs.startedAt, startedAt)));
  },
  async finishExecution(id: string, startedAt: string, wallTimeMs: number) {
    await db
      .update(jobs)
      .set({
        elapsedMs: sql`${jobs.elapsedMs} + ${wallTimeMs}`,
        startedAt: null,
        heartbeatAt: null,
        updatedAt: now(),
      })
      .where(and(eq(jobs.id, id), eq(jobs.startedAt, startedAt)));
  },
  async claim(id: string) {
    const startedAt = now();
    const [job] = await db
      .update(jobs)
      .set({
        status: "running",
        startedAt,
        heartbeatAt: startedAt,
        updatedAt: startedAt,
      })
      .where(and(eq(jobs.id, id), eq(jobs.status, "queued")))
      .returning();
    if (job) {
      await recordAgentMetric(job, "started");
      notifyChat(job);
    }
    return job ?? null;
  },
  async log(jobId: string, action: string, detail = "") {
    await db
      .insert(jobActions)
      .values({ jobId, action, detail, createdAt: now() });
    const job = await this.get(jobId);
    if (!job) {
      return;
    }
    await recordAudit(
      "agent.action",
      { jobId, action, detail },
      job.projectId,
      currentActor() ?? { id: jobId, name: "Specbook", kind: "agent" }
    );
    const decision =
      /^inbox:(?<capture1>approve|reject|answer|dismiss|report_bug|ignore)$/u.exec(
        action
      )?.[1];
    const verification =
      action === "proposal:verified"
        ? /^(?<capture1>[a-f0-9-]{36}): (?<capture2>passed|failed|error)$/u.exec(
            detail
          )
        : null;
    if (action === "stopped" || decision || verification) {
      await recordAgentMetric(
        job,
        (() => {
          if (decision) {
            return "decision";
          }
          if (verification) {
            return "verified";
          }
          return "stopped";
        })(),
        (() => {
          if (decision) {
            return { decision, actor: "human", itemId: detail };
          }
          if (verification) {
            return {
              itemId: verification[1],
              verificationStatus: verification[2],
            };
          }
          return {};
        })()
      );
    }
  },
  async actions(jobId: string) {
    return await db
      .select()
      .from(jobActions)
      .where(eq(jobActions.jobId, jobId))
      .orderBy(asc(jobActions.id));
  },
  async actionsByJob(jobIds: string[]) {
    const grouped = new Map<string, (typeof jobActions.$inferSelect)[]>(
      jobIds.map((id) => [id, []])
    );
    if (!jobIds.length) {
      return grouped;
    }
    for (const action of await db
      .select()
      .from(jobActions)
      .where(inArray(jobActions.jobId, jobIds))
      .orderBy(asc(jobActions.id))) {
      grouped.get(action.jobId)?.push(action);
    }
    return grouped;
  },
  async addItem(
    input: Pick<
      InboxItem,
      "jobId" | "projectId" | "kind" | "title" | "body"
    > & { payload?: Record<string, unknown> }
  ) {
    const job = await this.get(input.jobId);
    const payload = {
      ...input.payload,
      ...(job?.sourceChatId ? { sourceChatId: job.sourceChatId } : {}),
    };
    const [item] = await db
      .insert(inboxItems)
      .values({
        ...input,
        payload,
        id: crypto.randomUUID(),
        status: "pending",
        createdAt: now(),
        updatedAt: now(),
      })
      .returning();
    if (job && requireValue(item).kind !== "note") {
      await recordAgentMetric(job, "item_created", {
        itemId: requireValue(item).id,
        itemKind: requireValue(item).kind,
      });
    }
    if (job) {
      notifyChat(job);
    }
    if (typeof payload.sourceChatId === "string") {
      publishChatUpdate(payload.sourceChatId);
    }
    return requireValue(item);
  },
  async inbox(projectId: string) {
    return await db
      .select()
      .from(inboxItems)
      .where(eq(inboxItems.projectId, projectId))
      .orderBy(desc(inboxItems.createdAt));
  },
  async itemsForChat(
    projectId: string,
    chatId: string,
    jobIds: string[],
    itemIds: string[]
  ) {
    return await db
      .select()
      .from(inboxItems)
      .where(
        and(
          eq(inboxItems.projectId, projectId),
          or(
            jobIds.length ? inArray(inboxItems.jobId, jobIds) : undefined,
            itemIds.length ? inArray(inboxItems.id, itemIds) : undefined,
            sql`json_extract(${inboxItems.payload}, '$.sourceChatId') = ${chatId}`,
            sql`json_extract(${inboxItems.payload}, '$.discussionChatId') = ${chatId}`
          )
        )
      )
      .orderBy(desc(inboxItems.createdAt));
  },
  async itemsForJob(
    jobId: string,
    filters: { kind?: InboxItem["kind"]; statuses?: InboxItem["status"][] } = {}
  ) {
    return await db
      .select()
      .from(inboxItems)
      .where(
        and(
          eq(inboxItems.jobId, jobId),
          filters.kind ? eq(inboxItems.kind, filters.kind) : undefined,
          filters.statuses
            ? inArray(inboxItems.status, filters.statuses)
            : undefined
        )
      )
      .orderBy(desc(inboxItems.createdAt));
  },
  async itemsByKind(
    projectId: string,
    kind: InboxItem["kind"],
    statuses?: InboxItem["status"][]
  ) {
    return await db
      .select()
      .from(inboxItems)
      .where(
        and(
          eq(inboxItems.projectId, projectId),
          eq(inboxItems.kind, kind),
          statuses ? inArray(inboxItems.status, statuses) : undefined
        )
      )
      .orderBy(desc(inboxItems.createdAt));
  },
  async specBatchForJob(
    projectId: string,
    jobId: string,
    approvedOnly = false
  ) {
    return (
      (await (async () => {
        const awaitedValue10321 = await db
          .select()
          .from(inboxItems)
          .where(
            and(
              eq(inboxItems.projectId, projectId),
              eq(inboxItems.kind, "spec_batch"),
              approvedOnly ? eq(inboxItems.status, "approved") : undefined,
              sql`exists (select 1 from json_each(${inboxItems.payload}, '$.specBatch.candidates') candidate where json_extract(candidate.value, '$.jobId') = ${jobId})`
            )
          )
          .orderBy(desc(inboxItems.createdAt))
          .limit(1);
        return awaitedValue10321[0];
      })()) ?? null
    );
  },
  async itemsForJobs(
    projectId: string,
    jobIds: string[],
    filters: { kind?: InboxItem["kind"]; statuses?: InboxItem["status"][] } = {}
  ) {
    if (!jobIds.length) {
      return [];
    }
    return await db
      .select()
      .from(inboxItems)
      .where(
        and(
          eq(inboxItems.projectId, projectId),
          inArray(inboxItems.jobId, jobIds),
          filters.kind ? eq(inboxItems.kind, filters.kind) : undefined,
          filters.statuses
            ? inArray(inboxItems.status, filters.statuses)
            : undefined
        )
      )
      .orderBy(desc(inboxItems.createdAt));
  },
  async decisions(projectId: string, limit = 12) {
    return await db
      .select()
      .from(inboxItems)
      .where(
        and(
          eq(inboxItems.projectId, projectId),
          inArray(inboxItems.status, ["approved", "rejected", "dismissed"])
        )
      )
      .orderBy(desc(inboxItems.createdAt))
      .limit(limit);
  },
  async item(id: string) {
    return (
      (await (async () => {
        const awaitedValue11929 = await db
          .select()
          .from(inboxItems)
          .where(eq(inboxItems.id, id));
        return awaitedValue11929[0];
      })()) ?? null
    );
  },
  async claimItem(id: string) {
    return (
      (await (async () => {
        const awaitedValue12075 = await db
          .update(inboxItems)
          .set({ status: "applying", updatedAt: now() })
          .where(and(eq(inboxItems.id, id), eq(inboxItems.status, "pending")))
          .returning();
        return awaitedValue12075[0];
      })()) ?? null
    );
  },
  async updateItem(
    id: string,
    patch: Partial<
      Pick<InboxItem, "status" | "answer" | "commitSha" | "payload">
    >
  ) {
    const [item] = await db
      .update(inboxItems)
      .set({ ...patch, updatedAt: now() })
      .where(eq(inboxItems.id, id))
      .returning();
    if (item) {
      const job = await this.get(item.jobId);
      if (job) {
        notifyChat(job);
      }
      for (const chatId of [
        payloadOf(item).sourceChatId,
        payloadOf(item).discussionChatId,
      ]) {
        if (typeof chatId === "string") {
          publishChatUpdate(chatId);
        }
      }
    }
  },
  async answer(item: InboxItem, answer: string) {
    const job = await this.get(item.jobId);
    if (!job) {
      throw new Error("The investigation no longer exists");
    }
    const deterministic = payloadOf(item).runIntentId === job.id;
    const [resumed] = await db.batch([
      db
        .update(jobs)
        .set({
          ...requeuePatch(job, {
            pendingMessage: `Human answer to "${item.title}":\n${answer}\nContinue the original goal. Inspect list_inbox before repeating work.`,
          }),
          status: deterministic ? "completed" : "queued",
          updatedAt: now(),
        })
        .where(
          and(
            eq(jobs.id, item.jobId),
            eq(jobs.status, "blocked"),
            inArray(
              jobs.id,
              db
                .select({ jobId: inboxItems.jobId })
                .from(inboxItems)
                .where(
                  and(
                    eq(inboxItems.id, item.id),
                    eq(inboxItems.status, "applying")
                  )
                )
            )
          )
        )
        .returning({ id: jobs.id }),
      db
        .update(inboxItems)
        .set({ status: "answered", answer, updatedAt: now() })
        .where(
          and(
            eq(inboxItems.id, item.id),
            eq(inboxItems.status, "applying"),
            sql`changes() = 1`
          )
        ),
    ]);
    if (!resumed.length) {
      throw new Error(
        "The job is no longer paused; its answer was not applied"
      );
    }
    const updated = await this.get(job.id);
    if (updated) {
      await recordAgentMetric(updated, "status_changed");
      notifyChat(updated);
    }
  },
  async recover() {
    for (const job of await db
      .select()
      .from(jobs)
      .where(or(isNotNull(jobs.startedAt), eq(jobs.status, "running")))) {
      const interval = job.startedAt
        ? Date.parse(job.heartbeatAt ?? job.startedAt) -
          Date.parse(job.startedAt)
        : 0;
      const activeMs = Number.isFinite(interval) ? Math.max(0, interval) : 0;
      // oxlint-disable-next-line no-await-in-loop -- Apply dependent state changes in order and keep resource use bounded.
      const [recovered] = await db
        .update(jobs)
        .set({
          status: job.status === "running" ? "queued" : job.status,
          elapsedMs: sql`${jobs.elapsedMs} + ${activeMs}`,
          startedAt: null,
          heartbeatAt: null,
          updatedAt: now(),
        })
        .where(
          and(
            eq(jobs.id, job.id),
            eq(jobs.status, job.status),
            job.startedAt
              ? eq(jobs.startedAt, job.startedAt)
              : isNull(jobs.startedAt)
          )
        )
        .returning();
      if (recovered) {
        // oxlint-disable-next-line no-await-in-loop -- Apply dependent state changes in order and keep resource use bounded.
        await recordAgentMetric(recovered, "status_changed");
        // oxlint-disable-next-line no-await-in-loop -- Apply dependent state changes in order and keep resource use bounded.
        await this.log(
          job.id,
          "recovered",
          "Backend restarted. Reconcile existing Inbox proposals before continuing; do not repeat browser mutations."
        );
      }
    }
    await db
      .update(inboxItems)
      .set({ status: "pending", updatedAt: now() })
      .where(eq(inboxItems.status, "applying"));
  },
  async cancelProject(projectId: string) {
    await db
      .update(jobs)
      .set({ status: "cancelled", updatedAt: now() })
      .where(
        and(
          eq(jobs.projectId, projectId),
          inArray(jobs.status, ["queued", "paused", "blocked", "stalled"])
        )
      );
  },
};
