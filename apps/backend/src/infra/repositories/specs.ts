import crypto from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db, runBatch, type DbQuery } from "../db/client";
import { runs, specs, type SpecStatus, type SpecLifecycle } from "../db/schema";

export type Spec = typeof specs.$inferSelect;
export type DeleteSpecResult =
    | { status: "not_found" }
    | { status: "busy" }
    | { status: "deleted"; runIds: string[] };

export type SpecPatch = Partial<
    Pick<Spec, "lifecycle" | "title" | "description" | "path" | "sourceHash" | "markdownHash" | "status" | "invalidReason" | "featureId">
>;

class SpecsRepository {
    async createSpecRecord(input: {
        id?: string;
        projectId: string;
        featureId: string;
        title: string;
        description: string;
        path: string;
        sourceHash: string;
        markdownHash: string;
        status?: SpecStatus;
        lifecycle?: SpecLifecycle;
        invalidReason?: string | null;
    }): Promise<Spec> {
        const now = new Date().toISOString();
        const row: Spec = {
            id: input.id ?? crypto.randomUUID(),
            projectId: input.projectId,
            featureId: input.featureId,
            title: input.title,
            description: input.description,
            status: input.status ?? "unverified",
            lifecycle: input.lifecycle ?? "active",
            path: input.path,
            sourceHash: input.sourceHash,
            markdownHash: input.markdownHash,
            invalidReason: input.invalidReason ?? null,
            createdAt: now,
            updatedAt: now,
        };
        await db.insert(specs).values(row);
        return row;
    }

    async createSpecRecordRow(row: Spec): Promise<void> {
        await db.insert(specs).values(row);
    }

    async listSpecs(projectId: string): Promise<Spec[]> {
        return db
            .select()
            .from(specs)
            .where(eq(specs.projectId, projectId))
            .orderBy(asc(specs.createdAt), asc(specs.id));
    }

    async getSpec(id: string): Promise<Spec | null> {
        const rows = await db.select().from(specs).where(eq(specs.id, id));
        return rows[0] ?? null;
    }

    async getSpecByPath(projectId: string, path: string): Promise<Spec | null> {
        const rows = await db
            .select()
            .from(specs)
            .where(and(eq(specs.projectId, projectId), eq(specs.path, path)));
        return rows[0] ?? null;
    }

    async updateSpecRecord(id: string, patch: SpecPatch): Promise<void> {
        await db
            .update(specs)
            .set({ ...patch, updatedAt: new Date().toISOString() })
            .where(eq(specs.id, id));
    }

    async updateSpecStatus(id: string, status: SpecStatus, invalidReason: string | null = null): Promise<void> {
        await this.updateSpecRecord(id, { status, invalidReason });
    }

    async updateSpecStatusForContent(
        id: string,
        sourceHash: string,
        markdownHash: string,
        status: SpecStatus,
    ): Promise<void> {
        await db
            .update(specs)
            .set({ status, updatedAt: new Date().toISOString() })
            .where(
                and(
                    eq(specs.id, id),
                    eq(specs.sourceHash, sourceHash),
                    eq(specs.markdownHash, markdownHash),
                ),
            );
    }

    async deleteSpecRecord(id: string): Promise<void> {
        await db.delete(specs).where(eq(specs.id, id));
    }

    insertSpecQuery(row: Spec): DbQuery {
        return db.insert(specs).values(row);
    }

    updateSpecQuery(id: string, patch: SpecPatch): DbQuery {
        return db
            .update(specs)
            .set({ ...patch, updatedAt: new Date().toISOString() })
            .where(eq(specs.id, id));
    }

    /** Statements that delete the specs and their runs; callers check for running runs first. */
    deleteSpecsQueries(ids: string[]): DbQuery[] {
        if (ids.length === 0) return [];
        return [db.delete(runs).where(inArray(runs.specId, ids)), db.delete(specs).where(inArray(specs.id, ids))];
    }

    async deleteSpecWithRelations(id: string): Promise<DeleteSpecResult> {
        const specRows = await db.select({ id: specs.id }).from(specs).where(eq(specs.id, id));
        if (specRows.length === 0) return { status: "not_found" };
        const runRows = await db
            .select({ id: runs.id, status: runs.status })
            .from(runs)
            .where(eq(runs.specId, id));
        if (runRows.some((run) => run.status === "running")) return { status: "busy" };
        // Runs only start under the spec lock, which deletion callers hold.
        await runBatch(this.deleteSpecsQueries([id]));
        return { status: "deleted", runIds: runRows.map((run) => run.id) };
    }
}

export const specsRepository = new SpecsRepository();
