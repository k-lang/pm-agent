const SVG_NS = 'http://www.w3.org/2000/svg'
const MODE = window.location.pathname === '/expanded' ? 'expanded' : 'collapsed'
const API = MODE === 'expanded' ? '/api/graph-expanded' : '/api/graph'
const INITIAL_SCALE = 1 / 3
const NODE_SIZE = {
  event: { width: 480, height: 135 },
  goal: { width: 570, height: 156 },
  issue: { width: 510, height: 135 },
  result: { width: 510, height: 135 },
  work_block: { width: 540, height: 144 },
  work_item: { width: 420, height: 126 },
}

const svg = document.getElementById('graph')
const graphScroll = document.getElementById('graph-scroll')
const containerLayer = document.getElementById('container-layer')
const edgeLayer = document.getElementById('edge-layer')
const handleLayer = document.getElementById('handle-layer')
const nodeLayer = document.getElementById('node-layer')
const metaEl = document.getElementById('meta')
const btnFit = document.getElementById('btn-fit')
const btnZoomOut = document.getElementById('btn-zoom-out')
const btnZoomIn = document.getElementById('btn-zoom-in')
const nodeCardEl = document.getElementById('node-card')
const nodeCardBackdropEl = document.getElementById('node-card-backdrop')
const nodeCardCloseEl = document.getElementById('node-card-close')
const nodeCardTitleEl = document.getElementById('node-card-title')
const nodeCardMetaEl = document.getElementById('node-card-meta')
const nodeCardFieldsEl = document.getElementById('node-card-fields')
const nodeCardDescriptionEl = document.getElementById('node-card-description')

const state = {
  payload: null,
  positions: {},
  bends: {},
  selectedNodeId: null,
  selectedEdgeId: null,
  expandedNodeId: null,
  panDrag: null,
  zoom: 1,
  containers: {},
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

function createSvg(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag)
  for (const [key, value] of Object.entries(attrs)) {
    el.setAttribute(key, String(value))
  }
  return el
}

function midpoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

function currentViewBox() {
  const raw = svg.getAttribute('viewBox')
  if (!raw) {
    const width = Number(svg.dataset.baseWidth || 0)
    const height = Number(svg.dataset.baseHeight || 0)
    return { x: 0, y: 0, width, height }
  }
  const [x, y, width, height] = raw.split(/\s+/).map(Number)
  return { x, y, width, height }
}

function setViewBox(view) {
  svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.width} ${view.height}`)
}

function applyScale(scale, keepCenter = false) {
  const baseWidth = Number(svg.dataset.baseWidth || 0)
  const baseHeight = Number(svg.dataset.baseHeight || 0)
  if (!baseWidth || !baseHeight) return

  const prevWidth = svg.clientWidth || baseWidth * state.zoom
  const prevHeight = svg.clientHeight || baseHeight * state.zoom
  const prevCenterX = graphScroll.scrollLeft + graphScroll.clientWidth / 2
  const prevCenterY = graphScroll.scrollTop + graphScroll.clientHeight / 2
  const ratioX = prevWidth ? prevCenterX / prevWidth : 0.5
  const ratioY = prevHeight ? prevCenterY / prevHeight : 0.5

  state.zoom = scale
  svg.style.width = `${Math.round(baseWidth * scale)}px`
  svg.style.height = `${Math.round(baseHeight * scale)}px`

  if (keepCenter) {
    const nextWidth = baseWidth * scale
    const nextHeight = baseHeight * scale
    graphScroll.scrollLeft = Math.max(0, nextWidth * ratioX - graphScroll.clientWidth / 2)
    graphScroll.scrollTop = Math.max(0, nextHeight * ratioY - graphScroll.clientHeight / 2)
  }
}

function svgPoint(event) {
  const rect = svg.getBoundingClientRect()
  const view = currentViewBox()
  const scaleX = view.width / rect.width
  const scaleY = view.height / rect.height
  return {
    x: view.x + (event.clientX - rect.left) * scaleX,
    y: view.y + (event.clientY - rect.top) * scaleY,
  }
}

function getNodeSize(type) {
  return NODE_SIZE[type] || { width: 180, height: 60 }
}

function nodePosition(nodeId) {
  return state.positions[nodeId]
}

function nodeAnchors(nodeId) {
  const position = nodePosition(nodeId)
  const size = getNodeSize(state.payload.nodeMap[nodeId].type)
  return {
    left: { x: position.x - size.width / 2, y: position.y },
    right: { x: position.x + size.width / 2, y: position.y },
    top: { x: position.x, y: position.y - size.height / 2 },
    bottom: { x: position.x, y: position.y + size.height / 2 },
  }
}

function sameCommunity(edge) {
  const source = state.payload.nodeMap[edge.source]
  const target = state.payload.nodeMap[edge.target]
  return source?.communityGoalId && target?.communityGoalId && source.communityGoalId === target.communityGoalId
}

function isSubgoal(node) {
  return node?.type === 'goal' && Boolean(node.parentGoalId)
}

function horizontalAnchors(source, target) {
  const sourcePos = nodePosition(source.id)
  const targetPos = nodePosition(target.id)
  return sourcePos.x <= targetPos.x ? ['right', 'left'] : ['left', 'right']
}

function verticalAnchors(source, target) {
  const sourcePos = nodePosition(source.id)
  const targetPos = nodePosition(target.id)
  return sourcePos.y <= targetPos.y ? ['bottom', 'top'] : ['top', 'bottom']
}

function anchorKeysForEdge(edge) {
  const source = state.payload.nodeMap[edge.source]
  const target = state.payload.nodeMap[edge.target]
  const intra = sameCommunity(edge)
  const pair = `${source.type}->${target.type}`

  if (MODE === 'expanded') {
    if (pair === 'work_item->work_item') {
      return Math.abs(nodePosition(source.id).x - nodePosition(target.id).x) > 80
        ? horizontalAnchors(source, target)
        : verticalAnchors(source, target)
    }
    if (pair === 'work_item->result') return ['right', 'left']
    if (pair === 'result->work_item') return ['left', 'right']
    if (pair === 'work_item->issue') return horizontalAnchors(source, target)
  }

  if (pair === 'work_block->result' && intra) return ['left', 'left']
  if (pair === 'result->goal' || pair === 'result->issue') return ['right', 'bottom']
  if (!intra) return horizontalAnchors(source, target)

  if (pair === 'event->issue') return horizontalAnchors(source, target)
  if (pair === 'issue->goal') return verticalAnchors(source, target)
  if (pair === 'goal->goal') return verticalAnchors(source, target)
  if (pair === 'goal->work_block') {
    if (target.ownerGoalId === source.id) return verticalAnchors(source, target)
    if (isSubgoal(source)) return verticalAnchors(source, target)
    return horizontalAnchors(source, target)
  }
  if (pair === 'work_block->issue') return verticalAnchors(source, target)

  return verticalAnchors(source, target)
}

function sortByStepThenId(a, b) {
  const av = a.firstStep ?? Number.MAX_SAFE_INTEGER
  const bv = b.firstStep ?? Number.MAX_SAFE_INTEGER
  return av - bv || a.id.localeCompare(b.id)
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
      placeResultStack(positions, community.resultsByWorkBlock.get(node.id) || [], x)
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
  const inDegree = new Map(items.map((item) => [item.id, 0]))
  const outgoing = new Map(items.map((item) => [item.id, []]))
  nextEdges.forEach((edge) => {
    inDegree.set(edge.target, (inDegree.get(edge.target) || 0) + 1)
    outgoing.get(edge.source)?.push(edge.target)
  })

  const roots = items.filter((item) => (inDegree.get(item.id) || 0) === 0).sort(sortByStepThenId)
  const unvisited = new Set(items.map((item) => item.id))
  const columns = []

  function consumeChain(startId) {
    const column = []
    let current = startId
    let depthOffset = 0
    while (current && unvisited.has(current)) {
      unvisited.delete(current)
      const node = items.find((item) => item.id === current)
      if (!node) break
      column.push({ node, depthOffset })
      const nextIds = (outgoing.get(current) || [])
        .filter((id) => unvisited.has(id))
        .sort((a, b) => {
          const an = items.find((item) => item.id === a)
          const bn = items.find((item) => item.id === b)
          return sortByStepThenId(an, bn)
        })
      if (!nextIds.length) break
      const nextRowDepth = depthOffset + 1
      nextIds.slice(1).forEach((branchId) => {
        columns.push({ startDepth: nextRowDepth, chainStartId: branchId })
      })
      current = nextIds[0]
      depthOffset = nextRowDepth
    }
    return column
  }

  roots.forEach((root) => {
    if (unvisited.has(root.id)) columns.push({ startDepth: 0, chainStartId: root.id })
  })

  const resolved = []
  while (columns.length) {
    const next = columns.shift()
    if (!next || !unvisited.has(next.chainStartId)) continue
    resolved.push({ startDepth: next.startDepth, nodes: consumeChain(next.chainStartId) })
  }

  items.sort(sortByStepThenId).forEach((item) => {
    if (unvisited.has(item.id)) {
      resolved.push({ startDepth: 0, nodes: consumeChain(item.id) })
    }
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

function measureExpandedCommunity(community, edges) {
  const issueWidth = centeredRowWidth(community.issues.length, NODE_SIZE.issue.width, LAYOUT.issueGapX)
  const topWidth = community.topBlocks.reduce((sum, cluster) => sum + placeHolderExpandedWidth(cluster, edges), 0)
  const subWidth = community.subgoalColumns.reduce((sum, column) => sum + Math.max(LAYOUT.subgoalGapX, column.blocks.reduce((inner, cluster) => inner + placeHolderExpandedWidth(cluster, edges), 0) || LAYOUT.subgoalGapX), 0)
  return Math.max(600, issueWidth, topWidth + (topWidth && subWidth ? LAYOUT.branchGapX : 0) + subWidth)
}

function placeHolderExpandedWidth(cluster, edges) {
  return measureExpandedCluster(cluster, edges).width
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
  const subgoalWidth = community.subgoalColumns.reduce((sum, column, index) => {
    const blocksWidth = column.blocks.reduce((inner, cluster, blockIndex) => inner + placeHolderExpandedWidth(cluster, edges) + (blockIndex ? 180 : 0), 0)
    return sum + Math.max(LAYOUT.subgoalGapX, blocksWidth || LAYOUT.subgoalGapX) + (index ? 180 : 0)
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

function defaultPositions(nodes, edges) {
  const positions = {}
  const containers = {}
  const communities = MODE === 'expanded' ? buildExpandedCommunities(nodes) : buildCollapsedCommunities(nodes)
  let cursorX = LAYOUT.marginX

  communities.forEach((community) => {
    const width = MODE === 'expanded' ? measureExpandedCommunity(community, edges) : measureCollapsedCommunity(community)
    const centerX = cursorX + width / 2
    if (MODE === 'expanded') placeExpandedCommunity(positions, containers, community, centerX, edges)
    else placeCollapsedCommunity(positions, containers, community, centerX)
    cursorX += width + LAYOUT.communityGapX
  })

  nodes.filter((node) => !positions[node.id]).sort(sortByStepThenId).forEach((node, index) => {
    positions[node.id] = { x: cursorX, y: LAYOUT.fallbackY + index * 120 }
  })

  state.containers = containers
  return positions
}

function edgeBend(edgeId) {
  return state.bends[edgeId] || null
}

function defaultEdgeBend(edge) {
  const sourceNode = state.payload.nodeMap[edge.source]
  const targetNode = state.payload.nodeMap[edge.target]
  const intra = sameCommunity(edge)
  const pair = `${sourceNode.type}->${targetNode.type}`
  const [startKey] = anchorKeysForEdge(edge)
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

function edgeGeometry(edge) {
  const [startKey, endKey] = anchorKeysForEdge(edge)
  const start = nodeAnchors(edge.source)[startKey]
  const end = nodeAnchors(edge.target)[endKey]
  const mid = midpoint(start, end)
  const bend = edgeBend(edge.id) || defaultEdgeBend(edge)
  const handle = { x: mid.x + bend.dx, y: mid.y + bend.dy }
  return { start, end, mid, handle }
}

function quadPath(start, handle, end) {
  return `M ${start.x} ${start.y} Q ${handle.x} ${handle.y} ${end.x} ${end.y}`
}

function renderContainers() {
  containerLayer.innerHTML = ''
  if (MODE !== 'expanded') return
  Object.values(state.containers).forEach((container) => {
    const rect = createSvg('rect', {
      x: container.x,
      y: container.y,
      width: container.width,
      height: container.height,
      rx: 28,
      ry: 28,
      class: `work-block-container${state.selectedNodeId === container.blockId ? ' selected' : ''}`,
    })
    containerLayer.append(rect)
  })
}

function render() {
  renderContainers()
  renderEdges()
  renderNodes()
  renderSelection()
}

hideNodeCard()

function edgeTouchesSelectedNode(edge) {
  return state.selectedNodeId && (edge.source === state.selectedNodeId || edge.target === state.selectedNodeId)
}

function renderEdges() {
  edgeLayer.innerHTML = ''
  handleLayer.innerHTML = ''
  for (const edge of state.payload.edges) {
    const { start, end, mid, handle } = edgeGeometry(edge)
    const pathData = quadPath(start, handle, end)
    const group = createSvg('g')
    const highlighted = edgeTouchesSelectedNode(edge)

    const path = createSvg('path', {
      d: pathData,
      class: `edge-path${state.selectedEdgeId === edge.id ? ' selected' : ''}${highlighted ? ' highlighted' : ''}`,
    })
    const hit = createSvg('path', { d: pathData, class: 'edge-hit' })
    hit.addEventListener('click', (event) => {
      event.stopPropagation()
      state.selectedEdgeId = edge.id
      state.selectedNodeId = null
      state.expandedNodeId = null
      render()
    })

    const label = createSvg('text', {
      x: handle.x,
      y: handle.y - 10,
      class: 'edge-label',
    })
    label.textContent = edge.label

    group.append(path, hit, label)
    edgeLayer.append(group)

    if (state.selectedEdgeId === edge.id) {
      const guide = createSvg('line', {
        x1: mid.x,
        y1: mid.y,
        x2: handle.x,
        y2: handle.y,
        class: 'bend-guide',
      })
      handleLayer.append(guide)
    }
  }
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
    lines[lines.length - 1] = last.slice(0, Math.max(0, last.length - 1)) + '…'
  }
  return lines
}

function renderNodes() {
  nodeLayer.innerHTML = ''
  for (const node of state.payload.nodes) {
    const position = nodePosition(node.id)
    const size = getNodeSize(node.type)
    const g = createSvg('g', {
      class: `node ${node.type}${state.selectedNodeId === node.id ? ' selected' : ''}`,
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
      if (state.selectedNodeId === node.id && state.expandedNodeId !== node.id) {
        state.expandedNodeId = node.id
        renderSelection()
        return
      }
      state.selectedNodeId = node.id
      state.selectedEdgeId = null
      state.expandedNodeId = null
      render()
    })
    nodeLayer.append(g)
  }
}

function hideNodeCard() {
  nodeCardEl.classList.add('hidden')
}

function cardField(label, value) {
  const item = document.createElement('div')
  item.className = 'node-card-field'

  const labelEl = document.createElement('div')
  labelEl.className = 'node-card-field-label'
  labelEl.textContent = label

  const valueEl = document.createElement('div')
  valueEl.className = 'node-card-field-value'
  valueEl.textContent = value

  item.append(labelEl, valueEl)
  return item
}

function renderNodeFields(node) {
  nodeCardFieldsEl.innerHTML = ''
  const fields = [
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

  fields.forEach(([label, value]) => {
    nodeCardFieldsEl.append(cardField(label, value))
  })
}

function renderSelection() {
  if (state.selectedNodeId && state.expandedNodeId === state.selectedNodeId) {
    const node = state.payload.nodeMap[state.selectedNodeId]
    nodeCardTitleEl.textContent = node.summary || node.label
    nodeCardMetaEl.textContent = `${node.type} · ${node.id}`
    renderNodeFields(node)
    nodeCardDescriptionEl.textContent = node.description || '无 description'
    nodeCardEl.classList.remove('hidden')
    return
  }
  hideNodeCard()
}

function normalizePayload(payload) {
  return {
    ...payload,
    nodeMap: Object.fromEntries(payload.nodes.map((node) => [node.id, node])),
    edgeMap: Object.fromEntries(payload.edges.map((edge) => [edge.id, edge])),
  }
}

async function load() {
  const payload = normalizePayload(await fetch(API).then((res) => res.json()))
  state.payload = payload
  state.positions = { ...defaultPositions(payload.nodes, payload.edges), ...(payload.layout?.nodes || {}) }
  state.bends = { ...(payload.layout?.edges || {}) }
  metaEl.textContent = `nodes ${payload.meta.visibleNodeCount}/${payload.meta.rawNodeCount} · edges ${payload.meta.visibleEdgeCount}/${payload.meta.rawEdgeCount}`
  render()
  const initialBounds = graphBounds(900, 400)
  if (initialBounds) {
    svg.dataset.baseWidth = String(Math.ceil(initialBounds.width))
    svg.dataset.baseHeight = String(Math.ceil(initialBounds.height))
    setViewBox({ x: initialBounds.x, y: initialBounds.y, width: initialBounds.width, height: initialBounds.height })
    applyScale(INITIAL_SCALE)
  }
}

function graphBounds(paddingX = 220, paddingY = 160) {
  const nodes = state.payload?.nodes || []
  if (!nodes.length) return null

  const bounds = nodes.map((node) => {
    const position = state.positions[node.id]
    const size = getNodeSize(node.type)
    return {
      minX: position.x - size.width / 2,
      maxX: position.x + size.width / 2,
      minY: position.y - size.height / 2,
      maxY: position.y + size.height / 2,
    }
  })
  const containerBounds = Object.values(state.containers).map((container) => ({
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

function fitScale(bounds) {
  const scaleX = graphScroll.clientWidth / bounds.width
  const scaleY = graphScroll.clientHeight / bounds.height
  return Math.min(scaleX, scaleY)
}

function fit() {
  const bounds = graphBounds(220, 160)
  if (!bounds) return
  applyScale(fitScale(bounds))
  graphScroll.scrollLeft = 0
  graphScroll.scrollTop = 0
}

function zoomBy(factor) {
  applyScale(state.zoom * factor, true)
}

svg.addEventListener('click', () => {
  if (state.panDrag) return
  state.selectedNodeId = null
  state.selectedEdgeId = null
  state.expandedNodeId = null
  render()
})

nodeCardBackdropEl.addEventListener('click', () => {
  state.expandedNodeId = null
  renderSelection()
})

nodeCardCloseEl.addEventListener('click', () => {
  state.expandedNodeId = null
  renderSelection()
})

svg.addEventListener('pointerdown', (event) => {
  if (event.target !== svg) return
  svg.setPointerCapture(event.pointerId)
  state.panDrag = {
    pointerId: event.pointerId,
    clientX: event.clientX,
    clientY: event.clientY,
    scrollLeft: graphScroll.scrollLeft,
    scrollTop: graphScroll.scrollTop,
    moved: false,
  }
})

svg.addEventListener('pointermove', (event) => {
  if (state.panDrag && state.panDrag.pointerId === event.pointerId) {
    const dx = event.clientX - state.panDrag.clientX
    const dy = event.clientY - state.panDrag.clientY
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) state.panDrag.moved = true
    graphScroll.scrollLeft = state.panDrag.scrollLeft - dx
    graphScroll.scrollTop = state.panDrag.scrollTop - dy
  }
})

svg.addEventListener('pointerup', (event) => {
  if (state.panDrag && state.panDrag.pointerId === event.pointerId) state.panDrag = null
})

btnZoomOut.addEventListener('click', () => zoomBy(1 / 1.2))
btnZoomIn.addEventListener('click', () => zoomBy(1.2))
btnFit.addEventListener('click', fit)

load().catch((error) => {
  metaEl.textContent = error.message || String(error)
})
