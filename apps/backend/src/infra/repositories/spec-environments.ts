import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/client";
import { environments, specEnvironmentStates, type SpecStatus } from "../db/schema";
import { specsRepository, type Spec } from "./specs";

class SpecEnvironmentsRepository {
    async list(spec: Spec) {
        return db.select().from(specEnvironmentStates).where(and(
            eq(specEnvironmentStates.specId, spec.id),
            eq(specEnvironmentStates.sourceHash, spec.sourceHash),
            eq(specEnvironmentStates.markdownHash, spec.markdownHash),
        ));
    }

    async awaiting(spec: Spec, environmentId?: string): Promise<boolean> {
        if (!environmentId) return false;
        return (await this.list(spec)).some((state) => state.environmentId === environmentId && state.status === "awaiting_deploy");
    }

    async set(spec: Spec, environmentId: string, status: SpecStatus): Promise<void> {
        const row = { specId: spec.id, environmentId, sourceHash: spec.sourceHash, markdownHash: spec.markdownHash, status, updatedAt: new Date().toISOString() };
        const updated = await db.insert(specEnvironmentStates).select(db.select({
            specId: sql<string>`${row.specId}`.as("spec_id"),
            environmentId: environments.id,
            sourceHash: sql<string>`${row.sourceHash}`.as("source_hash"),
            markdownHash: sql<string>`${row.markdownHash}`.as("markdown_hash"),
            status: sql<SpecStatus>`${row.status}`.as("status"),
            updatedAt: sql<string>`${row.updatedAt}`.as("updated_at"),
        }).from(environments).where(and(eq(environments.id, environmentId), eq(environments.projectId, spec.projectId)))).onConflictDoUpdate({
            target: [specEnvironmentStates.specId, specEnvironmentStates.environmentId],
            set: row,
        }).returning({ specId: specEnvironmentStates.specId });
        if (updated.length) await this.refresh(spec, status);
    }

    async refresh(spec: Spec, fallback?: SpecStatus): Promise<void> {
        const states = await this.list(spec);
        const awaiting = states.some((state) => state.status === "awaiting_deploy");
        const status = awaiting && fallback !== "failed" ? "awaiting_deploy" : fallback ?? states.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.status ?? "unverified";
        await specsRepository.updateSpecStatusForContent(spec.id, spec.sourceHash, spec.markdownHash, status);
    }
}

export const specEnvironmentsRepository = new SpecEnvironmentsRepository();
