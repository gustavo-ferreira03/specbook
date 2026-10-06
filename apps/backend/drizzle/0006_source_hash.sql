-- spec.robot was replaced by spec.ts: the hash covers the Spec's executable source.
ALTER TABLE `specs` RENAME COLUMN `robot_hash` TO `source_hash`;--> statement-breakpoint
ALTER TABLE `runs` RENAME COLUMN `robot_hash` TO `source_hash`;
