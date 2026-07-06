import fs from "fs/promises"
import { GraphStorage } from "./storage"
import { GraphCommand, GraphEdge, GraphNode, type GraphOperation, type HistoryRecord, type NodeType } from "./schema"
import { GraphSemanticValidator, type GraphSemanticIssue } from "./semantic-validation"

export type GraphValidationIssue = GraphSemanticIssue

type ExecuteResult = {
  success: boolean
  executed_operations: unknown[]
  created_nodes: Record<string, string>
  created_edges: Record<string, string>
  updated_nodes: Record<string, string[]>
  updated_edges: Record<string, string[]>
  errors: string[]
  history_records_added?: number
  snapshot_created?: string
  affected_nodes?: string[]
  affected_edges?: string[]
}

export class GraphEngine {
  private idMapping = new Map<string, string>()

  constructor(readonly storage: GraphStorage) {}

  async executeCommand(command: GraphCommand): Promise<ExecuteResult> {
    const parsed = GraphCommand.parse(command)
    await this.storage.ensureDirectories()
    const result: ExecuteResult = {
      success: true,
      executed_operations: [],
      created_nodes: {},
      created_edges: {},
      updated_nodes: {},
      updated_edges: {},
      errors: [],
    }

    const validation = await this.validateOperations(parsed.operations)
    if (validation.length) return { ...result, success: false, errors: validation }

    for (const operation of parsed.operations) {
      try {
        if (operation.type === "create_node") {
          const node = await this.createNode(operation)
          result.created_nodes[operation.temp_id] = node.id
          this.idMapping.set(operation.temp_id, node.id)
          result.executed_operations.push({ success: true, operation: "create_node", temp_id: operation.temp_id, real_id: node.id, node_type: node.type, summary: node.summary })
        } else if (operation.type === "create_edge") {
          const edge = await this.createEdge(operation)
          const tempID = operation.temp_id || `edge_${Object.keys(result.created_edges).length}`
          result.created_edges[tempID] = edge.id
          result.executed_operations.push({ success: true, operation: "create_edge", temp_id: operation.temp_id, real_id: edge.id, from_node: edge.from_node_id, to_node: edge.to_node_id, edge_type: edge.type })
        } else if (operation.type === "update_node") {
          const nodeID = await this.updateNode(operation)
          result.updated_nodes[operation.node_id] = Object.keys(operation.updates)
          result.executed_operations.push({ success: true, operation: "update_node", node_id: nodeID, updates: Object.keys(operation.updates) })
        } else if (operation.type === "update_edge") {
          const edgeID = await this.updateEdge(operation)
          result.updated_edges[operation.edge_id] = [operation.new_description !== undefined ? "description" : undefined, operation.reason !== undefined ? "reason" : undefined].filter(Boolean) as string[]
          result.executed_operations.push({ success: true, operation: "update_edge", edge_id: edgeID, updates: result.updated_edges[operation.edge_id] })
        }
      } catch (error) {
        result.success = false
        result.errors.push(error instanceof Error ? error.message : String(error))
        return result
      }
    }

    try {
      const { affectedNodes, affectedEdges } = await this.addHistoryAndSnapshot(parsed, result)
      result.history_records_added = affectedNodes.size + affectedEdges.size
      result.snapshot_created = parsed.change_id
      result.affected_nodes = [...affectedNodes]
      result.affected_edges = [...affectedEdges]
    } catch (error) {
      result.success = false
      result.errors.push(error instanceof Error ? error.message : String(error))
    }
    return result
  }

  async validateOperations(operations: GraphOperation[]): Promise<string[]> {
    const errors: string[] = []
    const createdNodes = new Map<string, number>()
    const createdEdges = new Map<string, number>()

    operations.forEach((operation, index) => {
      if (operation.type === "create_node") {
        if (createdNodes.has(operation.temp_id)) errors.push(`操作 ${index + 1}: 重复的temp_id '${operation.temp_id}'`)
        createdNodes.set(operation.temp_id, index + 1)
      }
      if (operation.type === "create_edge") {
        const tempID = operation.temp_id || `edge_${createdEdges.size}`
        if (createdEdges.has(tempID)) errors.push(`操作 ${index + 1}: 重复的边temp_id '${tempID}'`)
        createdEdges.set(tempID, index + 1)
      }
    })

    for (const [index, operation] of operations.entries()) {
      const opNum = index + 1
      if (operation.type === "create_node") {
        const existing = await this.storage.getNodeById(operation.temp_id)
        if (existing) errors.push(`操作 ${opNum}: temp_id '${operation.temp_id}' 已被现有节点占用`)
        const linkedGoal = operation.data.type === "work_block" ? operation.data.linked_goal_id : undefined
        if (typeof linkedGoal === "string" && this.isTempId(linkedGoal, operations) && (!createdNodes.has(linkedGoal) || createdNodes.get(linkedGoal)! >= opNum)) {
          errors.push(`操作 ${opNum}: 引用的目标节点 '${linkedGoal}' 在此之前未创建`)
        }
        const workItems = operation.data.type === "work_block" && Array.isArray(operation.data.work_items) ? operation.data.work_items : []
        for (const ref of workItems) {
          if (typeof ref === "string" && this.isTempId(ref, operations) && (!createdNodes.has(ref) || createdNodes.get(ref)! >= opNum)) {
            errors.push(`操作 ${opNum}: 引用的工作项 '${ref}' 在此之前未创建`)
          }
        }
      } else if (operation.type === "create_edge") {
        if (operation.temp_id && await this.storage.loadEdge(operation.temp_id)) errors.push(`操作 ${opNum}: 边temp_id '${operation.temp_id}' 已被现有边占用`)
        for (const ref of [operation.from_node, operation.to_node]) {
          if (createdNodes.has(ref)) {
            if (createdNodes.get(ref)! >= opNum) errors.push(`操作 ${opNum}: 引用的节点 '${ref}' 在此操作之后创建`)
          } else if (this.isTempId(ref, operations)) {
            errors.push(`操作 ${opNum}: 临时节点 '${ref}' 未在当前步骤中创建`)
          } else if (!await this.storage.getNodeById(ref)) {
            errors.push(`操作 ${opNum}: 节点 '${ref}' 在storage中不存在`)
          }
        }
      } else if (operation.type === "update_node") {
        if (this.isTempId(operation.node_id, operations)) {
          const createdAt = createdNodes.get(operation.node_id)
          if (!this.idMapping.has(operation.node_id) && (!createdAt || createdAt >= opNum)) {
            errors.push(`操作 ${opNum}: 临时节点 '${operation.node_id}' 在此之前未创建`)
          }
        } else if (!await this.storage.getNodeById(operation.node_id)) {
          errors.push(`操作 ${opNum}: 节点 '${operation.node_id}' 在storage中不存在`)
        }
      } else if (operation.type === "update_edge") {
        if (this.isTempId(operation.edge_id, operations)) {
          const createdAt = createdEdges.get(operation.edge_id)
          if (!createdAt || createdAt >= opNum) errors.push(`操作 ${opNum}: 要更新的边 '${operation.edge_id}' 在此之前未创建`)
        } else if (!await this.storage.loadEdge(operation.edge_id)) {
          errors.push(`操作 ${opNum}: 要更新的边 '${operation.edge_id}' 在storage中不存在`)
        }
      }
    }
    return errors
  }

  async validateCommand(command: unknown): Promise<{ command?: GraphCommand; issues: GraphValidationIssue[] }> {
    const parsed = GraphCommand.safeParse(command)
    if (!parsed.success) {
      return {
        issues: parsed.error.issues.map((issue) => ({
          severity: "error",
          message: `operations.json 结构错误：${issue.path.join(".") || "(root)"} ${issue.message}`,
        })),
      }
    }
    const basicErrors = await this.validateOperations(parsed.data.operations)
    const semanticIssues = await new GraphSemanticValidator(this.storage).validateCommand(parsed.data)
    return {
      command: parsed.data,
      issues: [
        ...basicErrors.map((message) => ({ severity: "error" as const, message })),
        ...semanticIssues,
      ],
    }
  }

  private async createNode(operation: Extract<GraphOperation, { type: "create_node" }>) {
    const node = GraphNode.parse({ ...operation.data, id: operation.temp_id })
    await this.storage.saveNode(node)
    if (node.type === "work_block") await this.processWorkBlockRelations(node)
    if (node.type === "work_item") await this.processWorkItemRelations(node)
    return node
  }

  private async processWorkBlockRelations(node: Extract<GraphNode, { type: "work_block" }>) {
    if (!node.linked_goal_id) return
    node.linked_goal_id = this.resolveId(node.linked_goal_id)
    const goal = await this.storage.getNodeById(node.linked_goal_id)
    if (goal?.type === "goal" && !goal.linked_work_blocks.includes(node.id)) {
      goal.linked_work_blocks.push(node.id)
      await this.storage.saveNode(goal)
    }
    await this.storage.saveNode(node)
  }

  private async processWorkItemRelations(node: Extract<GraphNode, { type: "work_item" }>) {
    if (!node.linked_work_block_id) return
    node.linked_work_block_id = this.resolveId(node.linked_work_block_id)
    const block = await this.storage.getNodeById(node.linked_work_block_id)
    if (block?.type === "work_block" && !block.work_items.includes(node.id)) {
      block.work_items.push(node.id)
      await this.storage.saveNode(block)
    }
    await this.storage.saveNode(node)
  }

  private async createEdge(operation: Extract<GraphOperation, { type: "create_edge" }>) {
    const edge = GraphEdge.parse({
      id: operation.temp_id || `edge_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`,
      from_node_id: this.resolveId(operation.from_node),
      to_node_id: this.resolveId(operation.to_node),
      type: operation.edge_type,
      description: operation.description || "",
    })
    await this.storage.saveEdge(edge)
    await this.updateNodeEdgeReference(edge.from_node_id, edge.id, "outgoing_edges")
    await this.updateNodeEdgeReference(edge.to_node_id, edge.id, "incoming_edges")
    return edge
  }

  private async updateNode(operation: Extract<GraphOperation, { type: "update_node" }>) {
    const nodeID = this.resolveId(operation.node_id)
    const node = await this.storage.getNodeById(nodeID)
    if (!node) throw new Error(`节点 ${nodeID} 不存在`)
    const next = GraphNode.parse({ ...node, ...operation.updates, id: node.id, type: operation.updates.type || node.type })
    await this.storage.saveNode(next)
    return nodeID
  }

  private async updateEdge(operation: Extract<GraphOperation, { type: "update_edge" }>) {
    const edgeID = this.resolveId(operation.edge_id)
    const edge = await this.storage.loadEdge(edgeID)
    if (!edge) throw new Error(`边 ${edgeID} 不存在`)
    if (operation.new_description !== undefined) edge.description = operation.new_description
    await this.storage.saveEdge(edge)
    return edgeID
  }

  private async updateNodeEdgeReference(nodeID: string, edgeID: string, field: "incoming_edges" | "outgoing_edges") {
    const node = await this.storage.getNodeById(nodeID)
    if (!node) return
    if (!node[field].includes(edgeID)) node[field].push(edgeID)
    await this.storage.saveNode(node)
  }

  private async addHistoryAndSnapshot(command: GraphCommand, result: ExecuteResult) {
    const affectedNodes = new Set<string>()
    const affectedEdges = new Set<string>()
    Object.values(result.created_nodes).forEach((id) => affectedNodes.add(id))
    Object.values(result.created_edges).forEach((id) => affectedEdges.add(id))
    Object.keys(result.updated_nodes).forEach((id) => affectedNodes.add(this.resolveId(id)))
    Object.keys(result.updated_edges).forEach((id) => affectedEdges.add(this.resolveId(id)))

    for (const edgeID of Object.values(result.created_edges)) {
      const edge = await this.storage.loadEdge(edgeID)
      if (edge) {
        affectedNodes.add(edge.from_node_id)
        affectedNodes.add(edge.to_node_id)
      }
    }
    for (const nodeID of Object.values(result.created_nodes)) {
      const node = await this.storage.getNodeById(nodeID)
      if (node?.type === "work_block" && node.linked_goal_id) affectedNodes.add(node.linked_goal_id)
      if (node?.type === "work_item" && node.linked_work_block_id) affectedNodes.add(node.linked_work_block_id)
    }

    const realToTemp = new Map<string, string>()
    Object.entries(result.created_nodes).forEach(([temp, real]) => realToTemp.set(real, temp))
    Object.entries(result.created_edges).forEach(([temp, real]) => realToTemp.set(real, temp))
    Object.keys(result.updated_nodes).forEach((ref) => realToTemp.set(this.resolveId(ref), ref))
    Object.keys(result.updated_edges).forEach((ref) => realToTemp.set(this.resolveId(ref), ref))

    for (const nodeID of affectedNodes) {
      const node = await this.storage.getNodeById(nodeID)
      if (!node) continue
      const description = command.history_descriptions[realToTemp.get(nodeID) || nodeID] || "发生变动"
      await this.addNodeHistory(node, command.timestamp, command.change_id, description)
    }
    for (const edgeID of affectedEdges) {
      const edge = await this.storage.loadEdge(edgeID)
      if (!edge) continue
      const description = command.history_descriptions[realToTemp.get(edgeID) || edgeID] || (edge.description ? `建立边：${edge.description}` : "发生变动")
      await this.addEdgeHistory(edge, command.timestamp, command.change_id, description)
    }
    await this.createSnapshot(command.change_id, command.timestamp)
    return { affectedNodes, affectedEdges }
  }

  private async addNodeHistory(node: GraphNode, timestamp: string, version: string, description: string) {
    node.history.push(this.historyRecord(node, timestamp, version, description))
    await this.storage.saveNode(node)
  }

  private async addEdgeHistory(edge: GraphEdge, timestamp: string, version: string, description: string) {
    edge.history.push(this.historyRecord(edge, timestamp, version, description))
    await this.storage.saveEdge(edge)
  }

  private historyRecord(value: GraphNode | GraphEdge, timestamp: string, version: string, description: string): HistoryRecord {
    const { history: _history, ...serializedValue } = value
    return {
      timestamp,
      version,
      description,
      serialized_data: JSON.stringify(serializedValue, null, 2),
    }
  }

  private async createSnapshot(id: string, timestamp: string) {
    const nodes = Object.fromEntries((await this.storage.getAllNodes()).filter((node) => node.history.length).map((node) => [node.id, node.history.at(-1)?.version || "v1.0"]))
    const edges = Object.fromEntries((await this.storage.getAllEdges()).filter((edge) => edge.history.length).map((edge) => [edge.id, edge.history.at(-1)?.version || "v1.0"]))
    await this.storage.saveSnapshot({ id, timestamp, nodes, edges })
  }

  private resolveId(ref: string) {
    return this.idMapping.get(ref) || ref
  }

  private isTempId(ref: string, operations?: GraphOperation[]) {
    if (this.idMapping.has(ref)) return true
    if (ref.startsWith("node_") || ref.startsWith("edge_")) return false
    return operations?.some((op) => ("temp_id" in op && op.temp_id === ref)) || false
  }
}

export async function loadCommandAndExecute(jsonFilePath: string, dataDir: string) {
  const command = GraphCommand.parse(JSON.parse(await fs.readFile(jsonFilePath, "utf8")))
  const engine = new GraphEngine(new GraphStorage(dataDir))
  return engine.executeCommand(command)
}
