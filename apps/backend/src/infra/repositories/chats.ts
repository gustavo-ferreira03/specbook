import { desc, eq } from "drizzle-orm";
import { db } from "../db/client";
import { chats, type ChatMode } from "../db/schema";

export type ChatRow = typeof chats.$inferSelect;

export interface ChatMetadata {
    contextRevisionId?: string | null;
}

class ChatsRepository {
    chatMode(row: ChatRow): ChatMode {
        return row.contextRevisionId ? "discovery" : "standard";
    }

    async insertChat(id: string, projectId: string, metadata: ChatMetadata = {}): Promise<ChatRow> {
        const row: ChatRow = {
            id,
            projectId,
            contextRevisionId: metadata.contextRevisionId ?? null,
            createdAt: new Date().toISOString(),
        };
        await db.insert(chats).values(row);
        return row;
    }

    async listChatRows(projectId: string): Promise<ChatRow[]> {
        return db
            .select()
            .from(chats)
            .where(eq(chats.projectId, projectId))
            .orderBy(desc(chats.createdAt), desc(chats.id));
    }

    async getChatRow(id: string): Promise<ChatRow | null> {
        const rows = await db.select().from(chats).where(eq(chats.id, id));
        return rows[0] ?? null;
    }

    async deleteChatRow(id: string): Promise<void> {
        await db.delete(chats).where(eq(chats.id, id));
    }
}

export const chatsRepository = new ChatsRepository();
