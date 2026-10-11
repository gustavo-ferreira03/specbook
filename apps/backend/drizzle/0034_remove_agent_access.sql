DROP TABLE `project_agent_tokens`;--> statement-breakpoint
ALTER TABLE `chats` DROP COLUMN `source`;--> statement-breakpoint
ALTER TABLE `chats` DROP COLUMN `source_client`;--> statement-breakpoint
ALTER TABLE `projects` DROP COLUMN `agent_contract_policy`;--> statement-breakpoint
ALTER TABLE `projects` DROP COLUMN `agents_may_provide_credentials`;