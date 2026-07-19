const SVG_NS = 'http://www.w3.org/2000/svg'
const INITIAL_SCALE = 1 / 3

export const NODE_SIZE = {
  event: { width: 480, height: 135 },
  goal: { width: 570, height: 156 },
  issue: { width: 510, height: 135 },
  result: { width: 510, height: 135 },
  work_block: { width: 540, height: 144 },
  work_item: { width: 420, height: 126 },
}

const LAYOUT = {
  eventY: 240,
  eventGapY: 180,
  eventOffsetX: 360,
  issueY: 240,
  issueGapX: NODE_SIZE.issue.width + 120,
  goalY: 510,
  subgoalY: 840,
  topWorkBlockY: 1200,
  subgoalWorkBlockY: 1200,
  resultY: 1620,
  resultGapY: 180,
  subgoalGapX: 840,
  branchGapX: 930,
  topWorkGapX: 630,
  communityGapX: 1050,
  marginX: 270,
  fallbackY: 2250,
  workItemGapY: 180,
  workItemColumnGapX: 510,
  workItemPaddingX: 120,
  workItemPaddingY: 120,
  resultLaneGapX: 360,
}

let rendererSeq = 0

export function normalizeGraphPayload(payload) {
  const nodes = Array.isArray(payload?.nodes) ? payload.nodes : []
  const edges = Array.isArray(payload?.edges) ? payload.edges : []
  return {
    ...payload,
    nodes,
    edges,
    nodeMap: Object.fromEntries(nodes.map((node) => [node.id, node])),
    edgeMap: Object.fromEntries(edges.map((edge) => [edge.id, edge])),
  }
}

export function normalizeGraphRenderOptions(options = {}) {
  return {
    mode: options.mode || 'current',
    highlightNodeIds: new Set(options.highlightNodeIds || []),
    highlightEdgeIds: new Set(options.highlightEdgeIds || []),
    draftNodeIds: new Set(options.draftNodeIds || []),
    draftEdgeIds: new Set(options.draftEdgeIds || []),
    draftDetailUrlKeys: new Set(options.draftDetailUrlKeys || []),
    focusNodeId: options.focusNodeId || '',
    focusEdgeId: options.focusEdgeId || '',
  }
}

export function graphDetailUrlKey(nodeId, detailUrl) {
  return `${nodeId}\u0000${detailUrl}`
}

export function shouldUseDraftNoteFallback(options, nodeId, detailUrl) {
  return options.mode === 'draft-preview'
    && String(detailUrl).startsWith('notes/')
    && options.draftDetailUrlKeys.has(graphDetailUrlKey(nodeId, detailUrl))
}

export function graphNodeCardFields(node) {
  return [
    ['Type', node.type],
    ['ID', node.id],
    ['Status', node.status],
    ['Completion', node.completionScore == null ? null : `${node.completionScore}`],
    ['Resolution', node.resolutionScore == null ? null : `${node.resolutionScore}`],
    ['Detail URL', node.detailUrl],
    ['First step', node.firstStep == null ? null : String(node.firstStep)],
    ['First seen', node.firstSeenAt],
    ['Parent goal', node.parentGoalId],
    ['Owner goal', node.ownerGoalId],
    ['Community goal', node.communityGoalId],
    ['Top goal', node.topGoalId],
    ['Producing block', node.producingWorkBlockId],
    ['Linked work block', node.linkedWorkBlockId],
  ].filter(([, value]) => value !== null && value !== undefined && value !== '')
}

export function projectGraphDetailHref(projectName, detailUrl) {
  if (!projectName || !detailUrl) return detailUrl || ''
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/)/i.test(detailUrl)) return detailUrl
  return `/web/project-files.html?project=${encodeURIComponent(projectName)}&path=${encodeURIComponent(detailUrl)}`
}

export function isEdgeHighlighted(edge, selectedNodeId, options = normalizeGraphRenderOptions()) {
  if (options.highlightEdgeIds.has(edge.id)) return true
  if (options.mode === 'draft-preview') return false
  return Boolean(selectedNodeId && (edge.source === selectedNodeId || edge.target === selectedNodeId))
}

function createSvg(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag)
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value))
  return el
}

function midpoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

function sortByStepThenId(a, b) {
  const av = a?.firstStep ?? Number.MAX_SAFE_INTEGER
  const bv = b?.firstStep ?? Number.MAX_SAFE_INTEGER
  return av - bv || String(a?.id || '').localeCompare(String(b?.id || ''))
}

function groupBy(items, getKey) {
  const map = new Map()
  for (const item of items) {
    const key = getKey(item)
    if (!map.has(key)) map.set(key, [])
    map.get(key).push(item)
  }
  return map
}

function centeredRowWidth(count, nodeWidth, centerGap) {
  if (!count) return 0
  return nodeWidth + (count - 1) * centerGap
}

function getNodeSize(type) {
  return NODE_SIZE[type] || { width: 180, height: 60 }
}

function wrapNodeLines(text, maxCharsPerLine, maxLines) {
  const normalized = (text || '').replace(/\s+/g, ' ').trim()
  if (!normalized) return ['']

  const lines = []
  let current = ''
  for (const char of normalized) {
    if ((current + char).length > maxCharsPerLine) {
      lines.push(current)
      current = char
      if (lines.length === maxLines - 1) break
    } else {
      current += char
    }
  }
  if (lines.length < maxLines && current) lines.push(current)

  const consumed = lines.join('')
  if (consumed.length < normalized.length) {
    const last = lines[lines.length - 1] || ''
    lines[lines.length - 1] = last.slice(0, Math.max(0, last.length - 1)) + '...'
  }
  return lines
}

function buildCollapsedCommunities(nodes) {
  const topGoals = nodes.filter((node) => node.type === 'goal' && !node.parentGoalId).sort(sortByStepThenId)
  return topGoals.map((topGoal) => {
    const communityNodes = nodes.filter((node) => node.communityGoalId === topGoal.id || node.id === topGoal.id)
    const subgoals = communityNodes.filter((node) => node.type === 'goal' && node.parentGoalId === topGoal.id).sort(sortByStepThenId)
    const topWorkBlocks = communityNodes.filter((node) => node.type === 'work_block' && node.ownerGoalId === topGoal.id).sort(sortByStepThenId)
    const workBlocksByOwner = groupBy(
      communityNodes.filter((node) => node.type === 'work_block' && node.ownerGoalId && node.ownerGoalId !== topGoal.id),
      (node) => node.ownerGoalId,
    )
    const resultsByWorkBlock = groupBy(
      communityNodes.filter((node) => node.type === 'result' && node.producingWorkBlockId),
      (node) => node.producingWorkBlockId,
    )
    return {
      topGoal,
      events: communityNodes.filter((node) => node.type === 'event').sort(sortByStepThenId),
      issues: communityNodes.filter((node) => node.type === 'issue').sort(sortByStepThenId),
      topWorkBlocks,
      subgoalColumns: subgoals.map((subgoal) => ({
        subgoal,
        workBlocks: (workBlocksByOwner.get(subgoal.id) || []).sort(sortByStepThenId),
      })),
      resultsByWorkBlock,
    }
  })
}

function measureCollapsedCommunity(community) {
  const issueWidth = centeredRowWidth(community.issues.length, NODE_SIZE.issue.width, LAYOUT.issueGapX)
  const topWorkWidth = Math.max(1, community.topWorkBlocks.length) * LAYOUT.topWorkGapX
  const subgoalBranchWidth = community.subgoalColumns.reduce((sum, column) => {
    const workWidth = Math.max(1, column.workBlocks.length) * 165
    return sum + Math.max(LAYOUT.subgoalGapX, workWidth)
  }, 0)
  const totalBranchWidth = topWorkWidth + (community.topWorkBlocks.length && community.subgoalColumns.length ? LAYOUT.branchGapX : 0) + Math.max(0, subgoalBranchWidth)
  return Math.max(420, issueWidth, totalBranchWidth)
}

function placeResultStack(positions, results, x) {
  results.forEach((result, index) => {
    positions[result.id] = { x, y: LAYOUT.resultY + index * LAYOUT.resultGapY }
  })
}

function placeCollapsedCommunity(positions, containers, community, centerX) {
  void containers
  const width = measureCollapsedCommunity(community)
  positions[community.topGoal.id] = { x: centerX, y: LAYOUT.goalY }

  community.issues.forEach((node, index) => {
    const x = centerX - ((community.issues.length - 1) * LAYOUT.issueGapX) / 2 + index * LAYOUT.issueGapX
    positions[node.id] = { x, y: LAYOUT.issueY }
  })

  community.events.forEach((node, index) => {
    positions[node.id] = { x: centerX - width / 2 - LAYOUT.eventOffsetX, y: LAYOUT.eventY + index * LAYOUT.eventGapY }
  })

  const topWorkWidth = Math.max(1, community.topWorkBlocks.length) * LAYOUT.topWorkGapX
  const subgoalBranchWidth = community.subgoalColumns.reduce((sum, column) => {
    const workWidth = Math.max(1, column.workBlocks.length) * 165
    return sum + Math.max(LAYOUT.subgoalGapX, workWidth)
  }, 0)
  const combinedWidth = topWorkWidth + (community.topWorkBlocks.length && community.subgoalColumns.length ? LAYOUT.branchGapX : 0) + Math.max(0, subgoalBranchWidth)
  const leftEdge = centerX - combinedWidth / 2

  const topWorkCenter = leftEdge + topWorkWidth / 2
  community.topWorkBlocks.forEach((node, index) => {
    const x = topWorkCenter - ((community.topWorkBlocks.length - 1) * LAYOUT.topWorkGapX) / 2 + index * LAYOUT.topWorkGapX
    positions[node.id] = { x, y: LAYOUT.topWorkBlockY }
    placeResultStack(positions, community.resultsByWorkBlock.get(node.id) || [], x)
  })

  let subgoalCursor = leftEdge + topWorkWidth + (community.topWorkBlocks.length && community.subgoalColumns.length ? LAYOUT.branchGapX : 0)
  community.subgoalColumns.forEach((column) => {
    const workWidth = Math.max(1, column.workBlocks.length) * 165
    const branchWidth = Math.max(LAYOUT.subgoalGapX, workWidth)
    const branchCenter = subgoalCursor + branchWidth / 2
    positions[column.subgoal.id] = { x: branchCenter, y: LAYOUT.subgoalY }
    column.workBlocks.forEach((node, blockIndex) => {
      const x = branchCenter - ((column.workBlocks.length - 1) * 110) / 2 + blockIndex * 165
      positions[node.id] = { x, y: LAYOUT.subgoalWorkBlockY }
      placeResultStack(positions, column.resultsByWorkBlock?.get(node.id) || community.resultsByWorkBlock.get(node.id) || [], x)
    })
    subgoalCursor += branchWidth
  })

  return width
}

function buildExpandedCommunities(nodes) {
  const topGoals = nodes.filter((node) => node.type === 'goal' && !node.parentGoalId).sort(sortByStepThenId)
  return topGoals.map((topGoal) => {
    const communityNodes = nodes.filter((node) => node.communityGoalId === topGoal.id || node.id === topGoal.id)
    const subgoals = communityNodes.filter((node) => node.type === 'goal' && node.parentGoalId === topGoal.id).sort(sortByStepThenId)
    const blocks = communityNodes.filter((node) => node.type === 'work_block').sort(sortByStepThenId)
    const itemsByBlock = groupBy(
      communityNodes.filter((node) => node.type === 'work_item' && node.linkedWorkBlockId),
      (node) => node.linkedWorkBlockId,
    )
    const resultsByBlock = groupBy(
      communityNodes.filter((node) => node.type === 'result' && node.producingWorkBlockId),
      (node) => node.producingWorkBlockId,
    )
    const topBlocks = blocks.filter((block) => block.ownerGoalId === topGoal.id)
    const blocksByOwner = groupBy(
      blocks.filter((block) => block.ownerGoalId && block.ownerGoalId !== topGoal.id),
      (block) => block.ownerGoalId,
    )

    return {
      topGoal,
      events: communityNodes.filter((node) => node.type === 'event').sort(sortByStepThenId),
      issues: communityNodes.filter((node) => node.type === 'issue').sort(sortByStepThenId),
      topBlocks: topBlocks.map((block) => ({
        block,
        items: (itemsByBlock.get(block.id) || []).sort(sortByStepThenId),
        results: (resultsByBlock.get(block.id) || []).sort(sortByStepThenId),
      })),
      subgoalColumns: subgoals.map((subgoal) => ({
        subgoal,
        blocks: (blocksByOwner.get(subgoal.id) || []).sort(sortByStepThenId).map((block) => ({
          block,
          items: (itemsByBlock.get(block.id) || []).sort(sortByStepThenId),
          results: (resultsByBlock.get(block.id) || []).sort(sortByStepThenId),
        })),
      })),
    }
  })
}

function splitWorkItemsIntoColumns(items, edges) {
  if (!items.length) return []
  const itemIds = new Set(items.map((item) => item.id))
  const nextEdges = edges.filter((edge) => edge.type === 'next' && itemIds.has(edge.source) && itemIds.has(edge.target))
  const itemMap = new Map(items.map((item) => [item.id, item]))
  const inDegree = new Map(items.map((item) => [item.id, 0]))
  const outgoing = new Map(items.map((item) => [item.id, []]))
  nextEdges.forEach((edge) => {
    inDegree.set(edge.target, (inDegree.get(edge.target) || 0) + 1)
    outgoing.get(edge.source)?.push(edge.target)
  })

  const roots = items.filter((item) => (inDegree.get(item.id) || 0) === 0).sort(sortByStepThenId)
  const queue = []
  const unvisited = new Set(items.map((item) => item.id))
  const resolved = []

  function consumeChain(startId) {
    const column = []
    let current = startId
    let depthOffset = 0
    while (current && unvisited.has(current)) {
      unvisited.delete(current)
      const node = itemMap.get(current)
      if (!node) break
      column.push({ node, depthOffset })
      const nextIds = (outgoing.get(current) || [])
        .filter((id) => unvisited.has(id))
        .sort((a, b) => sortByStepThenId(itemMap.get(a), itemMap.get(b)))
      if (!nextIds.length) break
      const nextRowDepth = depthOffset + 1
      nextIds.slice(1).forEach((branchId) => {
        queue.push({ startDepth: nextRowDepth, chainStartId: branchId })
      })
      current = nextIds[0]
      depthOffset = nextRowDepth
    }
    return column
  }

  roots.forEach((root) => {
    if (unvisited.has(root.id)) queue.push({ startDepth: 0, chainStartId: root.id })
  })

  while (queue.length) {
    const next = queue.shift()
    if (!next || !unvisited.has(next.chainStartId)) continue
    resolved.push({ startDepth: next.startDepth, nodes: consumeChain(next.chainStartId) })
  }

  items.sort(sortByStepThenId).forEach((item) => {
    if (unvisited.has(item.id)) resolved.push({ startDepth: 0, nodes: consumeChain(item.id) })
  })

  return resolved.filter((column) => column.nodes.length)
}

function measureExpandedCluster(cluster, edges) {
  const columns = splitWorkItemsIntoColumns(cluster.items, edges)
  const itemWidth = NODE_SIZE.work_item.width
  const itemHeight = NODE_SIZE.work_item.height
  const workBlockWidth = NODE_SIZE.work_block.width
  const columnsWidth = Math.max(1, columns.length) * itemWidth + Math.max(0, columns.length - 1) * (LAYOUT.workItemColumnGapX - itemWidth)
  const containerWidth = Math.max(workBlockWidth, columnsWidth) + LAYOUT.workItemPaddingX * 2
  const resultsWidth = cluster.results.length ? NODE_SIZE.result.width + LAYOUT.resultLaneGapX : 0
  const width = containerWidth + resultsWidth
  const maxDepth = Math.max(0, ...columns.flatMap((column) => column.nodes.map((entry) => column.startDepth + entry.depthOffset)))
  const height = NODE_SIZE.work_block.height + LAYOUT.workItemPaddingY + Math.max(itemHeight, (maxDepth + 1) * LAYOUT.workItemGapY) + LAYOUT.workItemPaddingY
  return { width, height, containerWidth, columns }
}

function placeExpandedCluster(positions, containers, cluster, left, top, edges) {
  const measure = measureExpandedCluster(cluster, edges)
  const workBlockSize = getNodeSize('work_block')
  const itemSize = getNodeSize('work_item')
  const resultSize = getNodeSize('result')
  const blockX = left + workBlockSize.width / 2 + LAYOUT.workItemPaddingX
  const blockY = top + workBlockSize.height / 2 + 40
  positions[cluster.block.id] = { x: blockX, y: blockY }

  const columnLeft = left + LAYOUT.workItemPaddingX
  const itemBaseY = top + workBlockSize.height + LAYOUT.workItemPaddingY
  measure.columns.forEach((column, columnIndex) => {
    const x = columnLeft + itemSize.width / 2 + columnIndex * LAYOUT.workItemColumnGapX
    column.nodes.forEach((entry) => {
      positions[entry.node.id] = {
        x,
        y: itemBaseY + (column.startDepth + entry.depthOffset) * LAYOUT.workItemGapY,
      }
    })
  })

  const rightmostColumnX = measure.columns.length
    ? columnLeft + itemSize.width / 2 + (measure.columns.length - 1) * LAYOUT.workItemColumnGapX
    : blockX
  const resultX = rightmostColumnX + itemSize.width / 2 + LAYOUT.resultLaneGapX + resultSize.width / 2
  cluster.results.forEach((result, index) => {
    positions[result.id] = { x: resultX, y: itemBaseY + index * LAYOUT.resultGapY }
  })

  containers[cluster.block.id] = {
    x: left,
    y: top,
    width: measure.containerWidth,
    height: measure.height,
    blockId: cluster.block.id,
  }
  return measure.width
}

function placeHolderExpandedWidth(cluster, edges) {
  return measureExpandedCluster(cluster, edges).width
}

function measureExpandedCommunity(community, edges) {
  const issueWidth = centeredRowWidth(community.issues.length, NODE_SIZE.issue.width, LAYOUT.issueGapX)
  const topWidth = community.topBlocks.reduce((sum, cluster) => sum + placeHolderExpandedWidth(cluster, edges), 0)
  const subWidth = community.subgoalColumns.reduce((sum, column) => sum + Math.max(LAYOUT.subgoalGapX, column.blocks.reduce((inner, cluster) => inner + placeHolderExpandedWidth(cluster, edges), 0) || LAYOUT.subgoalGapX), 0)
  return Math.max(600, issueWidth, topWidth + (topWidth && subWidth ? LAYOUT.branchGapX : 0) + subWidth)
}

function placeExpandedCommunity(positions, containers, community, centerX, edges) {
  const width = measureExpandedCommunity(community, edges)
  positions[community.topGoal.id] = { x: centerX, y: LAYOUT.goalY }

  community.issues.forEach((node, index) => {
    const x = centerX - ((community.issues.length - 1) * LAYOUT.issueGapX) / 2 + index * LAYOUT.issueGapX
    positions[node.id] = { x, y: LAYOUT.issueY }
  })

  community.events.forEach((node, index) => {
    positions[node.id] = { x: centerX - width / 2 - LAYOUT.eventOffsetX, y: LAYOUT.eventY + index * LAYOUT.eventGapY }
  })

  const topBlocksWidth = community.topBlocks.reduce((sum, cluster, index) => sum + placeHolderExpandedWidth(cluster, edges) + (index ? LAYOUT.topWorkGapX : 0), 0)
  const subgoalWidth = community.subgoalColumns.reduce((sum, column, columnIndex) => {
    const blocksWidth = column.blocks.reduce((inner, cluster, blockIndex) => inner + placeHolderExpandedWidth(cluster, edges) + (blockIndex ? 180 : 0), 0)
    return sum + Math.max(LAYOUT.subgoalGapX, blocksWidth || LAYOUT.subgoalGapX) + (columnIndex ? 180 : 0)
  }, 0)

  const combinedWidth = topBlocksWidth + (topBlocksWidth && subgoalWidth ? LAYOUT.branchGapX : 0) + subgoalWidth
  let cursor = centerX - combinedWidth / 2

  community.topBlocks.forEach((cluster, index) => {
    if (index) cursor += LAYOUT.topWorkGapX
    const clusterWidth = placeHolderExpandedWidth(cluster, edges)
    placeExpandedCluster(positions, containers, cluster, cursor, LAYOUT.topWorkBlockY - 100, edges)
    cursor += clusterWidth
  })

  if (community.topBlocks.length && community.subgoalColumns.length) cursor += LAYOUT.branchGapX
  community.subgoalColumns.forEach((column, columnIndex) => {
    if (columnIndex) cursor += 180
    const blocksWidth = column.blocks.reduce((inner, cluster, blockIndex) => inner + placeHolderExpandedWidth(cluster, edges) + (blockIndex ? 180 : 0), 0)
    const branchWidth = Math.max(LAYOUT.subgoalGapX, blocksWidth || LAYOUT.subgoalGapX)
    const branchCenter = cursor + branchWidth / 2
    positions[column.subgoal.id] = { x: branchCenter, y: LAYOUT.subgoalY }
    let blockCursor = cursor
    column.blocks.forEach((cluster, blockIndex) => {
      if (blockIndex) blockCursor += 180
      const clusterWidth = placeHolderExpandedWidth(cluster, edges)
      placeExpandedCluster(positions, containers, cluster, blockCursor, LAYOUT.subgoalWorkBlockY - 100, edges)
      blockCursor += clusterWidth
    })
    cursor += branchWidth
  })

  return width
}

export function defaultGraphPositions(nodes, edges, view = 'collapsed') {
  const positions = {}
  const containers = {}
  const communities = view === 'expanded' ? buildExpandedCommunities(nodes) : buildCollapsedCommunities(nodes)
  let cursorX = LAYOUT.marginX

  communities.forEach((community) => {
    const width = view === 'expanded' ? measureExpandedCommunity(community, edges) : measureCollapsedCommunity(community)
    const centerX = cursorX + width / 2
    if (view === 'expanded') placeExpandedCommunity(positions, containers, community, centerX, edges)
    else placeCollapsedCommunity(positions, containers, community, centerX)
    cursorX += width + LAYOUT.communityGapX
  })

  nodes.filter((node) => !positions[node.id]).sort(sortByStepThenId).forEach((node, index) => {
    positions[node.id] = { x: cursorX, y: LAYOUT.fallbackY + index * 120 }
  })

  return { positions, containers }
}

export class ProjectGraphRenderer {
  constructor({ root, projectName = '', view = 'collapsed', showLegend = true, showControls = true, readonly = true, initialScale = INITIAL_SCALE } = {}) {
    if (!root) throw new Error('ProjectGraphRenderer requires root')
    this.root = root
    this.projectName = projectName
    this.view = view === 'expanded' ? 'expanded' : 'collapsed'
    this.showLegend = showLegend
    this.showControls = showControls
    this.readonly = readonly
    this.initialScale = initialScale
    this.id = `pg-${++rendererSeq}`
    this.detailLoadSeq = 0
    this.state = {
      payload: null,
      positions: {},
      bends: {},
      selectedNodeId: null,
      selectedEdgeId: null,
      expandedNodeId: null,
      panDrag: null,
      zoom: 1,
      containers: {},
      options: normalizeGraphRenderOptions(),
    }
    this._onSvgClick = this._onSvgClick.bind(this)
    this._onPointerDown = this._onPointerDown.bind(this)
    this._onPointerMove = this._onPointerMove.bind(this)
    this._onPointerUp = this._onPointerUp.bind(this)
    this._build()
  }

  _build() {
    this.root.innerHTML = `
      <section class="pg-renderer ${this.readonly ? 'readonly' : ''}" data-mode="current">
        ${this.showLegend ? `
          <section class="pg-legend">
            <h2>Legend</h2>
            <div class="pg-legend-row"><span class="pg-dot event"></span>Event</div>
            <div class="pg-legend-row"><span class="pg-dot goal"></span>Goal</div>
            <div class="pg-legend-row"><span class="pg-dot issue"></span>Issue</div>
            <div class="pg-legend-row"><span class="pg-dot result"></span>Result</div>
            <div class="pg-legend-row"><span class="pg-dot work_block"></span>Work Block</div>
            <div class="pg-legend-row" data-expanded-only><span class="pg-dot work_item"></span>Work Item</div>
          </section>
        ` : ''}
        ${this.showControls ? `
          <div class="pg-zoom-controls">
            <button type="button" data-graph-action="zoom-out">-</button>
            <button type="button" data-graph-action="zoom-in">+</button>
            <button type="button" data-graph-action="fit">Fit</button>
          </div>
        ` : ''}
        <div class="pg-scroll">
          <svg class="pg-svg" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid meet">
            <defs>
              <marker id="${this.id}-arrowhead" markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto">
                <path d="M 0 0 L 10 4 L 0 8 z" fill="#94a3b8"></path>
              </marker>
            </defs>
            <g data-layer="container"></g>
            <g data-layer="node"></g>
            <g data-layer="edge"></g>
            <g data-layer="handle"></g>
          </svg>
        </div>
        <div class="pg-node-card hidden">
          <div class="pg-node-card-backdrop"></div>
          <section class="pg-node-card-panel">
            <button class="pg-node-card-close" type="button">关闭</button>
            <h2 class="pg-node-card-title"></h2>
            <div class="pg-node-card-meta"></div>
            <div class="pg-node-card-fields"></div>
            <pre class="pg-node-card-description"></pre>
          </section>
        </div>
        <div class="pg-detail-viewer hidden" role="dialog" aria-modal="true" aria-label="来源文件预览">
          <div class="pg-detail-viewer-backdrop"></div>
          <section class="pg-detail-viewer-panel">
            <header class="pg-detail-viewer-header">
              <div>
                <div class="pg-detail-viewer-title">来源文件</div>
                <div class="pg-detail-viewer-path"></div>
              </div>
              <button class="pg-detail-viewer-close" type="button">关闭</button>
            </header>
            <pre class="pg-detail-viewer-content">请选择来源文件</pre>
          </section>
        </div>
      </section>
    `
    this.el = this.root.querySelector('.pg-renderer')
    this.scrollEl = this.root.querySelector('.pg-scroll')
    this.svg = this.root.querySelector('.pg-svg')
    this.containerLayer = this.root.querySelector('[data-layer="container"]')
    this.nodeLayer = this.root.querySelector('[data-layer="node"]')
    this.edgeLayer = this.root.querySelector('[data-layer="edge"]')
    this.handleLayer = this.root.querySelector('[data-layer="handle"]')
    this.nodeCardEl = this.root.querySelector('.pg-node-card')
    this.nodeCardTitleEl = this.root.querySelector('.pg-node-card-title')
    this.nodeCardMetaEl = this.root.querySelector('.pg-node-card-meta')
    this.nodeCardFieldsEl = this.root.querySelector('.pg-node-card-fields')
    this.nodeCardDescriptionEl = this.root.querySelector('.pg-node-card-description')
    this.detailViewerEl = this.root.querySelector('.pg-detail-viewer')
    this.detailViewerPathEl = this.root.querySelector('.pg-detail-viewer-path')
    this.detailViewerContentEl = this.root.querySelector('.pg-detail-viewer-content')
    this.root.querySelector('[data-graph-action="zoom-out"]')?.addEventListener('click', () => this.zoomBy(1 / 1.2))
    this.root.querySelector('[data-graph-action="zoom-in"]')?.addEventListener('click', () => this.zoomBy(1.2))
    this.root.querySelector('[data-graph-action="fit"]')?.addEventListener('click', () => this.fit())
    this.root.querySelector('.pg-node-card-backdrop')?.addEventListener('click', () => this.hideNodeCard())
    this.root.querySelector('.pg-node-card-close')?.addEventListener('click', () => this.hideNodeCard())
    this.root.querySelector('.pg-detail-viewer-backdrop')?.addEventListener('click', () => this.hideDetailViewer())
    this.root.querySelector('.pg-detail-viewer-close')?.addEventListener('click', () => this.hideDetailViewer())
    this.svg.addEventListener('click', this._onSvgClick)
    this.svg.addEventListener('pointerdown', this._onPointerDown)
    this.svg.addEventListener('pointermove', this._onPointerMove)
    this.svg.addEventListener('pointerup', this._onPointerUp)
  }

  destroy() {
    this.detailLoadSeq += 1
    this.svg?.removeEventListener('click', this._onSvgClick)
    this.svg?.removeEventListener('pointerdown', this._onPointerDown)
    this.svg?.removeEventListener('pointermove', this._onPointerMove)
    this.svg?.removeEventListener('pointerup', this._onPointerUp)
    this.root.innerHTML = ''
  }

  setView(view) {
    this.view = view === 'expanded' ? 'expanded' : 'collapsed'
    if (this.state.payload) this.setPayload(this.state.payload, this.state.options)
  }

  setPayload(payload, options = {}) {
    const normalized = normalizeGraphPayload(payload)
    this.state.payload = normalized
    this.state.options = normalizeGraphRenderOptions(options)
    this.el.dataset.mode = this.state.options.mode
    const layout = defaultGraphPositions(normalized.nodes, normalized.edges, this.view)
    this.state.positions = { ...layout.positions, ...(normalized.layout?.nodes || {}) }
    this.state.bends = { ...(normalized.layout?.edges || {}) }
    this.state.containers = layout.containers
    this.state.selectedNodeId = this.state.options.focusNodeId || null
    this.state.selectedEdgeId = this.state.options.focusEdgeId || null
    this.state.expandedNodeId = null
    this.render()
    this.resetViewport()
    if (this.state.options.focusNodeId) this.focusNode(this.state.options.focusNodeId)
    if (this.state.options.focusEdgeId) this.focusEdge(this.state.options.focusEdgeId)
  }

  setHighlights(options = {}) {
    this.state.options = normalizeGraphRenderOptions({ ...this.state.options, ...options })
    this.render()
  }

  getLayout() {
    return { nodes: this.state.positions, edges: this.state.bends }
  }

  nodePosition(nodeId) {
    return this.state.positions[nodeId]
  }

  nodeAnchors(nodeId) {
    const position = this.nodePosition(nodeId)
    const node = this.state.payload.nodeMap[nodeId]
    const size = getNodeSize(node?.type)
    return {
      left: { x: position.x - size.width / 2, y: position.y },
      right: { x: position.x + size.width / 2, y: position.y },
      top: { x: position.x, y: position.y - size.height / 2 },
      bottom: { x: position.x, y: position.y + size.height / 2 },
    }
  }

  sameCommunity(edge) {
    const source = this.state.payload.nodeMap[edge.source]
    const target = this.state.payload.nodeMap[edge.target]
    return source?.communityGoalId && target?.communityGoalId && source.communityGoalId === target.communityGoalId
  }

  isSubgoal(node) {
    return node?.type === 'goal' && Boolean(node.parentGoalId)
  }

  horizontalAnchors(source, target) {
    const sourcePos = this.nodePosition(source.id)
    const targetPos = this.nodePosition(target.id)
    return sourcePos.x <= targetPos.x ? ['right', 'left'] : ['left', 'right']
  }

  verticalAnchors(source, target) {
    const sourcePos = this.nodePosition(source.id)
    const targetPos = this.nodePosition(target.id)
    return sourcePos.y <= targetPos.y ? ['bottom', 'top'] : ['top', 'bottom']
  }

  anchorKeysForEdge(edge) {
    const source = this.state.payload.nodeMap[edge.source]
    const target = this.state.payload.nodeMap[edge.target]
    const intra = this.sameCommunity(edge)
    const pair = `${source?.type}->${target?.type}`

    if (this.view === 'expanded') {
      if (pair === 'work_item->work_item') {
        return Math.abs(this.nodePosition(source.id).x - this.nodePosition(target.id).x) > 80
          ? this.horizontalAnchors(source, target)
          : this.verticalAnchors(source, target)
      }
      if (pair === 'work_item->result') return ['right', 'left']
      if (pair === 'result->work_item') return ['left', 'right']
      if (pair === 'work_item->issue') return this.horizontalAnchors(source, target)
    }

    if (pair === 'work_block->result' && intra) return ['left', 'left']
    if (pair === 'result->goal' || pair === 'result->issue') return ['right', 'bottom']
    if (!intra) return this.horizontalAnchors(source, target)
    if (pair === 'event->issue') return this.horizontalAnchors(source, target)
    if (pair === 'issue->goal') return this.verticalAnchors(source, target)
    if (pair === 'goal->goal') return this.verticalAnchors(source, target)
    if (pair === 'goal->work_block') {
      if (target.ownerGoalId === source.id) return this.verticalAnchors(source, target)
      if (this.isSubgoal(source)) return this.verticalAnchors(source, target)
      return this.horizontalAnchors(source, target)
    }
    if (pair === 'work_block->issue') return this.verticalAnchors(source, target)
    return this.verticalAnchors(source, target)
  }

  edgeBend(edgeId) {
    return this.state.bends[edgeId] || null
  }

  defaultEdgeBend(edge) {
    const sourceNode = this.state.payload.nodeMap[edge.source]
    const targetNode = this.state.payload.nodeMap[edge.target]
    const intra = this.sameCommunity(edge)
    const pair = `${sourceNode?.type}->${targetNode?.type}`
    const [startKey] = this.anchorKeysForEdge(edge)
    const horizontal = startKey === 'left' || startKey === 'right'

    if (pair === 'work_item->work_item') return horizontal ? { dx: -110, dy: -32 } : { dx: -36, dy: 80 }
    if (pair === 'work_item->result') return { dx: 120, dy: -26 }
    if (pair === 'result->work_item') return { dx: -150, dy: -26 }
    if (pair === 'work_item->issue') return { dx: -120, dy: -30 }
    if (pair === 'result->goal') return intra ? { dx: -42, dy: -180 } : { dx: horizontal ? -180 : -42, dy: -80 }
    if (pair === 'result->issue') return horizontal ? { dx: -140, dy: -24 } : { dx: -36, dy: -160 }
    if (pair === 'work_block->issue') return horizontal ? { dx: -160, dy: -28 } : { dx: -34, dy: -150 }
    if (pair === 'issue->goal') return horizontal ? { dx: -120, dy: -24 } : { dx: -28, dy: 90 }
    if (pair === 'goal->goal') return horizontal ? { dx: -140, dy: -28 } : { dx: -32, dy: 120 }
    if (pair === 'goal->work_block') return horizontal ? { dx: -150, dy: -26 } : { dx: -34, dy: 110 }
    if (pair === 'work_block->result') return horizontal ? { dx: -120, dy: -24 } : { dx: -34, dy: 110 }
    if (pair === 'event->issue') return horizontal ? { dx: 80, dy: -22 } : { dx: -24, dy: 80 }
    return horizontal ? { dx: 140, dy: -24 } : { dx: -28, dy: 90 }
  }

  edgeGeometry(edge) {
    const [startKey, endKey] = this.anchorKeysForEdge(edge)
    const start = this.nodeAnchors(edge.source)[startKey]
    const end = this.nodeAnchors(edge.target)[endKey]
    const mid = midpoint(start, end)
    const bend = this.edgeBend(edge.id) || this.defaultEdgeBend(edge)
    const handle = { x: mid.x + bend.dx, y: mid.y + bend.dy }
    return { start, end, mid, handle }
  }

  quadPath(start, handle, end) {
    return `M ${start.x} ${start.y} Q ${handle.x} ${handle.y} ${end.x} ${end.y}`
  }

  renderContainers() {
    this.containerLayer.innerHTML = ''
    if (this.view !== 'expanded') return
    Object.values(this.state.containers).forEach((container) => {
      const rect = createSvg('rect', {
        x: container.x,
        y: container.y,
        width: container.width,
        height: container.height,
        rx: 28,
        ry: 28,
        class: `pg-work-block-container${this.state.selectedNodeId === container.blockId ? ' selected' : ''}`,
      })
      this.containerLayer.append(rect)
    })
  }

  renderEdges() {
    this.edgeLayer.innerHTML = ''
    this.handleLayer.innerHTML = ''
    for (const edge of this.state.payload.edges) {
      if (!this.state.positions[edge.source] || !this.state.positions[edge.target]) continue
      const { start, end, mid, handle } = this.edgeGeometry(edge)
      const pathData = this.quadPath(start, handle, end)
      const group = createSvg('g')
      const selected = this.state.selectedEdgeId === edge.id
      const highlighted = isEdgeHighlighted(edge, this.state.selectedNodeId, this.state.options)
      const draft = this.state.options.draftEdgeIds.has(edge.id)
      const path = createSvg('path', {
        d: pathData,
        class: `pg-edge-path${selected ? ' selected' : ''}${highlighted ? ' highlighted' : ''}${draft ? ' draft' : ''}`,
        'marker-end': `url(#${this.id}-arrowhead)`,
      })
      const hit = createSvg('path', { d: pathData, class: 'pg-edge-hit' })
      hit.addEventListener('click', (event) => {
        event.stopPropagation()
        this.state.selectedEdgeId = edge.id
        this.state.selectedNodeId = null
        this.state.expandedNodeId = null
        this.render()
      })
      const label = createSvg('text', { x: handle.x, y: handle.y - 10, class: 'pg-edge-label' })
      label.textContent = edge.label || edge.type || ''
      group.append(path, hit, label)
      this.edgeLayer.append(group)

      if (selected) {
        this.handleLayer.append(createSvg('line', {
          x1: mid.x,
          y1: mid.y,
          x2: handle.x,
          y2: handle.y,
          class: 'pg-bend-guide',
        }))
      }
    }
  }

  renderNodes() {
    this.nodeLayer.innerHTML = ''
    for (const node of this.state.payload.nodes) {
      const position = this.nodePosition(node.id)
      if (!position) continue
      const size = getNodeSize(node.type)
      const selected = this.state.selectedNodeId === node.id
      const highlighted = this.state.options.highlightNodeIds.has(node.id)
      const draft = this.state.options.draftNodeIds.has(node.id)
      const g = createSvg('g', {
        class: `pg-node ${node.type}${selected ? ' selected' : ''}${highlighted ? ' highlighted' : ''}${draft ? ' draft' : ''}`,
        transform: `translate(${position.x - size.width / 2} ${position.y - size.height / 2})`,
      })
      const rect = createSvg('rect', { width: size.width, height: size.height })
      const text = createSvg('text', { x: size.width / 2, y: size.height / 2 })
      const lines = wrapNodeLines(node.summary || node.label, node.type === 'work_item' ? 10 : 12, node.type === 'work_item' ? 2 : 3)
      const lineHeight = node.type === 'work_item' ? 36 : 42
      const startY = size.height / 2 - ((lines.length - 1) * lineHeight) / 2
      lines.forEach((line, index) => {
        const tspan = createSvg('tspan', { x: size.width / 2, y: startY + index * lineHeight })
        tspan.textContent = line
        text.append(tspan)
      })
      g.append(rect, text)
      g.addEventListener('click', (event) => {
        event.stopPropagation()
        if (this.state.selectedNodeId === node.id && this.state.expandedNodeId !== node.id) {
          this.state.expandedNodeId = node.id
          this.renderSelection()
          return
        }
        this.state.selectedNodeId = node.id
        this.state.selectedEdgeId = null
        this.state.expandedNodeId = null
        this.render()
      })
      this.nodeLayer.append(g)
    }
  }

  cardField(label, value, node) {
    const item = document.createElement('div')
    item.className = 'pg-node-card-field'
    const labelEl = document.createElement('div')
    labelEl.className = 'pg-node-card-field-label'
    labelEl.textContent = label
    const valueEl = document.createElement('div')
    valueEl.className = 'pg-node-card-field-value'
    if (label === 'Detail URL') {
      const link = document.createElement('a')
      link.href = projectGraphDetailHref(this.projectName, value)
      link.textContent = value
      link.target = '_blank'
      link.rel = 'noreferrer'
      if (projectGraphDetailHref(this.projectName, value) !== value) {
        link.addEventListener('click', (event) => {
          event.preventDefault()
          const draftNote = shouldUseDraftNoteFallback(this.state.options, node?.id, value)
          this.openDetailViewer(value, { draftNote })
        })
      }
      valueEl.append(link)
    } else {
      valueEl.textContent = value
    }
    item.append(labelEl, valueEl)
    return item
  }

  renderNodeFields(node) {
    this.nodeCardFieldsEl.innerHTML = ''
    graphNodeCardFields(node).forEach(([label, value]) => this.nodeCardFieldsEl.append(this.cardField(label, value, node)))
  }

  hideNodeCard() {
    this.state.expandedNodeId = null
    this.nodeCardEl.classList.add('hidden')
  }

  async openDetailViewer(detailUrl, { draftNote = false } = {}) {
    const loadSeq = ++this.detailLoadSeq
    this.detailViewerPathEl.textContent = detailUrl
    this.detailViewerContentEl.textContent = '加载中...'
    this.detailViewerEl.classList.remove('hidden')
    try {
      const response = await fetch(`/project/file/content?project=${encodeURIComponent(this.projectName)}&path=${encodeURIComponent(detailUrl)}`)
      let result
      if (response.ok) {
        result = await response.json()
      } else if (draftNote) {
        const draftResponse = await fetch(`/project/workflow/note?project=${encodeURIComponent(this.projectName)}`)
        if (!draftResponse.ok) throw new Error(await draftResponse.text())
        const draft = await draftResponse.json()
        if (!draft?.exists) throw new Error(await response.text())
        result = { type: 'text', content: draft.content }
      } else {
        throw new Error(await response.text())
      }
      if (loadSeq !== this.detailLoadSeq) return
      this.detailViewerContentEl.textContent = result?.type === 'binary'
        ? '该文件不可作为文本预览'
        : result?.content || '未返回内容'
    } catch (error) {
      if (loadSeq !== this.detailLoadSeq) return
      this.detailViewerContentEl.textContent = error instanceof Error ? error.message : '加载失败'
    }
  }

  hideDetailViewer() {
    this.detailLoadSeq += 1
    this.detailViewerEl.classList.add('hidden')
  }

  renderSelection() {
    if (this.state.selectedNodeId && this.state.expandedNodeId === this.state.selectedNodeId) {
      const node = this.state.payload.nodeMap[this.state.selectedNodeId]
      this.nodeCardTitleEl.textContent = node.summary || node.label
      this.nodeCardMetaEl.textContent = `${node.type} · ${node.id}`
      this.renderNodeFields(node)
      this.nodeCardDescriptionEl.textContent = node.description || '无 description'
      this.nodeCardEl.classList.remove('hidden')
      return
    }
    this.nodeCardEl.classList.add('hidden')
  }

  render() {
    if (!this.state.payload) return
    this.renderContainers()
    this.renderEdges()
    this.renderNodes()
    this.renderSelection()
  }

  graphBounds(paddingX = 220, paddingY = 160) {
    const nodes = this.state.payload?.nodes || []
    if (!nodes.length) return null
    const bounds = nodes.map((node) => {
      const position = this.state.positions[node.id]
      const size = getNodeSize(node.type)
      return {
        minX: position.x - size.width / 2,
        maxX: position.x + size.width / 2,
        minY: position.y - size.height / 2,
        maxY: position.y + size.height / 2,
      }
    })
    const containerBounds = Object.values(this.state.containers).map((container) => ({
      minX: container.x,
      maxX: container.x + container.width,
      minY: container.y,
      maxY: container.y + container.height,
    }))
    const allBounds = bounds.concat(containerBounds)
    const minX = Math.min(...allBounds.map((b) => b.minX)) - paddingX
    const maxX = Math.max(...allBounds.map((b) => b.maxX)) + paddingX
    const minY = Math.min(...allBounds.map((b) => b.minY)) - paddingY
    const maxY = Math.max(...allBounds.map((b) => b.maxY)) + paddingY
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
  }

  setViewBox(viewBox) {
    this.svg.setAttribute('viewBox', `${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`)
  }

  fitScale(bounds) {
    const scaleX = this.scrollEl.clientWidth / bounds.width
    const scaleY = this.scrollEl.clientHeight / bounds.height
    const scale = Math.min(scaleX, scaleY)
    return Number.isFinite(scale) && scale > 0 ? scale : this.initialScale
  }

  applyScale(scale, keepCenter = false) {
    const baseWidth = Number(this.svg.dataset.baseWidth || 0)
    const baseHeight = Number(this.svg.dataset.baseHeight || 0)
    if (!baseWidth || !baseHeight) return
    const prevWidth = this.svg.clientWidth || baseWidth * this.state.zoom
    const prevHeight = this.svg.clientHeight || baseHeight * this.state.zoom
    const prevCenterX = this.scrollEl.scrollLeft + this.scrollEl.clientWidth / 2
    const prevCenterY = this.scrollEl.scrollTop + this.scrollEl.clientHeight / 2
    const ratioX = prevWidth ? prevCenterX / prevWidth : 0.5
    const ratioY = prevHeight ? prevCenterY / prevHeight : 0.5

    this.state.zoom = scale
    this.svg.style.width = `${Math.round(baseWidth * scale)}px`
    this.svg.style.height = `${Math.round(baseHeight * scale)}px`

    if (keepCenter) {
      const nextWidth = baseWidth * scale
      const nextHeight = baseHeight * scale
      this.scrollEl.scrollLeft = Math.max(0, nextWidth * ratioX - this.scrollEl.clientWidth / 2)
      this.scrollEl.scrollTop = Math.max(0, nextHeight * ratioY - this.scrollEl.clientHeight / 2)
    }
  }

  resetViewport() {
    const bounds = this.graphBounds(900, 400)
    if (!bounds) return
    this.svg.dataset.baseWidth = String(Math.ceil(bounds.width))
    this.svg.dataset.baseHeight = String(Math.ceil(bounds.height))
    this.setViewBox(bounds)
    this.applyScale(this.initialScale)
  }

  fit() {
    const bounds = this.graphBounds(220, 160)
    if (!bounds) return
    this.applyScale(this.fitScale(bounds))
    this.scrollEl.scrollLeft = 0
    this.scrollEl.scrollTop = 0
  }

  zoomBy(factor) {
    this.applyScale(this.state.zoom * factor, true)
  }

  focusNode(nodeId) {
    if (!this.state.payload?.nodeMap[nodeId] || !this.state.positions[nodeId]) return
    this.state.selectedNodeId = nodeId
    this.state.selectedEdgeId = null
    this.state.expandedNodeId = null
    this.render()
    this.scrollToPosition(this.state.positions[nodeId])
  }

  focusEdge(edgeId) {
    const edge = this.state.payload?.edgeMap[edgeId]
    if (!edge) return
    this.state.selectedEdgeId = edgeId
    this.state.selectedNodeId = null
    this.state.expandedNodeId = null
    this.render()
    const { handle } = this.edgeGeometry(edge)
    this.scrollToPosition(handle)
  }

  scrollToPosition(position) {
    const bounds = this.graphBounds(900, 400)
    if (!bounds) return
    const scale = this.state.zoom || this.initialScale
    const left = (position.x - bounds.x) * scale - this.scrollEl.clientWidth / 2
    const top = (position.y - bounds.y) * scale - this.scrollEl.clientHeight / 2
    this.scrollEl.scrollLeft = Math.max(0, left)
    this.scrollEl.scrollTop = Math.max(0, top)
  }

  _onSvgClick() {
    if (this.state.panDrag) return
    this.state.selectedNodeId = null
    this.state.selectedEdgeId = null
    this.state.expandedNodeId = null
    this.render()
  }

  _onPointerDown(event) {
    if (event.target !== this.svg) return
    this.svg.setPointerCapture(event.pointerId)
    this.state.panDrag = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      scrollLeft: this.scrollEl.scrollLeft,
      scrollTop: this.scrollEl.scrollTop,
      moved: false,
    }
  }

  _onPointerMove(event) {
    if (!this.state.panDrag || this.state.panDrag.pointerId !== event.pointerId) return
    const dx = event.clientX - this.state.panDrag.clientX
    const dy = event.clientY - this.state.panDrag.clientY
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) this.state.panDrag.moved = true
    this.scrollEl.scrollLeft = this.state.panDrag.scrollLeft - dx
    this.scrollEl.scrollTop = this.state.panDrag.scrollTop - dy
  }

  _onPointerUp(event) {
    if (this.state.panDrag && this.state.panDrag.pointerId === event.pointerId) this.state.panDrag = null
  }
}
