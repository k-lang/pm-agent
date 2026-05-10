import fs from "fs/promises"
import path from "path"
import { ulid } from "ulid"
import z from "zod"
import { and, asc, Database, desc, eq } from "@/storage/db"
import { fn } from "@/util/fn"
import { ProjectQuestionRecordTable, ProjectSummaryRecordTable } from "./project.sql"
import { Session } from "@/session"
import { MessageV2 } from "@/session/message-v2"
import { SessionPrompt } from "@/session/prompt"
import { Instance } from "./instance"
import { MessageID, SessionID } from "@/session/schema"
import { NamedError } from "@/util/error"

export namespace ProjectDetail {
  export const SummaryStatus = z.enum(["pending", "running", "completed", "failed"])
  export const SummarySource = z.enum(["auto", "manual"])
  export const QuestionMode = z.enum(["question", "followup"])

  export const SummaryRecord = z.object({
    id: z.string(),
    projectDirectory: z.string(),
    sessionID: SessionID.zod,
    status: SummaryStatus,
    kind: z.literal("summary"),
    source: SummarySource,
    isCurrentBaseline: z.boolean(),
    summaryText: z.string().optional(),
    reportPath: z.string().optional(),
    reportLinkPath: z.string().optional(),
    time: z.object({
      created: z.number(),
      updated: z.number(),
    }),
  })
  export type SummaryRecord = z.infer<typeof SummaryRecord>

  export const QuestionRecord = z.object({
    id: z.string(),
    projectDirectory: z.string(),
    sessionID: SessionID.zod,
    baselineSummaryID: z.string().optional(),
    baselineSessionID: SessionID.zod,
    derivedFromBaselineSessionID: SessionID.zod,
    mode: QuestionMode,
    parentQuestionID: z.string().optional(),
    userMessageID: MessageID.zod.optional(),
    assistantMessageID: MessageID.zod.optional(),
    previewText: z.string().optional(),
    time: z.object({
      created: z.number(),
      updated: z.number(),
    }),
  })
  export type QuestionRecord = z.infer<typeof QuestionRecord>

  export const Detail = z.object({
    directory: z.string(),
    baselineSessionID: SessionID.zod.optional(),
    summarySessionID: SessionID.zod.optional(),
    currentSummary: SummaryRecord.optional(),
    summaries: SummaryRecord.array(),
    questions: QuestionRecord.array(),
  })
  export type Detail = z.infer<typeof Detail>

  const SUMMARY_REQUEST_TEXT = "请介绍一下当前项目情况，并生成一份项目总结报告。"
  const CURRENT_REPORT_LINK_NAME = "current_final_report.md"

  function reportRoot(directory: string) {
    return path.join(directory, "report_output")
  }

  function currentReportLinkPath(directory: string) {
    return path.join(reportRoot(directory), CURRENT_REPORT_LINK_NAME)
  }

  async function findLatestReportPath(directory: string) {
    const root = reportRoot(directory)
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
    const dirs = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse()

    for (const name of dirs) {
      const finalReport = path.join(root, name, "final_report.md")
      const exists = await fs.stat(finalReport).then(() => true).catch(() => false)
      if (exists) return finalReport
    }
    return undefined
  }

  async function readCurrentReport(directory: string, preferredPath?: string, allowLatestFallback = true) {
    const linkPath = currentReportLinkPath(directory)
    const candidates = [
      preferredPath,
      await fs.readlink(linkPath).then((linked) => path.resolve(path.dirname(linkPath), linked)).catch(() => undefined),
      allowLatestFallback ? await findLatestReportPath(directory) : undefined,
    ].filter((value): value is string => !!value)

    for (const resolved of candidates) {
      const summaryText = await fs.readFile(resolved, "utf8").catch(() => undefined)
      if (summaryText === undefined) continue
      return {
        reportPath: resolved,
        reportLinkPath: linkPath,
        summaryText,
      }
    }

    return { reportPath: undefined, reportLinkPath: undefined, summaryText: undefined }
  }

  const LatestRunFile = z.object({
    status: z.literal("completed"),
    reportPath: z.string().min(1),
    runDir: z.string().min(1),
  })

  function latestRunPath(directory: string) {
    return path.join(reportRoot(directory), "latest_run.json")
  }

  async function clearLatestRunFile(directory: string) {
    await fs.rm(latestRunPath(directory), { force: true }).catch(() => undefined)
  }

  async function readLatestRunFile(directory: string) {
    const markerPath = latestRunPath(directory)
    const raw = await fs.readFile(markerPath, "utf8").catch(() => undefined)
    if (!raw) return undefined
    const parsed = LatestRunFile.safeParse(JSON.parse(raw))
    if (!parsed.success) return undefined
    const reportPath = path.resolve(directory, parsed.data.reportPath)
    const exists = await fs.stat(reportPath).then(() => true).catch(() => false)
    if (!exists) return undefined
    return {
      markerPath,
      reportPath,
      runDir: path.resolve(directory, parsed.data.runDir),
    }
  }

  async function pointCurrentReportLink(directory: string, reportPath: string) {
    const linkPath = currentReportLinkPath(directory)
    await fs.mkdir(path.dirname(linkPath), { recursive: true })
    await fs.rm(linkPath, { force: true })
    const relative = path.relative(path.dirname(linkPath), reportPath)
    await fs.symlink(relative, linkPath)
    return linkPath
  }

  function summaryFromRow(row: typeof ProjectSummaryRecordTable.$inferSelect): SummaryRecord {
    return {
      id: row.id,
      projectDirectory: row.project_directory,
      sessionID: row.session_id,
      status: SummaryStatus.parse(row.status),
      kind: "summary",
      source: SummarySource.parse(row.source),
      isCurrentBaseline: !!row.is_current_baseline,
      summaryText: row.summary_text ?? undefined,
      reportPath: row.report_path ?? undefined,
      reportLinkPath: row.report_link_path ?? undefined,
      time: {
        created: row.time_created,
        updated: row.time_updated,
      },
    }
  }

  function visibleUserText(message: MessageV2.WithParts) {
    return message.parts
      .filter((part) => part.type === "text" && !part.synthetic && !part.ignored)
      .map((part) => part.text)
      .join("")
      .trim()
  }

  async function questionPreviewText(row: typeof ProjectQuestionRecordTable.$inferSelect) {
    if (!row.user_message_id) return undefined
    try {
      const message = await MessageV2.get({
        sessionID: row.session_id,
        messageID: MessageID.make(row.user_message_id),
      })
      const preview = visibleUserText(message)
      return preview || undefined
    } catch {
      return undefined
    }
  }

  function questionFromRow(
    row: typeof ProjectQuestionRecordTable.$inferSelect,
    options?: { previewText?: string },
  ): QuestionRecord {
    return {
      id: row.id,
      projectDirectory: row.project_directory,
      sessionID: row.session_id,
      baselineSummaryID: row.baseline_summary_id ?? undefined,
      baselineSessionID: row.baseline_session_id,
      mode: QuestionMode.parse(row.mode),
      derivedFromBaselineSessionID: row.baseline_session_id,
      parentQuestionID: row.parent_question_id ?? undefined,
      userMessageID: row.user_message_id ? MessageID.make(row.user_message_id) : undefined,
      assistantMessageID: row.assistant_message_id ? MessageID.make(row.assistant_message_id) : undefined,
      previewText: options?.previewText,
      time: {
        created: row.time_created,
        updated: row.time_updated,
      },
    }
  }

  export const listSummaries = fn(z.object({ directory: z.string() }), async (input) => {
    const summaries = Database.use((db) =>
      db
        .select()
        .from(ProjectSummaryRecordTable)
        .where(eq(ProjectSummaryRecordTable.project_directory, input.directory))
        .orderBy(desc(ProjectSummaryRecordTable.time_created))
        .all()
        .map(summaryFromRow),
    )

    return Promise.all(summaries.map(async (summary) => {
      const source = await readCurrentReport(input.directory, summary.reportPath)
      return {
        ...summary,
        summaryText: source.reportPath === summary.reportPath ? source.summaryText ?? summary.summaryText : summary.summaryText,
        reportPath: source.reportPath === summary.reportPath ? source.reportPath ?? summary.reportPath : summary.reportPath,
        reportLinkPath: summary.isCurrentBaseline
          ? source.reportLinkPath ?? summary.reportLinkPath
          : summary.reportLinkPath,
      }
    }))
  })

  export const listQuestions = fn(z.object({ directory: z.string() }), async (input) => {
    const [rows, firstRows] = Database.use((db) => [
      db
        .select()
        .from(ProjectQuestionRecordTable)
        .where(eq(ProjectQuestionRecordTable.project_directory, input.directory))
        .orderBy(desc(ProjectQuestionRecordTable.time_created))
        .all(),
      db
        .select()
        .from(ProjectQuestionRecordTable)
        .where(eq(ProjectQuestionRecordTable.project_directory, input.directory))
        .orderBy(asc(ProjectQuestionRecordTable.time_created))
        .all(),
    ])

    const firstRowBySession = new Map<string, typeof ProjectQuestionRecordTable.$inferSelect>()
    for (const row of firstRows) {
      if (firstRowBySession.has(row.session_id)) continue
      firstRowBySession.set(row.session_id, row)
    }

    const previewBySession = new Map<string, string | undefined>()
    await Promise.all([...firstRowBySession.entries()].map(async ([sessionID, row]) => {
      previewBySession.set(sessionID, await questionPreviewText(row))
    }))

    return rows.map((row) =>
      questionFromRow(row, { previewText: previewBySession.get(row.session_id) }))
  })

  export const currentSummary = fn(z.object({ directory: z.string() }), async (input) => {
    const row = Database.use((db) =>
      db
        .select()
        .from(ProjectSummaryRecordTable)
        .where(
          and(
            eq(ProjectSummaryRecordTable.project_directory, input.directory),
            eq(ProjectSummaryRecordTable.is_current_baseline, true),
          ),
        )
        .orderBy(desc(ProjectSummaryRecordTable.time_created))
        .get(),
    )
    if (!row) return undefined
    const summary = summaryFromRow(row)
    const report = await readCurrentReport(input.directory, summary.reportPath, summary.status === "completed")
    return {
      ...summary,
      summaryText: report.summaryText ?? summary.summaryText,
      reportPath: report.reportPath ?? summary.reportPath,
      reportLinkPath: report.reportLinkPath ?? summary.reportLinkPath,
    }
  })

  export const getDetail = fn(z.object({ directory: z.string() }), async (input) => {
    const [summaries, questions, current] = await Promise.all([
      listSummaries({ directory: input.directory }),
      listQuestions({ directory: input.directory }),
      currentSummary({ directory: input.directory }),
    ])
    return {
      directory: input.directory,
      baselineSessionID: current?.sessionID,
      summarySessionID: current?.sessionID,
      currentSummary: current,
      summaries,
      questions,
    } satisfies Detail
  })

  export const runSummary = fn(
    z.object({
      directory: z.string(),
      source: SummarySource.default("manual"),
    }),
    async (input) => {
      const session = await Instance.provide({
        directory: input.directory,
        fn: () => Session.create({ title: "项目总结" }),
      })

      const now = Date.now()
      const recordID = ulid(now)
      const linkPath = currentReportLinkPath(input.directory)

      Database.transaction((db) => {
        db
          .update(ProjectSummaryRecordTable)
          .set({
            is_current_baseline: false,
            time_updated: now,
          })
          .where(eq(ProjectSummaryRecordTable.project_directory, input.directory))
          .run()

        db.insert(ProjectSummaryRecordTable).values({
          id: recordID,
          project_directory: input.directory,
          session_id: session.id,
          status: "running",
          kind: "summary",
          source: input.source,
          is_current_baseline: true,
          summary_text: null,
          report_path: null,
          report_link_path: linkPath,
          time_created: now,
          time_updated: now,
        }).run()
      })

      void (async () => {
        try {
          await clearLatestRunFile(input.directory)
          await Instance.provide({
            directory: input.directory,
            fn: () => SessionPrompt.prompt({
              sessionID: session.id,
              noReply: true,
              parts: [{ type: "text", text: SUMMARY_REQUEST_TEXT }],
            }),
          })
          await Instance.provide({
            directory: input.directory,
            fn: () => SessionPrompt.loop({ sessionID: session.id }),
          })

          const latestRun = await readLatestRunFile(input.directory)
          const resolvedReportPath = latestRun?.reportPath
          const reportLinkPath = resolvedReportPath ? await pointCurrentReportLink(input.directory, resolvedReportPath) : linkPath
          const report = await readCurrentReport(input.directory, resolvedReportPath)
          Database.use((db) =>
            db
              .update(ProjectSummaryRecordTable)
              .set({
                status: resolvedReportPath ? "completed" : "failed",
                summary_text: report.summaryText ?? null,
                report_path: resolvedReportPath ?? null,
                report_link_path: reportLinkPath ?? null,
                time_updated: Date.now(),
              })
              .where(eq(ProjectSummaryRecordTable.id, recordID))
              .run(),
          )
        } catch {
          Database.use((db) =>
            db
              .update(ProjectSummaryRecordTable)
              .set({
                status: "failed",
                time_updated: Date.now(),
              })
              .where(eq(ProjectSummaryRecordTable.id, recordID))
              .run(),
          )
        }
      })()

      return summaryFromRow({
        id: recordID,
        project_directory: input.directory,
        session_id: session.id,
        status: "running",
        kind: "summary",
        source: input.source,
        is_current_baseline: true,
        summary_text: null,
        report_path: null,
        report_link_path: linkPath,
        time_created: now,
        time_updated: now,
      })
    },
  )

  export const updateSummary = fn(
    z.object({
      id: z.string(),
      summaryText: z.string(),
    }),
    async (input) => {
      const row = Database.use((db) =>
        db.select().from(ProjectSummaryRecordTable).where(eq(ProjectSummaryRecordTable.id, input.id)).get(),
      )
      if (!row) throw new NamedError.Unknown({ message: `Summary not found: ${input.id}` })

      const reportPath = row.report_path ?? (await readCurrentReport(row.project_directory)).reportPath
      if (!reportPath) throw new NamedError.Unknown({ message: `Summary report file not found for: ${input.id}` })

      await fs.writeFile(reportPath, input.summaryText, "utf8")
      const updated = Database.use((db) =>
        db
          .update(ProjectSummaryRecordTable)
          .set({
            summary_text: input.summaryText,
            report_path: reportPath,
            report_link_path: row.report_link_path ?? currentReportLinkPath(row.project_directory),
            time_updated: Date.now(),
          })
          .where(eq(ProjectSummaryRecordTable.id, input.id))
          .returning()
          .get(),
      )
      if (!updated) throw new NamedError.Unknown({ message: `Summary not found after update: ${input.id}` })
      return summaryFromRow(updated)
    },
  )

  export const askQuestion = fn(
    z.object({
      directory: z.string(),
      text: z.string().min(1),
      mode: QuestionMode,
      questionID: z.string().optional(),
      questionSessionID: SessionID.zod.optional(),
    }),
    async (input) => {
      const baseline = await currentSummary({ directory: input.directory })
      if (!baseline) {
        throw new NamedError.Unknown({ message: `No baseline summary for project: ${input.directory}` })
      }

      let sessionID: SessionID
      let parentQuestionID: string | undefined

      if (input.mode === "followup") {
        sessionID = input.questionSessionID ?? (() => { throw new NamedError.Unknown({ message: "questionSessionID is required for followup" }) })()
        parentQuestionID = input.questionID
      } else {
        const forked = await Instance.provide({
          directory: input.directory,
          fn: () => Session.fork({ sessionID: baseline.sessionID }),
        })
        sessionID = forked.id
      }

      const userMessage = await Instance.provide({
        directory: input.directory,
        fn: () => SessionPrompt.prompt({
          sessionID,
          noReply: true,
          parts: [{ type: "text", text: input.text }],
        }),
      })

      const now = Date.now()
      const recordID = ulid(now)
      Database.use((db) =>
        db.insert(ProjectQuestionRecordTable).values({
          id: recordID,
          project_directory: input.directory,
          session_id: sessionID,
          baseline_summary_id: baseline.id,
          baseline_session_id: baseline.sessionID,
          mode: input.mode,
          parent_question_id: parentQuestionID ?? null,
          user_message_id: userMessage.info.id,
          assistant_message_id: null,
          time_created: now,
          time_updated: now,
        }).run(),
      )

      void (async () => {
        try {
          const assistant = await Instance.provide({
            directory: input.directory,
            fn: () => SessionPrompt.loop({ sessionID }),
          })
          Database.use((db) =>
            db
              .update(ProjectQuestionRecordTable)
              .set({
                assistant_message_id: assistant.info.id,
                time_updated: Date.now(),
              })
              .where(eq(ProjectQuestionRecordTable.id, recordID))
              .run(),
          )
        } catch {}
      })()

      const question = Database.use((db) =>
        db.select().from(ProjectQuestionRecordTable).where(eq(ProjectQuestionRecordTable.id, recordID)).get(),
      )
      if (!question) throw new NamedError.Unknown({ message: `Question not found after insert: ${recordID}` })
      return questionFromRow(question)
    },
  )
}
