import fs from "fs/promises"
import path from "path"
import z from "zod"
import { GraphEngine } from "@/graph/engine"
import { EdgeType, GraphCommand, NodeType, type GraphCommand as GraphCommandData } from "@/graph/schema"
import { GraphStorage } from "@/graph/storage"
import { ProjectWorkflow } from "./state"
import { loadExpandedGraph } from "../../standalone-graph/transform"
import type { GraphPayload } from "../../standalone-graph/types"

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

  const operationArtifactDefinitions: { key: keyof ProjectWorkflow.State["artifacts"]; label: string; type: "markdown" | "json" }[] = [
    { key: "operationNotes", label: "图操作说明", type: "markdown" },
    { key: "changelogEntry", label: "changelog 增量", type: "markdown" },
    { key: "operations", label: "可执行图操作", type: "json" },
    { key: "validation", label: "校验结果", type: "json" },
    { key: "operationsDraft", label: "中间草案 JSON", type: "json" },
    { key: "operationIndex", label: "图操作索引 JSON", type: "json" },
    { key: "preview", label: "预览数据 JSON", type: "json" },
  ]

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
    graphDirectory: z.string().optional(),
    graph: z.unknown().optional(),
    change: z.object({
      createdNodeIds: z.array(z.string()).default([]),
      updatedNodeIds: z.array(z.string()).default([]),
      affectedNodeIds: z.array(z.string()).default([]),
      createdEdgeIds: z.array(z.string()).default([]),
      updatedEdgeIds: z.array(z.string()).default([]),
      affectedEdgeIds: z.array(z.string()).default([]),
      focusNodeId: z.string().optional(),
      focusEdgeId: z.string().optional(),
    }).optional(),
  }).passthrough()
  export type PreviewArtifact = z.infer<typeof PreviewArtifact>

  export const ApplyResultArtifact = z.object({
    appliedAt: z.string(),
    change_id: z.string(),
    success: z.boolean(),
    snapshot: z.string().optional(),
    operationsPath: z.string(),
    archivePath: z.string().optional(),
    notePath: z.string().optional(),
    result: z.unknown().optional(),
    errors: z.array(z.string()).default([]),
  }).passthrough()
  export type ApplyResultArtifact = z.infer<typeof ApplyResultArtifact>

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
    note_filename: z.string().min(1, "必须写入语义化工作笔记文件名"),
    description: z.string().optional(),
    changelog_entry: z.string().min(1, "必须写入本次 changelog 增量"),
    items: z.array(OperationDraftItem),
    review_notes: z.array(z.string()).default([]),
  }).passthrough().superRefine((draft, ctx) => {
    if (!draft.changelog_entry.includes(draft.change_id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["changelog_entry"],
        message: `changelog_entry 必须包含 change_id：${draft.change_id}`,
      })
    }
    const rawNoteFileBase = String(draft.note_filename).replace(/\.md$/iu, "")
    const noteFileBase = safePathSegment(rawNoteFileBase)
    const changeIDBase = safePathSegment(draft.change_id)
    if (!/[A-Za-z0-9]/u.test(rawNoteFileBase)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["note_filename"],
        message: "note_filename 必须包含英文或数字语义片段，建议使用英文/拼音 snake_case，不能只依赖安全转义生成文件名。",
      })
    }
    if (noteFileBase === changeIDBase) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["note_filename"],
        message: "note_filename 必须是根据工作笔记主题生成的语义化文件名，不能机械使用 change_id。",
      })
    }
    for (const field of ["operations", "commands", "history_descriptions", "operation_index", "validation", "preview"]) {
      if (field in draft) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `压缩 draft 顶层不允许写 ${field}；请只写 change_id、timestamp、note_filename、changelog_entry、items，并把历史说明写入每个 item.history。`,
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

  function previewGraphDir(directory: string) {
    return artifactPath(directory, "preview_graph")
  }

  function previewGraphBuildDir(directory: string) {
    return artifactPath(directory, "preview_graph.building")
  }

  function applyBackupDir(directory: string) {
    return artifactPath(directory, "apply_backup.building")
  }

  function appliedRoot(directory: string) {
    return path.join(directory, "workflows", "applied")
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

  function safePathSegment(value: string) {
    return value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "applied"
  }

  function escapeRegExp(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  }

  function stripHistoryVersionPrefix(description: string, version: string) {
    return description.replace(new RegExp(`^\\[${escapeRegExp(version)}\\]\\s*`, "u"), "")
  }

  function notePathForFilename(filename: string) {
    const base = filename.replace(/\.md$/iu, "")
    return `notes/${safePathSegment(base)}.md`
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

  function historySectionText(value: string | undefined) {
    if (!value) return ""
    const match = value.match(/\n{0,2}历史记录：\s*\n?([\s\S]*)$/u)
    return match?.[1] || ""
  }

  function normalizeReadableHistoryLines(value: string | undefined) {
    const section = value?.includes("历史记录：") ? historySectionText(value) : value || ""
    const lines: string[] = []
    for (const rawLine of section.split(/\r?\n/u)) {
      const trimmed = rawLine.trim()
      if (!trimmed) continue
      const bulletMatch = trimmed.match(/^(?:[-*]\s*)+(.+)$/u)
      if (bulletMatch?.[1]) {
        lines.push(bulletMatch[1].trim())
        continue
      }
      if (lines.length) lines[lines.length - 1] = `${lines[lines.length - 1]}\n${trimmed}`
      else lines.push(trimmed)
    }
    return lines.filter((line) => line.trim())
  }

  function renderReadableHistory(lines: string[]) {
    return lines.map((line) => `- ${line.replace(/\n/g, "\n  ")}`).join("\n")
  }

  function ensureHistoryChangeID(line: string, changeID: string) {
    const normalized = line.trim().replace(/^(?:[-*]\s*)+/u, "").trim()
    if (!normalized) return ""
    if (/^\[[^\]]+\]\s*/u.test(normalized)) return normalized
    return `[${changeID}] ${normalized}`
  }

  function appendHistoryContexts(line: string, contexts: string[]) {
    const additions = contexts
      .map((context) => context.trim())
      .filter((context, index, values) => context && values.indexOf(context) === index && !line.includes(context))
    if (!additions.length) return line
    const base = line.replace(/[。；;]\s*$/u, "")
    return `${base}；${additions.join("；")}`
  }

  function formatCurrentHistory(changeID: string, currentHistory: string | undefined, contexts: string[] = []) {
    const lines = normalizeReadableHistoryLines(currentHistory)
      .map((line) => ensureHistoryChangeID(line, changeID))
      .filter(Boolean)
    if (!lines.length) return undefined
    lines[0] = appendHistoryContexts(lines[0], contexts)
    return lines.join("\n")
  }

  function descriptionWithReadableHistory(
    description: string | undefined,
    existingDescription: string | undefined,
    currentHistory: string | undefined,
  ) {
    const base = stripEmbeddedHistoryText(description || "")
    const lines = [
      ...normalizeReadableHistoryLines(currentHistory),
      ...normalizeReadableHistoryLines(existingDescription),
    ]
    if (!lines.length) return base
    const historySection = `历史记录：\n${renderReadableHistory(lines)}`
    return base ? `${base}\n\n${historySection}` : historySection
  }

  type NodeInfo = {
    id: string
    type: z.infer<typeof NodeType>
    summary?: string
  }

  const nodeTypeLabel: Record<z.infer<typeof NodeType>, string> = {
    event: "事件",
    issue: "问题",
    goal: "目标",
    work_item: "工作项",
    result: "结果",
    work_block: "工作块",
  }

  function nodeLabel(info: NodeInfo | undefined, fallbackID: string) {
    return info?.summary || fallbackID
  }

  function nodeLabelWithKind(info: NodeInfo | undefined, fallbackID: string, kind: string) {
    const label = nodeLabel(info, fallbackID)
    return label.includes(kind) ? label : `${label}${kind}`
  }

  function typedNodeIDLabel(info: NodeInfo | undefined, fallbackID: string) {
    const type = info?.type ? nodeTypeLabel[info.type] : "节点"
    return `${type}节点id: ${fallbackID}`
  }

  function addHistoryContext(contexts: Map<string, string[]>, targetID: string | undefined, context: string) {
    if (!targetID || !context.trim()) return
    const list = contexts.get(targetID) || []
    if (!list.includes(context)) list.push(context)
    contexts.set(targetID, list)
  }

  function relationContextForSource(source: NodeInfo | undefined, target: NodeInfo | undefined, targetID: string, edgeType: z.infer<typeof EdgeType>) {
    const targetName = nodeLabel(target, targetID)
    if (source?.type === "work_item" && target?.type === "result" && (edgeType === "creates" || edgeType === "modifies_work")) {
      return `工作项产出${nodeLabelWithKind(target, targetID, "结果")}（${typedNodeIDLabel(target, targetID)}）`
    }
    if (source?.type === "result" && target?.type === "goal") {
      return `结果影响${targetName}（${typedNodeIDLabel(target, targetID)}）`
    }
    if (source?.type === "result" && target?.type === "issue") {
      return `结果影响${targetName}（${typedNodeIDLabel(target, targetID)}）`
    }
    if (source?.type === "work_item" && target?.type === "work_item" && edgeType === "next") {
      return `工作项后续衔接${targetName}（${typedNodeIDLabel(target, targetID)}）`
    }
    if (target?.type) return `${source?.type ? nodeTypeLabel[source.type] : "节点"}通过${edgeType}关系连接${targetName}（${typedNodeIDLabel(target, targetID)}）`
    return `节点通过${edgeType}关系连接${targetID}（节点id: ${targetID}）`
  }

  function relationContextForTarget(source: NodeInfo | undefined, sourceID: string, target: NodeInfo | undefined, edgeType: z.infer<typeof EdgeType>) {
    const sourceName = nodeLabel(source, sourceID)
    if (target?.type === "goal" && source?.type === "result") {
      return `此目标被${nodeLabelWithKind(source, sourceID, "结果")}影响（${typedNodeIDLabel(source, sourceID)}）`
    }
    if (target?.type === "issue" && source?.type === "result") {
      return `此问题被${nodeLabelWithKind(source, sourceID, "结果")}影响（${typedNodeIDLabel(source, sourceID)}）`
    }
    if (target?.type === "result" && source?.type === "work_item" && (edgeType === "creates" || edgeType === "modifies_work")) {
      return `结果由${nodeLabelWithKind(source, sourceID, "工作项")}产生（${typedNodeIDLabel(source, sourceID)}）`
    }
    if (target?.type === "work_item" && source?.type === "work_item" && edgeType === "next") {
      return `工作项承接${sourceName}（${typedNodeIDLabel(source, sourceID)}）`
    }
    if (source?.type) return `此${target?.type ? nodeTypeLabel[target.type] : "节点"}被${sourceName}通过${edgeType}关系连接（${typedNodeIDLabel(source, sourceID)}）`
    return `此节点被${sourceID}通过${edgeType}关系连接（节点id: ${sourceID}）`
  }

  function relationContextForEdge(source: NodeInfo | undefined, sourceID: string, target: NodeInfo | undefined, targetID: string, edgeType: z.infer<typeof EdgeType>) {
    return `建立${nodeLabel(source, sourceID)}到${nodeLabel(target, targetID)}的${edgeType}关系（${typedNodeIDLabel(source, sourceID)}；${typedNodeIDLabel(target, targetID)}）`
  }

  async function buildHistoryContexts(directory: string, draft: WorkflowOperationDraft) {
    const storage = new GraphStorage(directory)
    const contexts = new Map<string, string[]>()
    const nodeInfos = new Map<string, NodeInfo>()

    for (const item of draft.items) {
      if (item.kind === "create_node") {
        nodeInfos.set(item.temp_id, {
          id: item.temp_id,
          type: item.node_type,
          summary: item.summary,
        })
      }
    }

    const getNodeInfo = async (nodeID: string): Promise<NodeInfo | undefined> => {
      const cached = nodeInfos.get(nodeID)
      if (cached) return cached
      const node = await storage.getNodeById(nodeID)
      if (!node) return undefined
      const info = { id: node.id, type: node.type, summary: node.summary }
      nodeInfos.set(nodeID, info)
      return info
    }

    const linkedWorkBlockContext = async (targetID: string, workBlockID: string) => {
      const block = await getNodeInfo(workBlockID)
      addHistoryContext(contexts, targetID, `工作项被${nodeLabelWithKind(block, workBlockID, "工作块")}归属（工作块节点id: ${workBlockID}）`)
    }

    const linkedGoalContext = async (targetID: string, goalID: string) => {
      const goal = await getNodeInfo(goalID)
      addHistoryContext(contexts, targetID, `工作块服务于${nodeLabelWithKind(goal, goalID, "目标")}（目标节点id: ${goalID}）`)
    }

    for (const item of draft.items) {
      if (item.kind === "create_node" && item.node_type === "work_item" && typeof item.fields.linked_work_block_id === "string") {
        await linkedWorkBlockContext(item.temp_id, item.fields.linked_work_block_id)
      }
      if (item.kind === "update_node") {
        const node = await getNodeInfo(item.node_id)
        if (node?.type === "work_item" && typeof item.field_updates.linked_work_block_id === "string") {
          await linkedWorkBlockContext(item.node_id, item.field_updates.linked_work_block_id)
        }
        if (node?.type === "work_block" && typeof item.field_updates.linked_goal_id === "string") {
          await linkedGoalContext(item.node_id, item.field_updates.linked_goal_id)
        }
      }
      if (item.kind === "create_node" && item.node_type === "work_block" && typeof item.fields.linked_goal_id === "string") {
        await linkedGoalContext(item.temp_id, item.fields.linked_goal_id)
      }
    }

    for (const item of draft.items) {
      if (item.kind !== "create_edge") continue
      const source = await getNodeInfo(item.from_node)
      const target = await getNodeInfo(item.to_node)
      addHistoryContext(contexts, item.from_node, relationContextForSource(source, target, item.to_node, item.edge_type))
      addHistoryContext(contexts, item.to_node, relationContextForTarget(source, item.from_node, target, item.edge_type))
      addHistoryContext(contexts, item.temp_id, relationContextForEdge(source, item.from_node, target, item.to_node, item.edge_type))
    }

    for (const item of draft.items) {
      if (item.kind !== "update_edge") continue
      const edge = await storage.loadEdge(item.edge_id)
      if (!edge) continue
      const source = await getNodeInfo(edge.from_node_id)
      const target = await getNodeInfo(edge.to_node_id)
      addHistoryContext(contexts, item.edge_id, `更新${nodeLabel(source, edge.from_node_id)}到${nodeLabel(target, edge.to_node_id)}的${edge.type}关系（${typedNodeIDLabel(source, edge.from_node_id)}；${typedNodeIDLabel(target, edge.to_node_id)}）`)
    }

    return contexts
  }

  function timestampValue(input: WorkflowOperationDraft["timestamp"]) {
    return typeof input === "string" ? input : input.value
  }

  async function compileCompressedDraft(directory: string, draft: WorkflowOperationDraft): Promise<GraphCommandData> {
    const storage = new GraphStorage(directory)
    const operations: GraphCommandData["operations"] = []
    const historyDescriptions: Record<string, string> = {}
    const historyContexts = await buildHistoryContexts(directory, draft)

    for (const item of draft.items) {
      const currentHistory = (targetID: string | undefined) => formatCurrentHistory(draft.change_id, item.history, targetID ? historyContexts.get(targetID) : undefined)
      if (item.kind === "create_node") {
        const history = currentHistory(item.temp_id)
        const description = descriptionWithReadableHistory(item.description, undefined, history)
        operations.push({
          type: "create_node",
          temp_id: item.temp_id,
          data: dropUndefined({
            ...item.fields,
            type: item.node_type,
            summary: item.summary,
            description,
          }) as Record<string, unknown> & { type: z.infer<typeof NodeType> },
        })
        if (history) historyDescriptions[item.temp_id] = history
        continue
      }

      if (item.kind === "update_node") {
        const updates: Record<string, unknown> = { ...item.field_updates }
        const node = await storage.getNodeById(item.node_id)
        const history = currentHistory(item.node_id)
        if (item.description !== undefined) {
          updates.description = descriptionWithReadableHistory(item.description, node?.description, history)
        } else if (item.description_delta !== undefined) {
          updates.description = descriptionWithReadableHistory(appendDescriptionDelta(node?.description, item.description_delta), node?.description, history)
        } else if (history) {
          updates.description = descriptionWithReadableHistory(node?.description, node?.description, history)
        }
        operations.push({
          type: "update_node",
          node_id: item.node_id,
          updates,
        })
        if (history) historyDescriptions[item.node_id] = history
        continue
      }

      if (item.kind === "create_edge") {
        const history = currentHistory(item.temp_id)
        operations.push({
          type: "create_edge",
          temp_id: item.temp_id,
          from_node: item.from_node,
          to_node: item.to_node,
          edge_type: item.edge_type,
          description: descriptionWithReadableHistory(item.description, undefined, history),
        })
        if (history && item.temp_id) historyDescriptions[item.temp_id] = history
        continue
      }

      if (item.kind === "update_edge") {
        const edge = await storage.loadEdge(item.edge_id)
        const history = currentHistory(item.edge_id)
        const nextDescription = item.new_description !== undefined
          ? descriptionWithReadableHistory(item.new_description, edge?.description, history)
          : item.description_delta !== undefined
            ? descriptionWithReadableHistory(appendDescriptionDelta(edge?.description, item.description_delta), edge?.description, history)
            : history
              ? descriptionWithReadableHistory(edge?.description, edge?.description, history)
              : undefined
        operations.push({
          type: "update_edge",
          edge_id: item.edge_id,
          new_description: nextDescription,
          reason: item.reason,
        })
        if (history) historyDescriptions[item.edge_id] = history
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
    return GraphCommand.parse(command)
  }

  async function writeChangelogDraft(directory: string, entry: string | undefined) {
    await fs.rm(artifactPath(directory, "changelog_entry.txt"), { force: true })
    if (entry?.trim()) await fs.writeFile(artifactPath(directory, "changelog_entry.txt"), entry.trim() + "\n", "utf8")
  }

  async function uniqueNotePath(directory: string, preferredPath: string) {
    const parsed = path.parse(preferredPath)
    let candidate = preferredPath
    let index = 1
    while (await fileExists(path.join(directory, candidate))) {
      index += 1
      candidate = path.join(parsed.dir, `${parsed.name}_${index}${parsed.ext || ".md"}`)
    }
    return candidate
  }

  function notePathFromCommandDetailUrl(command: GraphCommandData) {
    for (const operation of command.operations) {
      if (operation.type === "create_node" && operation.data.type === "work_item" && typeof operation.data.detail_url === "string") {
        return operation.data.detail_url
      }
      if (operation.type === "update_node" && typeof operation.updates.detail_url === "string") return operation.updates.detail_url
    }
    return undefined
  }

  async function commandWithWorkflowNoteLink(directory: string, command: GraphCommandData, noteFilename?: string) {
    const note = await readOptionalText(artifactPath(directory, "note.md"))
    if (!note?.trim()) return { command, note, notePath: undefined, changed: false }

    const commandNotePath = notePathFromCommandDetailUrl(command)
    if (!noteFilename && !commandNotePath) {
      throw new Error("operations.json 缺少由 note_filename 编译得到的 work_item.detail_url，不能用 change_id 机械归档工作笔记。")
    }
    const preferredNotePath = noteFilename ? notePathForFilename(noteFilename) : commandNotePath!
    const notePath = noteFilename ? await uniqueNotePath(directory, preferredNotePath) : preferredNotePath
    const storage = new GraphStorage(directory)
    let changed = false
    const operations = await Promise.all(command.operations.map(async (operation) => {
      if (operation.type === "create_node" && operation.data.type === "work_item") {
        if (operation.data.detail_url === notePath) return operation
        changed = true
        return {
          ...operation,
          data: {
            ...operation.data,
            detail_url: notePath,
          },
        }
      }
      if (operation.type === "update_node") {
        const node = await storage.getNodeById(operation.node_id)
        const nextType = typeof operation.updates.type === "string" ? operation.updates.type : node?.type
        if (nextType !== "work_item") return operation
        if (operation.updates.detail_url === notePath) return operation
        changed = true
        return {
          ...operation,
          updates: {
            ...operation.updates,
            detail_url: notePath,
          },
        }
      }
      return operation
    }))

    return {
      command: changed ? GraphCommand.parse({ ...command, operations }) : command,
      note,
      notePath,
      changed,
    }
  }

  function graphEdgeRenderId(edge: { from_node_id: string; to_node_id: string; type: string }) {
    return `${edge.from_node_id}|${edge.to_node_id}|${edge.type}`
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

  function nodeLabelFromCommandOrStorage(input: {
    nodeId: string
    command: GraphCommandData
    storageNodes: Map<string, { summary?: string; type?: string }>
  }) {
    const created = input.command.operations.find((operation) => operation.type === "create_node" && operation.temp_id === input.nodeId)
    if (created?.type === "create_node") return String(created.data.summary || created.temp_id)
    const existing = input.storageNodes.get(input.nodeId)
    return existing?.summary || input.nodeId
  }

  type OperationIndexEdgeGroupInput = {
    operation: Extract<GraphCommandData["operations"][number], { type: "create_edge" | "update_edge" }>
    index: number
    sourceNodeId: string
    targetNodeId: string
    edgeType: string
    renderEdgeId: string
    description?: string
    historyTargetId?: string
  }

  async function buildOperationIndex(command: GraphCommandData, directory: string) {
    const storage = new GraphStorage(directory)
    const storageNodes = new Map<string, { summary?: string; type?: string }>()
    const updateEdgeInfo = new Map<string, { sourceNodeId: string; targetNodeId: string; edgeType: string; renderEdgeId: string }>()
    for (const operation of command.operations) {
      if (operation.type === "update_node") {
        const node = await storage.getNodeById(operation.node_id)
        if (node) storageNodes.set(node.id, { summary: node.summary, type: node.type })
      }
      if (operation.type === "create_edge" || operation.type === "update_edge") {
        const refs = operation.type === "create_edge"
          ? [operation.from_node, operation.to_node]
          : []
        for (const ref of refs) {
          if (!storageNodes.has(ref)) {
            const node = await storage.getNodeById(ref)
            if (node) storageNodes.set(node.id, { summary: node.summary, type: node.type })
          }
        }
      }
      if (operation.type === "update_edge") {
        const edge = await storage.loadEdge(operation.edge_id)
        if (edge) {
          updateEdgeInfo.set(operation.edge_id, {
            sourceNodeId: edge.from_node_id,
            targetNodeId: edge.to_node_id,
            edgeType: edge.type,
            renderEdgeId: graphEdgeRenderId(edge),
          })
          for (const ref of [edge.from_node_id, edge.to_node_id]) {
            if (!storageNodes.has(ref)) {
              const node = await storage.getNodeById(ref)
              if (node) storageNodes.set(node.id, { summary: node.summary, type: node.type })
            }
          }
        }
      }
    }
    const nodeIdsForOperation = (operation: GraphCommandData["operations"][number]) => {
      if (operation.type === "create_node") return [operation.temp_id]
      if (operation.type === "update_node") return [operation.node_id]
      if (operation.type === "create_edge") return [operation.from_node, operation.to_node]
      if (operation.type === "update_edge") {
        const edge = updateEdgeInfo.get(operation.edge_id)
        return edge ? [edge.sourceNodeId, edge.targetNodeId] : []
      }
      return []
    }
    const childNodeIdsForOperation = (operation: GraphCommandData["operations"][number]) => {
      if (operation.type === "create_edge" || operation.type === "update_edge") return []
      return nodeIdsForOperation(operation)
    }
    const edgeIdsForOperation = (operation: GraphCommandData["operations"][number]) => {
      if (operation.type === "create_edge") return [`${operation.from_node}|${operation.to_node}|${operation.edge_type}`]
      if (operation.type === "update_edge") return [updateEdgeInfo.get(operation.edge_id)?.renderEdgeId || operation.edge_id]
      return []
    }
    const nodeOperationFor = (nodeId: string) => command.operations
      .map((operation, index) => ({ operation, index }))
      .find(({ operation }) =>
        (operation.type === "create_node" && operation.temp_id === nodeId)
        || (operation.type === "update_node" && operation.node_id === nodeId),
      )
    const childEntry = (operation: GraphCommandData["operations"][number], index: number) => ({
      index,
      kind: operationKind(operation),
      title: operationTitle(operation),
      targetIds: operationTargets(operation),
      nodeIds: childNodeIdsForOperation(operation),
      edgeIds: edgeIdsForOperation(operation),
      history_entry: operationTargets(operation).map((target) => command.history_descriptions[target]).find(Boolean) || "",
    })
    const edgeGroup = (input: OperationIndexEdgeGroupInput) => {
      const sourceTitle = nodeLabelFromCommandOrStorage({ nodeId: input.sourceNodeId, command, storageNodes })
      const targetTitle = nodeLabelFromCommandOrStorage({ nodeId: input.targetNodeId, command, storageNodes })
      const sourceChild = nodeOperationFor(input.sourceNodeId)
      const targetChild = nodeOperationFor(input.targetNodeId)
      const childCandidates = [sourceChild, { operation: input.operation, index: input.index }, targetChild].filter((child): child is { operation: GraphCommandData["operations"][number]; index: number } => !!child)
      const seen = new Set<number>()
      const children = childCandidates.filter((child) => {
        if (seen.has(child.index)) return false
        seen.add(child.index)
        groupedOperationIndices.add(child.index)
        return true
      }).map((child) => childEntry(child.operation, child.index))
      return {
        index: input.index,
        kind: "关系组",
        title: `${sourceTitle} -[${input.edgeType}]-> ${targetTitle}`,
        description: input.description || command.history_descriptions[input.historyTargetId || ""] || "",
        sourceNodeId: input.sourceNodeId,
        targetNodeId: input.targetNodeId,
        edgeId: input.renderEdgeId,
        targetIds: [input.sourceNodeId, input.renderEdgeId, input.targetNodeId],
        nodeIds: [input.sourceNodeId, input.targetNodeId],
        edgeIds: [input.renderEdgeId],
        children,
      }
    }
    const groupedOperationIndices = new Set<number>()
    const edgeGroups = command.operations.flatMap((operation, index) => {
      if (operation.type === "create_edge") {
        return [edgeGroup({
          operation,
          index,
          sourceNodeId: operation.from_node,
          targetNodeId: operation.to_node,
          edgeType: operation.edge_type,
          renderEdgeId: `${operation.from_node}|${operation.to_node}|${operation.edge_type}`,
          description: operation.description,
          historyTargetId: operation.temp_id,
        })]
      }
      if (operation.type === "update_edge") {
        const edge = updateEdgeInfo.get(operation.edge_id)
        if (!edge) return []
        return [edgeGroup({
          operation,
          index,
          sourceNodeId: edge.sourceNodeId,
          targetNodeId: edge.targetNodeId,
          edgeType: edge.edgeType,
          renderEdgeId: edge.renderEdgeId,
          description: operation.new_description,
          historyTargetId: operation.edge_id,
        })]
      }
      return []
    })
    const standaloneGroups = command.operations.flatMap((operation, index) => {
      if (groupedOperationIndices.has(index)) return []
      const nodeIds = nodeIdsForOperation(operation)
      const edgeIds = edgeIdsForOperation(operation)
      return [{
        index,
        kind: operationKind(operation),
        title: operationTitle(operation),
        description: operationTargets(operation).map((target) => command.history_descriptions[target]).find(Boolean) || "",
        sourceNodeId: nodeIds[0] || "",
        targetNodeId: nodeIds[1] || "",
        edgeId: edgeIds[0] || "",
        targetIds: operationTargets(operation),
        nodeIds,
        edgeIds,
        children: [{
          index,
          kind: operationKind(operation),
          title: operationTitle(operation),
          targetIds: operationTargets(operation),
          nodeIds,
          edgeIds,
          history_entry: operationTargets(operation).map((target) => command.history_descriptions[target]).find(Boolean) || "",
        }],
      }]
    })
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
          nodeIds: nodeIdsForOperation(operation),
          edgeIds: edgeIdsForOperation(operation),
          history_entry: targets.map((target) => command.history_descriptions[target]).find(Boolean) || "",
        }
      }),
      groups: [...edgeGroups, ...standaloneGroups],
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
      "changelog_entry.txt",
      "operations.draft.json",
      "operations.json",
      "operation_index.json",
      "validation.json",
      "preview.json",
    ]
    await Promise.all([
      ...files.map((file) => fs.rm(artifactPath(input.directory, file), { force: true })),
      fs.rm(previewGraphDir(input.directory), { recursive: true, force: true }),
      fs.rm(previewGraphBuildDir(input.directory), { recursive: true, force: true }),
    ])
  }

  async function clearValidationAndPreview(directory: string) {
    await Promise.all([
      fs.rm(artifactPath(directory, "validation.json"), { force: true }),
      fs.rm(artifactPath(directory, "preview.json"), { force: true }),
      fs.rm(previewGraphDir(directory), { recursive: true, force: true }),
      fs.rm(previewGraphBuildDir(directory), { recursive: true, force: true }),
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
      fs.rm(artifactPath(input.directory, "changelog_entry.txt"), { force: true }),
      fs.rm(artifactPath(input.directory, "operation_index.json"), { force: true }),
      fs.rm(artifactPath(input.directory, "operations.json"), { force: true }),
      fs.rm(previewGraphDir(input.directory), { recursive: true, force: true }),
      fs.rm(previewGraphBuildDir(input.directory), { recursive: true, force: true }),
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
    const files = await Promise.all(operationArtifactDefinitions.map(async (definition) => {
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
      const command = (await commandWithWorkflowNoteLink(input.directory, normalizeCommand(await compileCompressedDraft(input.directory, draft.data)), draft.data.note_filename)).command
      await Promise.all([
        writeChangelogDraft(input.directory, draft.data.changelog_entry),
        fs.writeFile(artifactPath(input.directory, "operations.json"), JSON.stringify(command, null, 2) + "\n", "utf8"),
        fs.writeFile(artifactPath(input.directory, "operation_index.json"), JSON.stringify(await buildOperationIndex(command, input.directory), null, 2) + "\n", "utf8"),
      ])
      return { ok: true as const, command }
    }

    const validation = await writeValidation({
      directory: input.directory,
      passed: false,
      change_id: typeof raw === "object" && raw && "change_id" in raw ? String((raw as { change_id?: unknown }).change_id) : undefined,
      issues: draft.error.issues.map((issue) => graphIssue(`operations.draft.json 压缩草案结构错误：${issue.path.join(".") || "(root)"} ${issue.message}`)),
    })
    return { ok: false as const, validation }
  }

  export async function buildPreview(input: { directory: string }) {
    const validation = await readJsonFile(artifactPath(input.directory, "validation.json"), ValidationArtifact)
    if (!validation.passed) throw new Error("最近一次校验未通过，不能生成图谱预览。")
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
    const tempDirectory = previewGraphBuildDir(input.directory)
    const finalDirectory = previewGraphDir(input.directory)
    let graph: GraphPayload | undefined
    let change: PreviewArtifact["change"] | undefined
    try {
      await Promise.all([
        fs.rm(artifactPath(input.directory, "preview.json"), { force: true }),
        fs.rm(tempDirectory, { recursive: true, force: true }),
      ])
      await fs.mkdir(tempDirectory, { recursive: true })
      for (const entry of ["nodes", "edges", "changes", "snapshots", "metadata"]) {
        const source = path.join(input.directory, entry)
        if (await fileExists(source)) {
          await fs.cp(source, path.join(tempDirectory, entry), { recursive: true })
        }
      }
      const engine = new GraphEngine(new GraphStorage(tempDirectory))
      const result = await engine.executeCommand(command)
      if (!result.success) throw new Error(`预览 dry-run 执行失败：${result.errors.join("; ")}`)
      graph = await loadExpandedGraph(tempDirectory)
      const storage = new GraphStorage(tempDirectory)
      const createdEdgeIds = await Promise.all(Object.values(result.created_edges).map(async (id) => {
        const edge = await storage.loadEdge(id)
        return edge ? graphEdgeRenderId(edge) : id
      }))
      const updatedEdgeIds = await Promise.all(Object.keys(result.updated_edges).map(async (id) => {
        const edge = await storage.loadEdge(id)
        return edge ? graphEdgeRenderId(edge) : id
      }))
      const affectedEdgeIds = await Promise.all((result.affected_edges || []).map(async (id) => {
        const edge = await storage.loadEdge(id)
        return edge ? graphEdgeRenderId(edge) : id
      }))
      change = {
        createdNodeIds: Object.values(result.created_nodes),
        updatedNodeIds: Object.keys(result.updated_nodes).map((id) => result.created_nodes[id] || id),
        affectedNodeIds: result.affected_nodes || [],
        createdEdgeIds,
        updatedEdgeIds,
        affectedEdgeIds,
        focusNodeId: Object.values(result.created_nodes)[0] || Object.keys(result.updated_nodes)[0],
        focusEdgeId: createdEdgeIds[0] || updatedEdgeIds[0],
      }
      await fs.rm(finalDirectory, { recursive: true, force: true })
      await fs.rename(tempDirectory, finalDirectory)
    } catch (error) {
      await fs.rm(tempDirectory, { recursive: true, force: true })
      throw error
    }
    const preview = PreviewArtifact.parse({
      generatedAt: new Date().toISOString(),
      change_id: command.change_id,
      mode: "full-graph",
      operationCount: command.operations.length,
      affectedIds: [...affected],
      graphDirectory: "workflows/active/preview_graph",
      graph,
      change,
      note: "预览图谱由 workflows/active/preview_graph dry-run 生成，正式图数据尚未改变。",
    })
    await fs.writeFile(artifactPath(input.directory, "preview.json"), JSON.stringify(preview, null, 2) + "\n", "utf8")
    return preview
  }

  async function backupGraphData(directory: string) {
    const backup = applyBackupDir(directory)
    await fs.rm(backup, { recursive: true, force: true })
    await fs.mkdir(backup, { recursive: true })
    const entries = ["nodes", "edges", "changes", "snapshots", "metadata", "descriptions_output", "notes"]
    const existed: string[] = []
    for (const entry of entries) {
      const source = path.join(directory, entry)
      if (await fileExists(source)) {
        existed.push(entry)
        await fs.cp(source, path.join(backup, entry), { recursive: true })
      }
    }
    await fs.writeFile(path.join(backup, "manifest.json"), JSON.stringify({ entries, existed }, null, 2) + "\n", "utf8")
    return { backup, entries, existed }
  }

  async function restoreGraphData(directory: string, backup: { backup: string; entries: string[]; existed: string[] }) {
    for (const entry of backup.entries) {
      await fs.rm(path.join(directory, entry), { recursive: true, force: true })
      if (backup.existed.includes(entry)) {
        await fs.cp(path.join(backup.backup, entry), path.join(directory, entry), { recursive: true })
      }
    }
  }

  async function cleanupApplyBackup(directory: string) {
    await fs.rm(applyBackupDir(directory), { recursive: true, force: true })
  }

  async function cleanupArchivedApplyBackup(archiveDirectory: string) {
    await fs.rm(path.join(archiveDirectory, "apply_backup.building"), { recursive: true, force: true })
  }

  function nodeStatusLine(node: Awaited<ReturnType<GraphStorage["getAllNodes"]>>[number]) {
    const parts = [`状态: ${node.status}`]
    if ("completion_score" in node && typeof node.completion_score === "number") parts.push(`完成度: ${node.completion_score}%`)
    if ("resolution_score" in node && typeof node.resolution_score === "number") parts.push(`解决度: ${node.resolution_score}%`)
    return `[${parts.join(" | ")}]`
  }

  export async function refreshDescriptionOutputs(directory: string) {
    const storage = new GraphStorage(directory)
    const summaryDir = path.join(directory, "descriptions_output", "description_summary")
    const historyDir = path.join(directory, "descriptions_output", "history")
    await Promise.all([
      fs.rm(summaryDir, { recursive: true, force: true }),
      fs.rm(historyDir, { recursive: true, force: true }),
    ])
    await Promise.all([
      fs.mkdir(summaryDir, { recursive: true }),
      fs.mkdir(historyDir, { recursive: true }),
    ])

    for (const node of await storage.getAllNodes()) {
      const description = stripEmbeddedHistoryText(node.description || "")
      const summary = `${nodeStatusLine(node)}\n\n${description || node.summary || node.id}`.trimEnd() + "\n"
      const history = node.history.map((item) => `- [${item.version}] ${stripHistoryVersionPrefix(item.description, item.version)}`).join("\n")
      await Promise.all([
        fs.writeFile(path.join(summaryDir, `${node.id}.txt`), summary, "utf8"),
        fs.writeFile(path.join(historyDir, `${node.id}.txt`), history ? history + "\n" : "", "utf8"),
      ])
    }
  }

  async function readChangelogEntry(directory: string, command: GraphCommandData) {
    const rawEntry = await readOptionalText(artifactPath(directory, "changelog_entry.txt"))
    const entry = rawEntry?.trim()
    if (!entry) throw new Error("缺少 workflows/active/changelog_entry.txt；生成图操作草案时必须由大模型写入本次 changelog 增量。")
    if (!entry.includes(command.change_id)) throw new Error(`changelog_entry.txt 必须包含 change_id：${command.change_id}`)
    return entry.startsWith("[") ? entry : `[${command.timestamp}] ${entry}`
  }

  async function appendChangelog(directory: string, line: string) {
    const changelog = path.join(directory, "changes", "changelog.txt")
    await fs.mkdir(path.dirname(changelog), { recursive: true })
    const existing = await readOptionalText(changelog)
    const prefix = existing?.trim() ? `${existing.trimEnd()}\n\n` : ""
    await fs.writeFile(changelog, `${prefix}${line}\n`, "utf8")
  }

  async function writeStepArtifact(input: {
    directory: string
    command: GraphCommandData
    operationNotes?: string
    applyResult: ApplyResultArtifact
    workflowDir?: string
    applyResultPath?: string
  }) {
    const workflowDir = input.workflowDir ?? activeDir(input.directory)
    const applyResultPath = input.applyResultPath ?? "workflows/active/apply_result.json"
    const note = await readOptionalText(path.join(workflowDir, "note.md"))
    const body = [
      `# ${input.command.change_id}`,
      "",
      `- 工作时间：${input.command.timestamp}`,
      `- 应用时间：${input.applyResult.appliedAt}`,
      `- 快照：${input.applyResult.snapshot || "未生成"}`,
      "",
      "## 工作笔记",
      "",
      note?.trim() || "无",
      "",
      "## 图操作说明",
      "",
      input.operationNotes?.trim() || input.command.description || "无",
      "",
      "## 应用结果",
      "",
      `- 成功：${input.applyResult.success ? "是" : "否"}`,
      `- 操作数：${input.command.operations.length}`,
      `- apply_result：${applyResultPath}`,
    ].join("\n")
    await fs.writeFile(path.join(workflowDir, "step.md"), body.trimEnd() + "\n", "utf8")
  }

  async function nextAppliedWorkflowTarget(directory: string, changeID: string) {
    await fs.mkdir(appliedRoot(directory), { recursive: true })
    const base = path.join(appliedRoot(directory), safePathSegment(changeID))
    let target = base
    let index = 1
    while (await fileExists(target)) {
      index += 1
      target = `${base}_${index}`
    }
    return { target, archivePath: path.relative(directory, target) }
  }

  async function archiveAppliedWorkflow(directory: string, target: string) {
    const active = activeDir(directory)
    await fs.rename(active, target)
    await fs.mkdir(active, { recursive: true })
    return path.relative(directory, target)
  }

  async function writeActiveWorkflowState(directory: string, state: ProjectWorkflow.State) {
    await fs.writeFile(artifactPath(directory, "state.json"), JSON.stringify(ProjectWorkflow.State.parse(state), null, 2) + "\n", "utf8")
  }

  function appliedWorkflowState(state: ProjectWorkflow.State) {
    return ProjectWorkflow.State.parse({
      ...state,
      stage: "已应用",
      updatedAt: Date.now(),
      lastAction: "应用图操作",
      pendingConfirmation: undefined,
    })
  }

  async function writeApplyResult(directory: string, input: Omit<ApplyResultArtifact, "operationsPath"> & { operationsPath?: string }) {
    const result = ApplyResultArtifact.parse({
      ...input,
      operationsPath: input.operationsPath ?? "workflows/active/operations.json",
    })
    await fs.writeFile(artifactPath(directory, "apply_result.json"), JSON.stringify(result, null, 2) + "\n", "utf8")
    return result
  }

  async function saveWorkflowNoteToNotes(directory: string, notePath: string | undefined, note: string | undefined) {
    if (!notePath || !note?.trim()) return undefined
    const target = path.join(directory, notePath)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, note.trimEnd() + "\n", "utf8")
    return notePath
  }

  export async function applyOperations(input: { project: string; directory: string; confirm: boolean }): Promise<ProjectWorkflow.ActionResult> {
    if (!input.confirm) throw new Error("应用图操作需要 payload.confirm = true，并且必须来自用户明确确认。")
    const active = await ProjectWorkflow.getActive({ project: input.project, directory: input.directory })
    if (active.stage !== "图操作已生成") throw new Error("尚未生成可审核的图操作预览，不能应用图操作。")
    if (!active.state) throw new Error("缺少 active workflow state，不能应用图操作。")
    const originalState = active.state
    const validation = await readJsonFile(artifactPath(input.directory, "validation.json"), ValidationArtifact)
    if (!validation.passed) throw new Error("最近一次图操作校验未通过，不能应用图操作。")
    if (!(await fileExists(previewGraphDir(input.directory)))) throw new Error("缺少 preview_graph，不能应用图操作。")

    const prepared = await commandWithWorkflowNoteLink(input.directory, await readJsonFile(artifactPath(input.directory, "operations.json"), GraphCommand))
    const command = prepared.command
    if (prepared.changed) {
      await Promise.all([
        fs.writeFile(artifactPath(input.directory, "operations.json"), JSON.stringify(command, null, 2) + "\n", "utf8"),
        fs.writeFile(artifactPath(input.directory, "operation_index.json"), JSON.stringify(await buildOperationIndex(command, input.directory), null, 2) + "\n", "utf8"),
      ])
    }
    const postPrepareValidation = await new GraphEngine(new GraphStorage(input.directory)).validateCommand(command)
    const postPrepareErrors = postPrepareValidation.issues.filter((issue) => issue.severity === "error")
    if (postPrepareErrors.length) throw new Error(`图操作补充工作笔记引用后校验失败：${postPrepareErrors.map((issue) => issue.message).join("; ")}`)
    const changelogEntry = await readChangelogEntry(input.directory, command)
    const operationNotes = await readOptionalText(artifactPath(input.directory, "operation_notes.md"))
    const backup = await backupGraphData(input.directory)
    const archive = await nextAppliedWorkflowTarget(input.directory, command.change_id)
    let applyResult: ApplyResultArtifact | undefined
    let archivePath: string | undefined
    try {
      const engine = new GraphEngine(new GraphStorage(input.directory))
      const notePath = await saveWorkflowNoteToNotes(input.directory, prepared.notePath, prepared.note)
      const result = await engine.executeCommand(command)
      if (!result.success) throw new Error(result.errors.join("; ") || "图操作执行失败")
      applyResult = await writeApplyResult(input.directory, {
        appliedAt: new Date().toISOString(),
        change_id: command.change_id,
        success: true,
        snapshot: result.snapshot_created,
        operationsPath: `${archive.archivePath}/operations.json`,
        archivePath: archive.archivePath,
        result,
        notePath,
        errors: [],
      })
      await refreshDescriptionOutputs(input.directory)
      await appendChangelog(input.directory, changelogEntry)
      await writeStepArtifact({
        directory: input.directory,
        command,
        operationNotes,
        applyResult,
        applyResultPath: `${archive.archivePath}/apply_result.json`,
      })
      await writeActiveWorkflowState(input.directory, appliedWorkflowState(originalState))
      archivePath = await archiveAppliedWorkflow(input.directory, archive.target)
    } catch (error) {
      await restoreGraphData(input.directory, backup).catch(() => undefined)
      await cleanupApplyBackup(input.directory).catch(() => undefined)
      await writeActiveWorkflowState(input.directory, originalState).catch(() => undefined)
      const message = error instanceof Error ? error.message : String(error)
      await writeApplyResult(input.directory, {
        appliedAt: new Date().toISOString(),
        change_id: command.change_id,
        success: false,
        errors: [message],
      }).catch(() => undefined)
      throw error
    }

    await cleanupArchivedApplyBackup(path.join(input.directory, archivePath)).catch(() => undefined)
    const refreshed = await ProjectWorkflow.getActive({ project: input.project, directory: input.directory })
    return {
      ...refreshed,
      message: "图操作已应用到正式图数据，active workflow 已归档。",
      data: {
        applyResult,
        archivePath,
      },
    }
  }

  export async function runAction(input: ProjectWorkflow.ActionRequest & { directory?: string }): Promise<ProjectWorkflow.ActionResult> {
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
      let validation: ValidationArtifact
      let preview: PreviewArtifact | undefined
      try {
        const compiled = await compileOperationDraft({ directory })
        validation = compiled.ok ? await validateOperations({ directory }) : compiled.validation
        if (validation.passed) preview = await buildPreview({ directory })
      } catch (error) {
        validation = await writeValidation({
          directory,
          passed: false,
          issues: [graphIssue(`图操作草案执行层处理失败：${error instanceof Error ? error.message : String(error)}`)],
        })
      }
      const registered = await ProjectWorkflow.runAction({
        project: input.project,
        directory,
        action: "校验图操作",
        payload: {
          passed: validation.passed,
          summary: validation.passed ? "图操作草案通过自动校验，预览已同步生成。" : "图操作草案自动校验未通过，需要修订 operations.draft.json。",
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
          preview: preview ? {
            change_id: preview.change_id,
            operationCount: preview.operationCount,
            graphDirectory: preview.graphDirectory,
          } : undefined,
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

    if (input.action === "提出修订意见") {
      const target = typeof input.payload?.target === "string" ? input.payload.target : undefined
      const result = await ProjectWorkflow.runAction(input)
      if (target === "图操作") await clearValidationAndPreview(directory)
      else await clearGraphDraftArtifacts({ directory, includeNoteReview: true })
      const refreshed = await ProjectWorkflow.getActive({ project: input.project, directory })
      return { ...refreshed, message: result.message, data: result.data }
    }

    if (input.action === "应用图操作") {
      const confirm = input.payload?.confirm === true
      return applyOperations({ project: input.project, directory, confirm })
    }

    return ProjectWorkflow.runAction(input)
  }
}
