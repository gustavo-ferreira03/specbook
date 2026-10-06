ALTER TABLE `jobs` ADD `run_id` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `classification` text;--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_run_id_unique` ON `jobs` (`run_id`);--> statement-breakpoint
ALTER TABLE `runs` ADD `automation_pending` integer DEFAULT false NOT NULL;