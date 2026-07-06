import fs from "fs/promises"
import path from "path"
import z from "zod"
import { GraphEngine } from "@/graph/engine"
import { EdgeType, GraphCommand, NodeType, type GraphCommand as GraphCommandData } from "@/graph/schema"
import { GraphStorage } from "@/graph/storage"
import { ProjectWorkflow } from "./state"

export namespace ProjectWorkflowExecution {
  export const OperationArtifactSnapshot = z.object({
    workflow: ProjectWorkflow.ActionResult,
    files: z.array(z.object({
      key: z.string(),
      label: z.string(),
      path: z.string(),
      type: z.enum(["markdown", "json"]),
      exists: z.boolean(),
      content: z.string().optional(),
    })),
  })
  export type OperationArtifactSnapshot = z.infer<typeof OperationArtifactSnapshot>

  const NoteWritePayload = z.object({
    content: z.string(),
    summary: z.string().optional(),
    source: z.enum(["llm_draft", "manual_import", "manual_edit", "llm_revision"]).optional(),
    sourcePath: z.string().optional(),
  })

  export const ValidationArtifact = z.object({
    passed: z.boolean(),
    checkedAt: z.string().optional(),
    change_id: z.string().optional(),
    issues: z.array(z.unknown()).default([]),
  }).passthrough()
  export type ValidationArtifact = z.infer<typeof ValidationArtifact>

  export const PreviewArtifact = z.object({
    generatedAt: z.string().optional(),
    change_id: z.string().optional(),
    mode: z.string().optional(),
    operationCount: z.number().optional(),
    affectedIds: z.array(z.string()).optional(),
  }).passthrough()
  export type PreviewArtifact = z.infer<typeof PreviewArtifact>

  const TimestampDraft = z.union([
    z.string(),
    z.object({
      value: z.string(),
      source: z.string().optional(),
    }).passthrough(),
  ])

  const BaseDraftItem = z.object({
    history: z.string().optional(),
    review_note: z.string().optional(),
  })

  const CreateNodeDraftItem = BaseDraftItem.extend({
    kind: z.literal("create_node"),
    temp_id: z.string(),
    node_type: NodeType,
    summary: z.string().optional(),
    description: z.string().optional(),
    fields: z.record(z.string(), z.unknown()).default({}),
  }).passthrough()

  const UpdateNodeDraftItem = BaseDraftItem.extend({
    kind: z.literal("update_node"),
    node_id: z.string(),
    field_updates: z.record(z.string(), z.unknown()).default({}),
    description_delta: z.string().optional(),
    description: z.string().optional(),
  }).passthrough()

  const CreateEdgeDraftItem = BaseDraftItem.extend({
    kind: z.literal("create_edge"),
    temp_id: z.string().optional(),
    from_node: z.string(),
    to_node: z.string(),
    edge_type: EdgeType,
    description: z.string().optional(),
  }).passthrough()

  const UpdateEdgeDraftItem = BaseDraftItem.extend({
    kind: z.literal("update_edge"),
    edge_id: z.string(),
    new_description: z.string().optional(),
    description_delta: z.string().optional(),
    reason: z.string().optional(),
  }).passthrough()

  const OperationDraftItem = z.discriminatedUnion("kind", [
    CreateNodeDraftItem,
    UpdateNodeDraftItem,
    CreateEdgeDraftItem,
    UpdateEdgeDraftItem,
  ])

  const WorkflowOperationDraft = z.object({
    change_id: z.string(),
    timestamp: TimestampDraft,
    description: z.string().optional(),
    items: z.array(OperationDraftItem),
    review_notes: z.array(z.string()).default([]),
  }).passthrough().superRefine((draft, ctx) => {
    for (const field of ["operations", "commands", "history_descriptions", "operation_index", "validation", "preview"]) {
      if (field in draft) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `压缩 draft 顶层不允许写 ${field}；请只写 change_id、timestamp、items，并把历史说明写入每个 item.history。`,
        })
      }
    }
    draft.items.forEach((item, index) => {
      if (item.kind === "create_node" && ("linked_work_blocks" in item.fields || "work_items" in item.fields)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["items", index, "fields"],
          message: "压缩 draft 不允许写 linked_work_blocks/work_items 反向派生列表；请只写 linked_goal_id 或 linked_work_block_id，反向列表由图引擎维护。",
        })
      }
      if (item.kind === "update_node" && ("linked_work_blocks" in item.field_updates || "work_items" in item.field_updates)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["items", index, "field_updates"],
          message: "压缩 draft 不允许更新 linked_work_blocks/work_items 反向派生列表；请通过 linked_goal_id 或 linked_work_block_id 表达归属，反向列表由图引擎维护。",
        })
      }
    })
  })
  type WorkflowOperationDraft = z.infer<typeof WorkflowOperationDraft>

  function activeDir(directory: string) {
    return path.join(directory, "workflows", "active")
  }

  function artifactPath(directory: string, file: string) {
    return path.join(activeDir(directory), file)
  }

  async function readOptionalText(file: string) {
    return fs.readFile(file, "utf8").catch(() => undefined)
  }

  async function fileExists(file: string) {
    return !!(await fs.stat(file).catch(() => undefined))
  }

  async function readJsonFile<T>(file: string, schema: z.ZodType<T>) {
    const raw = await fs.readFile(file, "utf8")
    return schema.parse(JSON.parse(raw))
  }

  async function readJsonValue(file: string) {
    return JSON.parse(await fs.readFile(file, "utf8"))
  }

  function dropUndefined(input: Record<string, unknown>) {
    return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined))
  }

  function graphIssue(message: string, operationIndex?: number) {
    return { severity: "error" as const, message, operationIndex }
  }

  function stripEmbeddedHistory(value: unknown) {
    if (typeof value !== "string") return value
    return value.replace(/\n{0,2}历史记录：[\s\S]*$/u, "").trimEnd()
  }

  function stripEmbeddedHistoryText(value: string) {
    return stripEmbeddedHistory(value) as string
  }

  function appendDescriptionDelta(existing: string | undefined, delta: string) {
    const base = stripEmbeddedHistoryText(existing || "")
    if (!base) return delta.trim()
    return `${base.trimEnd()}\n\n${delta.trim()}`
  }

  function timestampValue(input: WorkflowOperationDraft["timestamp"]) {
    return typeof input === "string" ? input : input.value
  }

  async function compileCompressedDraft(directory: string, draft: WorkflowOperationDraft): Promise<GraphCommandData> {
    const storage = new GraphStorage(directory)
    const operations: GraphCommandData["operations"] = []
    const historyDescriptions: Record<string, string> = {}

    for (const item of draft.items) {
      if (item.kind === "create_node") {
        operations.push({
          type: "create_node",
          temp_id: item.temp_id,
          data: dropUndefined({
            ...item.fields,
            type: item.node_type,
            summary: item.summary,
            description: stripEmbeddedHistory(item.description),
          }) as Record<string, unknown> & { type: z.infer<typeof NodeType> },
        })
        if (item.history) historyDescriptions[item.temp_id] = item.history
        continue
      }

      if (item.kind === "update_node") {
        const updates: Record<string, unknown> = { ...item.field_updates }
        if (item.description !== undefined) {
          updates.description = stripEmbeddedHistory(item.description)
        } else if (item.description_delta !== undefined) {
          const node = await storage.getNodeById(item.node_id)
          updates.description = appendDescriptionDelta(node?.description, item.description_delta)
        }
        operations.push({
          type: "update_node",
          node_id: item.node_id,
          updates,
        })
        if (item.history) historyDescriptions[item.node_id] = item.history
        continue
      }

      if (item.kind === "create_edge") {
        operations.push({
          type: "create_edge",
          temp_id: item.temp_id,
          from_node: item.from_node,
          to_node: item.to_node,
          edge_type: item.edge_type,
          description: item.description,
        })
        if (item.history && item.temp_id) historyDescriptions[item.temp_id] = item.history
        continue
      }

      if (item.kind === "update_edge") {
        operations.push({
          type: "update_edge",
          edge_id: item.edge_id,
          new_description: item.new_description ?? item.description_delta,
          reason: item.reason,
        })
        if (item.history) historyDescriptions[item.edge_id] = item.history
      }
    }

    return GraphCommand.parse({
      change_id: draft.change_id,
      timestamp: timestampValue(draft.timestamp),
      description: draft.description,
      operations,
      history_descriptions: historyDescriptions,
    })
  }

  function normalizeCommand(command: GraphCommandData): GraphCommandData {
    return GraphCommand.parse({
      ...command,
      operations: command.operations.map((operation) => {
        if (operation.type === "create_node") {
          return {
            ...operation,
            data: {
              ...operation.data,
              description: stripEmbeddedHistory(operation.data.description),
            },
          }
        }
        if (operation.type === "update_node") {
          return {
            ...operation,
            updates: {
              ...operation.updates,
              description: stripEmbeddedHistory(operation.updates.description),
            },
          }
        }
        return operation
      }),
    })
  }

  function operationTargets(operation: GraphCommandData["operations"][number]) {
    if (operation.type === "create_node") return [operation.temp_id]
    if (operation.type === "update_node") return [operation.node_id]
    if (operation.type === "create_edge") return [operation.temp_id, operation.from_node, operation.to_node].filter(Boolean) as string[]
    return [operation.edge_id]
  }

  function operationKind(operation: GraphCommandData["operations"][number]) {
    if (operation.type === "create_node") return "新增节点"
    if (operation.type === "update_node") return "更新节点"
    if (operation.type === "create_edge") return "新增关系"
    return "更新关系"
  }

  function operationTitle(operation: GraphCommandData["operations"][number]) {
    if (operation.type === "create_node") {
      return `${operation.data.type}: ${String(operation.data.summary || operation.temp_id)}`
    }
    if (operation.type === "update_node") return operation.node_id
    if (operation.type === "create_edge") return `${operation.from_node} -[${operation.edge_type}]-> ${operation.to_node}`
    return operation.edge_id
  }

  function buildOperationIndex(command: GraphCommandData) {
    return {
      generatedAt: new Date().toISOString(),
      change_id: command.change_id,
      items: command.operations.map((operation, index) => {
        const targets = operationTargets(operation)
        return {
          index,
          kind: operationKind(operation),
          title: operationTitle(operation),
          targetIds: targets,
          history_entry: targets.map((target) => command.history_descriptions[target]).find(Boolean) || "",
        }
      }),
    }
  }

  async function writeValidation(input: {
    directory: string
    passed: boolean
    change_id?: string
    issues: unknown[]
  }) {
    const validation = ValidationArtifact.parse({
      passed: input.passed,
      checkedAt: new Date().toISOString(),
      change_id: input.change_id,
      issues: input.issues,
    })
    await fs.writeFile(artifactPath(input.directory, "validation.json"), JSON.stringify(validation, null, 2) + "\n", "utf8")
    return validation
  }

  export async function writeNote(input: {
    directory: string
    content: string
  }) {
    await fs.mkdir(activeDir(input.directory), { recursive: true })
    await fs.writeFile(artifactPath(input.directory, "note.md"), input.content.trimEnd() + "\n", "utf8")
  }

  export async function clearGraphDraftArtifacts(input: { directory: string; includeNoteReview?: boolean }) {
    const files = [
      ...(input.includeNoteReview ? ["note_review.json"] : []),
      "operation_notes.md",
      "operations.draft.json",
      "operations.json",
      "operation_index.json",
      "validation.json",
      "preview.json",
    ]
    await Promise.all(files.map((file) => fs.rm(artifactPath(input.directory, file), { force: true })))
  }

  async function clearValidationAndPreview(directory: string) {
    await Promise.all([
      fs.rm(artifactPath(directory, "validation.json"), { force: true }),
      fs.rm(artifactPath(directory, "preview.json"), { force: true }),
    ])
  }

  async function prepareOperationArtifactManifest(input: {
    directory: string
    artifacts: Record<string, unknown>
  }) {
    const managed = [
      { key: "operationNotes", file: "operation_notes.md" },
      { key: "operationsDraft", file: "operations.draft.json" },
    ]
    if (!input.artifacts.operationsDraft) throw new Error("生成图操作必须先写入 workflows/active/operations.draft.json；operations.json、operation_index.json、validation.json 和 preview.json 由执行层生成。")
    const missing: string[] = []
    for (const item of managed) {
      if (!input.artifacts[item.key]) continue
      if (!(await fileExists(artifactPath(input.directory, item.file)))) missing.push(item.file)
    }
    if (missing.length) throw new Error(`图操作草案产物尚未写入：${missing.join(", ")}`)

    await Promise.all([
      fs.rm(artifactPath(input.directory, "validation.json"), { force: true }),
      fs.rm(artifactPath(input.directory, "preview.json"), { force: true }),
      fs.rm(artifactPath(input.directory, "operation_index.json"), { force: true }),
      fs.rm(artifactPath(input.directory, "operations.json"), { force: true }),
    ])
  }

  async function operationArtifactStatus(directory: string) {
    const [operationNotes, operationsDraft, operationIndex, operations] = await Promise.all([
      fileExists(artifactPath(directory, "operation_notes.md")),
      fileExists(artifactPath(directory, "operations.draft.json")),
      fileExists(artifactPath(directory, "operation_index.json")),
      fileExists(artifactPath(directory, "operations.json")),
    ])
    return {
      hasOperationNotes: operationNotes,
      hasDraft: operationsDraft,
      hasOperationIndex: operationIndex,
      hasExecutableCommand: operations,
    }
  }

  export async function readOperationArtifacts(input: { project: string; directory?: string }): Promise<OperationArtifactSnapshot> {
    const directory = input.directory ?? ProjectWorkflow.projectDirectory(input.project)
    const workflow = await ProjectWorkflow.getActive({ project: input.project, directory })
    const state = workflow.state
    if (!state) return OperationArtifactSnapshot.parse({ workflow, files: [] })
    const definitions: { key: keyof ProjectWorkflow.State["artifacts"]; label: string; type: "markdown" | "json" }[] = [
      { key: "operationNotes", label: "图操作说明", type: "markdown" },
      { key: "operations", label: "可执行图操作", type: "json" },
      { key: "validation", label: "校验结果", type: "json" },
      { key: "operationsDraft", label: "中间草案 JSON", type: "json" },
      { key: "operationIndex", label: "图操作索引 JSON", type: "json" },
      { key: "preview", label: "预览数据 JSON", type: "json" },
    ]
    const files = await Promise.all(definitions.map(async (definition) => {
      const relativePath = state.artifacts[definition.key]
      const content = await readOptionalText(artifactPath(directory, relativePath))
      return {
        key: definition.key,
        label: definition.label,
        path: `workflows/active/${relativePath}`,
        type: definition.type,
        exists: content !== undefined,
        content,
      }
    }))
    return OperationArtifactSnapshot.parse({ workflow, files })
  }

  export async function validateOperations(input: { directory: string }) {
    const storage = new GraphStorage(input.directory)
    const engine = new GraphEngine(storage)
    const validationResult = await engine.validateCommand(await readJsonValue(artifactPath(input.directory, "operations.json")))
    const errors = validationResult.issues
    return writeValidation({
      directory: input.directory,
      passed: errors.every((issue) => issue.severity !== "error"),
      change_id: validationResult.command?.change_id,
      issues: errors,
    })
  }

  export async function compileOperationDraft(input: { directory: string }) {
    let raw: unknown
    try {
      raw = await readJsonValue(artifactPath(input.directory, "operations.draft.json"))
    } catch (error) {
      const validation = await writeValidation({
        directory: input.directory,
        passed: false,
        issues: [graphIssue(`operations.draft.json 读取或 JSON 解析失败：${error instanceof Error ? error.message : String(error)}`)],
      })
      return { ok: false as const, validation }
    }

    const draft = WorkflowOperationDraft.safeParse(raw)
    if (draft.success) {
      const command = normalizeCommand(await compileCompressedDraft(input.directory, draft.data))
      await Promise.all([
        fs.writeFile(artifactPath(input.directory, "operations.json"), JSON.stringify(command, null, 2) + "\n", "utf8"),
        fs.writeFile(artifactPath(input.directory, "operation_index.json"), JSON.stringify(buildOperationIndex(command), null, 2) + "\n", "utf8"),
      ])
      return { ok: true as const, command }
    }

    const parsed = GraphCommand.safeParse(raw)
    if (!parsed.success) {
      const validation = await writeValidation({
        directory: input.directory,
        passed: false,
        change_id: typeof raw === "object" && raw && "change_id" in raw ? String((raw as { change_id?: unknown }).change_id) : undefined,
        issues: [
          ...draft.error.issues.map((issue) => graphIssue(`operations.draft.json 压缩草案结构错误：${issue.path.join(".") || "(root)"} ${issue.message}`)),
          ...parsed.error.issues.map((issue) => graphIssue(`operations.draft.json 兼容 GraphCommand 结构错误：${issue.path.join(".") || "(root)"} ${issue.message}`)),
        ],
      })
      return { ok: false as const, validation }
    }

    const command = normalizeCommand(parsed.data)
    await Promise.all([
      fs.writeFile(artifactPath(input.directory, "operations.json"), JSON.stringify(command, null, 2) + "\n", "utf8"),
      fs.writeFile(artifactPath(input.directory, "operation_index.json"), JSON.stringify(buildOperationIndex(command), null, 2) + "\n", "utf8"),
    ])
    return { ok: true as const, command }
  }

  export async function buildPreview(input: { directory: string }) {
    const validation = await readJsonFile(artifactPath(input.directory, "validation.json"), ValidationArtifact)
    if (!validation.passed) throw new Error("最近一次校验未通过，不能生成预览。")
    const command = await readJsonFile(artifactPath(input.directory, "operations.json"), GraphCommand)
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
    const preview = PreviewArtifact.parse({
      generatedAt: new Date().toISOString(),
      change_id: command.change_id,
      mode: "完整图谱预览",
      operationCount: command.operations.length,
      affectedIds: [...affected],
      note: "当前版本只生成预览元数据；图谱渲染层后续读取 operations 后叠加高亮。",
    })
    await fs.writeFile(artifactPath(input.directory, "preview.json"), JSON.stringify(preview, null, 2) + "\n", "utf8")
    return preview
  }

  export async function runAction(input: ProjectWorkflow.ActionRequest & { directory?: string }) {
    const directory = input.directory ?? ProjectWorkflow.projectDirectory(input.project)

    if (input.action === "更新工作笔记") {
      const payload = NoteWritePayload.parse(input.payload)
      await ProjectWorkflow.runAction({ project: input.project, directory, action: "开始或恢复", payload: {} })
      await writeNote({ directory, content: payload.content })
      return runAction({
        project: input.project,
        directory,
        action: "同步工作笔记变更",
        payload: {
          summary: payload.summary,
          source: payload.source,
          sourcePath: payload.sourcePath,
        },
      })
    }

    if (input.action === "同步工作笔记变更") {
      if (!(await fileExists(artifactPath(directory, "note.md")))) {
        return ProjectWorkflow.runAction(input)
      }
      await clearGraphDraftArtifacts({ directory, includeNoteReview: true })
      return ProjectWorkflow.runAction(input)
    }

    if (input.action === "生成图操作草案") {
      if (!(await fileExists(artifactPath(directory, "note.md")))) {
        return ProjectWorkflow.runAction(input)
      }
      const artifacts = input.payload?.artifacts
      if (artifacts && typeof artifacts === "object" && !Array.isArray(artifacts)) {
        await prepareOperationArtifactManifest({ directory, artifacts: artifacts as Record<string, unknown> })
      }
      const result = await ProjectWorkflow.runAction(input)
      const compiled = await compileOperationDraft({ directory })
      const validation = compiled.ok ? await validateOperations({ directory }) : compiled.validation
      const registered = await ProjectWorkflow.runAction({
        project: input.project,
        directory,
        action: "校验图操作",
        payload: {
          passed: validation.passed,
          summary: validation.passed ? "图操作草案通过自动校验。" : "图操作草案自动校验未通过，需要修订 operations.draft.json。",
        },
      })
      const refreshed = await ProjectWorkflow.getActive({ project: input.project, directory })
      return {
        ...refreshed,
        message: validation.passed ? result.message : "已登记图操作草案，但自动校验未通过，需要修订 operations.draft.json。",
        data: {
          ...result.data,
          ...registered.data,
          ...await operationArtifactStatus(directory),
          validation: {
            passed: validation.passed,
            issueCount: validation.issues.length,
            issues: validation.issues,
          },
        },
      }
    }

    if (input.action === "校验图操作") {
      if (!(await fs.stat(artifactPath(directory, "operations.json")).catch(() => undefined))) {
        return ProjectWorkflow.runAction(input)
      }
      const validation = await validateOperations({ directory })
      return ProjectWorkflow.runAction({
        ...input,
        directory,
        payload: {
          ...input.payload,
          passed: validation.passed,
          summary: validation.passed ? "图操作草案通过校验。" : "图操作草案校验未通过，需要修订图操作。",
        },
      })
    }

    if (input.action === "生成预览") {
      await buildPreview({ directory })
      return ProjectWorkflow.runAction(input)
    }

    if (input.action === "提出修订意见") {
      const target = typeof input.payload?.target === "string" ? input.payload.target : undefined
      const result = await ProjectWorkflow.runAction(input)
      if (target === "图操作") await clearValidationAndPreview(directory)
      else await clearGraphDraftArtifacts({ directory, includeNoteReview: true })
      const refreshed = await ProjectWorkflow.getActive({ project: input.project, directory })
      return { ...refreshed, message: result.message, data: result.data }
    }

    return ProjectWorkflow.runAction(input)
  }
}
