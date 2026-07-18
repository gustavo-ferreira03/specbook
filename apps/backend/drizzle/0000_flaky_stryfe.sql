CREATE TABLE `app_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`llm` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `chats` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`context_revision_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `features` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`parent_id` text,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`path` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `project_context_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`source_chat_id` text,
	`status` text NOT NULL,
	`brief` text NOT NULL,
	`context` text NOT NULL,
	`actions_used` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`confirmed_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`base_url` text NOT NULL,
	`git_remote_url` text,
	`git_token` text,
	`git_push_error` text,
	`git_conflict_paths` text,
	`context_sync_error` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`spec_id` text NOT NULL,
	`commit_sha` text NOT NULL,
	`robot_hash` text NOT NULL,
	`status` text NOT NULL,
	`started_at` text NOT NULL,
	`duration_ms` integer,
	`fail_reason` text,
	FOREIGN KEY (`spec_id`) REFERENCES `specs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `specs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`feature_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'unverified' NOT NULL,
	`path` text NOT NULL,
	`robot_hash` text NOT NULL,
	`invalid_reason` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`feature_id`) REFERENCES `features`(`id`) ON UPDATE no action ON DELETE no action
);
