ALTER TABLE `conversations` RENAME TO `chats`;
--> statement-breakpoint
ALTER TABLE `project_context_revisions` RENAME COLUMN `source_conversation_id` TO `source_chat_id`;
