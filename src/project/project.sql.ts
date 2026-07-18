import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../storage/schema.sql"
import type { ProjectID } from "./schema"
import type { SessionID, MessageID } from "@/session/schema"

export const ProjectTable = sqliteTable("project", {
  id: text().$type<ProjectID>().primaryKey(),
  worktree: text().notNull(),
  name: text(),
  ...Timestamps,
  time_initialized: integer(),
})

export const ProjectSummaryRecordTable = sqliteTable(
  "project_summary_record",
  {
    id: text().primaryKey(),
    project_directory: text().notNull(),
    session_id: text().$type<SessionID>().notNull(),
    status: text().notNull(),
    kind: text().notNull(),
    source: text().notNull(),
    is_current_baseline: integer({ mode: "boolean" }).notNull().default(false),
    report_path: text(),
    report_link_path: text(),
    graph_version: text(),
    ...Timestamps,
  },
  (table) => [
    index("project_summary_record_project_idx").on(table.project_directory),
    index("project_summary_record_session_idx").on(table.session_id),
    index("project_summary_record_current_idx").on(table.project_directory, table.is_current_baseline),
  ],
)

export const ProjectQuestionRecordTable = sqliteTable(
  "project_question_record",
  {
    id: text().primaryKey(),
    project_directory: text().notNull(),
    session_id: text().$type<SessionID>().notNull(),
    baseline_summary_id: text(),
    baseline_session_id: text().$type<SessionID>().notNull(),
    mode: text().notNull(),
    parent_question_id: text(),
    user_message_id: text(),
    assistant_message_id: text().$type<MessageID>(),
    ...Timestamps,
  },
  (table) => [
    index("project_question_record_project_idx").on(table.project_directory),
    index("project_question_record_session_idx").on(table.session_id),
    index("project_question_record_baseline_idx").on(table.project_directory, table.baseline_session_id),
  ],
)
