CREATE TABLE `spec_environment_states` (
	`spec_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`source_hash` text NOT NULL,
	`markdown_hash` text NOT NULL,
	`status` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`spec_id`) REFERENCES `specs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `spec_environment_states_spec_environment_idx` ON `spec_environment_states` (`spec_id`,`environment_id`);--> statement-breakpoint
ALTER TABLE `runs` ADD `awaiting_deploy` integer DEFAULT false NOT NULL;