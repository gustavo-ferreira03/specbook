import { desc, eq } from "drizzle-orm";
import { db } from "../db/client";
import { conversations, type ConversationMode } from "../db/schema";

export type ConversationRow = typeof conversations.$inferSelect;

export interface ConversationMetadata {
    contextRevisionId?: string | null;
}

class ConversationsRepository {
    conversationMode(row: ConversationRow): ConversationMode {
        return row.contextRevisionId ? "discovery" : "standard";
    }

    async insertConversation(
        id: string,
        projectId: string,
        metadata: ConversationMetadata = {},
    ): Promise<ConversationRow> {
        const row: ConversationRow = {
            id,
            projectId,
            contextRevisionId: metadata.contextRevisionId ?? null,
            createdAt: new Date().toISOString(),
        };
        await db.insert(conversations).values(row);
        return row;
    }

    async listConversationRows(projectId: string): Promise<ConversationRow[]> {
        return db
            .select()
            .from(conversations)
            .where(eq(conversations.projectId, projectId))
            .orderBy(desc(conversations.createdAt), desc(conversations.id));
    }

    async getConversationRow(id: string): Promise<ConversationRow | null> {
        const rows = await db.select().from(conversations).where(eq(conversations.id, id));
        return rows[0] ?? null;
    }

    async deleteConversationRow(id: string): Promise<void> {
        await db.delete(conversations).where(eq(conversations.id, id));
    }
}

export const conversationsRepository = new ConversationsRepository();
