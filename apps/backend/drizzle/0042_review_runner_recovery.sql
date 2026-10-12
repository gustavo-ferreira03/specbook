ALTER TABLE `runner_jobs` ADD `queue_expires_at` text;--> statement-breakpoint
ALTER TABLE `runner_jobs` ADD `claimed_at` text;--> statement-breakpoint
ALTER TABLE `runner_jobs` ADD `completion_started_at` text;--> statement-breakpoint
ALTER TABLE `runner_tokens` ADD `purpose` text DEFAULT 'runner' NOT NULL;