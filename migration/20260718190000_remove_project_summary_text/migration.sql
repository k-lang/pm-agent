CREATE TABLE `__new_project_summary_record` (
	`id` text PRIMARY KEY,
	`project_directory` text NOT NULL,
	`session_id` text NOT NULL,
	`status` text NOT NULL,
	`kind` text NOT NULL,
	`source` text NOT NULL,
	`is_current_baseline` integer DEFAULT false NOT NULL,
	`report_path` text,
	`report_link_path` text,
	`graph_version` text,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_project_summary_record` (
	`id`,
	`project_directory`,
	`session_id`,
	`status`,
	`kind`,
	`source`,
	`is_current_baseline`,
	`report_path`,
	`report_link_path`,
	`graph_version`,
	`time_created`,
	`time_updated`
)
SELECT
	`id`,
	`project_directory`,
	`session_id`,
	`status`,
	`kind`,
	`source`,
	`is_current_baseline`,
	`report_path`,
	`report_link_path`,
	`graph_version`,
	`time_created`,
	`time_updated`
FROM `project_summary_record`;
--> statement-breakpoint
DROP TABLE `project_summary_record`;
--> statement-breakpoint
ALTER TABLE `__new_project_summary_record` RENAME TO `project_summary_record`;
--> statement-breakpoint
CREATE INDEX `project_summary_record_project_idx` ON `project_summary_record` (`project_directory`);
--> statement-breakpoint
CREATE INDEX `project_summary_record_session_idx` ON `project_summary_record` (`session_id`);
--> statement-breakpoint
CREATE INDEX `project_summary_record_current_idx` ON `project_summary_record` (`project_directory`, `is_current_baseline`);
