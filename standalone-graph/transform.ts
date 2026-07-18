import fs from "fs/promises"
import path from "path"
import type { EdgeBend, GraphEdge, GraphNode, GraphPayload, GraphView, NodePosition, RawEdge, RawNode, SavedLayout } from "./types"

const DEFAULT_PROJECT = "jiedaidan"
const DEFAULT_PROJECT_DIR = path.join(process.cwd(), "project_graph_data", DEFAULT_PROJECT)
const COLLAPSED_VISIBLE_NODE_TYPES = new Set<GraphNode["type"]>(["event", "goal", "issue", "result", "work_block"])
const EXPANDED_VISIBLE_NODE_TYPES = new Set<GraphNode["type"]>(["event", "goal", "issue", "result", "work_block", "work_item"])

function projectPaths(projectDir: string, view: GraphView) {
  return {
    root: projectDir,
    nodesDir: path.join(projectDir, "nodes"),
    edgesDir: path.join(projectDir, "edges"),
    layoutPath: path.join(projectDir, "metadata", view === "expanded" ? "layout.expanded.json" : "layout.json"),
  }
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T
}

async function listJsonFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const files = await Promise.all(entries.map(async (entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return listJsonFiles(full)
    return entry.name.endsWith(".json") ? [full] : []
  }))
  return files.flat().sort()
}

function nodeLabel(node: RawNode): string {
  return node.id.trim()
}

function parseStep(value: string | undefined): number | null {
  if (!value) return null
  const match = value.match(/^step(\d+)_/)
  return match ? Number(match[1]) : null
}

function sortedHistoryEntries(node: RawNode): Array<{ timestamp?: string; version?: string }> {
  if (!Array.isArray(node.history)) return []
  return [...node.history as Array<{ timestamp?: string; version?: string }>].sort((a, b) => {
    const stepDiff = (parseStep(a.version) ?? Number.MAX_SAFE_INTEGER) - (parseStep(b.version) ?? Number.MAX_SAFE_INTEGER)
    if (stepDiff !== 0) return stepDiff
    return (a.timestamp || "9999").localeCompare(b.timestamp || "9999")
  })
}

function firstSeenAt(node: RawNode): string | null {
  return sortedHistoryEntries(node)[0]?.timestamp || null
}

function firstStep(node: RawNode): number | null {
  for (const entry of sortedHistoryEntries(node)) {
    const step = parseStep(entry.version)
    if (step !== null) return step
  }
  return null
}

function edgeLabel(type: string): string {
  return type.replaceAll("_", " ").toLowerCase()
}

function normalizeLayout(input: unknown): SavedLayout | null {
  if (!input || typeof input !== "object") return null
  const source = input as { nodes?: Record<string, NodePosition>; edges?: Record<string, EdgeBend> }
  const nodes: Record<string, NodePosition> = {}
  const edges: Record<string, EdgeBend> = {}
  for (const [key, value] of Object.entries(source.nodes || {})) {
    if (!value || typeof value.x !== "number" || typeof value.y !== "number") continue
    nodes[key] = { x: value.x, y: value.y }
  }
  for (const [key, value] of Object.entries(source.edges || {})) {
    if (!value || typeof value.dx !== "number" || typeof value.dy !== "number") continue
    edges[key] = { dx: value.dx, dy: value.dy }
  }
  return { nodes, edges }
}

export async function readSavedLayout(projectDir = DEFAULT_PROJECT_DIR, view: GraphView = "collapsed"): Promise<SavedLayout | null> {
  try {
    const raw = await readJsonFile<unknown>(projectPaths(projectDir, view).layoutPath)
    return normalizeLayout(raw)
  } catch {
    return null
  }
}

export async function saveLayout(layout: SavedLayout, projectDir = DEFAULT_PROJECT_DIR, view: GraphView = "collapsed"): Promise<SavedLayout> {
  const normalized = normalizeLayout(layout) || { nodes: {}, edges: {} }
  const layoutPath = projectPaths(projectDir, view).layoutPath
  await fs.mkdir(path.dirname(layoutPath), { recursive: true })
  await fs.writeFile(layoutPath, JSON.stringify(normalized, null, 2) + "\n", "utf8")
  return normalized
}

async function readNodes(projectDir: string): Promise<RawNode[]> {
  const files = await listJsonFiles(projectPaths(projectDir, "collapsed").nodesDir)
  return Promise.all(files.map((file) => readJsonFile<RawNode>(file)))
}

async function readEdges(projectDir: string): Promise<RawEdge[]> {
  const files = await listJsonFiles(projectPaths(projectDir, "collapsed").edgesDir)
  return Promise.all(files.map((file) => readJsonFile<RawEdge>(file)))
}

function activeEdges(nodes: RawNode[], edges: RawEdge[]) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  return edges.filter((edge) =>
    nodeById.get(edge.from_node_id)?.outgoing_edges?.includes(edge.id) &&
    nodeById.get(edge.to_node_id)?.incoming_edges?.includes(edge.id))
}

function buildGoalHierarchy(edges: RawEdge[]) {
  const childToParent = new Map<string, string>()
  for (const edge of edges) {
    if (edge.type !== "subgoal") continue
    childToParent.set(edge.to_node_id, edge.from_node_id)
  }
  const resolveTopGoal = (goalId: string): string => {
    let current = goalId
    const seen = new Set<string>()
    while (childToParent.has(current) && !seen.has(current)) {
      seen.add(current)
      current = childToParent.get(current) || current
    }
    return current
  }
  return { childToParent, resolveTopGoal }
}

function buildVisibleNodes(nodes: RawNode[], edges: RawEdge[], visibleTypes: Set<GraphNode["type"]>, remapEdges: boolean): {
  visibleNodes: GraphNode[]
  nodeById: Map<string, RawNode>
  workItemToBlock: Map<string, string>
  resolveTopGoal: (goalId: string) => string
  topGoalIds: Set<string>
  childToParent: Map<string, string>
} {
  const nodeById = new Map<string, RawNode>()
  const workItemToBlock = new Map<string, string>()
  const visibleNodes: GraphNode[] = []
  const { childToParent, resolveTopGoal } = buildGoalHierarchy(edges)
  const topGoalIds = new Set<string>()

  for (const node of nodes) {
    nodeById.set(node.id, node)
    if (node.type === "work_item" && node.linked_work_block_id) {
      workItemToBlock.set(node.id, node.linked_work_block_id)
    }
    if (node.type === "goal" && !childToParent.has(node.id)) {
      topGoalIds.add(node.id)
    }
  }

  const visibleEndpoint = (id: string): string | null => remapEdges ? remapEndpoint(id, workItemToBlock) : (id || null)

  const goalParent = new Map<string, string | null>()
  const goalTop = new Map<string, string>()
  const workBlockOwner = new Map<string, string | null>()
  const workBlockCommunity = new Map<string, string | null>()

  for (const node of nodes) {
    if (node.type === "goal") {
      const parentGoalId = childToParent.get(node.id) || null
      goalParent.set(node.id, parentGoalId)
      goalTop.set(node.id, resolveTopGoal(node.id))
    }
    if (node.type === "work_block") {
      const ownerGoalId = node.linked_goal_id || null
      workBlockOwner.set(node.id, ownerGoalId)
      workBlockCommunity.set(node.id, ownerGoalId ? resolveTopGoal(ownerGoalId) : null)
    }
  }

  const adjacency = new Map<string, Array<{ otherId: string; edgeType: string }>>()
  const outgoing = new Map<string, Array<{ otherId: string; edgeType: string }>>()
  for (const node of nodes) {
    adjacency.set(node.id, [])
    outgoing.set(node.id, [])
  }
  const pushAdjacency = (a: string, b: string, edgeType: string) => {
    if (!adjacency.has(a)) adjacency.set(a, [])
    adjacency.get(a)?.push({ otherId: b, edgeType })
  }
  const pushOutgoing = (a: string, b: string, edgeType: string) => {
    if (!outgoing.has(a)) outgoing.set(a, [])
    outgoing.get(a)?.push({ otherId: b, edgeType })
  }

  for (const edge of edges) {
    if (edge.type === "subgoal") continue
    const source = visibleEndpoint(edge.from_node_id)
    const target = visibleEndpoint(edge.to_node_id)
    if (!source || !target || source === target) continue
    pushAdjacency(source, target, edge.type)
    pushAdjacency(target, source, edge.type)
    pushOutgoing(source, target, edge.type)
  }

  const communityByNodeId = new Map<string, string | null>()
  const producingWorkBlockByResultId = new Map<string, string | null>()

  for (const node of nodes) {
    if (node.type === "goal") communityByNodeId.set(node.id, resolveTopGoal(node.id))
    if (node.type === "work_block") communityByNodeId.set(node.id, workBlockCommunity.get(node.id) || null)
  }

  for (const node of nodes.filter((node) => node.type === "result")) {
    const neighborNodes = (adjacency.get(node.id) || []).map((entry) => nodeById.get(entry.otherId)).filter(Boolean) as RawNode[]
    const itemProducer = neighborNodes
      .filter((other) => other.type === "work_item" && other.linked_work_block_id)
      .sort((a, b) => (firstStep(a) ?? Number.MAX_SAFE_INTEGER) - (firstStep(b) ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id))[0] || null
    const blockProducer = neighborNodes
      .filter((other) => other.type === "work_block")
      .sort((a, b) => (firstStep(a) ?? Number.MAX_SAFE_INTEGER) - (firstStep(b) ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id))[0] || null
    const producingBlockId = itemProducer?.linked_work_block_id || blockProducer?.id || null
    producingWorkBlockByResultId.set(node.id, producingBlockId)
    communityByNodeId.set(node.id, producingBlockId ? (workBlockCommunity.get(producingBlockId) || null) : null)
  }

  const sortResolvedTargets = (entries: Array<{ otherId: string; edgeType: string }>) => entries
    .map((entry) => ({
      edgeType: entry.edgeType,
      node: nodeById.get(entry.otherId) || null,
      communityGoalId: communityByNodeId.get(entry.otherId) || null,
    }))
    .filter((entry) => entry.node && entry.communityGoalId)
    .sort((a, b) => {
      const stepDiff = (firstStep(a.node as RawNode) ?? Number.MAX_SAFE_INTEGER) - (firstStep(b.node as RawNode) ?? Number.MAX_SAFE_INTEGER)
      if (stepDiff !== 0) return stepDiff
      return (a.node as RawNode).id.localeCompare((b.node as RawNode).id)
    })

  const inferCommunityFromOutgoing = (nodeId: string): string | null => {
    const targets = sortResolvedTargets(outgoing.get(nodeId) || [])
    return targets[0]?.communityGoalId || null
  }

  const inferCommunityFromNeighbors = (nodeId: string): string | null => {
    const neighbors = sortResolvedTargets(adjacency.get(nodeId) || [])
    return neighbors[0]?.communityGoalId || null
  }

  for (const node of nodes.filter((node) => node.type === "issue" || node.type === "event")) {
    communityByNodeId.set(node.id, inferCommunityFromOutgoing(node.id) || inferCommunityFromNeighbors(node.id))
  }

  for (const node of nodes) {
    if (!visibleTypes.has(node.type as GraphNode["type"])) continue
    const parentGoalId = node.type === "goal" ? (goalParent.get(node.id) || null) : null
    const ownerGoalId = node.type === "work_block"
      ? (workBlockOwner.get(node.id) || null)
      : node.type === "work_item"
        ? (workBlockOwner.get(node.linked_work_block_id || "") || null)
        : null
    const topGoalId = node.type === "goal"
      ? (goalTop.get(node.id) || null)
      : node.type === "work_block"
        ? (workBlockCommunity.get(node.id) || null)
        : node.type === "work_item"
          ? (workBlockCommunity.get(node.linked_work_block_id || "") || null)
          : null
    visibleNodes.push({
      id: node.id,
      type: node.type as GraphNode["type"],
      label: nodeLabel(node),
      summary: node.summary,
      description: node.description,
      detailUrl: node.detail_url ?? null,
      status: node.status ?? null,
      completionScore: typeof node.completion_score === "number" ? node.completion_score : null,
      topGoalId,
      parentGoalId,
      ownerGoalId,
      communityGoalId: communityByNodeId.get(node.id) || topGoalId,
      producingWorkBlockId: node.type === "result" ? (producingWorkBlockByResultId.get(node.id) || null) : null,
      linkedWorkBlockId: node.type === "work_item" ? (node.linked_work_block_id || null) : null,
      firstSeenAt: firstSeenAt(node),
      firstStep: firstStep(node),
    })
  }

  return { visibleNodes, nodeById, workItemToBlock, resolveTopGoal, topGoalIds, childToParent }
}

function remapEndpoint(id: string, workItemToBlock: Map<string, string>): string | null {
  return workItemToBlock.get(id) || id || null
}

function buildStructuralEdges(
  nodes: RawNode[],
  edges: RawEdge[],
  visibleIds: Set<string>,
  resolveTopGoal: (goalId: string) => string,
): GraphEdge[] {
  const edgeMap = new Map<string, GraphEdge>()
  const add = (source: string, target: string, type: string, label: string, description: string) => {
    if (!visibleIds.has(source) || !visibleIds.has(target) || source === target) return
    const id = `${source}|${target}|${type}`
    if (edgeMap.has(id)) return
    edgeMap.set(id, {
      id,
      source,
      target,
      type,
      label,
      count: 1,
      description,
      topGoalId: resolveTopGoal(source),
    })
  }

  for (const node of nodes) {
    if (node.type === "goal") {
      for (const workBlockId of node.linked_work_blocks || []) {
        add(node.id, workBlockId, "goal_work_block", "owns block", `${node.id} links to ${workBlockId} via linked_work_blocks`)
      }
    }
    if (node.type === "work_block" && node.linked_goal_id) {
      add(node.linked_goal_id, node.id, "goal_work_block", "owns block", `${node.id} links to ${node.linked_goal_id} via linked_goal_id`)
    }
  }

  for (const edge of edges) {
    if (edge.type !== "subgoal") continue
    add(edge.from_node_id, edge.to_node_id, "subgoal", "subgoal", edge.description)
  }

  return Array.from(edgeMap.values()).sort((a, b) => a.id.localeCompare(b.id))
}

function inferTopGoalId(source: string, target: string, nodeById: Map<string, RawNode>, resolveTopGoal: (goalId: string) => string): string | null {
  const sourceNode = nodeById.get(source)
  const targetNode = nodeById.get(target)
  if (sourceNode?.type === "goal") return resolveTopGoal(source)
  if (targetNode?.type === "goal") return resolveTopGoal(target)
  if (sourceNode?.type === "work_block" && sourceNode.linked_goal_id) return resolveTopGoal(sourceNode.linked_goal_id)
  if (targetNode?.type === "work_block" && targetNode.linked_goal_id) return resolveTopGoal(targetNode.linked_goal_id)
  if (sourceNode?.type === "work_item" && sourceNode.linked_work_block_id) {
    const block = nodeById.get(sourceNode.linked_work_block_id)
    if (block?.type === "work_block" && block.linked_goal_id) return resolveTopGoal(block.linked_goal_id)
  }
  if (targetNode?.type === "work_item" && targetNode.linked_work_block_id) {
    const block = nodeById.get(targetNode.linked_work_block_id)
    if (block?.type === "work_block" && block.linked_goal_id) return resolveTopGoal(block.linked_goal_id)
  }
  return null
}

function buildExpandedEdges(
  edges: RawEdge[],
  visibleIds: Set<string>,
  nodeById: Map<string, RawNode>,
  resolveTopGoal: (goalId: string) => string,
): GraphEdge[] {
  const edgeMap = new Map<string, GraphEdge>()

  for (const edge of edges) {
    const source = edge.from_node_id
    const target = edge.to_node_id
    if (!source || !target || source === target) continue
    if (!visibleIds.has(source) || !visibleIds.has(target)) continue
    const id = `${source}|${target}|${edge.type}`
    if (edgeMap.has(id)) continue
    edgeMap.set(id, {
      id,
      source,
      target,
      type: edge.type,
      label: edgeLabel(edge.type),
      count: 1,
      description: edge.description,
      topGoalId: inferTopGoalId(source, target, nodeById, resolveTopGoal),
    })
  }

  return Array.from(edgeMap.values()).sort((a, b) => a.id.localeCompare(b.id))
}

function buildCollapsedEdges(
  edges: RawEdge[],
  visibleIds: Set<string>,
  workItemToBlock: Map<string, string>,
  nodeById: Map<string, RawNode>,
  resolveTopGoal: (goalId: string) => string,
): GraphEdge[] {
  const edgeMap = new Map<string, GraphEdge>()

  const remapGoalIfNeeded = (id: string) => {
    const node = nodeById.get(id)
    if (node?.type === "goal") return resolveTopGoal(id)
    return id
  }

  for (const edge of edges) {
    if (edge.type === "subgoal") continue
    const source = remapGoalIfNeeded(remapEndpoint(edge.from_node_id, workItemToBlock) || "")
    const target = remapGoalIfNeeded(remapEndpoint(edge.to_node_id, workItemToBlock) || "")
    if (!source || !target || source === target) continue
    if (!visibleIds.has(source) || !visibleIds.has(target)) continue
    if (nodeById.get(source)?.type === "work_block" && nodeById.get(target)?.type === "work_block") continue
    const id = `${source}|${target}|${edge.type}`
    const existing = edgeMap.get(id)
    if (existing) {
      existing.count += 1
      continue
    }
    edgeMap.set(id, {
      id,
      source,
      target,
      type: edge.type,
      label: edgeLabel(edge.type),
      count: 1,
      description: edge.description,
      topGoalId: inferTopGoalId(source, target, nodeById, resolveTopGoal),
    })
  }

  return Array.from(edgeMap.values()).sort((a, b) => a.id.localeCompare(b.id))
}

async function loadGraphForMode(projectDir: string, mode: GraphView): Promise<GraphPayload> {
  const [rawNodes, rawEdges, layout] = await Promise.all([readNodes(projectDir), readEdges(projectDir), readSavedLayout(projectDir, mode)])
  const currentEdges = activeEdges(rawNodes, rawEdges)
  const visibleTypes = mode === "expanded" ? EXPANDED_VISIBLE_NODE_TYPES : COLLAPSED_VISIBLE_NODE_TYPES
  const remapEdges = mode !== "expanded"
  const { visibleNodes, nodeById, workItemToBlock, resolveTopGoal, topGoalIds } = buildVisibleNodes(rawNodes, currentEdges, visibleTypes, remapEdges)
  const visibleIds = new Set(visibleNodes.map((node) => node.id))
  const graphEdges = mode === "expanded"
    ? buildExpandedEdges(currentEdges, visibleIds, nodeById, resolveTopGoal)
    : buildCollapsedEdges(currentEdges, visibleIds, workItemToBlock, nodeById, resolveTopGoal)
  const structuralEdges = buildStructuralEdges(rawNodes, currentEdges, visibleIds, resolveTopGoal)

  const allEdgeMap = new Map<string, GraphEdge>()
  for (const edge of [...graphEdges, ...structuralEdges]) {
    allEdgeMap.set(edge.id, edge)
  }
  const visibleEdges = Array.from(allEdgeMap.values()).sort((a, b) => a.id.localeCompare(b.id))

  return {
    project: path.basename(projectDir),
    meta: {
      rawNodeCount: rawNodes.length,
      visibleNodeCount: visibleNodes.length,
      rawEdgeCount: currentEdges.length,
      visibleEdgeCount: visibleEdges.length,
      topGoalCount: topGoalIds.size,
    },
    nodes: visibleNodes,
    edges: visibleEdges,
    layout,
  }
}

export async function loadGraph(projectDir = DEFAULT_PROJECT_DIR): Promise<GraphPayload> {
  return loadGraphForMode(projectDir, "collapsed")
}

export async function loadExpandedGraph(projectDir = DEFAULT_PROJECT_DIR): Promise<GraphPayload> {
  return loadGraphForMode(projectDir, "expanded")
}
