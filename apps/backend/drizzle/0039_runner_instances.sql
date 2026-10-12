CREATE TABLE `runner_instances` (
	`id` text PRIMARY KEY NOT NULL,
	`runner_id` text NOT NULL,
	`mode` text NOT NULL,
	`cli_version` text NOT NULL,
	`protocol_version` integer NOT NULL,
	`concurrency` integer NOT NULL,
	`last_seen_at` text NOT NULL,
	FOREIGN KEY (`runner_id`) REFERENCES `runner_tokens`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `runner_instances_token` ON `runner_instances` (`runner_id`);--> statement-breakpoint
ALTER TABLE `runner_jobs` ADD `runner_instance_id` text;