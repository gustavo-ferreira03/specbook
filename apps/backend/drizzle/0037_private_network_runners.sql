CREATE TABLE `runner_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`batch_id` text NOT NULL,
	`project_id` text NOT NULL,
	`group` text,
	`payload` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`runner_id` text,
	`lease_id` text,
	`lease_expires_at` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`runner_id`) REFERENCES `runner_tokens`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runner_jobs_batch_id_unique` ON `runner_jobs` (`batch_id`);--> statement-breakpoint
CREATE INDEX `runner_jobs_status_group` ON `runner_jobs` (`status`,`group`);--> statement-breakpoint
CREATE INDEX `runner_jobs_lease_expiry` ON `runner_jobs` (`lease_expires_at`);--> statement-breakpoint
CREATE TABLE `runner_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`group` text,
	`token_hash` text NOT NULL,
	`created_at` text NOT NULL,
	`last_seen_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runner_tokens_token_hash_unique` ON `runner_tokens` (`token_hash`);--> statement-breakpoint
ALTER TABLE `environments` ADD `executor` text DEFAULT 'server' NOT NULL;--> statement-breakpoint
ALTER TABLE `environments` ADD `runner_group` text;