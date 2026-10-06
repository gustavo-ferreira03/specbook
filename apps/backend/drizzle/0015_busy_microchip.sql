ALTER TABLE `jobs` ADD `daily_usage` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `retry_at` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `system_error` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `infrastructure_retries` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `project_stewards` ADD `extra_usage` text;