export type NodeType = "event" | "goal" | "issue" | "result" | "work_block" | "work_item"

export type RawNode = {
  id: string
  type: NodeType
  summary: string
  description: string
  detail_url?: string | null
  outgoing_edges?: string[]
  incoming_edges?: string[]
  history?: unknown[]
  status?: string
  completion_score?: number
  linked_work_blocks?: string[]
  linked_goal_id?: string | null
  linked_work_block_id?: string | null
  work_items?: string[]
}

export type RawEdge = {
  id: string
  from_node_id: string
  to_node_id: string
  type: string
  description: string
  history?: unknown[]
}

export type NodePosition = {
  x: number
  y: number
}

export type EdgeBend = {
  dx: number
  dy: number
}

export type SavedLayout = {
  nodes: Record<string, NodePosition>
  edges: Record<string, EdgeBend>
}

export type GraphView = "collapsed" | "expanded"

export type GraphNode = {
  id: string
  type: NodeType
  label: string
  summary: string
  description: string
  detailUrl: string | null
  status: string | null
  completionScore: number | null
  topGoalId: string | null
  parentGoalId: string | null
  ownerGoalId: string | null
  communityGoalId: string | null
  producingWorkBlockId: string | null
  linkedWorkBlockId: string | null
  firstSeenAt: string | null
  firstStep: number | null
}

export type GraphEdge = {
  id: string
  source: string
  target: string
  type: string
  label: string
  count: number
  description: string
  topGoalId: string | null
}

export type GraphPayload = {
  project: string
  meta: {
    rawNodeCount: number
    visibleNodeCount: number
    rawEdgeCount: number
    visibleEdgeCount: number
    topGoalCount: number
  }
  nodes: GraphNode[]
  edges: GraphEdge[]
  layout: SavedLayout | null
}
