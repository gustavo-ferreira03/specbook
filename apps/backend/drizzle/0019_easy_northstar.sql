ALTER TABLE `project_ci_tokens` ADD `request_window_started_at` text;--> statement-breakpoint
ALTER TABLE `project_ci_tokens` ADD `request_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `ci_allowed_origins` text DEFAULT '[]' NOT NULL;