import { and, eq } from "drizzle-orm";
import { db } from "../db/client";
import { specEnvironmentStates, type SpecStatus } from "../db/schema";
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
        await db.insert(specEnvironmentStates).values(row).onConflictDoUpdate({
            target: [specEnvironmentStates.specId, specEnvironmentStates.environmentId],
            set: row,
        });
        const awaiting = (await this.list(spec)).some((state) => state.status === "awaiting_deploy");
        await specsRepository.updateSpecStatusForContent(spec.id, spec.sourceHash, spec.markdownHash, awaiting && status !== "failed" ? "awaiting_deploy" : status);
    }
}

export const specEnvironmentsRepository = new SpecEnvironmentsRepository();
