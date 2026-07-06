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

  function previewGraphDir(directory: string) {
    return artifactPath(directory, "preview_graph")
  }

  function previewGraphBuildDir(directory: string) {
    return artifactPath(directory, "preview_graph.building")
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

  function timestampValue(input: WorkflowOperationDraft["timestamp"]) {
    return typeof input === "string" ? input : input.value
  }

  async function compileCompressedDraft(directory: string, draft: WorkflowOperationDraft): Promise<GraphCommandData> {
    const storage = new GraphStorage(directory)
    const operations: GraphCommandData["operations"] = []
    const historyDescriptions: Record<string, string> = {}

    for (const item of draft.items) {
      if (item.kind === "create_node") {
        const description = descriptionWithReadableHistory(item.description, undefined, item.history)
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
        if (item.history) historyDescriptions[item.temp_id] = item.history
        continue
      }

      if (item.kind === "update_node") {
        const updates: Record<string, unknown> = { ...item.field_updates }
        const node = await storage.getNodeById(item.node_id)
        if (item.description !== undefined) {
          updates.description = descriptionWithReadableHistory(item.description, node?.description, item.history)
        } else if (item.description_delta !== undefined) {
          updates.description = descriptionWithReadableHistory(appendDescriptionDelta(node?.description, item.description_delta), node?.description, item.history)
        } else if (item.history) {
          updates.description = descriptionWithReadableHistory(node?.description, node?.description, item.history)
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
          description: descriptionWithReadableHistory(item.description, undefined, item.history),
        })
        if (item.history && item.temp_id) historyDescriptions[item.temp_id] = item.history
        continue
      }

      if (item.kind === "update_edge") {
        const edge = await storage.loadEdge(item.edge_id)
        const nextDescription = item.new_description !== undefined
          ? descriptionWithReadableHistory(item.new_description, edge?.description, item.history)
          : item.description_delta !== undefined
            ? descriptionWithReadableHistory(appendDescriptionDelta(edge?.description, item.description_delta), edge?.description, item.history)
            : item.history
              ? descriptionWithReadableHistory(edge?.description, edge?.description, item.history)
              : undefined
        operations.push({
          type: "update_edge",
          edge_id: item.edge_id,
          new_description: nextDescription,
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
    return GraphCommand.parse(command)
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
        fs.writeFile(artifactPath(input.directory, "operation_index.json"), JSON.stringify(await buildOperationIndex(command, input.directory), null, 2) + "\n", "utf8"),
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
      fs.writeFile(artifactPath(input.directory, "operation_index.json"), JSON.stringify(await buildOperationIndex(command, input.directory), null, 2) + "\n", "utf8"),
    ])
    return { ok: true as const, command }
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

    return ProjectWorkflow.runAction(input)
  }
}
