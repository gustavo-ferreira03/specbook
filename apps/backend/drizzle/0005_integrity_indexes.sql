-- The column was removed from the schema (and from the 0004 snapshot) without a
-- matching statement, so databases created from 0000 still carry it.
ALTER TABLE `project_context_revisions` DROP COLUMN `actions_used`;--> statement-breakpoint
-- Merge duplicate (project_id, path) rows into the oldest one before the unique
-- indexes are created. Runs and child rows are re-pointed, never dropped.
UPDATE `runs` SET `spec_id` = COALESCE((SELECT k.`id` FROM `specs` d JOIN `specs` k ON k.`project_id` = d.`project_id` AND k.`path` = d.`path` WHERE d.`id` = `runs`.`spec_id` ORDER BY k.`created_at`, k.`id` LIMIT 1), `spec_id`);--> statement-breakpoint
DELETE FROM `specs` WHERE EXISTS (SELECT 1 FROM `specs` k WHERE k.`project_id` = `specs`.`project_id` AND k.`path` = `specs`.`path` AND (k.`created_at` < `specs`.`created_at` OR (k.`created_at` = `specs`.`created_at` AND k.`id` < `specs`.`id`)));--> statement-breakpoint
UPDATE `specs` SET `feature_id` = COALESCE((SELECT k.`id` FROM `features` d JOIN `features` k ON k.`project_id` = d.`project_id` AND k.`path` = d.`path` WHERE d.`id` = `specs`.`feature_id` ORDER BY k.`created_at`, k.`id` LIMIT 1), `feature_id`);--> statement-breakpoint
UPDATE `features` SET `parent_id` = COALESCE((SELECT k.`id` FROM `features` d JOIN `features` k ON k.`project_id` = d.`project_id` AND k.`path` = d.`path` WHERE d.`id` = `features`.`parent_id` ORDER BY k.`created_at`, k.`id` LIMIT 1), `parent_id`) WHERE `parent_id` IS NOT NULL;--> statement-breakpoint
DELETE FROM `features` WHERE EXISTS (SELECT 1 FROM `features` k WHERE k.`project_id` = `features`.`project_id` AND k.`path` = `features`.`path` AND (k.`created_at` < `features`.`created_at` OR (k.`created_at` = `features`.`created_at` AND k.`id` < `features`.`id`)));--> statement-breakpoint
CREATE UNIQUE INDEX `features_project_path_unique` ON `features` (`project_id`,`path`);--> statement-breakpoint
CREATE INDEX `runs_spec_started_idx` ON `runs` (`spec_id`,`started_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `specs_project_path_unique` ON `specs` (`project_id`,`path`);
