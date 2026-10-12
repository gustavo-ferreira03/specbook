ALTER TABLE `runner_tokens` ADD `cli_version` text;--> statement-breakpoint
ALTER TABLE `runner_tokens` ADD `protocol_version` integer;--> statement-breakpoint
ALTER TABLE `runner_tokens` ADD `concurrency` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `runner_tokens` ADD `project_ids` text;