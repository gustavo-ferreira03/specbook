CREATE TABLE `project_context_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`source_conversation_id` text,
	`status` text NOT NULL,
	`brief` text NOT NULL,
	`context` text NOT NULL,
	`actions_used` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`confirmed_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `conversations` ADD `context_revision_id` text;