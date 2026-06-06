import { describe, expect, test } from "bun:test"
import path from "path"
import { loadExpandedGraph, loadGraph, readSavedLayout, saveLayout } from "./transform"

const PROJECT_DIR = path.join(process.cwd(), "project_graph_data", "jiedaidan")

describe("standalone graph transform", () => {
  test("excludes work_item nodes and remaps their edges", async () => {
    const graph = await loadGraph(PROJECT_DIR)
    expect(graph.nodes.every((node) => node.type !== "event" && node.type !== "goal" && node.type !== "issue" && node.type !== "result" && node.type !== "work_block")).toBe(false)
    expect(graph.nodes.map((node) => node.type)).not.toContain("work_item" as never)
    expect(graph.edges.some((edge) => edge.source.includes("work_item") || edge.target.includes("work_item"))).toBe(false)
  })

  test("adds goal to work_block structural edges", async () => {
    const graph = await loadGraph(PROJECT_DIR)
    expect(graph.edges.some((edge) => edge.type === "goal_work_block")).toBe(true)
    expect(graph.edges.some((edge) => edge.id === "goal_understand_requirements|work_block_analysis|goal_work_block")).toBe(true)
  })

  test("preserves subgoals with parent goal metadata", async () => {
    const graph = await loadGraph(PROJECT_DIR)
    const subgoal = graph.nodes.find((node) => node.id === "goal_analyze_b_vendor_solution")
    expect(subgoal).toBeDefined()
    expect(subgoal?.parentGoalId).toBe("goal_emergency_solution_design")
    expect(subgoal?.topGoalId).toBe("goal_emergency_solution_design")
    expect(graph.edges.some((edge) => edge.type === "subgoal" && edge.source === "goal_emergency_solution_design" && edge.target === "goal_analyze_b_vendor_solution")).toBe(true)
  })

  test("returns work block owner and first step metadata", async () => {
    const graph = await loadGraph(PROJECT_DIR)
    const block = graph.nodes.find((node) => node.id === "work_block_analyze_b_vendor_solution")
    const goal = graph.nodes.find((node) => node.id === "goal_understand_requirements")
    expect(block?.ownerGoalId).toBe("goal_analyze_b_vendor_solution")
    expect(block?.communityGoalId).toBe("goal_emergency_solution_design")
    expect(goal?.firstStep).toBe(0)
  })

  test("derives community ownership for event issue and result nodes", async () => {
    const graph = await loadGraph(PROJECT_DIR)
    const event = graph.nodes.find((node) => node.id === "event_m_bank_project")
    const issue = graph.nodes.find((node) => node.id === "issue_faq_insufficient")
    const result = graph.nodes.find((node) => node.id === "result_emergency_plan_result")
    expect(event?.communityGoalId).toBe("goal_understand_requirements")
    expect(issue?.communityGoalId).toBe("goal_faq_strategy")
    expect(result?.communityGoalId).toBe("goal_emergency_solution_design")
    expect(result?.producingWorkBlockId).toBe("work_block_emergency_solution_design")
  })

  test("does not return self-loop edges", async () => {
    const graph = await loadGraph(PROJECT_DIR)
    expect(graph.edges.some((edge) => edge.source === edge.target)).toBe(false)
  })

  test("does not return collapsed work_block to work_block edges", async () => {
    const graph = await loadGraph(PROJECT_DIR)
    const nodeMap = new Map(graph.nodes.map((node) => [node.id, node]))
    expect(graph.edges.some((edge) => nodeMap.get(edge.source)?.type === "work_block" && nodeMap.get(edge.target)?.type === "work_block")).toBe(false)
  })

  test("persists and reads layout", async () => {
    const original = await readSavedLayout(PROJECT_DIR)
    const next = {
      nodes: { goal_understand_requirements: { x: 123, y: 456 } },
      edges: { "goal_understand_requirements|work_block_analysis|goal_work_block": { dx: 10, dy: -20 } },
    }
    try {
      await saveLayout(next, PROJECT_DIR)
      const restored = await readSavedLayout(PROJECT_DIR)
      expect(restored).toEqual(next)
    } finally {
      await saveLayout(original || { nodes: {}, edges: {} }, PROJECT_DIR)
    }
  })

  test("stores expanded layout separately from collapsed layout", async () => {
    const originalCollapsed = await readSavedLayout(PROJECT_DIR, "collapsed")
    const originalExpanded = await readSavedLayout(PROJECT_DIR, "expanded")
    const collapsed = {
      nodes: { goal_understand_requirements: { x: 11, y: 22 } },
      edges: {},
    }
    const expanded = {
      nodes: { work_item_analyze_b_vendor_solution: { x: 33, y: 44 } },
      edges: {},
    }
    try {
      await saveLayout(collapsed, PROJECT_DIR, "collapsed")
      await saveLayout(expanded, PROJECT_DIR, "expanded")
      expect(await readSavedLayout(PROJECT_DIR, "collapsed")).toEqual(collapsed)
      expect(await readSavedLayout(PROJECT_DIR, "expanded")).toEqual(expanded)
    } finally {
      await saveLayout(originalCollapsed || { nodes: {}, edges: {} }, PROJECT_DIR, "collapsed")
      await saveLayout(originalExpanded || { nodes: {}, edges: {} }, PROJECT_DIR, "expanded")
    }
  })
})

describe("standalone expanded graph transform", () => {
  test("includes work_item nodes and preserves raw work_item edge endpoints", async () => {
    const graph = await loadExpandedGraph(PROJECT_DIR)
    expect(graph.nodes.map((node) => node.type)).toContain("work_item" as never)
    expect(graph.edges.some((edge) => edge.source.includes("work_item") || edge.target.includes("work_item"))).toBe(true)
  })

  test("keeps structural goal and subgoal edges in expanded mode", async () => {
    const graph = await loadExpandedGraph(PROJECT_DIR)
    expect(graph.edges.some((edge) => edge.type === "goal_work_block")).toBe(true)
    expect(graph.edges.some((edge) => edge.type === "subgoal" && edge.source === "goal_emergency_solution_design" && edge.target === "goal_analyze_b_vendor_solution")).toBe(true)
  })

  test("returns work_item ownership metadata and result producing block", async () => {
    const graph = await loadExpandedGraph(PROJECT_DIR)
    const item = graph.nodes.find((node) => node.id === "work_item_analyze_b_vendor_solution")
    const result = graph.nodes.find((node) => node.id === "result_emergency_plan_result")
    expect(item?.linkedWorkBlockId).toBe("work_block_analyze_b_vendor_solution")
    expect(item?.communityGoalId).toBe("goal_emergency_solution_design")
    expect(result?.producingWorkBlockId).toBe("work_block_emergency_solution_design")
  })

  test("preserves node detail urls in expanded mode", async () => {
    const graph = await loadExpandedGraph(PROJECT_DIR)
    const issue = graph.nodes.find((node) => node.id === "issue_faq_insufficient")
    expect(issue?.detailUrl).toBe("jiedaidan_trace/progress/identify_ambiguities.txt")
  })
})
