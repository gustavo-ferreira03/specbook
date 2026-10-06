CREATE TABLE `environments` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`base_url` text NOT NULL,
	`allowed_origins` text DEFAULT '[]' NOT NULL,
	`credential_overrides` text DEFAULT '{}' NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `environments_project_name_idx` ON `environments` (`project_id`,`name`);--> statement-breakpoint
ALTER TABLE `runs` ADD `environment` text;--> statement-breakpoint
INSERT INTO `environments` (`id`, `project_id`, `name`, `base_url`, `allowed_origins`, `credential_overrides`)
SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-a' || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))), `id`, 'Production', `base_url`, `ci_allowed_origins`, '{}' FROM `projects`;
--> statement-breakpoint
ALTER TABLE `projects` DROP COLUMN `ci_allowed_origins`;