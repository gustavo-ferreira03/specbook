import crypto from "node:crypto";
import { and, asc, count, eq, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { RunnerPayload } from "@specbook/runtime/runner-protocol";
import { db } from "../db/client";
import { runnerInstances, runnerJobs, runnerTokens } from "../db/schema";

export type RunnerToken = typeof runnerTokens.$inferSelect;
export type RunnerJob = typeof runnerJobs.$inferSelect;
export type RunnerInstance = typeof runnerInstances.$inferSelect;

class RunnersRepository {
    async instances(): Promise<RunnerInstance[]> {
        return db.select().from(runnerInstances);
    }

    async reportInstance(runnerId: string, instanceId: string, versions: { version: string; protocolVersion: number; concurrency: number }, mode: "runner" | "tunnel" = "runner"): Promise<void> {
        const existing = (await db.select().from(runnerInstances).where(eq(runnerInstances.id, instanceId)))[0];
        if (existing && existing.runnerId !== runnerId) throw new Error("Runner instance belongs to another token");
        const row = { id: instanceId, runnerId, mode, cliVersion: versions.version, protocolVersion: versions.protocolVersion,
            concurrency: versions.concurrency, lastSeenAt: new Date().toISOString() };
        await db.insert(runnerInstances).values(row).onConflictDoUpdate({ target: runnerInstances.id, set: row });
    }

    async disconnect(runnerId: string, instanceId: string): Promise<void> {
        await db.delete(runnerInstances).where(and(eq(runnerInstances.runnerId, runnerId), eq(runnerInstances.id, instanceId)));
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
            db.delete(runnerInstances).where(eq(runnerInstances.runnerId, id)),
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
            leaseExpiresAt: null, attempts: 0, createdAt: now, updatedAt: now };
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
        await db.update(runnerJobs).set({ status: "queued", runnerId: null, leaseId: null, leaseExpiresAt: null, updatedAt: now })
            .where(and(eq(runnerJobs.status, "leased"), or(lte(runnerJobs.leaseExpiresAt, now), isNull(runnerJobs.runnerId))));
    }

    async claim(runner: RunnerToken, leaseMs: number, instanceId = runner.id): Promise<RunnerJob | null> {
        await this.reclaim();
        const [{ active }] = await db.select({ active: count() }).from(runnerJobs).where(and(eq(runnerJobs.runnerInstanceId, instanceId), eq(runnerJobs.status, "leased")));
        const instance = (await db.select().from(runnerInstances).where(eq(runnerInstances.id, instanceId)))[0];
        if (active >= (instance?.concurrency ?? runner.concurrency)) return null;
        const matchingGroup = runner.group ? or(isNull(runnerJobs.group), eq(runnerJobs.group, runner.group)) : isNull(runnerJobs.group);
        const matchingProjects = runner.projectIds === null ? undefined : sql`${runnerJobs.projectId} in (select value from json_each(${JSON.stringify(runner.projectIds)}))`;
        const candidate = (await db.select().from(runnerJobs).where(and(eq(runnerJobs.status, "queued"), matchingGroup, matchingProjects)).orderBy(asc(runnerJobs.createdAt)).limit(1))[0];
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
            .where(and(eq(runnerJobs.id, id), eq(runnerJobs.status, "leased"), eq(runnerJobs.leaseId, leaseId), eq(runnerJobs.runnerId, runnerId), sql`${runnerJobs.leaseExpiresAt} > ${now}`))
            .returning({ leaseExpiresAt: runnerJobs.leaseExpiresAt });
        return rows.length ? expires : null;
    }

    async release(id: string, leaseId: string, runnerId: string): Promise<boolean> {
        const rows = await db.update(runnerJobs).set({ status: "queued", runnerId: null, leaseId: null, leaseExpiresAt: null, updatedAt: new Date().toISOString() })
            .where(and(eq(runnerJobs.id, id), eq(runnerJobs.status, "leased"), eq(runnerJobs.leaseId, leaseId), eq(runnerJobs.runnerId, runnerId)))
            .returning({ id: runnerJobs.id });
        return rows.length > 0;
    }

    async complete(id: string): Promise<void> {
        await db.update(runnerJobs).set({ status: "completed", leaseExpiresAt: null, updatedAt: new Date().toISOString() })
            .where(eq(runnerJobs.id, id));
    }

    async cancelBatch(batchId: string): Promise<boolean> {
        const rows = await db.update(runnerJobs).set({ status: "completed", runnerId: null, leaseId: null, leaseExpiresAt: null, updatedAt: new Date().toISOString() })
            .where(and(eq(runnerJobs.batchId, batchId), ne(runnerJobs.status, "completed"))).returning({ id: runnerJobs.id });
        return rows.length > 0;
    }
}

export const runnersRepository = new RunnersRepository();
