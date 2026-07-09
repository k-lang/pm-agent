import z from "zod"

export const NodeType = z.enum(["event", "issue", "goal", "work_item", "result", "work_block"])
export type NodeType = z.infer<typeof NodeType>

export const EventStatus = z.enum(["occurred", "changed"])
export const IssueStatus = z.enum(["discovered", "resolving", "resolved", "shelved", "ignored"])
export const GoalStatus = z.enum(["established", "in_progress", "completed", "failed", "cancelled", "adjusted"])
export const WorkItemStatus = z.enum(["planned", "in_progress", "finished", "cancelled", "ongoing"])
export const ResultStatus = z.enum(["produced", "changed"])
export const WorkBlockStatus = z.enum(["active", "completed", "cancelled"])

export const NODE_STATUS_VALUES = {
  event: EventStatus.options,
  issue: IssueStatus.options,
  goal: GoalStatus.options,
  work_item: WorkItemStatus.options,
  result: ResultStatus.options,
  work_block: WorkBlockStatus.options,
} satisfies Record<NodeType, readonly string[]>

export const NODE_MUTABLE_FIELD_KEYS = {
  event: ["summary", "description", "detail_url", "status"],
  issue: ["summary", "description", "detail_url", "status", "resolution_score"],
  goal: ["summary", "description", "detail_url", "status", "completion_score"],
  work_item: ["summary", "description", "detail_url", "status", "linked_work_block_id"],
  result: ["summary", "description", "detail_url", "status"],
  work_block: ["summary", "description", "detail_url", "status", "linked_goal_id"],
} satisfies Record<NodeType, readonly string[]>

export const NODE_CREATE_DATA_KEYS = {
  event: ["type", ...NODE_MUTABLE_FIELD_KEYS.event],
  issue: ["type", ...NODE_MUTABLE_FIELD_KEYS.issue],
  goal: ["type", ...NODE_MUTABLE_FIELD_KEYS.goal],
  work_item: ["type", ...NODE_MUTABLE_FIELD_KEYS.work_item],
  result: ["type", ...NODE_MUTABLE_FIELD_KEYS.result],
  work_block: ["type", ...NODE_MUTABLE_FIELD_KEYS.work_block],
} satisfies Record<NodeType, readonly string[]>

export const NODE_DRAFT_FIELD_KEYS = {
  event: ["detail_url", "status"],
  issue: ["detail_url", "status", "resolution_score"],
  goal: ["detail_url", "status", "completion_score"],
  work_item: ["detail_url", "status", "linked_work_block_id"],
  result: ["detail_url", "status"],
  work_block: ["detail_url", "status", "linked_goal_id"],
} satisfies Record<NodeType, readonly string[]>

export const EdgeType = z.enum([
  "leads_to",
  "generates",
  "adjusts",
  "cancels",
  "triggers",
  "affects",
  "forms",
  "modifies",
  "next",
  "discovers",
  "creates",
  "modifies_work",
  "subgoal",
  "generates_goal",
  "adjusts_goal",
  "cancels_goal",
  "affects_issue",
  "generates_result",
  "adjusts_result",
  "cancels_result",
  "based_on",
])
export type EdgeType = z.infer<typeof EdgeType>

export const HistoryRecord = z.object({
  timestamp: z.string(),
  version: z.string(),
  description: z.string(),
  serialized_data: z.string(),
})
export type HistoryRecord = z.infer<typeof HistoryRecord>

const BaseNode = z.object({
  id: z.string(),
  type: NodeType,
  summary: z.string().default(""),
  description: z.string().default(""),
  detail_url: z.string().nullable().default(null),
  outgoing_edges: z.array(z.string()).default([]),
  incoming_edges: z.array(z.string()).default([]),
  history: z.array(HistoryRecord).default([]),
})

export const EventNode = BaseNode.extend({
  type: z.literal("event"),
  status: EventStatus.default("occurred"),
})
export const IssueNode = BaseNode.extend({
  type: z.literal("issue"),
  status: IssueStatus.default("discovered"),
  resolution_score: z.number().nullable().default(null),
})
export const GoalNode = BaseNode.extend({
  type: z.literal("goal"),
  status: GoalStatus.default("established"),
  completion_score: z.number().nullable().default(null),
  linked_work_blocks: z.array(z.string()).default([]),
})
export const WorkItemNode = BaseNode.extend({
  type: z.literal("work_item"),
  status: WorkItemStatus.default("planned"),
  linked_work_block_id: z.string().nullable().default(null),
})
export const ResultNode = BaseNode.extend({
  type: z.literal("result"),
  status: ResultStatus.default("produced"),
})
export const WorkBlockNode = BaseNode.extend({
  type: z.literal("work_block"),
  status: WorkBlockStatus.default("active"),
  work_items: z.array(z.string()).default([]),
  linked_goal_id: z.string().nullable().default(null),
})

export const GraphNode = z.discriminatedUnion("type", [
  EventNode,
  IssueNode,
  GoalNode,
  WorkItemNode,
  ResultNode,
  WorkBlockNode,
])
export type GraphNode = z.infer<typeof GraphNode>

export const GraphEdge = z.object({
  id: z.string(),
  from_node_id: z.string(),
  to_node_id: z.string(),
  type: EdgeType,
  description: z.string().default(""),
  history: z.array(HistoryRecord).default([]),
})
export type GraphEdge = z.infer<typeof GraphEdge>

export const GraphSnapshot = z.object({
  id: z.string(),
  timestamp: z.string(),
  nodes: z.record(z.string(), z.string()),
  edges: z.record(z.string(), z.string()),
})
export type GraphSnapshot = z.infer<typeof GraphSnapshot>

export const CreateNodeOperation = z.object({
  type: z.literal("create_node"),
  temp_id: z.string(),
  data: z.record(z.string(), z.unknown()).and(z.object({ type: NodeType })),
})
export const UpdateNodeOperation = z.object({
  type: z.literal("update_node"),
  node_id: z.string(),
  updates: z.record(z.string(), z.unknown()),
})
export const CreateEdgeOperation = z.object({
  type: z.literal("create_edge"),
  temp_id: z.string().optional(),
  from_node: z.string(),
  to_node: z.string(),
  edge_type: EdgeType,
  description: z.string().optional(),
})
export const UpdateEdgeOperation = z.object({
  type: z.literal("update_edge"),
  edge_id: z.string(),
  new_description: z.string().optional(),
  reason: z.string().optional(),
})

export const GraphOperation = z.discriminatedUnion("type", [
  CreateNodeOperation,
  UpdateNodeOperation,
  CreateEdgeOperation,
  UpdateEdgeOperation,
])
export type GraphOperation = z.infer<typeof GraphOperation>

export const GraphCommand = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  version: z.string().optional(),
  change_id: z.string(),
  timestamp: z.string(),
  operations: z.array(GraphOperation),
  history_descriptions: z.record(z.string(), z.string()).default({}),
})
export type GraphCommand = z.infer<typeof GraphCommand>

export const NODE_TYPES: NodeType[] = ["event", "issue", "goal", "work_item", "result", "work_block"]
