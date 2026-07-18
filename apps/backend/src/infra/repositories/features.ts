import crypto from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "../db/client";
import { features, runs, specs } from "../db/schema";

export type Feature = typeof features.$inferSelect;
export type DeleteFeatureResult =
    | { status: "not_found" }
    | { status: "busy" }
    | { status: "deleted"; specIds: string[]; runIds: string[] };

class FeaturesRepository {
    private collectFeatureIds(rootId: string, rows: Feature[]): string[] {
        const ids = new Set([rootId]);
        let changed = true;
        while (changed) {
            changed = false;
            for (const feature of rows) {
                if (feature.parentId && ids.has(feature.parentId) && !ids.has(feature.id)) {
                    ids.add(feature.id);
                    changed = true;
                }
            }
        }
        return [...ids];
    }

    async createFeature(
        projectId: string,
        parentId: string | null,
        title: string,
        description: string,
        path: string,
        id: string = crypto.randomUUID(),
    ): Promise<Feature> {
        const row: Feature = {
            id,
            projectId,
            parentId,
            title,
            description,
            path,
            createdAt: new Date().toISOString(),
        };
        await db.insert(features).values(row);
        return row;
    }

    async getFeatureByPath(projectId: string, path: string): Promise<Feature | null> {
        const rows = await db
            .select()
            .from(features)
            .where(and(eq(features.projectId, projectId), eq(features.path, path)));
        return rows[0] ?? null;
    }

    async updateFeatureRecord(
        id: string,
        patch: Partial<Pick<Feature, "title" | "description" | "path" | "parentId">>,
    ): Promise<void> {
        await db.update(features).set(patch).where(eq(features.id, id));
    }

    async listFeatures(projectId: string): Promise<Feature[]> {
        return db
            .select()
            .from(features)
            .where(eq(features.projectId, projectId))
            .orderBy(asc(features.createdAt), asc(features.id));
    }

    async getFeature(id: string): Promise<Feature | null> {
        const rows = await db.select().from(features).where(eq(features.id, id));
        return rows[0] ?? null;
    }

    async getFeatureDeletionSpecIds(id: string): Promise<string[] | null> {
        const target = await this.getFeature(id);
        if (!target) return null;
        const featureIds = this.collectFeatureIds(id, await this.listFeatures(target.projectId));
        const specRows = await db
            .select({ id: specs.id })
            .from(specs)
            .where(inArray(specs.featureId, featureIds));
        return specRows.map((spec) => spec.id);
    }

    async deleteFeatureWithRelations(id: string): Promise<DeleteFeatureResult> {
        return db.transaction(async (tx) => {
            const targets = await tx.select().from(features).where(eq(features.id, id));
            const target = targets[0];
            if (!target) return { status: "not_found" };
            const projectFeatures = await tx
                .select()
                .from(features)
                .where(eq(features.projectId, target.projectId));
            const featureIds = this.collectFeatureIds(id, projectFeatures);
            const specRows = await tx
                .select({ id: specs.id })
                .from(specs)
                .where(inArray(specs.featureId, featureIds));
            const specIds = specRows.map((spec) => spec.id);
            const runRows = specIds.length
                ? await tx
                      .select({ id: runs.id, status: runs.status })
                      .from(runs)
                      .where(inArray(runs.specId, specIds))
                : [];
            if (runRows.some((run) => run.status === "running")) return { status: "busy" };
            if (specIds.length) {
                await tx.delete(runs).where(inArray(runs.specId, specIds));
                await tx.delete(specs).where(inArray(specs.id, specIds));
            }
            await tx.delete(features).where(inArray(features.id, featureIds));
            return { status: "deleted", specIds, runIds: runRows.map((run) => run.id) };
        });
    }
}

export const featuresRepository = new FeaturesRepository();
