ALTER TABLE `jobs` ADD `error_code` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `error_code` text;--> statement-breakpoint
CREATE INDEX `inbox_job_kind_status` ON `inbox_items` (`job_id`,`kind`,`status`);--> statement-breakpoint
CREATE INDEX `inbox_project_kind_status` ON `inbox_items` (`project_id`,`kind`,`status`);