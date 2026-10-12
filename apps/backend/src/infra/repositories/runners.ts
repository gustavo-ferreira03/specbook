import crypto from "node:crypto";
import { and, asc, eq, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { RunnerPayload } from "@specbook/runtime/runner-protocol";
import { db } from "../db/client";
import { runnerJobs, runnerTokens } from "../db/schema";

export type RunnerToken = typeof runnerTokens.$inferSelect;
export type RunnerJob = typeof runnerJobs.$inferSelect;

class RunnersRepository {
    async list(): Promise<RunnerToken[]> {
        return db.select().from(runnerTokens).orderBy(asc(runnerTokens.createdAt));
    }

    async token(hash: string): Promise<RunnerToken | null> {
        return (await db.select().from(runnerTokens).where(eq(runnerTokens.tokenHash, hash)))[0] ?? null;
    }

    async get(id: string): Promise<RunnerToken | null> {
        return (await db.select().from(runnerTokens).where(eq(runnerTokens.id, id)))[0] ?? null;
    }

    async create(name: string, group: string | null, hash: string): Promise<RunnerToken> {
        const row = { id: crypto.randomUUID(), name, group, tokenHash: hash, createdAt: new Date().toISOString(), lastSeenAt: null };
        await db.insert(runnerTokens).values(row);
        return row;
    }

    async touch(id: string): Promise<void> {
        await db.update(runnerTokens).set({ lastSeenAt: new Date().toISOString() }).where(eq(runnerTokens.id, id));
    }

    async revoke(id: string): Promise<boolean> {
        const removed = await db.delete(runnerTokens).where(eq(runnerTokens.id, id)).returning({ id: runnerTokens.id });
        await db.update(runnerJobs).set({ status: "queued", runnerId: null, leaseId: null, leaseExpiresAt: null, updatedAt: new Date().toISOString() })
            .where(and(eq(runnerJobs.status, "leased"), isNull(runnerJobs.runnerId)));
        return removed.length > 0;
    }

    async enqueue(batchId: string, projectId: string, group: string | null, payload: RunnerPayload): Promise<RunnerJob> {
        const now = new Date().toISOString();
        const row: RunnerJob = { id: crypto.randomUUID(), batchId, projectId, group, payload, status: "queued", runnerId: null, leaseId: null,
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

    async claim(runner: RunnerToken, leaseMs: number): Promise<RunnerJob | null> {
        await this.reclaim();
        const matchingGroup = runner.group ? or(isNull(runnerJobs.group), eq(runnerJobs.group, runner.group)) : isNull(runnerJobs.group);
        const candidate = (await db.select().from(runnerJobs).where(and(eq(runnerJobs.status, "queued"), matchingGroup)).orderBy(asc(runnerJobs.createdAt)).limit(1))[0];
        if (!candidate) return null;
        const updated = await db.update(runnerJobs).set({ status: "leased", runnerId: runner.id, leaseId: crypto.randomUUID(),
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
