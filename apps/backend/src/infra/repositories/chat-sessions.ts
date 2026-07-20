import { and, eq } from "drizzle-orm";
import { db } from "../db/client";
import { chatSessions } from "../db/schema";

export type ChatSessionRow = typeof chatSessions.$inferSelect;

class ChatSessionsRepository {
    async upsert(row: ChatSessionRow): Promise<void> {
        await db
            .insert(chatSessions)
            .values(row)
            .onConflictDoUpdate({
                target: [chatSessions.projectId, chatSessions.profileId],
                set: { state: row.state, savedAt: row.savedAt },
            });
    }

    async getByProfile(projectId: string, profileId: string): Promise<ChatSessionRow | null> {
        const rows = await db
            .select()
            .from(chatSessions)
            .where(and(eq(chatSessions.projectId, projectId), eq(chatSessions.profileId, profileId)));
        return rows[0] ?? null;
    }

    async deleteByProfileId(profileId: string): Promise<void> {
        await db.delete(chatSessions).where(eq(chatSessions.profileId, profileId));
    }
}

export const chatSessionsRepository = new ChatSessionsRepository();
