import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/client";
import { projectAgentTokens } from "../db/schema";

export const agentAccessRepository = {
    async token(projectId: string) {
        return (await db.select().from(projectAgentTokens).where(eq(projectAgentTokens.projectId, projectId)))[0] ?? null;
    },
    async setToken(projectId: string, token: { tokenHash: string; tokenPrefix: string; createdAt: string }) {
        await db.insert(projectAgentTokens).values({ projectId, ...token }).onConflictDoUpdate({
            target: projectAgentTokens.projectId,
            set: { ...token, lastUsedAt: null, requestWindowStartedAt: null, requestCount: 0 },
        });
    },
    async consumeRequest(projectId: string, tokenHash: string, at = Date.now()): Promise<boolean> {
        const window = new Date(Math.floor(at / 60_000) * 60_000).toISOString();
        const [row] = await db.update(projectAgentTokens).set({
            requestWindowStartedAt: window,
            requestCount: sql`CASE WHEN ${projectAgentTokens.requestWindowStartedAt} = ${window} THEN ${projectAgentTokens.requestCount} + 1 ELSE 1 END`,
        }).where(and(eq(projectAgentTokens.projectId, projectId), eq(projectAgentTokens.tokenHash, tokenHash),
            sql`(${projectAgentTokens.requestWindowStartedAt} IS NULL OR ${projectAgentTokens.requestWindowStartedAt} != ${window} OR ${projectAgentTokens.requestCount} < 30)`))
            .returning({ projectId: projectAgentTokens.projectId });
        return !!row;
    },
    async revokeToken(projectId: string) {
        await db.delete(projectAgentTokens).where(eq(projectAgentTokens.projectId, projectId));
    },
    async touchToken(projectId: string, tokenHash: string) {
        await db.update(projectAgentTokens).set({ lastUsedAt: new Date().toISOString() })
            .where(and(eq(projectAgentTokens.projectId, projectId), eq(projectAgentTokens.tokenHash, tokenHash)));
    },
};
