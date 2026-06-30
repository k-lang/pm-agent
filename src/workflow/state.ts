import fs from "fs/promises"
import path from "path"
import { ulid } from "ulid"
import z from "zod"
import { projectGraphRoot } from "@/project/root"
import { GraphCommand } from "@/graph/schema"
import { GraphEngine } from "@/graph/engine"
import { GraphStorage } from "@/graph/storage"
import { GraphSemanticValidator } from "@/graph/semantic-validation"

export namespace ProjectWorkflow {
  export const Stage = z.enum([
    "收集材料",
    "笔记已生成",
    "笔记需补充",
    "图操作已生成",
    "图操作需修订",
    "校验已通过",
    "预览已生成",
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
    "检查笔记充分性",
    "生成图操作草案",
    "校验图操作",
    "生成预览",
    "提出修订意见",
    "应用图操作",
  ])
  export type Action = z.infer<typeof Action>

  const ArtifactPaths = z.object({
    messages: z.string().default("messages.jsonl"),
    resources: z.string().default("resources.json"),
    note: z.string().default("note.md"),
    noteReview: z.string().default("note_review.json"),
    operations: z.string().default("operations.json"),
    validation: z.string().default("validation.json"),
    preview: z.string().default("preview.json"),
  })

  export const State = z.object({
    id: z.string(),
    project: z.string(),
    stage: Stage,
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
      operations: "operations.json",
      validation: "validation.json",
      preview: "preview.json",
    }),
    lastAction: Action.optional(),
    pendingConfirmation: z.object({
      action: Action,
      message: z.string(),
    }).optional(),
    history: z.array(z.object({
      time: z.number(),
      action: Action,
      from: Stage.optional(),
      to: Stage,
      summary: z.string(),
    })).default([]),
  })
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

  const MessagePayload = z.object({
    role: z.enum(["用户", "助手", "系统"]).default("用户"),
    text: z.string().min(1),
  })

  const ResourcePayload = z.object({
    path: z.string().min(1),
    title: z.string().optional(),
    note: z.string().optional(),
  })

  const NotePayload = z.object({
    content: z.string(),
    summary: z.string().optional(),
  })

  const OperationsPayload = z.object({
    command: GraphCommand.optional(),
    operations: GraphCommand.shape.operations.optional(),
    change_id: z.string().optional(),
    description: z.string().optional(),
    history_descriptions: GraphCommand.shape.history_descriptions.optional(),
  }).refine((value) => value.command || value.operations, {
    message: "需要提供 command 或 operations",
  })

  const ApplyPayload = z.object({
    confirm: z.boolean().default(false),
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
    const state = State.parse({
      id: ulid(now),
      project,
      stage: "收集材料",
      createdAt: now,
      updatedAt: now,
      history: [],
    })
    state.history.push({
      time: now,
      action: "开始或恢复",
      to: state.stage,
      summary: "创建工作推进草案。",
    })
    return state
  }

  function transition(state: State, action: Action, to: Stage, summary: string): State {
    const now = Date.now()
    const from = state.stage
    return State.parse({
      ...state,
      stage: to,
      updatedAt: now,
      lastAction: action,
      pendingConfirmation: undefined,
      history: [
        ...state.history,
        {
          time: now,
          action,
          from,
          to,
          summary,
        },
      ],
    })
  }

  function touch(state: State, action: Action, summary: string): State {
    return transition(state, action, state.stage, summary)
  }

  async function fileExists(file: string) {
    return !!(await fs.stat(file).catch(() => undefined))
  }

  async function artifactStatus(directory: string, state: State) {
    const [note, noteReview, operations, validation, preview] = await Promise.all([
      fileExists(artifactPath(directory, state, "note")),
      fileExists(artifactPath(directory, state, "noteReview")),
      fileExists(artifactPath(directory, state, "operations")),
      fileExists(artifactPath(directory, state, "validation")),
      fileExists(artifactPath(directory, state, "preview")),
    ])
    return { note, noteReview, operations, validation, preview }
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
      { action: "更新工作笔记", reason: "创建或修订 note.md；用户可随时回到笔记层。" },
      { action: "提出修订意见", reason: "记录用户对工作笔记、图操作或两者的审核意见。" },
      { action: "放弃草案", reason: "清空当前 active 草案。", requiresUserConfirmation: true },
    ]
    const blockedActions: { action: Action; reason: string }[] = []

    if (artifacts.note) availableActions.push({ action: "检查笔记充分性", reason: "判断当前工作笔记是否足以支撑图操作生成。" })
    else blockedActions.push({ action: "检查笔记充分性", reason: "尚未生成工作笔记。" })

    if (artifacts.note) availableActions.push({ action: "生成图操作草案", reason: "基于当前工作笔记和审核意见生成或重生成 operations.json。" })
    else blockedActions.push({ action: "生成图操作草案", reason: "尚未生成工作笔记。" })

    if (artifacts.operations) availableActions.push({ action: "校验图操作", reason: "校验当前 operations.json 的基础合法性和布局语义。" })
    else blockedActions.push({ action: "校验图操作", reason: "尚未生成图操作草案。" })

    if (artifacts.validation) availableActions.push({ action: "生成预览", reason: "如果最近一次校验通过，可生成图谱预览元数据。" })
    else blockedActions.push({ action: "生成预览", reason: "尚未校验图操作。" })

    if (state.stage === "预览已生成") availableActions.push({ action: "应用图操作", reason: "预览后可在用户明确确认时应用图操作。", requiresUserConfirmation: true })
    else blockedActions.push({ action: "应用图操作", reason: "尚未生成可审核的预览。" })

    const recommendations: string[] = []
    if (!artifacts.note) recommendations.push("先整理或更新工作笔记；材料不足时继续追加消息或登记资源。")
    if (state.stage === "笔记需补充") recommendations.push("当前笔记不足以支撑图操作，优先追问用户并修订工作笔记。")
    if (state.stage === "图操作需修订") recommendations.push("当前工作笔记可以保留，优先根据审核意见或校验结果修订图操作。")
    if (state.stage === "校验已通过") recommendations.push("校验通过后可以生成预览；用户仍可选择继续修改笔记或图操作。")
    if (state.stage === "预览已生成") recommendations.push("预览已生成后，用户可确认应用，也可只修订图操作或回到工作笔记。")
    if (!recommendations.length) recommendations.push("根据用户意图选择补材料、改笔记、生成图操作、校验或预览；状态机只做轻量护栏。")

    return { availableActions, blockedActions, recommendations }
  }

  async function ensureRunnable(directory: string, state: State, action: Action, payload: Record<string, unknown>) {
    if (action === "开始或恢复") return
    if (state.stage === "应用中" || state.stage === "已应用" || state.stage === "已取消") {
      throw new Error(`当前草案处于终态「${state.stage}」，不能执行「${action}」。`)
    }
    const artifacts = await artifactStatus(directory, state)
    if (action === "检查笔记充分性" && !artifacts.note) throw new Error("尚未生成工作笔记，不能检查笔记充分性。")
    if (action === "生成图操作草案" && !artifacts.note) throw new Error("尚未生成工作笔记，不能生成图操作草案。")
    if (action === "校验图操作" && !artifacts.operations) throw new Error("尚未生成图操作草案，不能校验。")
    if (action === "生成预览" && !artifacts.validation) throw new Error("尚未校验图操作，不能生成预览。")
    if (action === "应用图操作") {
      const parsed = ApplyPayload.parse(payload)
      if (state.stage !== "预览已生成") throw new Error("尚未生成可审核的预览，不能应用图操作。")
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

  async function inactive(project: string, directory: string, message: string): Promise<ActionResult> {
    const view = await actionView(directory)
    return {
      ok: true,
      project,
      ...view,
      message,
    }
  }

  async function startOrResume(project: string, directory: string) {
    const existing = await readState(directory)
    if (existing) return ok(project, directory, existing, `已恢复工作推进草案，当前阶段：${existing.stage}。`, { restored: true })
    const state = createState(project)
    await writeState(directory, state)
    return ok(project, directory, state, "已创建新的工作推进草案。", { restored: false })
  }

  async function discard(project: string, directory: string, state: State) {
    const next = transition(state, "放弃草案", "已取消", "用户确认放弃 active 草案。")
    await writeState(directory, next)
    await fs.rm(activeDir(directory), { recursive: true, force: true })
    return inactive(project, directory, "已清空当前 active 草案。")
  }

  function commandFromPayload(payload: z.infer<typeof OperationsPayload>): GraphCommand {
    if (payload.command) return GraphCommand.parse(payload.command)
    return GraphCommand.parse({
      change_id: payload.change_id ?? `workflow_${Date.now()}`,
      timestamp: new Date().toISOString(),
      description: payload.description,
      operations: payload.operations ?? [],
      history_descriptions: payload.history_descriptions ?? {},
    })
  }

  async function loadCommand(directory: string, state: State) {
    return readJsonFile(artifactPath(directory, state, "operations"), GraphCommand)
  }

  async function validateCommand(directory: string, state: State) {
    const command = await loadCommand(directory, state)
    const storage = new GraphStorage(directory)
    const engine = new GraphEngine(storage)
    const basicErrors = await engine.validateOperations(command.operations)
    const semanticIssues = await new GraphSemanticValidator(storage).validateCommand(command)
    const errors = [
      ...basicErrors.map((message) => ({ severity: "error", message })),
      ...semanticIssues,
    ]
    const passed = errors.every((issue) => issue.severity !== "error")
    const validation = {
      passed,
      checkedAt: new Date().toISOString(),
      change_id: command.change_id,
      issues: errors,
    }
    await fs.writeFile(artifactPath(directory, state, "validation"), JSON.stringify(validation, null, 2) + "\n", "utf8")
    return validation
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
      const next = touch(state, "追加消息", `追加${payload.role}消息。`)
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
      const next = touch(state, "登记资源", `登记资源：${payload.title || payload.path}`)
      await writeState(directory, next)
      return ok(project, directory, next, "已登记资源。")
    }

    if (request.action === "更新工作笔记") {
      const payload = NotePayload.parse(request.payload)
      await fs.writeFile(artifactPath(directory, state, "note"), payload.content.trimEnd() + "\n", "utf8")
      await Promise.all([
        fs.rm(artifactPath(directory, state, "noteReview"), { force: true }),
        fs.rm(artifactPath(directory, state, "validation"), { force: true }),
        fs.rm(artifactPath(directory, state, "preview"), { force: true }),
      ])
      const next = transition(state, "更新工作笔记", "笔记已生成", payload.summary || "创建或修订工作笔记。")
      await writeState(directory, next)
      return ok(project, directory, next, "已更新工作笔记。", { notePath: next.artifacts.note })
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
        review.summary || (review.sufficient ? "当前工作笔记足以生成图操作草案。" : "当前工作笔记仍需补充。"),
      )
      await writeState(directory, next)
      return ok(project, directory, next, review.sufficient ? "笔记充分性检查通过。" : "笔记仍需补充。", { review })
    }

    if (request.action === "生成图操作草案") {
      const payload = OperationsPayload.parse(request.payload)
      const command = commandFromPayload(payload)
      await fs.writeFile(artifactPath(directory, state, "operations"), JSON.stringify(command, null, 2) + "\n", "utf8")
      await Promise.all([
        fs.rm(artifactPath(directory, state, "validation"), { force: true }),
        fs.rm(artifactPath(directory, state, "preview"), { force: true }),
      ])
      const next = transition(state, "生成图操作草案", "图操作已生成", command.description || `生成图操作草案：${command.change_id}`)
      await writeState(directory, next)
      return ok(project, directory, next, "已保存图操作草案。", {
        change_id: command.change_id,
        operationCount: command.operations.length,
      })
    }

    if (request.action === "校验图操作") {
      const validation = await validateCommand(directory, state)
      const next = transition(
        state,
        "校验图操作",
        validation.passed ? "校验已通过" : "图操作需修订",
        validation.passed ? "图操作草案通过校验。" : "图操作草案校验未通过，需要修订图操作。",
      )
      await writeState(directory, next)
      return ok(project, directory, next, validation.passed ? "校验已通过。" : "图操作需修订。", { validation })
    }

    if (request.action === "生成预览") {
      const validation = await readJsonFile(artifactPath(directory, state, "validation"), z.object({
        passed: z.boolean(),
        issues: z.array(z.unknown()).default([]),
      }))
      if (!validation.passed) throw new Error("最近一次校验未通过，不能生成预览。")
      const command = await loadCommand(directory, state)
      const affected = new Set<string>()
      for (const operation of command.operations) {
        if (operation.type === "create_node") affected.add(operation.temp_id)
        if (operation.type === "update_node") affected.add(operation.node_id)
        if (operation.type === "create_edge") {
          affected.add(operation.from_node)
          affected.add(operation.to_node)
          if (operation.temp_id) affected.add(operation.temp_id)
        }
        if (operation.type === "update_edge") affected.add(operation.edge_id)
      }
      const preview = {
        generatedAt: new Date().toISOString(),
        change_id: command.change_id,
        mode: "完整图谱预览",
        operationCount: command.operations.length,
        affectedIds: [...affected],
        note: "当前版本只生成预览元数据；图谱渲染层后续读取 operations 后叠加高亮。",
      }
      await fs.writeFile(artifactPath(directory, state, "preview"), JSON.stringify(preview, null, 2) + "\n", "utf8")
      const next = transition(state, "生成预览", "预览已生成", "生成图操作预览元数据。")
      await writeState(directory, next)
      return ok(project, directory, next, "已生成预览元数据。", { preview })
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
      if (nextStage !== "图操作需修订") {
        await Promise.all([
          fs.rm(artifactPath(directory, state, "noteReview"), { force: true }),
          fs.rm(artifactPath(directory, state, "validation"), { force: true }),
          fs.rm(artifactPath(directory, state, "preview"), { force: true }),
        ])
      } else {
        await fs.rm(artifactPath(directory, state, "preview"), { force: true })
      }
      const next = transition(state, "提出修订意见", nextStage, `用户提出${payload.target}修订意见：${payload.comment}`)
      await writeState(directory, next)
      return ok(project, directory, next, `已记录${payload.target}修订意见。`)
    }

    if (request.action === "应用图操作") {
      const payload = ApplyPayload.parse(request.payload)
      if (!payload.confirm) throw new Error("应用图操作需要 payload.confirm = true，并且必须来自用户明确确认。")
      throw new Error("当前版本只实现状态机、草案文件和校验/预览，不执行真实图数据写入。")
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
