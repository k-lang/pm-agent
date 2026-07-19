import { describe, expect, test } from "bun:test"
import {
  NODE_SIZE,
  defaultGraphPositions,
  graphNodeCardFields,
  graphDetailUrlKey,
  isEdgeHighlighted,
  loadGraphDetailContent,
  normalizeGraphPayload,
  normalizeGraphRenderOptions,
  projectGraphDetailHref,
  shouldUseActiveDraftNote,
} from "./project-graph-renderer.js"

const nodes = [
  { id: "goal_main", type: "goal", summary: "主目标", firstStep: 0, communityGoalId: "goal_main" },
  { id: "work_block_main", type: "work_block", summary: "主工作块", firstStep: 1, ownerGoalId: "goal_main", communityGoalId: "goal_main" },
  { id: "work_item_main", type: "work_item", summary: "主工作项", firstStep: 2, linkedWorkBlockId: "work_block_main", communityGoalId: "goal_main" },
  { id: "result_main", type: "result", summary: "主结果", firstStep: 3, producingWorkBlockId: "work_block_main", communityGoalId: "goal_main" },
]

const edges = [
  { id: "goal_main|work_block_main|goal_work_block", source: "goal_main", target: "work_block_main", type: "goal_work_block", label: "goal_work_block" },
  { id: "work_block_main|work_item_main|contains", source: "work_block_main", target: "work_item_main", type: "contains", label: "contains" },
  { id: "work_item_main|result_main|creates", source: "work_item_main", target: "result_main", type: "creates", label: "creates" },
]

describe("project graph renderer helpers", () => {
  test("shows issue resolution scores including zero in node details", () => {
    expect(graphNodeCardFields({ id: "issue_open", type: "issue", resolutionScore: 0 })).toContainEqual(["Resolution", "0"])
    expect(graphNodeCardFields({ id: "issue_active", type: "issue", resolutionScore: 40 })).toContainEqual(["Resolution", "40"])
  })

  test("routes project-relative detail urls through the project file viewer", () => {
    expect(projectGraphDetailHref("zxzq-demo", "notes/top level.md"))
      .toBe("/web/project-files.html?project=zxzq-demo&path=notes%2Ftop%20level.md")
    expect(projectGraphDetailHref("zxzq-demo", "https://example.com/detail"))
      .toBe("https://example.com/detail")
  })

  test("normalizes payload without coupling renderer to a project fetch", () => {
    const payload = normalizeGraphPayload({ nodes, edges, layout: { nodes: {}, edges: {} } })

    expect(payload.nodeMap.goal_main).toMatchObject({ type: "goal" })
    expect(payload.edgeMap["work_item_main|result_main|creates"]).toMatchObject({ type: "creates" })
  })

  test("normalizes preview options for future draft graph rendering", () => {
    const options = normalizeGraphRenderOptions({
      mode: "draft-preview",
      highlightNodeIds: ["work_item_main"],
      highlightEdgeIds: ["work_item_main|result_main|creates"],
      draftNodeIds: ["result_main"],
      draftEdgeIds: ["work_item_main|result_main|creates"],
      draftDetailUrlKeys: [graphDetailUrlKey("result_main", "notes/result.md")],
      focusNodeId: "work_item_main",
    })

    expect(options.mode).toBe("draft-preview")
    expect(options.highlightNodeIds.has("work_item_main")).toBe(true)
    expect(options.highlightEdgeIds.has("work_item_main|result_main|creates")).toBe(true)
    expect(options.draftNodeIds.has("result_main")).toBe(true)
    expect(options.draftEdgeIds.has("work_item_main|result_main|creates")).toBe(true)
    expect(options.draftDetailUrlKeys.has(graphDetailUrlKey("result_main", "notes/result.md"))).toBe(true)
    expect(options.focusNodeId).toBe("work_item_main")
  })

  test("does not treat an unchanged detail url as an active draft note", () => {
    const options = normalizeGraphRenderOptions({
      mode: "draft-preview",
      draftNodeIds: ["work_item_main"],
      draftDetailUrlKeys: [graphDetailUrlKey("result_main", "notes/result.md")],
    })

    expect(options.draftNodeIds.has("work_item_main")).toBe(true)
    expect(shouldUseActiveDraftNote(options, "work_item_main", "notes/result.md")).toBe(false)
    expect(shouldUseActiveDraftNote(options, "result_main", "notes/result.md")).toBe(true)
    expect(shouldUseActiveDraftNote(options, "result_main", "https://example.com/result")).toBe(false)
  })

  test("uses the active note before an existing project note for draft detail urls", async () => {
    const requested = []
    const fetchImpl = async (url) => {
      requested.push(url)
      if (url.startsWith("/project/workflow/note")) {
        return new Response(JSON.stringify({ exists: true, content: "active correction note" }), { status: 200 })
      }
      return new Response(JSON.stringify({ type: "text", content: "older archived note" }), { status: 200 })
    }

    const result = await loadGraphDetailContent({
      fetchImpl,
      projectName: "zxzq-demo",
      detailUrl: "notes/reused_name.md",
      useDraftNote: true,
    })

    expect(result).toEqual({ type: "text", content: "active correction note" })
    expect(requested).toEqual(["/project/workflow/note?project=zxzq-demo"])
  })

  test("keeps formal project files authoritative outside draft note paths", async () => {
    const requested = []
    const fetchImpl = async (url) => {
      requested.push(url)
      return new Response(JSON.stringify({ type: "text", content: "archived note" }), { status: 200 })
    }

    const result = await loadGraphDetailContent({
      fetchImpl,
      projectName: "zxzq-demo",
      detailUrl: "notes/existing.md",
      useDraftNote: false,
    })

    expect(result).toEqual({ type: "text", content: "archived note" })
    expect(requested).toEqual([
      "/project/file/content?project=zxzq-demo&path=notes%2Fexisting.md",
    ])
  })

  test("computes expanded positions for graph preview payloads", () => {
    const layout = defaultGraphPositions(nodes, edges, "expanded")

    expect(layout.positions.goal_main).toBeDefined()
    expect(layout.positions.work_block_main).toBeDefined()
    expect(layout.positions.work_item_main).toBeDefined()
    expect(layout.positions.result_main).toBeDefined()
    expect(layout.containers.work_block_main).toMatchObject({ blockId: "work_block_main" })
  })

  test("keeps issue rows centered and prevents overlap in both graph views", () => {
    const issueNodes = [
      { id: "goal_issue_owner", type: "goal", summary: "问题所属目标", firstStep: 0, communityGoalId: "goal_issue_owner" },
      { id: "issue_first", type: "issue", summary: "第一个问题", firstStep: 1, communityGoalId: "goal_issue_owner" },
      { id: "issue_second", type: "issue", summary: "第二个问题", firstStep: 2, communityGoalId: "goal_issue_owner" },
    ]

    for (const view of ["collapsed", "expanded"]) {
      const { positions } = defaultGraphPositions(issueNodes, [], view)
      const firstX = positions.issue_first.x
      const secondX = positions.issue_second.x
      const goalX = positions.goal_issue_owner.x

      expect(secondX - firstX).toBeGreaterThan(NODE_SIZE.issue.width)
      expect((firstX + secondX) / 2).toBe(goalX)
    }
  })

  test("does not use selected-node incident edge highlighting in draft preview mode", () => {
    const edge = edges[1]

    expect(isEdgeHighlighted(edge, "work_block_main", normalizeGraphRenderOptions({ mode: "current" }))).toBe(true)
    expect(isEdgeHighlighted(edge, "work_block_main", normalizeGraphRenderOptions({ mode: "draft-preview" }))).toBe(false)
    expect(isEdgeHighlighted(edge, "work_block_main", normalizeGraphRenderOptions({
      mode: "draft-preview",
      highlightEdgeIds: [edge.id],
    }))).toBe(true)
  })
})
