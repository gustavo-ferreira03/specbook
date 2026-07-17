import crypto from "node:crypto";
import { asc, eq, inArray } from "drizzle-orm";
import { db } from "../db/client";
import { features, runs, specs, specVersions } from "../db/schema";

export type Feature = typeof features.$inferSelect;
export type DeleteFeatureResult =
    | { status: "not_found" }
    | { status: "busy" }
    | { status: "deleted"; specIds: string[]; runIds: string[] };

function collectFeatureIds(rootId: string, rows: Feature[]): string[] {
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

export async function createFeature(
    projectId: string,
    parentId: string | null,
    title: string,
    description: string,
): Promise<Feature> {
    const row: Feature = {
        id: crypto.randomUUID(),
        projectId,
        parentId,
        title,
        description,
        createdAt: new Date().toISOString(),
    };
    await db.insert(features).values(row);
    return row;
}

export async function listFeatures(projectId: string): Promise<Feature[]> {
    return db
        .select()
        .from(features)
        .where(eq(features.projectId, projectId))
        .orderBy(asc(features.createdAt), asc(features.id));
}

export async function getFeature(id: string): Promise<Feature | null> {
    const rows = await db.select().from(features).where(eq(features.id, id));
    return rows[0] ?? null;
}

export async function getFeatureDeletionSpecIds(id: string): Promise<string[] | null> {
    const target = await getFeature(id);
    if (!target) return null;
    const featureIds = collectFeatureIds(id, await listFeatures(target.projectId));
    const specRows = await db
        .select({ id: specs.id })
        .from(specs)
        .where(inArray(specs.featureId, featureIds));
    return specRows.map((spec) => spec.id);
}

export async function deleteFeatureWithRelations(id: string): Promise<DeleteFeatureResult> {
    return db.transaction(async (tx) => {
        const targets = await tx.select().from(features).where(eq(features.id, id));
        const target = targets[0];
        if (!target) return { status: "not_found" };
        const projectFeatures = await tx
            .select()
            .from(features)
            .where(eq(features.projectId, target.projectId));
        const featureIds = collectFeatureIds(id, projectFeatures);
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
            await tx.delete(specVersions).where(inArray(specVersions.specId, specIds));
            await tx.delete(specs).where(inArray(specs.id, specIds));
        }
        await tx.delete(features).where(inArray(features.id, featureIds));
        return { status: "deleted", specIds, runIds: runRows.map((run) => run.id) };
    });
}
