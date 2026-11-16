import { and, eq } from "drizzle-orm";

import { db } from "../db/client";
import { chatSessions } from "../db/schema";

class ChatSessionsRepository {
  // oxlint-disable-next-line class-methods-use-this -- Keep this operation on the service instance used by callers.
  async upsert(row: ChatSessionRow): Promise<void> {
    await db
      .insert(chatSessions)
      .values(row)
      .onConflictDoUpdate({
        target: [chatSessions.projectId, chatSessions.profileId],
        set: { state: row.state, savedAt: row.savedAt },
      });
  }

  // oxlint-disable-next-line class-methods-use-this -- Keep this operation on the service instance used by callers.
  async getByProfile(
    projectId: string,
    profileId: string
  ): Promise<ChatSessionRow | null> {
    const rows = await db
      .select()
      .from(chatSessions)
      .where(
        and(
          eq(chatSessions.projectId, projectId),
          eq(chatSessions.profileId, profileId)
        )
      );
    return rows[0] ?? null;
  }

  // oxlint-disable-next-line class-methods-use-this -- Keep this operation on the service instance used by callers.
  async deleteByProfileId(profileId: string): Promise<void> {
    await db.delete(chatSessions).where(eq(chatSessions.profileId, profileId));
  }
}

export type ChatSessionRow = typeof chatSessions.$inferSelect;

export const chatSessionsRepository = new ChatSessionsRepository();
