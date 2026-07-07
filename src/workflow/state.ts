import fs from "fs/promises"
import path from "path"
import { ulid } from "ulid"
import z from "zod"
import { projectGraphRoot } from "@/project/root"

export namespace ProjectWorkflow {
  export const Stage = z.enum([
    "收集材料",
    "笔记已生成",
    "笔记需补充",
    "图操作已生成",
    "图操作需修订",
    "应用中",
    "已应用",
    "已取消",
  ])
  export type Stage = z.infer<typeof Stage>

  export const Action = z.enum([
    "开始或恢复",
    "放弃草案",
    "追加消息",
    "登记资源",
    "更新工作笔记",
    "同步工作笔记变更",
    "检查笔记充分性",
    "生成图操作草案",
    "校验图操作",
    "提出修订意见",
    "应用图操作",
  ])
  export type Action = z.infer<typeof Action>

  export const BaselineStatus = z.enum(["missing", "running", "completed", "failed", "stale"])
  export type BaselineStatus = z.infer<typeof BaselineStatus>

  const ArtifactPaths = z.object({
    messages: z.string().default("messages.jsonl"),
    resources: z.string().default("resources.json"),
    note: z.string().default("note.md"),
    noteReview: z.string().default("note_review.json"),
    operationNotes: z.string().default("operation_notes.md"),
    changelogEntry: z.string().default("changelog_entry.txt"),
    operationsDraft: z.string().default("operations.draft.json"),
    operations: z.string().default("operations.json"),
    operationIndex: z.string().default("operation_index.json"),
    validation: z.string().default("validation.json"),
    preview: z.string().default("preview.json"),
    previewGraph: z.string().default("preview_graph"),
  })

  export const State = z.object({
    id: z.string(),
    project: z.string(),
    stage: Stage,
    sessionID: z.string().optional(),
    sessionStartedAt: z.number().optional(),
    warmupSessionID: z.string().optional(),
    warmupStatus: BaselineStatus.optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
    base: z.object({
      snapshotId: z.string().optional(),
      graphHash: z.string().optional(),
    }).default({}),
    artifacts: ArtifactPaths.default({
      messages: "messages.jsonl",
      resources: "resources.json",
      note: "note.md",
      noteReview: "note_review.json",
      operationNotes: "operation_notes.md",
      changelogEntry: "changelog_entry.txt",
      operationsDraft: "operations.draft.json",
      operations: "operations.json",
      operationIndex: "operation_index.json",
      validation: "validation.json",
      preview: "preview.json",
      previewGraph: "preview_graph",
    }),
    lastAction: Action.optional(),
    pendingConfirmation: z.object({
      action: Action,
      message: z.string(),
    }).optional(),
  }).strict()
  export type State = z.infer<typeof State>

  export const ActionRequest = z.object({
    project: z.string(),
    action: Action,
    payload: z.record(z.string(), z.unknown()).default({}),
  })
  export type ActionRequest = z.infer<typeof ActionRequest>

  export const ActionResult = z.object({
    ok: z.boolean(),
    message: z.string(),
    project: z.string(),
    workflowID: z.string().optional(),
    stage: Stage.optional(),
    availableActions: z.array(z.object({
      action: Action,
      reason: z.string(),
      requiresUserConfirmation: z.boolean().optional(),
    })),
    blockedActions: z.array(z.object({
      action: Action,
      reason: z.string(),
    })),
    recommendations: z.array(z.string()),
    allowedActions: z.array(Action).optional(),
    state: State.optional(),
    data: z.record(z.string(), z.unknown()).optional(),
  })
  export type ActionResult = z.infer<typeof ActionResult>

  export const ActiveArtifactSnapshot = z.object({
    note: z.string().optional(),
    resources: z.string().optional(),
  })
  export type ActiveArtifactSnapshot = z.infer<typeof ActiveArtifactSnapshot>

  const MessagePayload = z.object({
    role: z.enum(["用户", "助手", "系统"]).default("用户"),
    text: z.string().min(1),
  })

  const ResourcePayload = z.object({
    path: z.string().min(1),
    title: z.string().optional(),
    note: z.string().optional(),
  })

  const NoteSyncPayload = z.object({
    summary: z.string().optional(),
    source: z.enum(["llm_draft", "manual_import", "manual_edit", "llm_revision"]).optional(),
    sourcePath: z.string().optional(),
  })

  const OperationArtifactsPayload = z.object({
    operationNotes: z.boolean().optional(),
    operationsDraft: z.boolean().optional(),
  }).refine((value) => value.operationsDraft === true, {
    message: "生成图操作必须登记已写入的 operations.draft.json",
  })

  const OperationsPayload = z.object({
    summary: z.string().optional(),
    change_id: z.string().optional(),
    artifacts: OperationArtifactsPayload,
  }).strict()

  const ApplyPayload = z.object({
    confirm: z.boolean().default(false),
    applied: z.boolean().optional(),
    applyResultPath: z.string().optional(),
    archivePath: z.string().optional(),
  })

  const NoteReviewPayload = z.object({
    sufficient: z.boolean(),
    summary: z.string().optional(),
    blockingQuestions: z.array(z.string()).default([]),
    missingFields: z.array(z.string()).default([]),
    canDraftOperations: z.boolean().optional(),
  })

  const RevisionPayload = z.object({
    target: z.enum(["工作笔记", "图操作", "两者"]),
    comment: z.string().min(1),
  })

  const ValidationRegisterPayload = z.object({
    passed: z.boolean().optional(),
    summary: z.string().optional(),
  })

  const ValidationArtifact = z.object({
    passed: z.boolean(),
    issues: z.array(z.unknown()).default([]),
  }).passthrough()

  function validateProjectName(input: string) {
    const name = input.trim()
    if (!name) throw new Error("项目名不能为空")
    if (name === "." || name === ".." || name === ".agents") throw new Error(`非法项目名：${name}`)
    if (name.includes("/") || name.includes("\\")) throw new Error("项目名不能包含路径分隔符")
    return name
  }

  export function projectDirectory(project: string) {
    return path.join(projectGraphRoot(), validateProjectName(project))
  }

  function workflowRoot(directory: string) {
    return path.join(directory, "workflows")
  }

  function activeDir(directory: string) {
    return path.join(workflowRoot(directory), "active")
  }

  function activeStatePath(directory: string) {
    return path.join(activeDir(directory), "state.json")
  }

  function artifactPath(directory: string, state: State, key: keyof z.infer<typeof ArtifactPaths>) {
    return path.join(activeDir(directory), state.artifacts[key])
  }

  function defaultArtifactPath(directory: string, key: keyof z.infer<typeof ArtifactPaths>) {
    return path.join(activeDir(directory), ArtifactPaths.parse({})[key])
  }

  async function ensureProject(directory: string) {
    const stat = await fs.stat(directory).catch(() => undefined)
    if (!stat?.isDirectory()) throw new Error(`项目目录不存在：${directory}`)
    await fs.mkdir(activeDir(directory), { recursive: true })
  }

  async function readState(directory: string): Promise<State | undefined> {
    const raw = await fs.readFile(activeStatePath(directory), "utf8").catch(() => undefined)
    if (!raw) return undefined
    return State.parse(JSON.parse(raw))
  }

  async function readOptionalText(file: string) {
    return fs.readFile(file, "utf8").catch(() => undefined)
  }

  async function writeState(directory: string, state: State) {
    await fs.mkdir(activeDir(directory), { recursive: true })
    await fs.writeFile(activeStatePath(directory), JSON.stringify(State.parse(state), null, 2) + "\n", "utf8")
  }

  async function appendJsonLine(file: string, value: unknown) {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.appendFile(file, JSON.stringify(value) + "\n", "utf8")
  }

  async function readJsonFile<T>(file: string, schema: z.ZodType<T>) {
    const raw = await fs.readFile(file, "utf8")
    return schema.parse(JSON.parse(raw))
  }

  function createState(project: string, now = Date.now()): State {
    return State.parse({
      id: ulid(now),
      project,
      stage: "收集材料",
      createdAt: now,
      updatedAt: now,
    })
  }

  function withSessionBinding(state: State, input: { sessionID?: string; warmupSessionID?: string; warmupStatus?: BaselineStatus }) {
    const now = Date.now()
    const sessionChanged = !!input.sessionID && input.sessionID !== state.sessionID
    return State.parse({
      ...state,
      sessionID: input.sessionID ?? state.sessionID,
      sessionStartedAt: sessionChanged ? now : state.sessionStartedAt,
      warmupSessionID: input.warmupSessionID ?? state.warmupSessionID,
      warmupStatus: input.warmupStatus ?? state.warmupStatus,
      updatedAt: now,
    })
  }

  async function cleanupWorkflowChatSession(state?: State) {
    if (!state?.sessionID) return
    const [{ Session }, { SessionPrompt }] = await Promise.all([
      import("@/session"),
      import("@/session/prompt"),
    ])
    await SessionPrompt.cancel(state.sessionID as any).catch(() => undefined)
    await Session.remove(state.sessionID as any).catch(() => undefined)
  }

  function transition(state: State, action: Action, to: Stage): State {
    const now = Date.now()
    return State.parse({
      ...state,
      stage: to,
      updatedAt: now,
      lastAction: action,
      pendingConfirmation: undefined,
    })
  }

  function touch(state: State, action: Action): State {
    return transition(state, action, state.stage)
  }

  async function fileExists(file: string) {
    return !!(await fs.stat(file).catch(() => undefined))
  }

  async function artifactStatus(directory: string, state: State) {
    const [note, noteReview, operationNotes, operationsDraft, operations, operationIndex, validation, preview, previewGraph] = await Promise.all([
      fileExists(artifactPath(directory, state, "note")),
      fileExists(artifactPath(directory, state, "noteReview")),
      fileExists(artifactPath(directory, state, "operationNotes")),
      fileExists(artifactPath(directory, state, "operationsDraft")),
      fileExists(artifactPath(directory, state, "operations")),
      fileExists(artifactPath(directory, state, "operationIndex")),
      fileExists(artifactPath(directory, state, "validation")),
      fileExists(artifactPath(directory, state, "preview")),
      fileExists(artifactPath(directory, state, "previewGraph")),
    ])
    return { note, noteReview, operationNotes, operationsDraft, operations, operationIndex, validation, preview, previewGraph }
  }

  async function latestValidationPassed(directory: string, state: State) {
    const validation = await readJsonFile(artifactPath(directory, state, "validation"), ValidationArtifact).catch(() => undefined)
    return validation?.passed === true
  }

  async function clearGraphDraftArtifacts(directory: string, state: State, options: { includeNoteReview?: boolean } = {}) {
    const keys: (keyof z.infer<typeof ArtifactPaths>)[] = [
      ...(options.includeNoteReview ? ["noteReview" as const] : []),
      "operationNotes",
      "changelogEntry",
      "operationsDraft",
      "operations",
      "operationIndex",
      "validation",
      "preview",
      "previewGraph",
    ]
    await Promise.all(keys.map((key) => fs.rm(artifactPath(directory, state, key), { recursive: key === "previewGraph", force: true })))
  }

  async function assertOperationArtifactManifest(
    directory: string,
    state: State,
    artifacts: NonNullable<z.infer<typeof OperationsPayload>["artifacts"]>,
  ) {
    const managed: { key: keyof z.infer<typeof ArtifactPaths>; produced: boolean }[] = [
      { key: "operationNotes", produced: !!artifacts.operationNotes },
      { key: "operationsDraft", produced: !!artifacts.operationsDraft },
    ]
    const missing: string[] = []
    for (const item of managed) {
      if (!item.produced) continue
      if (!(await fileExists(artifactPath(directory, state, item.key)))) missing.push(state.artifacts[item.key])
    }
    if (missing.length) throw new Error(`图操作草案产物尚未写入：${missing.join(", ")}`)
  }

  async function actionView(directory: string, state?: State) {
    if (!state) {
      return {
        availableActions: [{ action: "开始或恢复" as const, reason: "当前没有 active 草案，可以创建或恢复工作推进。" }],
        blockedActions: [] as { action: Action; reason: string }[],
        recommendations: ["先选择项目并开始工作推进。"],
      }
    }

    if (state.stage === "应用中" || state.stage === "已应用" || state.stage === "已取消") {
      return {
        availableActions: [] as { action: Action; reason: string; requiresUserConfirmation?: boolean }[],
        blockedActions: Action.options.map((action) => ({ action, reason: `当前草案处于终态「${state.stage}」，不能继续修改。` })),
        recommendations: ["如需继续推进，请开始新的工作推进草案。"],
      }
    }

    const artifacts = await artifactStatus(directory, state)
    const availableActions: { action: Action; reason: string; requiresUserConfirmation?: boolean }[] = [
      { action: "追加消息", reason: "继续记录用户输入、模型回应或审核意见。" },
      { action: "登记资源", reason: "登记上传附件或项目资源，供工作笔记引用。" },
      { action: "提出修订意见", reason: "记录用户对工作笔记、图操作或两者的审核意见。" },
      { action: "放弃草案", reason: "结束并删除当前 active workflow；如已有工作笔记则只保留 note.md 供下一轮重新开始。", requiresUserConfirmation: true },
    ]
    const blockedActions: { action: Action; reason: string }[] = []

    if (artifacts.note) {
      availableActions.push({ action: "同步工作笔记变更", reason: "note.md 已由人工导入或原版编辑工具更新后，同步状态；执行层会清理过期下游产物。" })
      availableActions.push({ action: "检查笔记充分性", reason: "判断当前工作笔记是否足以支撑图操作生成。" })
    } else {
      blockedActions.push({ action: "同步工作笔记变更", reason: "尚未生成工作笔记，无法同步笔记变更。" })
      blockedActions.push({ action: "检查笔记充分性", reason: "尚未生成工作笔记。" })
    }

    if (artifacts.note) availableActions.push({ action: "生成图操作草案", reason: "登记已由图操作生成模块写入的 operations.draft.json 和可审核说明；执行层会生成 operations.json、索引、校验结果和图谱预览。" })
    else blockedActions.push({ action: "生成图操作草案", reason: "尚未生成工作笔记。" })

    if (artifacts.operations) availableActions.push({ action: "校验图操作", reason: "校验当前 operations.json 的基础合法性和布局语义。" })
    else blockedActions.push({ action: "校验图操作", reason: artifacts.operationNotes || artifacts.operationsDraft ? "尚未生成可执行 operations.json，当前中间说明或草稿不能替代图操作。" : "尚未生成图操作草案。" })

    const previewReady = artifacts.preview && artifacts.previewGraph && await latestValidationPassed(directory, state)
    if (state.stage === "图操作已生成" && previewReady) {
      availableActions.push({ action: "应用图操作", reason: "图操作和预览已生成，可在用户明确确认时应用图操作。", requiresUserConfirmation: true })
    } else {
      blockedActions.push({ action: "应用图操作", reason: "尚未生成可审核的图操作预览。" })
    }

    const recommendations: string[] = []
    if (!artifacts.note) recommendations.push("先整理或更新工作笔记；材料不足时继续追加消息或登记资源。")
    if (state.stage === "笔记需补充") recommendations.push("当前笔记不足以支撑图操作，优先追问用户并修订工作笔记。")
    if (state.stage === "图操作需修订") recommendations.push("当前工作笔记可以保留，优先根据审核意见或校验结果修订图操作。")
    if (state.stage === "图操作已生成" && previewReady) recommendations.push("图操作和预览已生成后，用户可确认应用，也可继续修订图操作或回到工作笔记。")
    if (!recommendations.length) recommendations.push("根据用户意图选择补材料、改笔记、生成或修订图操作；状态机只做轻量护栏。")

    return { availableActions, blockedActions, recommendations }
  }

  async function ensureRunnable(directory: string, state: State, action: Action, payload: Record<string, unknown>) {
    if (action === "开始或恢复") return
    if (state.stage === "应用中" || state.stage === "已应用" || state.stage === "已取消") {
      throw new Error(`当前草案处于终态「${state.stage}」，不能执行「${action}」。`)
    }
    const artifacts = await artifactStatus(directory, state)
    if (action === "同步工作笔记变更" && !artifacts.note) throw new Error("尚未生成工作笔记，不能同步工作笔记变更。")
    if (action === "检查笔记充分性" && !artifacts.note) throw new Error("尚未生成工作笔记，不能检查笔记充分性。")
    if (action === "生成图操作草案" && !artifacts.note) throw new Error("尚未生成工作笔记，不能生成图操作草案。")
    if (action === "校验图操作" && !artifacts.validation && !artifacts.operations) throw new Error(artifacts.operationNotes || artifacts.operationsDraft ? "尚未生成校验结果，不能登记校验。" : "尚未生成图操作草案，不能校验。")
    if (action === "应用图操作") {
      const parsed = ApplyPayload.parse(payload)
      if (state.stage !== "图操作已生成") throw new Error("尚未生成可审核的图操作预览，不能应用图操作。")
      if (!artifacts.preview || !artifacts.previewGraph || !(await latestValidationPassed(directory, state))) throw new Error("尚未生成可审核的图操作预览，不能应用图操作。")
      if (!parsed.confirm) throw new Error("应用图操作需要 payload.confirm = true，并且必须来自用户明确确认。")
    }
  }

  async function ok(project: string, directory: string, state: State, message: string, data?: Record<string, unknown>): Promise<ActionResult> {
    const view = await actionView(directory, state)
    return {
      ok: true,
      project,
      workflowID: state.id,
      stage: state.stage,
      ...view,
      state,
      message,
      data,
    }
  }

  async function inactive(project: string, directory: string, message: string, data?: Record<string, unknown>): Promise<ActionResult> {
    const view = await actionView(directory)
    return {
      ok: true,
      project,
      ...view,
      message,
      data,
    }
  }

  async function startOrResume(project: string, directory: string) {
    const existing = await readState(directory)
    if (existing) return ok(project, directory, existing, `已恢复工作推进草案，当前阶段：${existing.stage}。`, { restored: true })
    let state = createState(project)
    const preservedNote = await readOptionalText(defaultArtifactPath(directory, "note"))
    if (preservedNote?.trim()) {
      state = State.parse({
        ...state,
        stage: "笔记已生成",
        lastAction: "同步工作笔记变更",
      })
    }
    await writeState(directory, state)
    return ok(project, directory, state, preservedNote?.trim() ? "已基于保留的工作笔记创建新的工作推进草案。" : "已创建新的工作推进草案。", {
      restored: false,
      preservedNote: !!preservedNote?.trim(),
    })
  }

  export async function bindSessions(input: {
    project: string
    directory?: string
    sessionID?: string
    warmupSessionID?: string
    warmupStatus?: BaselineStatus
  }) {
    const project = validateProjectName(input.project)
    const directory = input.directory ?? projectDirectory(project)
    await ensureProject(directory)
    const existing = await readState(directory)
    if (!existing) throw new Error("当前项目没有 active 工作推进草案，请先执行「开始或恢复」。")
    const next = withSessionBinding(existing, {
      sessionID: input.sessionID,
      warmupSessionID: input.warmupSessionID,
      warmupStatus: input.warmupStatus,
    })
    await writeState(directory, next)
    return ok(project, directory, next, "已绑定工作推进会话。")
  }

  export async function readActiveArtifacts(input: { project: string; directory?: string }): Promise<ActiveArtifactSnapshot> {
    const project = validateProjectName(input.project)
    const directory = input.directory ?? projectDirectory(project)
    await ensureProject(directory)
    const state = await readState(directory)
    const [note, resources] = await Promise.all([
      readOptionalText(state ? artifactPath(directory, state, "note") : defaultArtifactPath(directory, "note")),
      readOptionalText(state ? artifactPath(directory, state, "resources") : defaultArtifactPath(directory, "resources")),
    ])
    return ActiveArtifactSnapshot.parse({ note, resources })
  }

  export async function replaceActiveForWarmup(input: {
    project: string
    directory?: string
    sessionID: string
    warmupSessionID: string
    warmupStatus?: BaselineStatus
    carry?: ActiveArtifactSnapshot
  }) {
    const project = validateProjectName(input.project)
    const directory = input.directory ?? projectDirectory(project)
    await ensureProject(directory)
    const existing = await readState(directory)
    const carry = input.carry ?? await readActiveArtifacts({ project, directory })
    await fs.rm(activeDir(directory), { recursive: true, force: true })
    await fs.mkdir(activeDir(directory), { recursive: true })
    let state = createState(project)
    state = State.parse({
      ...state,
      sessionID: input.sessionID,
      sessionStartedAt: Date.now(),
      warmupSessionID: input.warmupSessionID,
      warmupStatus: input.warmupStatus ?? "completed",
    })

    if (carry.resources) {
      await fs.writeFile(artifactPath(directory, state, "resources"), carry.resources, "utf8")
    }
    if (carry.note?.trim()) {
      await fs.writeFile(artifactPath(directory, state, "note"), carry.note.trimEnd() + "\n", "utf8")
      state = transition(
        state,
        "同步工作笔记变更",
        "笔记已生成",
      )
    }
    await writeState(directory, state)
    return ok(project, directory, state, "已创建重新预热后的 active 工作推进草案。", {
      carriedNote: !!carry.note?.trim(),
      carriedResources: !!carry.resources?.trim(),
    })
      .finally(() => cleanupWorkflowChatSession(existing))
  }

  async function discard(project: string, directory: string, state: State) {
    const note = await readOptionalText(artifactPath(directory, state, "note"))
    const resources = await readOptionalText(artifactPath(directory, state, "resources"))
    await cleanupWorkflowChatSession(state)
    if (!note?.trim()) {
      await fs.rm(activeDir(directory), { recursive: true, force: true })
      return inactive(project, directory, "已清空当前 active 草案。")
    }

    await fs.rm(activeDir(directory), { recursive: true, force: true })
    await fs.mkdir(activeDir(directory), { recursive: true })
    await fs.writeFile(defaultArtifactPath(directory, "note"), note.trimEnd() + "\n", "utf8")
    if (resources?.trim()) await fs.writeFile(defaultArtifactPath(directory, "resources"), resources, "utf8")
    return inactive(project, directory, "已放弃当前 active workflow，并保留工作笔记。", {
      notePath: "workflows/active/note.md",
      preservedNote: true,
      preservedResources: !!resources?.trim(),
    })
  }

  export async function runAction(input: ActionRequest & { directory?: string }): Promise<ActionResult> {
    const request = ActionRequest.parse(input)
    const project = validateProjectName(request.project)
    const directory = input.directory ?? projectDirectory(project)
    await ensureProject(directory)

    if (request.action === "开始或恢复") return startOrResume(project, directory)

    const state = await readState(directory)
    if (!state) throw new Error("当前项目没有 active 工作推进草案，请先执行「开始或恢复」。")
    await ensureRunnable(directory, state, request.action, request.payload)

    if (request.action === "放弃草案") return discard(project, directory, state)

    if (request.action === "追加消息") {
      const payload = MessagePayload.parse(request.payload)
      await appendJsonLine(artifactPath(directory, state, "messages"), {
        time: new Date().toISOString(),
        role: payload.role,
        text: payload.text,
      })
      const next = touch(state, "追加消息")
      await writeState(directory, next)
      return ok(project, directory, next, "已记录消息。")
    }

    if (request.action === "登记资源") {
      const payload = ResourcePayload.parse(request.payload)
      await appendJsonLine(artifactPath(directory, state, "resources"), {
        time: new Date().toISOString(),
        path: payload.path,
        title: payload.title,
        note: payload.note,
      })
      const next = touch(state, "登记资源")
      await writeState(directory, next)
      return ok(project, directory, next, "已登记资源。")
    }

    if (request.action === "更新工作笔记") {
      throw new Error("「更新工作笔记」不再由状态机接收整篇 note 内容。请先由 note service 写入 note.md，再调用「同步工作笔记变更」。")
    }

    if (request.action === "同步工作笔记变更") {
      const payload = NoteSyncPayload.parse(request.payload)
      const next = transition(state, "同步工作笔记变更", "笔记已生成")
      await writeState(directory, next)
      return ok(project, directory, next, "已同步工作笔记变更。", {
        notePath: next.artifacts.note,
        source: payload.source,
        sourcePath: payload.sourcePath,
      })
    }

    if (request.action === "检查笔记充分性") {
      const payload = NoteReviewPayload.parse(request.payload)
      const review = {
        checkedAt: new Date().toISOString(),
        sufficient: payload.sufficient,
        canDraftOperations: payload.canDraftOperations ?? payload.sufficient,
        blockingQuestions: payload.blockingQuestions,
        missingFields: payload.missingFields,
        summary: payload.summary,
      }
      await fs.writeFile(artifactPath(directory, state, "noteReview"), JSON.stringify(review, null, 2) + "\n", "utf8")
      const next = transition(
        state,
        "检查笔记充分性",
        review.sufficient && review.canDraftOperations ? "笔记已生成" : "笔记需补充",
      )
      await writeState(directory, next)
      return ok(project, directory, next, review.sufficient ? "笔记充分性检查通过。" : "笔记仍需补充。", { review })
    }

    if (request.action === "生成图操作草案") {
      const payload = OperationsPayload.parse(request.payload)
      await assertOperationArtifactManifest(directory, state, payload.artifacts)
      const artifacts = await artifactStatus(directory, state)
      const next = transition(state, "生成图操作草案", "图操作已生成")
      await writeState(directory, next)
      return ok(project, directory, next, "已登记图操作草案产物。", {
        change_id: payload.change_id,
        hasOperationNotes: artifacts.operationNotes,
        hasDraft: artifacts.operationsDraft,
        hasOperationIndex: artifacts.operationIndex,
        hasExecutableCommand: artifacts.operations,
      })
    }

    if (request.action === "校验图操作") {
      const payload = ValidationRegisterPayload.parse(request.payload)
      const validation = await readJsonFile(artifactPath(directory, state, "validation"), ValidationArtifact)
      const passed = payload.passed ?? validation.passed
      const next = transition(
        state,
        "校验图操作",
        passed ? "图操作已生成" : "图操作需修订",
      )
      await writeState(directory, next)
      return ok(project, directory, next, passed ? "图操作和预览已生成。" : "图操作需修订。", {
        validation: {
          passed: validation.passed,
          issueCount: validation.issues.length,
          issues: validation.issues,
        },
      })
    }

    if (request.action === "提出修订意见") {
      const payload = RevisionPayload.parse(request.payload)
      await appendJsonLine(artifactPath(directory, state, "messages"), {
        time: new Date().toISOString(),
        role: "用户",
        type: "修订意见",
        target: payload.target,
        text: payload.comment,
      })
      const nextStage: Stage = payload.target === "图操作" ? "图操作需修订" : payload.target === "工作笔记" ? "笔记需补充" : "笔记需补充"
      const next = transition(state, "提出修订意见", nextStage)
      await writeState(directory, next)
      return ok(project, directory, next, `已记录${payload.target}修订意见。`)
    }

    if (request.action === "应用图操作") {
      const payload = ApplyPayload.parse(request.payload)
      if (!payload.confirm) throw new Error("应用图操作需要 payload.confirm = true，并且必须来自用户明确确认。")
      if (!payload.applied) throw new Error("应用图操作必须由执行层完成正式写图后登记，不能直接由状态机推进。")
      const next = transition(state, "应用图操作", "已应用")
      await writeState(directory, next)
      return ok(project, directory, next, "图操作已应用到正式图数据。", {
        applyResultPath: payload.applyResultPath,
        archivePath: payload.archivePath,
      })
    }

    throw new Error(`未支持的动作：${request.action}`)
  }

  export async function getActive(input: { project: string; directory?: string }): Promise<ActionResult> {
    const project = validateProjectName(input.project)
    const directory = input.directory ?? projectDirectory(project)
    await ensureProject(directory)
    const state = await readState(directory)
    if (!state) return inactive(project, directory, "当前没有 active 工作推进草案。")
    return ok(project, directory, state, `当前阶段：${state.stage}。`)
  }
}
