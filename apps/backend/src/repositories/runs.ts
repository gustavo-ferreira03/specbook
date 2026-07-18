import crypto from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { db } from "../db/client";
import { runs, type RunStatus } from "../db/schema";

export type Run = typeof runs.$inferSelect;

class RunsRepository {
    async createRun(input: { specId: string; specVersionId: string }): Promise<Run> {
        const row: Run = {
            id: crypto.randomUUID(),
            specId: input.specId,
            specVersionId: input.specVersionId,
            status: "running",
            startedAt: new Date().toISOString(),
            durationMs: null,
            failReason: null,
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

    async listRuns(specId: string): Promise<Run[]> {
        return db
            .select()
            .from(runs)
            .where(eq(runs.specId, specId))
            .orderBy(desc(runs.startedAt), desc(runs.id));
    }

    async getRun(id: string): Promise<Run | null> {
        const rows = await db.select().from(runs).where(eq(runs.id, id));
        return rows[0] ?? null;
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
