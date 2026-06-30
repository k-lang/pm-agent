import { GraphCommand, type GraphOperation, type NodeType } from "./schema"
import { GraphStorage } from "./storage"

export type GraphSemanticIssue = {
  severity: "error" | "warning"
  operationIndex?: number
  nodeId?: string
  message: string
}

type NodeRef = {
  id: string
  type: NodeType
  data: Record<string, unknown>
  operationIndex?: number
  isNew: boolean
}

type EdgeRef = {
  from: string
  to: string
  type: string
}

export class GraphSemanticValidator {
  constructor(readonly storage: GraphStorage) {}

  async validateCommand(command: GraphCommand): Promise<GraphSemanticIssue[]> {
    const parsed = GraphCommand.parse(command)
    const existingNodes = await this.loadExistingNodes()
    const nodes = new Map(existingNodes)
    const edges: EdgeRef[] = (await this.storage.getAllEdges()).map((edge) => ({
      from: edge.from_node_id,
      to: edge.to_node_id,
      type: edge.type,
    }))
    const newNodeIds = new Set<string>()
    const issues: GraphSemanticIssue[] = []

    parsed.operations.forEach((operation, index) => {
      if (operation.type === "create_node") {
        newNodeIds.add(operation.temp_id)
        nodes.set(operation.temp_id, {
          id: operation.temp_id,
          type: operation.data.type,
          data: operation.data,
          operationIndex: index,
          isNew: true,
        })
      }
      if (operation.type === "update_node") {
        const node = nodes.get(operation.node_id)
        if (node) nodes.set(operation.node_id, { ...node, data: { ...node.data, ...operation.updates }, operationIndex: index })
      }
      if (operation.type === "create_edge") {
        edges.push({ from: operation.from_node, to: operation.to_node, type: operation.edge_type })
      }
    })

    for (const nodeId of newNodeIds) {
      const node = nodes.get(nodeId)
      if (!node) continue
      if (node.type === "work_block") {
        this.validateTypedReference(issues, node, "linked_goal_id", "goal", nodes, "工作块必须关联到目标 linked_goal_id")
      }
      if (node.type === "work_item") {
        this.validateTypedReference(issues, node, "linked_work_block_id", "work_block", nodes, "工作项必须关联到工作块 linked_work_block_id")
      }
      if (node.type === "result" && !this.findProducingWorkBlock(node.id, nodes, edges)) {
        issues.push({
          severity: "error",
          operationIndex: node.operationIndex,
          nodeId: node.id,
          message: "结果节点必须通过边连接到 work_item 或 work_block，以便推断 producing work_block",
        })
      }
      if ((node.type === "issue" || node.type === "event") && !this.inferCommunity(node.id, nodes, edges)) {
        issues.push({
          severity: "error",
          operationIndex: node.operationIndex,
          nodeId: node.id,
          message: `${node.type} 节点必须通过边连接到可归属 community 的节点`,
        })
      }
    }

    return issues
  }

  private async loadExistingNodes() {
    const entries = await Promise.all((await this.storage.getAllNodes()).map(async (node): Promise<[string, NodeRef]> => [
      node.id,
      {
        id: node.id,
        type: node.type,
        data: node as unknown as Record<string, unknown>,
        isNew: false,
      },
    ]))
    return entries
  }

  private validateTypedReference(
    issues: GraphSemanticIssue[],
    node: NodeRef,
    field: string,
    expectedType: NodeType,
    nodes: Map<string, NodeRef>,
    missingMessage: string,
  ) {
    const ref = node.data[field]
    if (typeof ref !== "string" || !ref) {
      issues.push({ severity: "error", operationIndex: node.operationIndex, nodeId: node.id, message: missingMessage })
      return
    }
    const target = nodes.get(ref)
    if (!target) {
      issues.push({ severity: "error", operationIndex: node.operationIndex, nodeId: node.id, message: `${field} 引用的节点不存在: ${ref}` })
      return
    }
    if (target.type !== expectedType) {
      issues.push({ severity: "error", operationIndex: node.operationIndex, nodeId: node.id, message: `${field} 必须引用 ${expectedType}，实际引用 ${target.type}: ${ref}` })
    }
  }

  private topGoalFor(nodeId: string, nodes: Map<string, NodeRef>, edges: EdgeRef[], seen = new Set<string>()): string | null {
    if (seen.has(nodeId)) return null
    seen.add(nodeId)
    const node = nodes.get(nodeId)
    if (!node) return null
    if (node.type === "goal") {
      const parentEdge = edges.find((edge) => edge.type === "subgoal" && edge.to === nodeId)
      return parentEdge ? this.topGoalFor(parentEdge.from, nodes, edges, seen) : node.id
    }
    if (node.type === "work_block") {
      const goalId = node.data.linked_goal_id
      return typeof goalId === "string" ? this.topGoalFor(goalId, nodes, edges, seen) : null
    }
    if (node.type === "work_item") {
      const blockId = node.data.linked_work_block_id
      return typeof blockId === "string" ? this.topGoalFor(blockId, nodes, edges, seen) : null
    }
    if (node.type === "result") {
      const blockId = this.findProducingWorkBlock(nodeId, nodes, edges)
      return blockId ? this.topGoalFor(blockId, nodes, edges, seen) : null
    }
    if (node.type === "issue" || node.type === "event") return this.inferCommunity(nodeId, nodes, edges)
    return null
  }

  private findProducingWorkBlock(nodeId: string, nodes: Map<string, NodeRef>, edges: EdgeRef[]) {
    const neighborIds = edges
      .filter((edge) => edge.from === nodeId || edge.to === nodeId)
      .flatMap((edge) => [edge.from, edge.to])
      .filter((id) => id !== nodeId)
    for (const id of neighborIds) {
      const node = nodes.get(id)
      if (node?.type === "work_item" && typeof node.data.linked_work_block_id === "string") return node.data.linked_work_block_id
      if (node?.type === "work_block") return node.id
    }
    return null
  }

  private inferCommunity(nodeId: string, nodes: Map<string, NodeRef>, edges: EdgeRef[]) {
    const outgoing = edges.filter((edge) => edge.from === nodeId)
    for (const edge of outgoing) {
      const community = this.topGoalFor(edge.to, nodes, edges)
      if (community) return community
    }
    const adjacent = edges.filter((edge) => edge.from === nodeId || edge.to === nodeId)
    for (const edge of adjacent) {
      const other = edge.from === nodeId ? edge.to : edge.from
      const community = this.topGoalFor(other, nodes, edges)
      if (community) return community
    }
    return null
  }
}

