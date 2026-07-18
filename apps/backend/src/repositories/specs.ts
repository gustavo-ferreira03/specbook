import crypto from "node:crypto";
import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "../db/client";
import { runs, specs, specVersions, type HumanSpec, type SpecStatus } from "../db/schema";

export type Spec = typeof specs.$inferSelect;
export type SpecVersion = typeof specVersions.$inferSelect;
export type DeleteSpecResult =
    | { status: "not_found" }
    | { status: "busy" }
    | { status: "deleted"; runIds: string[] };

class SpecsRepository {
    async createSpecRecord(input: {
        projectId: string;
        featureId: string;
        title: string;
        description: string;
    }): Promise<Spec> {
        const now = new Date().toISOString();
        const row: Spec = {
            id: crypto.randomUUID(),
            projectId: input.projectId,
            featureId: input.featureId,
            title: input.title,
            description: input.description,
            status: "draft",
            currentVersionId: null,
            createdAt: now,
            updatedAt: now,
        };
        await db.insert(specs).values(row);
        return row;
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

    async updateSpecStatus(id: string, status: SpecStatus, currentVersionId?: string): Promise<void> {
        const patch: Partial<Spec> = {
            status,
            updatedAt: new Date().toISOString(),
        };
        if (currentVersionId !== undefined) patch.currentVersionId = currentVersionId;
        await db.update(specs).set(patch).where(eq(specs.id, id));
    }

    async updateSpecStatusForVersion(
        id: string,
        currentVersionId: string,
        status: SpecStatus,
    ): Promise<void> {
        await db
            .update(specs)
            .set({ status, updatedAt: new Date().toISOString() })
            .where(and(eq(specs.id, id), eq(specs.currentVersionId, currentVersionId)));
    }

    async publishSpecVersion(
        id: string,
        currentVersionId: string,
        metadata: { title?: string; description?: string } = {},
    ): Promise<void> {
        const patch: Partial<Spec> = {
            status: "unverified",
            currentVersionId,
            updatedAt: new Date().toISOString(),
        };
        if (metadata.title !== undefined) patch.title = metadata.title;
        if (metadata.description !== undefined) patch.description = metadata.description;
        await db
            .update(specs)
            .set(patch)
            .where(eq(specs.id, id));
    }

    async deleteSpecRecord(id: string): Promise<void> {
        await db.delete(specs).where(eq(specs.id, id));
    }

    async deleteSpecWithRelations(id: string): Promise<DeleteSpecResult> {
        return db.transaction(async (tx) => {
            const specRows = await tx.select({ id: specs.id }).from(specs).where(eq(specs.id, id));
            if (specRows.length === 0) return { status: "not_found" };
            const runRows = await tx
                .select({ id: runs.id, status: runs.status })
                .from(runs)
                .where(eq(runs.specId, id));
            if (runRows.some((run) => run.status === "running")) return { status: "busy" };
            await tx.delete(runs).where(eq(runs.specId, id));
            await tx.delete(specVersions).where(eq(specVersions.specId, id));
            await tx.delete(specs).where(eq(specs.id, id));
            return { status: "deleted", runIds: runRows.map((run) => run.id) };
        });
    }

    async addSpecVersion(input: {
        specId: string;
        version: number;
        humanSpec: HumanSpec;
        executablePath: string;
        executableHash: string;
    }): Promise<SpecVersion> {
        const row: SpecVersion = {
            id: crypto.randomUUID(),
            specId: input.specId,
            version: input.version,
            humanSpec: input.humanSpec,
            executablePath: input.executablePath,
            executableHash: input.executableHash,
            createdAt: new Date().toISOString(),
        };
        await db.insert(specVersions).values(row);
        return row;
    }

    async getSpecVersion(id: string): Promise<SpecVersion | null> {
        const rows = await db.select().from(specVersions).where(eq(specVersions.id, id));
        return rows[0] ?? null;
    }

    async deleteSpecVersion(id: string): Promise<void> {
        await db.delete(specVersions).where(eq(specVersions.id, id));
    }

    async latestVersionNumber(specId: string): Promise<number> {
        const rows = await db
            .select()
            .from(specVersions)
            .where(eq(specVersions.specId, specId))
            .orderBy(desc(specVersions.version), desc(specVersions.createdAt), desc(specVersions.id))
            .limit(1);
        return rows[0]?.version ?? 0;
    }
}

export const specsRepository = new SpecsRepository();
