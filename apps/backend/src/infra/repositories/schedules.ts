import crypto from "node:crypto";
import { and, asc, desc, eq, isNull, lt, lte } from "drizzle-orm";
import { decryptSecret, encryptSecret } from "../../core/credentials/crypto";
import { db, runBatch } from "../db/client";
import { projectAutomations, webhookNotifications } from "../db/schema";

export type ProjectAutomation = typeof projectAutomations.$inferSelect;
export type WebhookNotification = typeof webhookNotifications.$inferSelect;
type Settings = Pick<ProjectAutomation, "cron" | "specIds" | "healFailures" | "webhookUrl" | "nextRunAt">;

export const MAX_WEBHOOK_ATTEMPTS = 5;
const RETRY_DELAYS = [10_000, 30_000, 120_000, 600_000];
const now = () => new Date().toISOString();

function withPlainWebhook(row: ProjectAutomation): ProjectAutomation {
    return { ...row, webhookUrl: row.webhookUrl ? decryptSecret(row.webhookUrl) : null };
}

export const schedulesRepository = {
    async get(projectId: string): Promise<ProjectAutomation | null> {
        const [row] = await db.select().from(projectAutomations).where(eq(projectAutomations.projectId, projectId));
        return row ? withPlainWebhook(row) : null;
    },
    async list() {
        return db.select({ projectId: projectAutomations.projectId }).from(projectAutomations);
    },
    async save(projectId: string, settings: Settings): Promise<ProjectAutomation> {
        const patch = { ...settings, webhookUrl: settings.webhookUrl ? encryptSecret(settings.webhookUrl) : null, lastError: null, updatedAt: now() };
        const [row] = await db.insert(projectAutomations).values({ projectId, ...patch })
            .onConflictDoUpdate({ target: projectAutomations.projectId, set: patch }).returning();
        return withPlainWebhook(row!);
    },
    async update(projectId: string, patch: Partial<Pick<ProjectAutomation, "nextRunAt" | "lastBatchId" | "lastBatchStatus" | "lastError">>) {
        await db.update(projectAutomations).set({ ...patch, updatedAt: now() }).where(eq(projectAutomations.projectId, projectId));
    },
    async claimDue(projectId: string, dueAt: string, nextRunAt: string): Promise<boolean> {
        const rows = await db.update(projectAutomations).set({ nextRunAt, updatedAt: now() })
            .where(and(eq(projectAutomations.projectId, projectId), eq(projectAutomations.nextRunAt, dueAt))).returning({ projectId: projectAutomations.projectId });
        return rows.length > 0;
    },
    async recordBatch(projectId: string, batchId: string, status: ProjectAutomation["lastBatchStatus"], notification: {
        webhookUrl: string; payload: Record<string, unknown>;
    } | null) {
        const queries = [db.update(projectAutomations).set({ lastBatchId: batchId, lastBatchStatus: status, lastError: null, updatedAt: now() })
            .where(eq(projectAutomations.projectId, projectId))];
        await runBatch([
            ...queries,
            ...(notification && status ? [db.insert(webhookNotifications).values({
                id: crypto.randomUUID(), projectId, batchId, status,
                webhookUrl: encryptSecret(notification.webhookUrl), payload: notification.payload,
                attempts: 0, nextAttemptAt: now(), createdAt: now(),
            }).onConflictDoNothing({ target: [webhookNotifications.batchId, webhookNotifications.status] })] : []),
        ]);
    },
    async notifications(projectId: string) {
        return db.select({
            id: webhookNotifications.id, batchId: webhookNotifications.batchId, status: webhookNotifications.status,
            attempts: webhookNotifications.attempts, nextAttemptAt: webhookNotifications.nextAttemptAt,
            deliveredAt: webhookNotifications.deliveredAt, lastError: webhookNotifications.lastError,
            createdAt: webhookNotifications.createdAt,
        }).from(webhookNotifications).where(eq(webhookNotifications.projectId, projectId))
            .orderBy(desc(webhookNotifications.createdAt)).limit(30);
    },
    async pendingNotifications(at: string): Promise<WebhookNotification[]> {
        return db.select().from(webhookNotifications).where(and(
            isNull(webhookNotifications.deliveredAt), lte(webhookNotifications.nextAttemptAt, at),
            lt(webhookNotifications.attempts, MAX_WEBHOOK_ATTEMPTS),
        )).orderBy(asc(webhookNotifications.createdAt)).limit(10);
    },
    async claimNotification(row: WebhookNotification, at: string): Promise<WebhookNotification | null> {
        const attempts = row.attempts + 1;
        const [claimed] = await db.update(webhookNotifications).set({
            attempts,
            nextAttemptAt: attempts < MAX_WEBHOOK_ATTEMPTS ? new Date(Date.parse(at) + 60_000).toISOString() : null,
            lastError: "Webhook delivery interrupted before confirmation",
        }).where(and(
            eq(webhookNotifications.id, row.id), eq(webhookNotifications.attempts, row.attempts),
            isNull(webhookNotifications.deliveredAt), lte(webhookNotifications.nextAttemptAt, at),
        )).returning();
        return claimed ?? null;
    },
    async finishNotification(row: WebhookNotification, error: string | null, at: string) {
        await db.update(webhookNotifications).set({
            deliveredAt: error ? null : at,
            lastError: error,
            nextAttemptAt: error && row.attempts < MAX_WEBHOOK_ATTEMPTS
                ? new Date(Date.parse(at) + RETRY_DELAYS[row.attempts - 1]!).toISOString() : null,
        }).where(and(eq(webhookNotifications.id, row.id), eq(webhookNotifications.attempts, row.attempts),
            eq(webhookNotifications.lastError, "Webhook delivery interrupted before confirmation")));
    },
    async cancelPendingNotifications(projectId: string) {
        await db.update(webhookNotifications).set({ nextAttemptAt: null, lastError: "Webhook configuration changed before delivery" })
            .where(and(eq(webhookNotifications.projectId, projectId), isNull(webhookNotifications.deliveredAt)));
    },
};
