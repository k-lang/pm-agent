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
import { Provider } from "@/provider/provider"
import { ProviderID } from "@/provider/schema"

export namespace ProjectDetail {
  export const SummaryStatus = z.enum(["pending", "running", "completed", "expired", "failed"])
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
    graphVersion: z.string().optional(),
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
    threadStartUserMessageID: MessageID.zod.optional(),
    time: z.object({
      created: z.number(),
      updated: z.number(),
    }),
  })
  export type QuestionRecord = z.infer<typeof QuestionRecord>

  export const Turn = z.object({
    userMessageID: MessageID.zod,
    questionText: z.string(),
    answerText: z.string(),
    errorText: z.string().optional(),
    details: MessageV2.Part.array(),
    running: z.boolean(),
  })
  export type Turn = z.infer<typeof Turn>

  export const SelectedThread = z.object({
    questionID: z.string(),
    sessionID: SessionID.zod,
    userMessageID: MessageID.zod.optional(),
    threadStartUserMessageID: MessageID.zod.optional(),
    turns: Turn.array(),
    running: z.boolean(),
  })
  export type SelectedThread = z.infer<typeof SelectedThread>

  export const Detail = z.object({
    directory: z.string(),
    baselineSessionID: SessionID.zod.optional(),
    summarySessionID: SessionID.zod.optional(),
    currentSummary: SummaryRecord.optional(),
    summaries: SummaryRecord.array(),
    questions: QuestionRecord.array(),
    selectedQuestionID: z.string().optional(),
    selectedThread: SelectedThread.optional(),
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

  const ApplyResultFile = z.object({
    appliedAt: z.string().optional(),
    change_id: z.string().optional(),
    success: z.boolean().optional(),
    snapshot: z.string().optional(),
    graphVersion: z.string().optional(),
  })

  async function readApplyResult(file: string) {
    const raw = await fs.readFile(file, "utf8").catch(() => undefined)
    if (!raw) return undefined
    try {
      const parsed = ApplyResultFile.safeParse(JSON.parse(raw))
      return parsed.success ? parsed.data : undefined
    } catch {
      return undefined
    }
  }

  async function publishedActiveGraphVersion(directory: string) {
    const result = await readApplyResult(path.join(directory, "workflows", "active", "apply_result.json"))
    const version = result?.snapshot || result?.change_id
    if (result?.success !== true || !result.graphVersion || !version) return undefined
    const [publishedGraph, latestGraph] = await Promise.all([
      fs.realpath(path.resolve(directory, result.graphVersion)).catch(() => undefined),
      fs.realpath(path.join(directory, "workflows", "latest_graph")).catch(() => undefined),
    ])
    return publishedGraph && publishedGraph === latestGraph ? version : undefined
  }

  export async function currentGraphVersion(directory: string) {
    const activeVersion = await publishedActiveGraphVersion(directory)
    if (activeVersion) return activeVersion

    const appliedRoot = path.join(directory, "workflows", "applied")
    const appliedEntries = await fs.readdir(appliedRoot, { withFileTypes: true }).catch(() => [])
    const appliedResults = await Promise.all(appliedEntries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const result = await readApplyResult(path.join(appliedRoot, entry.name, "apply_result.json"))
        if (!result || result.success === false) return undefined
        const version = result.snapshot || result.change_id
        if (!version) return undefined
        return {
          version,
          appliedAt: result.appliedAt ? Date.parse(result.appliedAt) || 0 : 0,
        }
      }))
    const latestApplied = appliedResults
      .filter((value): value is { version: string; appliedAt: number } => !!value)
      .sort((a, b) => b.appliedAt - a.appliedAt)[0]
    if (latestApplied) return latestApplied.version
    return undefined
  }

  async function withComputedSummaryStatus(directory: string, summary: SummaryRecord): Promise<SummaryRecord> {
    if (summary.status !== "completed") return summary
    const currentVersion = await currentGraphVersion(directory)
    if (summary.graphVersion !== currentVersion) {
      return { ...summary, status: "expired" }
    }
    return summary
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
      graphVersion: row.graph_version ?? undefined,
      time: {
        created: row.time_created,
        updated: row.time_updated,
      },
    }
  }

  function visibleUserText(message: MessageV2.WithParts) {
    return message.parts.reduce((result, part) => {
      if (part.type !== "text" || part.synthetic || part.ignored) return result
      return result + part.text
    }, "").trim()
  }

  function hasVisibleUserText(message: MessageV2.WithParts) {
    return message.parts.some((part) => part.type === "text" && !part.synthetic && !part.ignored && part.text.trim())
  }

  function assistantReplies(messages: MessageV2.WithParts[], userMessageID: MessageID) {
    return messages.filter((item) => item.info.role === "assistant" && item.info.parentID === userMessageID)
  }

  function isQuestionRunning(messages: MessageV2.WithParts[], userMessageID: MessageID) {
    const assistants = assistantReplies(messages, userMessageID)
    if (!assistants.length) return true
    return assistants.some((assistant) => assistant.info.role === "assistant" && !assistant.info.time.completed)
  }

  function isHiddenAssistantPart(part: MessageV2.Part) {
    return part.type === "step-start" || part.type === "step-finish" || part.type === "compaction" || part.type === "retry" || part.type === "subtask"
  }

  function messageErrorText(error: unknown): string | undefined {
    if (!error) return undefined
    if (typeof error === "string") return error
    if (typeof error !== "object") return String(error)
    const record = error as Record<string, any>
    const data = typeof record.data === "object" && record.data ? record.data as Record<string, any> : undefined
    return data?.message ?? record.message ?? record.code ?? record.name ?? "error"
  }

  async function buildTurns(question: QuestionRecord, runningUserMessageID?: MessageID): Promise<Turn[]> {
    const messages = await Session.messages({ sessionID: question.sessionID })
    const startIndex = question.threadStartUserMessageID
      ? messages.findIndex((message) => message.info.id === question.threadStartUserMessageID)
      : -1
    const visibleMessages = startIndex > -1 ? messages.slice(startIndex) : messages
    const filtered = visibleMessages.filter((message) => {
      if (message.info.role === "user" && !hasVisibleUserText(message)) return false
      return true
    })

    const turns: Turn[] = []
    for (const message of filtered) {
      if (message.info.role !== "user") continue
      const questionText = visibleUserText(message)
      if (!questionText) continue

      const assistants = assistantReplies(filtered, message.info.id)
      const answerParts = assistants.flatMap((assistant) => assistant.parts || [])
      const errorText = assistants
        .map((assistant) => assistant.info.role === "assistant" ? messageErrorText(assistant.info.error) : undefined)
        .find(Boolean)
      const answerText = answerParts.reduce((result, part) => {
        if (part.type !== "text" || part.synthetic || part.ignored) return result
        return result + part.text
      }, "").trim()
      const details = answerParts.filter((part) => part.type !== "text" && !isHiddenAssistantPart(part))
      const running = runningUserMessageID === message.info.id && isQuestionRunning(filtered, message.info.id)

      if (!answerText && !errorText && !details.length && !running) continue

      turns.push({
        userMessageID: message.info.id,
        questionText,
        answerText,
        errorText,
        details,
        running,
      })
    }
    return turns
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
    options?: { previewText?: string; threadStartUserMessageID?: MessageID },
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
      threadStartUserMessageID: options?.threadStartUserMessageID,
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
      return withComputedSummaryStatus(input.directory, {
        ...summary,
        summaryText: source.reportPath === summary.reportPath ? source.summaryText ?? summary.summaryText : summary.summaryText,
        reportPath: source.reportPath === summary.reportPath ? source.reportPath ?? summary.reportPath : summary.reportPath,
        reportLinkPath: summary.isCurrentBaseline
          ? source.reportLinkPath ?? summary.reportLinkPath
          : summary.reportLinkPath,
      })
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
    const threadStartUserMessageIDBySession = new Map<string, MessageID | undefined>()
    await Promise.all([...firstRowBySession.entries()].map(async ([sessionID, row]) => {
      previewBySession.set(sessionID, await questionPreviewText(row))
      threadStartUserMessageIDBySession.set(
        sessionID,
        row.user_message_id ? MessageID.make(row.user_message_id) : undefined,
      )
    }))

    return rows.map((row) =>
      questionFromRow(row, {
        previewText: previewBySession.get(row.session_id),
        threadStartUserMessageID: threadStartUserMessageIDBySession.get(row.session_id),
      }))
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
    return withComputedSummaryStatus(input.directory, {
      ...summary,
      summaryText: report.summaryText ?? summary.summaryText,
      reportPath: report.reportPath ?? summary.reportPath,
      reportLinkPath: report.reportLinkPath ?? summary.reportLinkPath,
    })
  })

  async function selectedThread(questions: QuestionRecord[], selectedQuestionID?: string) {
    if (!questions.length) return undefined
    const selected = questions.find((question) => question.id === selectedQuestionID) ?? questions[0]
    if (!selected) return undefined
    const latestInSession = questions.find((question) => question.sessionID === selected.sessionID)
    const turns = await buildTurns(selected, latestInSession?.userMessageID)
    return {
      questionID: selected.id,
      sessionID: selected.sessionID,
      userMessageID: latestInSession?.userMessageID,
      threadStartUserMessageID: selected.threadStartUserMessageID,
      turns,
      running: turns.some((turn) => turn.running),
    } satisfies SelectedThread
  }

  export const getDetail = fn(z.object({ directory: z.string(), selectedQuestionID: z.string().optional() }), async (input) => {
    const [summaries, questions, current] = await Promise.all([
      listSummaries({ directory: input.directory }),
      listQuestions({ directory: input.directory }),
      currentSummary({ directory: input.directory }),
    ])
    const selected = await selectedThread(questions, input.selectedQuestionID)
    return {
      directory: input.directory,
      baselineSessionID: current?.sessionID,
      summarySessionID: current?.sessionID,
      currentSummary: current,
      summaries,
      questions,
      selectedQuestionID: selected?.questionID,
      selectedThread: selected,
    } satisfies Detail
  })

  export const runSummary = fn(
    z.object({
      directory: z.string(),
      source: SummarySource.default("manual"),
    }),
    async (input) => {
      const graphVersion = await currentGraphVersion(input.directory)
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
          graph_version: graphVersion ?? null,
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
                graph_version: graphVersion ?? null,
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
        graph_version: graphVersion ?? null,
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

  export const AskQuestionResult = z.object({
    question: QuestionRecord,
    detail: Detail,
  })
  export type AskQuestionResult = z.infer<typeof AskQuestionResult>

  function errorFromUnknown(error: unknown, providerID: string): NonNullable<MessageV2.Assistant["error"]> {
    if (Provider.ModelNotFoundError.isInstance(error)) {
      const hint = error.data.suggestions?.length ? ` Did you mean: ${error.data.suggestions.join(", ")}?` : ""
      return new NamedError.Unknown({
        message: `Model not found: ${error.data.providerID}/${error.data.modelID}.${hint}`,
      }).toObject()
    }
    return MessageV2.fromError(error, { providerID: ProviderID.make(providerID) })
  }

  async function persistQuestionFailure(input: {
    directory: string
    recordID: string
    sessionID: SessionID
    userMessage: MessageV2.User
    error: unknown
  }) {
    const now = Date.now()
    const assistant = await Instance.provide({
      directory: input.directory,
      fn: () => Session.updateMessage({
        id: MessageID.ascending(),
        parentID: input.userMessage.id,
        role: "assistant",
        mode: input.userMessage.agent,
        agent: input.userMessage.agent,
        variant: input.userMessage.variant,
        path: {
          cwd: Instance.directory,
          root: Instance.worktree,
        },
        cost: 0,
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        modelID: input.userMessage.model.modelID,
        providerID: input.userMessage.model.providerID,
        error: errorFromUnknown(input.error, input.userMessage.model.providerID),
        time: {
          created: now,
          completed: now,
        },
        sessionID: input.sessionID,
      }),
    }) as MessageV2.Assistant

    Database.use((db) =>
      db
        .update(ProjectQuestionRecordTable)
        .set({
          assistant_message_id: assistant.id,
          time_updated: now,
        })
        .where(eq(ProjectQuestionRecordTable.id, input.recordID))
        .run(),
    )
  }

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
      if (baseline.status !== "completed") {
        throw new NamedError.Unknown({ message: `Project summary is ${baseline.status}; regenerate the project summary before asking questions.` })
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
        } catch (error) {
          await persistQuestionFailure({
            directory: input.directory,
            recordID,
            sessionID,
            userMessage: userMessage.info as MessageV2.User,
            error,
          }).catch(() => {})
        }
      })()

      const question = Database.use((db) =>
        db.select().from(ProjectQuestionRecordTable).where(eq(ProjectQuestionRecordTable.id, recordID)).get(),
      )
      if (!question) throw new NamedError.Unknown({ message: `Question not found after insert: ${recordID}` })
      const questionRecord = questionFromRow(question, {
        previewText: input.mode === "question" ? input.text : undefined,
        threadStartUserMessageID: input.mode === "question" ? userMessage.info.id : undefined,
      })
      return {
        question: questionRecord,
        detail: await getDetail({
          directory: input.directory,
          selectedQuestionID: input.mode === "question" ? questionRecord.id : input.questionID,
        }),
      } satisfies AskQuestionResult
    },
  )
}
