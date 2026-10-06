import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/client";
import { projectCiTokens } from "../db/schema";

export const ciRepository = {
    async token(projectId: string) {
        return (await db.select().from(projectCiTokens).where(eq(projectCiTokens.projectId, projectId)))[0] ?? null;
    },
    async setToken(projectId: string, token: { tokenHash: string; tokenPrefix: string; createdAt: string }) {
        await db.insert(projectCiTokens).values({ projectId, ...token }).onConflictDoUpdate({
            target: projectCiTokens.projectId,
            set: { ...token, lastUsedAt: null, requestWindowStartedAt: null, requestCount: 0 },
        });
    },
    async consumeRequest(projectId: string, tokenHash: string, at = Date.now()): Promise<boolean> {
        const window = new Date(Math.floor(at / 60_000) * 60_000).toISOString();
        const [row] = await db.update(projectCiTokens).set({
            requestWindowStartedAt: window,
            requestCount: sql`CASE WHEN ${projectCiTokens.requestWindowStartedAt} = ${window} THEN ${projectCiTokens.requestCount} + 1 ELSE 1 END`,
        }).where(and(eq(projectCiTokens.projectId, projectId), eq(projectCiTokens.tokenHash, tokenHash),
            sql`(${projectCiTokens.requestWindowStartedAt} IS NULL OR ${projectCiTokens.requestWindowStartedAt} != ${window} OR ${projectCiTokens.requestCount} < 30)`))
            .returning({ projectId: projectCiTokens.projectId });
        return !!row;
    },
    async revokeToken(projectId: string) {
        await db.delete(projectCiTokens).where(eq(projectCiTokens.projectId, projectId));
    },
    async touchToken(projectId: string, tokenHash: string) {
        await db.update(projectCiTokens).set({ lastUsedAt: new Date().toISOString() })
            .where(and(eq(projectCiTokens.projectId, projectId), eq(projectCiTokens.tokenHash, tokenHash)));
    },
};
