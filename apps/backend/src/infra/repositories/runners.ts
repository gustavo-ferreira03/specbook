import crypto from "node:crypto";
import { and, asc, count, eq, gt, inArray, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import type { RunnerPayload } from "@specbook/runtime/runner-protocol";
import { HTTPException } from "hono/http-exception";
import { db } from "../db/client";
import { runnerInstances, runnerJobs, runnerTokens } from "../db/schema";

export type RunnerToken = typeof runnerTokens.$inferSelect;
export type RunnerJob = typeof runnerJobs.$inferSelect;
export type RunnerInstance = typeof runnerInstances.$inferSelect;
export const MAX_RUNNER_ATTEMPTS = 3;
export const RUNNER_QUEUE_GRACE_MS = 60_000;

export function runnerJobDeadline(job: RunnerJob): number {
    return Date.parse(job.createdAt) + job.payload.timeoutMs + RUNNER_QUEUE_GRACE_MS;
}

class RunnersRepository {
    async instance(id: string): Promise<RunnerInstance | null> {
        return (await db.select().from(runnerInstances).where(eq(runnerInstances.id, id)))[0] ?? null;
    }
    async instances(): Promise<RunnerInstance[]> {
        return db.select().from(runnerInstances).where(and(isNull(runnerInstances.disconnectedAt), gt(runnerInstances.lastSeenAt, new Date(Date.now() - 90_000).toISOString())));
    }

    async reportInstance(runnerId: string, instanceId: string, versions: { version: string; protocolVersion: number; concurrency: number }, mode: "runner" | "tunnel" = "runner"): Promise<void> {
        const existing = await this.instance(instanceId);
        if (existing && (existing.runnerId !== runnerId || existing.mode !== mode)) throw new HTTPException(403, { message: "Runner instance belongs to another connection" });
        if (existing?.disconnectedAt) throw new HTTPException(409, { message: "Runner instance disconnected. Restart the CLI process." });
        const row = { id: instanceId, runnerId, mode, cliVersion: versions.version, protocolVersion: versions.protocolVersion,
            concurrency: versions.concurrency, lastSeenAt: new Date().toISOString() };
        const updated = await db.insert(runnerInstances).values(row).onConflictDoUpdate({ target: runnerInstances.id, set: row,
            setWhere: and(eq(runnerInstances.runnerId, runnerId), eq(runnerInstances.mode, mode), isNull(runnerInstances.disconnectedAt)) }).returning({ id: runnerInstances.id });
        if (!updated.length) throw new HTTPException(409, { message: "Runner instance disconnected. Restart the CLI process." });
    }

    async disconnect(runnerId: string, instanceId: string): Promise<void> {
        const now = new Date().toISOString();
        await db.insert(runnerInstances).values({ id: instanceId, runnerId, mode: "runner", cliVersion: "0.0.0", protocolVersion: 0,
            concurrency: 1, lastSeenAt: now, disconnectedAt: now }).onConflictDoUpdate({ target: runnerInstances.id,
                set: { disconnectedAt: now }, setWhere: eq(runnerInstances.runnerId, runnerId) });
        await db.update(runnerJobs).set({ status: "queued", runnerId: null, runnerInstanceId: null, leaseId: null, leaseExpiresAt: null,
            updatedAt: new Date().toISOString() }).where(and(eq(runnerJobs.runnerId, runnerId), eq(runnerJobs.runnerInstanceId, instanceId), eq(runnerJobs.status, "leased")));
    }
    async list(): Promise<RunnerToken[]> {
        return db.select().from(runnerTokens).orderBy(asc(runnerTokens.createdAt));
    }

    async token(hash: string): Promise<RunnerToken | null> {
        return (await db.select().from(runnerTokens).where(eq(runnerTokens.tokenHash, hash)))[0] ?? null;
    }

    async get(id: string): Promise<RunnerToken | null> {
        return (await db.select().from(runnerTokens).where(eq(runnerTokens.id, id)))[0] ?? null;
    }

    async create(name: string, group: string | null, hash: string, projectIds: string[] | null = null): Promise<RunnerToken> {
        const row: RunnerToken = { id: crypto.randomUUID(), name, group, tokenHash: hash, createdAt: new Date().toISOString(), lastSeenAt: null,
            cliVersion: null, protocolVersion: null, concurrency: 1, projectIds };
        await db.insert(runnerTokens).values(row);
        return row;
    }

    async touch(id: string, versions?: { version: string; protocolVersion: number; concurrency: number }): Promise<void> {
        await db.update(runnerTokens).set({ lastSeenAt: new Date().toISOString(), ...(versions ? {
            cliVersion: versions.version, protocolVersion: versions.protocolVersion, concurrency: versions.concurrency,
        } : {}) }).where(eq(runnerTokens.id, id));
    }

    async rotate(id: string, hash: string): Promise<RunnerToken | null> {
        const [tokens] = await db.batch([
            db.update(runnerTokens).set({ tokenHash: hash, lastSeenAt: null, cliVersion: null, protocolVersion: null })
                .where(eq(runnerTokens.id, id)).returning(),
            db.update(runnerJobs).set({ status: "queued", runnerId: null, leaseId: null, leaseExpiresAt: null, updatedAt: new Date().toISOString() })
                .where(and(eq(runnerJobs.runnerId, id), eq(runnerJobs.status, "leased"))),
            db.update(runnerInstances).set({ disconnectedAt: new Date().toISOString() }).where(eq(runnerInstances.runnerId, id)),
        ]);
        return tokens[0] ?? null;
    }

    async revoke(id: string): Promise<boolean> {
        const removed = await db.delete(runnerTokens).where(eq(runnerTokens.id, id)).returning({ id: runnerTokens.id });
        await db.update(runnerJobs).set({ status: "queued", runnerId: null, leaseId: null, leaseExpiresAt: null, updatedAt: new Date().toISOString() })
            .where(and(eq(runnerJobs.status, "leased"), isNull(runnerJobs.runnerId)));
        return removed.length > 0;
    }

    async enqueue(batchId: string, projectId: string, group: string | null, payload: RunnerPayload): Promise<RunnerJob> {
        const now = new Date().toISOString();
        const row: RunnerJob = { id: crypto.randomUUID(), batchId, projectId, group, payload, status: "queued", runnerId: null, runnerInstanceId: null, leaseId: null,
            leaseExpiresAt: null, attempts: 0, lastFailure: null, createdAt: now, updatedAt: now };
        await db.insert(runnerJobs).values(row);
        return row;
    }

    async pending(): Promise<RunnerJob[]> {
        return db.select().from(runnerJobs).where(ne(runnerJobs.status, "completed"));
    }

    async job(id: string): Promise<RunnerJob | null> {
        return (await db.select().from(runnerJobs).where(eq(runnerJobs.id, id)))[0] ?? null;
    }

    async reclaim(now = new Date().toISOString()): Promise<void> {
        await db.update(runnerJobs).set({ status: "queued", runnerId: null, runnerInstanceId: null, leaseId: null, leaseExpiresAt: null,
            lastFailure: "Runner lease expired before completion.", updatedAt: now })
            .where(and(eq(runnerJobs.status, "leased"), or(lte(runnerJobs.leaseExpiresAt, now), isNull(runnerJobs.runnerId))));
    }

    async claim(runner: RunnerToken, leaseMs: number, instanceId = runner.id): Promise<RunnerJob | null> {
        await this.reclaim();
        const instance = await this.instance(instanceId);
        if (!instance || instance.runnerId !== runner.id || instance.mode !== "runner" || instance.disconnectedAt) return null;
        const [{ active }] = await db.select({ active: count() }).from(runnerJobs).where(and(eq(runnerJobs.runnerInstanceId, instanceId), inArray(runnerJobs.status, ["leased", "completing"])));
        if (active >= instance.concurrency) return null;
        const matchingGroup = runner.group ? eq(runnerJobs.group, runner.group) : isNull(runnerJobs.group);
        const matchingProjects = runner.projectIds === null ? undefined : sql`${runnerJobs.projectId} in (select value from json_each(${JSON.stringify(runner.projectIds)}))`;
        const beforeDeadline = sql`(julianday(${runnerJobs.createdAt}) + (json_extract(${runnerJobs.payload}, '$.timeoutMs') + ${RUNNER_QUEUE_GRACE_MS}) / 86400000.0) > julianday(${new Date().toISOString()})`;
        const candidate = (await db.select().from(runnerJobs).where(and(eq(runnerJobs.status, "queued"), lt(runnerJobs.attempts, MAX_RUNNER_ATTEMPTS), beforeDeadline, matchingGroup, matchingProjects)).orderBy(asc(runnerJobs.createdAt)).limit(1))[0];
        if (!candidate) return null;
        const updated = await db.update(runnerJobs).set({ status: "leased", runnerId: runner.id, runnerInstanceId: instanceId, leaseId: crypto.randomUUID(),
            leaseExpiresAt: new Date(Date.now() + leaseMs).toISOString(), attempts: sql`${runnerJobs.attempts} + 1`, updatedAt: new Date().toISOString() })
            .where(and(eq(runnerJobs.id, candidate.id), eq(runnerJobs.status, "queued"))).returning();
        return updated[0] ?? null;
    }

    async heartbeat(id: string, leaseId: string, runnerId: string, leaseMs: number): Promise<string | null> {
        const now = new Date().toISOString();
        const expires = new Date(Date.now() + leaseMs).toISOString();
        const rows = await db.update(runnerJobs).set({ leaseExpiresAt: expires, updatedAt: now })
            .where(and(eq(runnerJobs.id, id), inArray(runnerJobs.status, ["leased", "completing"]), eq(runnerJobs.leaseId, leaseId), eq(runnerJobs.runnerId, runnerId), sql`${runnerJobs.leaseExpiresAt} > ${now}`))
            .returning({ leaseExpiresAt: runnerJobs.leaseExpiresAt });
        return rows.length ? expires : null;
    }

    async release(id: string, leaseId: string, runnerId: string): Promise<boolean> {
        const rows = await db.update(runnerJobs).set({ status: "queued", runnerId: null, runnerInstanceId: null, leaseId: null, leaseExpiresAt: null, updatedAt: new Date().toISOString() })
            .where(and(eq(runnerJobs.id, id), eq(runnerJobs.status, "leased"), eq(runnerJobs.leaseId, leaseId), eq(runnerJobs.runnerId, runnerId)))
            .returning({ id: runnerJobs.id });
        return rows.length > 0;
    }

    async reserveCompletion(id: string): Promise<void> {
        await db.update(runnerJobs).set({ status: "completing", updatedAt: new Date().toISOString() }).where(eq(runnerJobs.id, id));
    }

    async restoreLease(id: string, leaseId: string): Promise<void> {
        await db.update(runnerJobs).set({ status: "leased", updatedAt: new Date().toISOString() })
            .where(and(eq(runnerJobs.id, id), eq(runnerJobs.status, "completing"), eq(runnerJobs.leaseId, leaseId)));
    }

    async recordFailure(id: string, reason: string): Promise<void> {
        await db.update(runnerJobs).set({ lastFailure: reason }).where(eq(runnerJobs.id, id));
    }

    async complete(id: string, failed = false): Promise<void> {
        await db.update(runnerJobs).set({ status: "completed", leaseExpiresAt: null, updatedAt: new Date().toISOString(),
            ...(failed ? { runnerId: null, runnerInstanceId: null, leaseId: null } : { lastFailure: null }) })
            .where(eq(runnerJobs.id, id));
    }

    async cancelBatch(batchId: string): Promise<boolean> {
        const rows = await db.update(runnerJobs).set({ status: "completed", runnerId: null, leaseId: null, leaseExpiresAt: null, updatedAt: new Date().toISOString() })
            .where(and(eq(runnerJobs.batchId, batchId), ne(runnerJobs.status, "completed"))).returning({ id: runnerJobs.id });
        return rows.length > 0;
    }
}

export const runnersRepository = new RunnersRepository();
