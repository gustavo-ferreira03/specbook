CREATE TABLE `project_agent_tokens` (
	`project_id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`token_prefix` text NOT NULL,
	`created_at` text NOT NULL,
	`last_used_at` text,
	`request_window_started_at` text,
	`request_count` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `chats` ADD `source` text;--> statement-breakpoint
ALTER TABLE `chats` ADD `source_client` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `agent_contract_policy` text DEFAULT 'apply_declared' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `agents_may_provide_credentials` integer DEFAULT true NOT NULL;