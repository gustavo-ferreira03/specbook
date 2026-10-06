CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_id` text,
	`actor_name` text NOT NULL,
	`actor_kind` text NOT NULL,
	`action` text NOT NULL,
	`project_id` text,
	`details` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_created` ON `audit_events` (`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `audit_project` ON `audit_events` (`project_id`);--> statement-breakpoint
CREATE TABLE `oidc_identities` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`issuer` text NOT NULL,
	`subject` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oidc_issuer_subject` ON `oidc_identities` (`issuer`,`subject`);--> statement-breakpoint
CREATE INDEX `oidc_user` ON `oidc_identities` (`user_id`);--> statement-breakpoint
CREATE TABLE `oidc_states` (
	`state_hash` text PRIMARY KEY NOT NULL,
	`browser_hash` text NOT NULL,
	`pkce_verifier` text NOT NULL,
	`nonce` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`issuer` text NOT NULL,
	`client_id` text NOT NULL,
	`link_user_id` text,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`link_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `user_invites` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`email` text NOT NULL,
	`role` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`consumed_at` text,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_invites_token_hash_unique` ON `user_invites` (`token_hash`);--> statement-breakpoint
CREATE TABLE `user_sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `user_sessions_user` ON `user_sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `user_sessions_expiry` ON `user_sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`password_hash` text,
	`role` text NOT NULL,
	`disabled_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
ALTER TABLE `app_settings` ADD `sso` text;--> statement-breakpoint
ALTER TABLE `app_settings` ADD `retention` text;--> statement-breakpoint
ALTER TABLE `app_settings` ADD `retention_last_cleanup` text;--> statement-breakpoint
ALTER TABLE `app_settings` ADD `security` text;