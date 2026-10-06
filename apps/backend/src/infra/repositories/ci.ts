import { and, eq } from "drizzle-orm";
import { db } from "../db/client";
import { projectCiTokens } from "../db/schema";

export const ciRepository = {
    async token(projectId: string) {
        return (await db.select().from(projectCiTokens).where(eq(projectCiTokens.projectId, projectId)))[0] ?? null;
    },
    async setToken(projectId: string, token: { tokenHash: string; tokenPrefix: string; createdAt: string }) {
        await db.insert(projectCiTokens).values({ projectId, ...token }).onConflictDoUpdate({
            target: projectCiTokens.projectId,
            set: { ...token, lastUsedAt: null },
        });
    },
    async revokeToken(projectId: string) {
        await db.delete(projectCiTokens).where(eq(projectCiTokens.projectId, projectId));
    },
    async touchToken(projectId: string, tokenHash: string) {
        await db.update(projectCiTokens).set({ lastUsedAt: new Date().toISOString() })
            .where(and(eq(projectCiTokens.projectId, projectId), eq(projectCiTokens.tokenHash, tokenHash)));
    },
};
