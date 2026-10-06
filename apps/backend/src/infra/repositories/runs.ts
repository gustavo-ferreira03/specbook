import crypto from "node:crypto";
import { and, desc, eq, inArray, lt, max, or } from "drizzle-orm";
import { db } from "../db/client";
import { runs, type RunStatus, type RunEnvironment } from "../db/schema";

export type Run = typeof runs.$inferSelect;

export const DEFAULT_RUN_LIST_LIMIT = 50;
export const MAX_RUN_LIST_LIMIT = 200;

class RunsRepository {
    async createRun(input: { specId: string; commitSha: string; sourceHash: string; automate?: boolean; healOnFailure?: boolean; retryOf?: string; baseUrl?: string; environment?: RunEnvironment }): Promise<Run> {
        const row: Run = {
            id: crypto.randomUUID(),
            specId: input.specId,
            commitSha: input.commitSha,
            sourceHash: input.sourceHash,
            status: "running",
            startedAt: new Date().toISOString(),
            durationMs: null,
            failReason: null,
            automationPending: input.automate ?? false,
            healOnFailure: input.healOnFailure ?? true,
            retryOf: input.retryOf ?? null,
            flaky: false,
            baseUrl: input.baseUrl ?? null,
            environment: input.environment ?? null,
        };
        await db.insert(runs).values(row);
        return row;
    }

    async finishRun(
        id: string,
        status: Exclude<RunStatus, "running">,
        durationMs: number | null,
        failReason: string | null,
    ): Promise<void> {
        await db.update(runs).set({ status, durationMs, failReason }).where(eq(runs.id, id));
    }

    /** Newest first. `before` is a run id cursor: only runs older than it are returned. */
    async listRuns(specId: string, options: { limit?: number; before?: string } = {}): Promise<Run[]> {
        const limit = Math.min(Math.max(Math.trunc(options.limit ?? DEFAULT_RUN_LIST_LIMIT), 1), MAX_RUN_LIST_LIMIT);
        let condition = eq(runs.specId, specId);
        if (options.before) {
            const cursor = await this.getRun(options.before);
            if (!cursor || cursor.specId !== specId) return [];
            condition = and(
                condition,
                or(lt(runs.startedAt, cursor.startedAt), and(eq(runs.startedAt, cursor.startedAt), lt(runs.id, cursor.id))),
            )!;
        }
        return db
            .select()
            .from(runs)
            .where(condition)
            .orderBy(desc(runs.startedAt), desc(runs.id))
            .limit(limit);
    }

    /** The most recent run of each of the given Specs, keyed by Spec id. */
    async latestRuns(specIds: string[]): Promise<Map<string, Run>> {
        const latest = new Map<string, Run>();
        if (specIds.length === 0) return latest;
        const newest = db
            .select({ specId: runs.specId, startedAt: max(runs.startedAt).as("newest_started_at") })
            .from(runs)
            .where(inArray(runs.specId, specIds))
            .groupBy(runs.specId)
            .as("newest");
        const rows = await db
            .select({ run: runs })
            .from(runs)
            .innerJoin(newest, and(eq(runs.specId, newest.specId), eq(runs.startedAt, newest.startedAt)));
        for (const { run } of rows) latest.set(run.specId, run);
        return latest;
    }

    async pendingAutomation(): Promise<Run[]> {
        return db.select().from(runs).where(and(eq(runs.automationPending, true), inArray(runs.status, ["passed", "failed", "error"]))).limit(100);
    }

    async retryFor(runId: string): Promise<Run | null> {
        return (await db.select().from(runs).where(eq(runs.retryOf, runId)))[0] ?? null;
    }

    async markFlaky(originalId: string, retryId: string): Promise<void> {
        await db.update(runs).set({ flaky: true }).where(inArray(runs.id, [originalId, retryId]));
    }

    async acknowledgeAutomation(id: string): Promise<void> {
        await db.update(runs).set({ automationPending: false }).where(eq(runs.id, id));
    }

    async getRun(id: string): Promise<Run | null> {
        const rows = await db.select().from(runs).where(eq(runs.id, id));
        return rows[0] ?? null;
    }

    async hasRunningRuns(specIds: string[]): Promise<boolean> {
        if (specIds.length === 0) return false;
        const rows = await db
            .select({ id: runs.id })
            .from(runs)
            .where(and(inArray(runs.specId, specIds), eq(runs.status, "running")))
            .limit(1);
        return rows.length > 0;
    }

    async deleteRun(id: string): Promise<void> {
        await db.delete(runs).where(eq(runs.id, id));
    }

    async markInterruptedRuns(): Promise<void> {
        await db
            .update(runs)
            .set({ status: "error", failReason: "Backend stopped before the run completed" })
            .where(eq(runs.status, "running"));
    }
}

export const runsRepository = new RunsRepository();
