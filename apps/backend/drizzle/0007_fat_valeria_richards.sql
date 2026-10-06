CREATE TABLE `inbox_items` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`job_id` text NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`payload` text NOT NULL,
	`answer` text,
	`commit_sha` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `inbox_project_status` ON `inbox_items` (`project_id`,`status`);--> statement-breakpoint
CREATE TABLE `job_actions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` text NOT NULL,
	`action` text NOT NULL,
	`detail` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `job_actions_job` ON `job_actions` (`job_id`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`trigger` text NOT NULL,
	`goal` text NOT NULL,
	`status` text NOT NULL,
	`budget` text NOT NULL,
	`tokens_used` integer DEFAULT 0 NOT NULL,
	`actions_used` integer DEFAULT 0 NOT NULL,
	`elapsed_ms` integer DEFAULT 0 NOT NULL,
	`started_at` text,
	`pending_message` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_chat_id_unique` ON `jobs` (`chat_id`);--> statement-breakpoint
CREATE INDEX `jobs_project_status` ON `jobs` (`project_id`,`status`);