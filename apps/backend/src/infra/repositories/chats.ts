import { desc, eq } from "drizzle-orm";

import { db } from "../db/client";
import { chats } from "../db/schema";
import type { ChatMode } from "../db/schema";

class ChatsRepository {
  // oxlint-disable-next-line class-methods-use-this -- Keep this operation on the service instance used by callers.
  chatMode(row: ChatRow): ChatMode {
    return row.contextRevisionId ? "discovery" : "standard";
  }

  // oxlint-disable-next-line class-methods-use-this -- Keep this operation on the service instance used by callers.
  async insertChat(
    id: string,
    projectId: string,
    metadata: ChatMetadata = {}
  ): Promise<ChatRow> {
    const row: ChatRow = {
      id,
      projectId,
      contextRevisionId: metadata.contextRevisionId ?? null,
      createdAt: new Date().toISOString(),
    };
    await db.insert(chats).values(row);
    return row;
  }

  // oxlint-disable-next-line class-methods-use-this -- Keep this operation on the service instance used by callers.
  async listChatRows(projectId: string): Promise<ChatRow[]> {
    return await db
      .select()
      .from(chats)
      .where(eq(chats.projectId, projectId))
      .orderBy(desc(chats.createdAt), desc(chats.id));
  }

  // oxlint-disable-next-line class-methods-use-this -- Keep this operation on the service instance used by callers.
  async getChatRow(id: string): Promise<ChatRow | null> {
    const rows = await db.select().from(chats).where(eq(chats.id, id));
    return rows[0] ?? null;
  }

  // oxlint-disable-next-line class-methods-use-this -- Keep this operation on the service instance used by callers.
  async deleteChatRow(id: string): Promise<void> {
    await db.delete(chats).where(eq(chats.id, id));
  }
}

export type ChatRow = typeof chats.$inferSelect;

export interface ChatMetadata {
  contextRevisionId?: string | null;
}

export const chatsRepository = new ChatsRepository();
