CREATE TABLE `project_summary_record` (
	`id` text PRIMARY KEY,
	`project_directory` text NOT NULL,
	`session_id` text NOT NULL,
	`status` text NOT NULL,
	`kind` text NOT NULL,
	`source` text NOT NULL,
	`is_current_baseline` integer DEFAULT false NOT NULL,
	`summary_text` text,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `project_question_record` (
	`id` text PRIMARY KEY,
	`project_directory` text NOT NULL,
	`session_id` text NOT NULL,
	`baseline_summary_id` text,
	`baseline_session_id` text NOT NULL,
	`mode` text NOT NULL,
	`parent_question_id` text,
	`user_message_id` text,
	`assistant_message_id` text,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `project_summary_record_project_idx` ON `project_summary_record` (`project_directory`);
--> statement-breakpoint
CREATE INDEX `project_summary_record_session_idx` ON `project_summary_record` (`session_id`);
--> statement-breakpoint
CREATE INDEX `project_summary_record_current_idx` ON `project_summary_record` (`project_directory`, `is_current_baseline`);
--> statement-breakpoint
CREATE INDEX `project_question_record_project_idx` ON `project_question_record` (`project_directory`);
--> statement-breakpoint
CREATE INDEX `project_question_record_session_idx` ON `project_question_record` (`session_id`);
--> statement-breakpoint
CREATE INDEX `project_question_record_baseline_idx` ON `project_question_record` (`project_directory`, `baseline_session_id`);
