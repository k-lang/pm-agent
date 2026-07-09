import { GraphCommand, NODE_CREATE_DATA_KEYS, NODE_MUTABLE_FIELD_KEYS, NODE_STATUS_VALUES, type EdgeType, type NodeType } from "./schema"
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
  operationIndex?: number
}

export function validateEdgeRelation(fromType: NodeType, toType: NodeType, edgeType: EdgeType) {
  if ((fromType === "goal" && toType === "work_block") || (fromType === "work_block" && toType === "goal")) {
    return "goal 与 work_block 是属性关系，请使用 linked_goal_id/linked_work_blocks，不要创建边。"
  }
  if ((fromType === "work_block" && toType === "work_item") || (fromType === "work_item" && toType === "work_block")) {
    return "work_block 与 work_item 是属性关系，请使用 linked_work_block_id/work_items，不要创建边。"
  }
  const allowed: Record<NodeType, Partial<Record<NodeType, EdgeType[]>>> = {
    event: {
      work_item: ["leads_to"],
      goal: ["generates", "adjusts", "cancels"],
      issue: ["triggers", "affects"],
      result: ["forms", "modifies"],
    },
    work_item: {
      work_item: ["next"],
      issue: ["discovers"],
      result: ["creates", "modifies_work"],
    },
    goal: {
      goal: ["subgoal"],
    },
    issue: {
      goal: ["generates_goal", "adjusts_goal", "cancels_goal"],
    },
    result: {
      issue: ["affects_issue"],
      goal: ["generates_result", "adjusts_result", "cancels_result"],
      work_item: ["based_on"],
    },
    work_block: {},
  }
  const allowedTypes = allowed[fromType]?.[toType] ?? []
  if (!allowedTypes.includes(edgeType)) {
    return `${fromType} -> ${toType} 不应使用 ${edgeType}，允许类型：${allowedTypes.length ? allowedTypes.join(", ") : "无"}。`
  }
  return undefined
}

function edgeTargetExistenceIssue(edgeType: EdgeType, target: NodeRef) {
  const newTargetTypes = new Set<EdgeType>(["generates", "triggers", "forms", "creates", "generates_goal", "generates_result"])
  const existingTargetTypes = new Set<EdgeType>([
    "adjusts",
    "cancels",
    "affects",
    "modifies",
    "modifies_work",
    "adjusts_goal",
    "cancels_goal",
    "affects_issue",
    "adjusts_result",
    "cancels_result",
  ])
  if (newTargetTypes.has(edgeType) && !target.isNew) {
    return `${edgeType} 表示产生或触发新对象，目标节点 ${target.id} 已存在；请改用调整/影响类边，或不要创建这条边。`
  }
  if (existingTargetTypes.has(edgeType) && target.isNew) {
    return `${edgeType} 表示调整、取消、影响或修改已有对象，目标节点 ${target.id} 是本轮新建；请改用产生/触发/创建类边，或把关系写入节点描述。`
  }
  return undefined
}

function nodeStatusIssue(nodeType: NodeType, status: unknown) {
  if (status === undefined) return undefined
  const allowed: readonly string[] = NODE_STATUS_VALUES[nodeType]
  if (typeof status !== "string" || !allowed.includes(status)) {
    return `${nodeType}.status 不应使用 ${String(status)}，允许状态：${allowed.join(", ")}。`
  }
  return undefined
}

function unknownFieldIssues(nodeType: NodeType, data: Record<string, unknown>, allowed: readonly string[]) {
  return Object.keys(data)
    .filter((field) => !allowed.includes(field))
    .map((field) => `${nodeType}.${field} 不是合法字段，允许字段：${allowed.join(", ")}。`)
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
        const statusIssue = nodeStatusIssue(operation.data.type, operation.data.status)
        if (statusIssue) {
          issues.push({
            severity: "error",
            operationIndex: index,
            nodeId: operation.temp_id,
            message: statusIssue,
          })
        }
        for (const message of unknownFieldIssues(operation.data.type, operation.data, NODE_CREATE_DATA_KEYS[operation.data.type])) {
          issues.push({
            severity: "error",
            operationIndex: index,
            nodeId: operation.temp_id,
            message,
          })
        }
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
        if (node) {
          const statusIssue = nodeStatusIssue(node.type, operation.updates.status)
          if (statusIssue) {
            issues.push({
              severity: "error",
              operationIndex: index,
              nodeId: operation.node_id,
              message: statusIssue,
            })
          }
          for (const message of unknownFieldIssues(node.type, operation.updates, NODE_MUTABLE_FIELD_KEYS[node.type])) {
            issues.push({
              severity: "error",
              operationIndex: index,
              nodeId: operation.node_id,
              message,
            })
          }
          nodes.set(operation.node_id, { ...node, data: { ...node.data, ...operation.updates }, operationIndex: index })
        }
      }
      if (operation.type === "create_edge") {
        edges.push({ from: operation.from_node, to: operation.to_node, type: operation.edge_type, operationIndex: index })
      }
    })

    for (const edge of edges.filter((item) => item.operationIndex !== undefined)) {
      const from = nodes.get(edge.from)
      const to = nodes.get(edge.to)
      if (!from || !to) continue
      const relationIssue = validateEdgeRelation(from.type, to.type, edge.type as EdgeType)
      if (relationIssue) {
        issues.push({
          severity: "error",
          operationIndex: edge.operationIndex,
          message: relationIssue,
        })
      }
      const targetExistenceIssue = edgeTargetExistenceIssue(edge.type as EdgeType, to)
      if (targetExistenceIssue) {
        issues.push({
          severity: "error",
          operationIndex: edge.operationIndex,
          message: targetExistenceIssue,
        })
      }
    }

    this.validateRedundantEventWorkLeads(issues, nodes, edges)

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

  private validateRedundantEventWorkLeads(issues: GraphSemanticIssue[], nodes: Map<string, NodeRef>, edges: EdgeRef[]) {
    const generatedGoalsByEvent = new Map<string, Set<string>>()
    for (const edge of edges) {
      if (edge.type !== "generates") continue
      const from = nodes.get(edge.from)
      const to = nodes.get(edge.to)
      if (from?.type !== "event" || to?.type !== "goal") continue
      const goals = generatedGoalsByEvent.get(edge.from) ?? new Set<string>()
      goals.add(edge.to)
      generatedGoalsByEvent.set(edge.from, goals)
    }

    for (const edge of edges.filter((item) => item.operationIndex !== undefined && item.type === "leads_to")) {
      const generatedGoals = generatedGoalsByEvent.get(edge.from)
      if (!generatedGoals?.size) continue
      const from = nodes.get(edge.from)
      const to = nodes.get(edge.to)
      if (from?.type !== "event" || to?.type !== "work_item") continue
      for (const goalId of generatedGoals) {
        if (!this.isWorkItemUnderGoal(edge.to, goalId, nodes, edges)) continue
        issues.push({
          severity: "error",
          operationIndex: edge.operationIndex,
          message: `event ${edge.from} 已经通过 generates 产生目标 ${goalId}，work_item ${edge.to} 又通过工作块归属于该目标；不要再创建 event -> work_item 的 leads_to，除非事件直接导致该工作项且不是通过目标/工作块派生。`,
        })
        break
      }
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

  private isWorkItemUnderGoal(workItemId: string, goalId: string, nodes: Map<string, NodeRef>, edges: EdgeRef[]) {
    const workItem = nodes.get(workItemId)
    if (workItem?.type !== "work_item") return false
    const blockId = workItem.data.linked_work_block_id
    if (typeof blockId !== "string") return false
    const block = nodes.get(blockId)
    if (block?.type !== "work_block") return false
    const linkedGoalId = block.data.linked_goal_id
    if (typeof linkedGoalId !== "string") return false
    return this.goalMatchesOrDescendsFrom(linkedGoalId, goalId, nodes, edges)
  }

  private goalMatchesOrDescendsFrom(candidateGoalId: string, ancestorGoalId: string, nodes: Map<string, NodeRef>, edges: EdgeRef[], seen = new Set<string>()): boolean {
    if (candidateGoalId === ancestorGoalId) return true
    if (seen.has(candidateGoalId)) return false
    seen.add(candidateGoalId)
    const goal = nodes.get(candidateGoalId)
    if (goal?.type !== "goal") return false
    const parentEdges = edges.filter((edge) => edge.type === "subgoal" && edge.to === candidateGoalId)
    return parentEdges.some((edge) => this.goalMatchesOrDescendsFrom(edge.from, ancestorGoalId, nodes, edges, seen))
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
