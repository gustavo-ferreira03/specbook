import crypto from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/client";
import { projectSignals, projectStewards, stewardIntents } from "../db/schema";

export type Steward = typeof projectStewards.$inferSelect;
export type ProjectSignal = typeof projectSignals.$inferSelect;
export type Intent = typeof stewardIntents.$inferSelect;
const now = () => new Date().toISOString();

export const stewardRepository = {
    async get(projectId: string): Promise<Steward> {
        await db.insert(projectStewards).values({ projectId, updatedAt: now() }).onConflictDoNothing();
        return (await db.select().from(projectStewards).where(eq(projectStewards.projectId, projectId)))[0]!;
    },
    async update(projectId: string, patch: Partial<Pick<Steward, "autonomy" | "observation" | "lastPlannerAt" | "extraUsage">>) {
        await this.get(projectId);
        await db.update(projectStewards).set({ ...patch, updatedAt: now() }).where(eq(projectStewards.projectId, projectId));
    },
    async signal(input: Pick<ProjectSignal, "projectId" | "key" | "kind" | "title" | "body"> & { payload?: Record<string, unknown> }) {
        await db.insert(projectSignals).values({ ...input, id: crypto.randomUUID(), createdAt: now() }).onConflictDoNothing();
    },
    async signals(projectId: string) {
        return db.select().from(projectSignals).where(eq(projectSignals.projectId, projectId)).orderBy(desc(projectSignals.createdAt)).limit(300);
    },
    async pendingSignals(projectId: string) {
        return db.select().from(projectSignals).where(and(eq(projectSignals.projectId, projectId), eq(projectSignals.status, "pending")));
    },
    async resumeObserved(projectId: string) {
        await db.update(projectSignals).set({ status: "pending" }).where(and(eq(projectSignals.projectId, projectId), eq(projectSignals.status, "observed")));
    },
    async acknowledge(id: string, status: ProjectSignal["status"]) {
        await db.update(projectSignals).set({ status }).where(eq(projectSignals.id, id));
    },
    async addIntent(input: Pick<Intent, "projectId" | "key" | "fingerprint" | "intent" | "priority" | "reason">) {
        await db.insert(stewardIntents).values({ ...input, id: crypto.randomUUID(), createdAt: now(), updatedAt: now() }).onConflictDoNothing();
        return (await db.select().from(stewardIntents).where(and(eq(stewardIntents.projectId, input.projectId), eq(stewardIntents.key, input.key))))[0]!;
    },
    async intents(projectId: string) {
        return db.select().from(stewardIntents).where(eq(stewardIntents.projectId, projectId)).orderBy(desc(stewardIntents.priority), desc(stewardIntents.createdAt));
    },
    async updateIntent(id: string, patch: Partial<Pick<Intent, "status" | "jobId" | "batchId" | "reason">>) {
        await db.update(stewardIntents).set({ ...patch, updatedAt: now() }).where(eq(stewardIntents.id, id));
    },
};
