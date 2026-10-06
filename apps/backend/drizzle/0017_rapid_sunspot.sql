ALTER TABLE `steward_intents` ADD `source` text DEFAULT 'event' NOT NULL;--> statement-breakpoint
ALTER TABLE `project_stewards` DROP COLUMN `last_planner_at`;--> statement-breakpoint
UPDATE `steward_intents` SET `source` = 'user'
WHERE `key` LIKE 'chat:%' OR `key` LIKE 'regression:%' OR `key` LIKE 'manual-task:%'
    OR EXISTS (SELECT 1 FROM `jobs` WHERE (`jobs`.`id` = `steward_intents`.`job_id` OR `jobs`.`id` = `steward_intents`.`id`) AND `jobs`.`trigger` IN ('manual', 'chat'));--> statement-breakpoint
WITH RECURSIVE `requested` (`id`) AS (
    SELECT `id` FROM `steward_intents` WHERE `source` = 'user'
    UNION
    SELECT `child`.`id` FROM `steward_intents` AS `child` JOIN `requested` AS `parent`
        ON `child`.`key` LIKE 'resume-run:' || `parent`.`id` || ':%'
)
UPDATE `steward_intents` SET `source` = 'user' WHERE `id` IN (SELECT `id` FROM `requested`);--> statement-breakpoint
INSERT INTO `job_actions` (`job_id`, `action`, `detail`, `created_at`)
SELECT `id`, 'retired', 'Automatic planning and unsolicited exploration were removed. Existing findings and proposals remain available.', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM `jobs` WHERE `status` IN ('queued', 'running', 'paused', 'blocked', 'stalled') AND (
    `kind` = 'planner' OR (`kind` IN ('coverage', 'explore') AND `trigger` NOT IN ('manual', 'chat')
        AND NOT EXISTS (SELECT 1 FROM `steward_intents` WHERE (`job_id` = `jobs`.`id` OR `steward_intents`.`id` = `jobs`.`id`) AND `source` = 'user'))
);--> statement-breakpoint
UPDATE `inbox_items` SET `status` = 'dismissed', `payload` = json_set(`payload`, '$.retiredByScope', json('true')),
    `updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE `kind` = 'question' AND `status` IN ('pending', 'applying') AND `job_id` IN (
    SELECT `id` FROM `jobs` WHERE `kind` = 'planner' OR (`kind` IN ('coverage', 'explore') AND `trigger` NOT IN ('manual', 'chat')
        AND NOT EXISTS (SELECT 1 FROM `steward_intents` WHERE (`job_id` = `jobs`.`id` OR `steward_intents`.`id` = `jobs`.`id`) AND `source` = 'user'))
);--> statement-breakpoint
UPDATE `jobs` SET `status` = 'cancelled', `retry_at` = NULL,
    `stop_reason` = 'Automatic planning and unsolicited exploration were removed.', `updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE `status` IN ('queued', 'running', 'paused', 'blocked', 'stalled') AND (
    `kind` = 'planner' OR (`kind` IN ('coverage', 'explore') AND `trigger` NOT IN ('manual', 'chat')
        AND NOT EXISTS (SELECT 1 FROM `steward_intents` WHERE (`job_id` = `jobs`.`id` OR `steward_intents`.`id` = `jobs`.`id`) AND `source` = 'user'))
);--> statement-breakpoint
UPDATE `steward_intents` SET `status` = 'ignored', `reason` = 'Automatic planning and unsolicited exploration were removed.',
    `updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE `status` IN ('pending', 'running') AND (json_extract(`intent`, '$.kind') = 'planner'
    OR (json_extract(`intent`, '$.kind') IN ('coverage', 'explore') AND `source` = 'event'));
