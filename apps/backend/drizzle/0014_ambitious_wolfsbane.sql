CREATE TABLE `project_ci_tokens` (
	`project_id` text PRIMARY KEY NOT NULL,
	`token_hash` text,
	`token_prefix` text,
	`created_at` text,
	`last_used_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
