ALTER TABLE `jobs` RENAME COLUMN "budget" TO "limits";--> statement-breakpoint
ALTER TABLE `jobs` ADD `stop_reason` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `safety_retries` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` DROP COLUMN `daily_usage`;--> statement-breakpoint
ALTER TABLE `app_settings` ADD `agent_paused` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `project_stewards` ADD `paused` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `project_stewards` DROP COLUMN `extra_usage`;--> statement-breakpoint
UPDATE `jobs` SET `limits` = json_object('maxActions', `actions_used` + 500, 'wallTimeMs', `elapsed_ms` + 3600000);--> statement-breakpoint
UPDATE `jobs` SET `status` = 'stalled',
    `stop_reason` = 'The previous investigation did not finish. Specbook will retry with a different approach.',
    `retry_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+1 minute')
WHERE `status` = 'budget_exceeded';
