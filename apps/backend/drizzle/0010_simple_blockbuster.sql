CREATE TABLE `project_automations` (
	`project_id` text PRIMARY KEY NOT NULL,
	`cron` text,
	`spec_ids` text DEFAULT '[]' NOT NULL,
	`heal_failures` integer DEFAULT true NOT NULL,
	`webhook_url` text,
	`next_run_at` text,
	`last_batch_id` text,
	`last_batch_status` text,
	`last_error` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `webhook_notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`batch_id` text NOT NULL,
	`status` text NOT NULL,
	`webhook_url` text NOT NULL,
	`payload` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text,
	`delivered_at` text,
	`last_error` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_batch_status_unique` ON `webhook_notifications` (`batch_id`,`status`);--> statement-breakpoint
CREATE INDEX `webhook_retry_idx` ON `webhook_notifications` (`next_attempt_at`);