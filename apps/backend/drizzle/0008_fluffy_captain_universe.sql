ALTER TABLE `jobs` ADD `kind` text DEFAULT 'review' NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` ADD `spec_id` text;