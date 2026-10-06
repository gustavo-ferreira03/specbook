ALTER TABLE `runs` ADD `heal_on_failure` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `retry_of` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `flaky` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `base_url` text;--> statement-breakpoint
CREATE UNIQUE INDEX `runs_retry_of_unique` ON `runs` (`retry_of`);