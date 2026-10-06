ALTER TABLE `jobs` ADD `source_chat_id` text REFERENCES chats(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `steward_intents` ADD `source_chat_id` text REFERENCES chats(id) ON DELETE SET NULL;
