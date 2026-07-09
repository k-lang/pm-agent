import { afterAll, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { spawnSync } from "child_process"
import { GraphEngine, loadCommandAndExecute } from "./engine"
import { GraphSemanticValidator } from "./semantic-validation"
import { GraphCommand, GraphNode } from "./schema"
import { GraphStorage } from "./storage"
import { loadExpandedGraph, loadGraph } from "../../standalone-graph/transform"

const TRACKER_ROOT = "/mnt/sda/test_claude_code/proj5_pm/project_progress_tracker"
const COMMANDS_DIR = path.join(TRACKER_ROOT, "jiedaidan_trace", "commands")
const REFINED_COMMANDS_DIR = path.join(TRACKER_ROOT, "jiedaidan_trace", "refined_v2", "commands")
const PYTHON_SRC = path.join(TRACKER_ROOT, "src")
const OUTPUT_ROOT = path.join(os.tmpdir(), "pm-agent-graph-engine-test")
const PYTHON_OUT = path.join(OUTPUT_ROOT, "python")
const TS_OUT = path.join(OUTPUT_ROOT, "ts")

async function stepFiles(commandsDir = COMMANDS_DIR) {
  const files = await fs.readdir(commandsDir)
  return files
    .filter((file) => /^step\d+\.json$/.test(file))
    .sort((a, b) => Number(a.match(/\d+/)?.[0] || 0) - Number(b.match(/\d+/)?.[0] || 0))
    .map((file) => path.join(commandsDir, file))
}

async function listJsonFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  const nested = await Promise.all(entries.map(async (entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return listJsonFiles(full)
    return entry.isFile() && entry.name.endsWith(".json") ? [full] : []
  }))
  return nested.flat().sort()
}

async function readJson(file: string) {
  return JSON.parse(await fs.readFile(file, "utf8"))
}

function normalizeHistory(history: unknown, options: { keepSerializedData?: boolean } = {}) {
  if (!Array.isArray(history)) return []
  return history.map((entry) => {
    const item = entry as Record<string, unknown>
    const normalized: Record<string, unknown> = {
      timestamp: item.timestamp,
      version: item.version,
      description: item.description,
    }
    if (options.keepSerializedData && typeof item.serialized_data === "string") {
      normalized.serialized_data = JSON.parse(item.serialized_data)
    }
    return normalized
  })
}

function normalizeGraphObject(value: Record<string, unknown>, options: { keepSerializedData?: boolean } = {}) {
  const copy = { ...value }
  if ("history" in copy) copy.history = normalizeHistory(copy.history, options)
  return copy
}

async function normalizedDirectory(root: string, options: { keepSerializedData?: boolean } = {}) {
  const files = await listJsonFiles(root)
  const result: Record<string, unknown> = {}
  for (const file of files) {
    const rel = path.relative(root, file)
    if (rel.startsWith(`metadata${path.sep}`)) continue
    result[rel.replaceAll(path.sep, "/")] = normalizeGraphObject(await readJson(file), options)
  }
  return result
}

async function runPythonStep(file: string) {
  const script = `
import sys
sys.path.insert(0, ${JSON.stringify(PYTHON_SRC)})
from lowcode_engine import load_config_and_execute
file = ${JSON.stringify(file)}
out = ${JSON.stringify(PYTHON_OUT)}
result = load_config_and_execute(file, out)
if not result.get("success"):
    print(result)
    raise SystemExit(1)
`
  const result = spawnSync("python3", ["-c", script], { encoding: "utf8" })
  if (result.status !== 0) {
    throw new Error(`python replay failed for ${file}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  }
}

async function runTsStep(file: string) {
  const result = await loadCommandAndExecute(file, TS_OUT)
  if (!result.success) throw new Error(`ts replay failed for ${file}: ${result.errors.join("; ")}`)
}

async function runTsReplay(files: string[]) {
  for (const file of files) await runTsStep(file)
}

afterAll(async () => {
  await fs.rm(OUTPUT_ROOT, { recursive: true, force: true })
})

describe("graph engine", () => {
  test("replays jiedaidan steps equivalently to the python engine after every step", async () => {
    const files = await stepFiles()
    await fs.rm(OUTPUT_ROOT, { recursive: true, force: true })
    await fs.mkdir(OUTPUT_ROOT, { recursive: true })

    for (const file of files) {
      await runPythonStep(file)
      await runTsStep(file)
      expect(await normalizedDirectory(TS_OUT), path.basename(file)).toEqual(await normalizedDirectory(PYTHON_OUT))
    }
  }, 30000)

  test("replays refined jiedaidan steps equivalently to the python engine including history snapshots", async () => {
    const files = await stepFiles(REFINED_COMMANDS_DIR)
    await fs.rm(OUTPUT_ROOT, { recursive: true, force: true })
    await fs.mkdir(OUTPUT_ROOT, { recursive: true })

    for (const file of files) {
      await runPythonStep(file)
      await runTsStep(file)
      expect(await normalizedDirectory(TS_OUT, { keepSerializedData: true }), path.basename(file)).toEqual(await normalizedDirectory(PYTHON_OUT, { keepSerializedData: true }))
    }
  }, 30000)

  test("refined replay preserves readable history in node descriptions", async () => {
    const files = await stepFiles(REFINED_COMMANDS_DIR)
    await fs.rm(TS_OUT, { recursive: true, force: true })
    await runTsReplay(files)

    const nodes = (await new GraphStorage(TS_OUT).getAllNodes())
    expect(nodes.length).toBeGreaterThan(0)
    expect(nodes.every((node) => node.description.includes("历史记录："))).toBe(true)
  }, 30000)

  test("history serialized_data stores the object snapshot without nested history", async () => {
    const files = await stepFiles(REFINED_COMMANDS_DIR)
    await fs.rm(TS_OUT, { recursive: true, force: true })
    await runTsReplay(files.slice(0, 2))

    const storage = new GraphStorage(TS_OUT)
    const node = await storage.getNodeById("goal_knowledge_organization")
    expect(node?.history.length).toBeGreaterThan(0)
    expect(JSON.parse(node!.history.at(-1)!.serialized_data)).not.toHaveProperty("history")

    const edge = await storage.loadEdge("edge_event_to_goal")
    expect(edge?.history.length).toBeGreaterThan(0)
    expect(JSON.parse(edge!.history.at(-1)!.serialized_data)).not.toHaveProperty("history")
  }, 30000)

  test("replayed graph can be transformed for collapsed and expanded views", async () => {
    const files = await stepFiles()
    await fs.rm(TS_OUT, { recursive: true, force: true })
    await runTsReplay(files)

    const collapsed = await loadGraph(TS_OUT)
    const expanded = await loadExpandedGraph(TS_OUT)
    expect(collapsed.nodes.length).toBeGreaterThan(0)
    expect(expanded.nodes.length).toBeGreaterThan(collapsed.nodes.length)
    expect(expanded.nodes.some((node) => node.type === "work_item")).toBe(true)
    expect(expanded.nodes.filter((node) => !node.communityGoalId && node.type !== "goal").map((node) => node.id)).toEqual([])
  }, 30000)

  test("semantic validator accepts valid new-target edge relations", async () => {
    const storage = new GraphStorage(path.join(OUTPUT_ROOT, "semantic-valid-new-targets"))
    await fs.rm(storage.root, { recursive: true, force: true })
    const validator = new GraphSemanticValidator(storage)
    const command = GraphCommand.parse({
      change_id: "valid_new_target_relations",
      timestamp: "2026-07-09T10:00:00+08:00",
      operations: [
        {
          type: "create_node",
          temp_id: "event_customer_request",
          data: { type: "event", summary: "客户提出新要求", description: "" },
        },
        {
          type: "create_node",
          temp_id: "goal_customer_demo",
          data: { type: "goal", summary: "完成客户 demo", description: "" },
        },
        {
          type: "create_node",
          temp_id: "work_block_demo",
          data: { type: "work_block", summary: "demo 工作块", description: "", linked_goal_id: "goal_customer_demo" },
        },
        {
          type: "create_node",
          temp_id: "work_item_demo_plan",
          data: { type: "work_item", summary: "制定 demo 方案", description: "", linked_work_block_id: "work_block_demo" },
        },
        {
          type: "create_node",
          temp_id: "goal_customer_response",
          data: { type: "goal", summary: "响应客户现场要求", description: "" },
        },
        {
          type: "create_node",
          temp_id: "work_block_customer_response",
          data: { type: "work_block", summary: "客户响应工作块", description: "", linked_goal_id: "goal_customer_response" },
        },
        {
          type: "create_node",
          temp_id: "work_item_customer_response",
          data: { type: "work_item", summary: "处理客户现场要求", description: "", linked_work_block_id: "work_block_customer_response" },
        },
        {
          type: "create_node",
          temp_id: "issue_demo_scope",
          data: { type: "issue", summary: "demo 范围未收敛", description: "" },
        },
        {
          type: "create_node",
          temp_id: "result_demo_plan",
          data: { type: "result", summary: "demo 方案草稿", description: "" },
        },
        {
          type: "create_edge",
          temp_id: "edge_event_generates_goal",
          from_node: "event_customer_request",
          to_node: "goal_customer_demo",
          edge_type: "generates",
        },
        {
          type: "create_edge",
          temp_id: "edge_event_leads_work",
          from_node: "event_customer_request",
          to_node: "work_item_customer_response",
          edge_type: "leads_to",
        },
        {
          type: "create_edge",
          temp_id: "edge_work_discovers_issue",
          from_node: "work_item_demo_plan",
          to_node: "issue_demo_scope",
          edge_type: "discovers",
        },
        {
          type: "create_edge",
          temp_id: "edge_work_creates_result",
          from_node: "work_item_demo_plan",
          to_node: "result_demo_plan",
          edge_type: "creates",
        },
      ],
      history_descriptions: {},
    })

    expect(await validator.validateCommand(command)).toEqual([])
  })

  test("semantic validator rejects redundant event-to-work leads when event already generates parent goal", async () => {
    const storage = new GraphStorage(path.join(OUTPUT_ROOT, "semantic-redundant-event-work"))
    await fs.rm(storage.root, { recursive: true, force: true })
    const validator = new GraphSemanticValidator(storage)
    const command = GraphCommand.parse({
      change_id: "redundant_event_work_leads",
      timestamp: "2026-07-09T10:00:00+08:00",
      operations: [
        {
          type: "create_node",
          temp_id: "event_customer_request",
          data: { type: "event", summary: "客户提出新要求", description: "" },
        },
        {
          type: "create_node",
          temp_id: "goal_customer_demo",
          data: { type: "goal", summary: "完成客户 demo", description: "" },
        },
        {
          type: "create_node",
          temp_id: "work_block_demo",
          data: { type: "work_block", summary: "demo 工作块", description: "", linked_goal_id: "goal_customer_demo" },
        },
        {
          type: "create_node",
          temp_id: "work_item_demo_plan",
          data: { type: "work_item", summary: "制定 demo 方案", description: "", linked_work_block_id: "work_block_demo" },
        },
        {
          type: "create_edge",
          temp_id: "edge_event_generates_goal",
          from_node: "event_customer_request",
          to_node: "goal_customer_demo",
          edge_type: "generates",
        },
        {
          type: "create_edge",
          temp_id: "edge_event_leads_work",
          from_node: "event_customer_request",
          to_node: "work_item_demo_plan",
          edge_type: "leads_to",
        },
      ],
      history_descriptions: {},
    })

    const issues = await validator.validateCommand(command)
    const messages = issues.map((issue) => issue.message).join("\n")
    expect(messages).toContain("已经通过 generates 产生目标 goal_customer_demo")
    expect(messages).toContain("不要再创建 event -> work_item 的 leads_to")
  })

  test("graph node schema rejects status values outside each node type whitelist", () => {
    expect(() => GraphNode.parse({
      id: "work_item_invalid_status",
      type: "work_item",
      summary: "错误状态工作项",
      description: "",
      status: "active",
    })).toThrow()
    expect(() => GraphNode.parse({
      id: "result_invalid_status",
      type: "result",
      summary: "错误状态结果",
      description: "",
      status: "draft",
    })).toThrow()
    expect(() => GraphNode.parse({
      id: "issue_invalid_status",
      type: "issue",
      summary: "错误状态问题",
      description: "",
      status: "open",
    })).toThrow()
  })

  test("semantic validator rejects invalid create and update node statuses before execution", async () => {
    const root = path.join(OUTPUT_ROOT, "semantic-invalid-status")
    await fs.rm(root, { recursive: true, force: true })
    const storage = new GraphStorage(root)
    await storage.saveNode(GraphNode.parse({
      id: "goal_existing",
      type: "goal",
      summary: "已有目标",
      description: "",
      status: "established",
    }))
    const validator = new GraphSemanticValidator(storage)
    const command = GraphCommand.parse({
      change_id: "invalid_node_status",
      timestamp: "2026-07-09T10:00:00+08:00",
      operations: [
        {
          type: "create_node",
          temp_id: "work_block_valid",
          data: { type: "work_block", summary: "有效工作块", description: "", linked_goal_id: "goal_existing" },
        },
        {
          type: "create_node",
          temp_id: "work_item_active_is_invalid",
          data: { type: "work_item", summary: "错误 active 工作项", description: "", status: "active", linked_work_block_id: "work_block_valid" },
        },
        {
          type: "create_node",
          temp_id: "result_draft_is_invalid",
          data: { type: "result", summary: "错误 draft 结果", description: "", status: "draft" },
        },
        {
          type: "update_node",
          node_id: "goal_existing",
          updates: { status: "active" },
        },
      ],
      history_descriptions: {},
    })

    const messages = (await validator.validateCommand(command)).map((issue) => issue.message).join("\n")
    expect(messages).toContain("work_item.status 不应使用 active")
    expect(messages).toContain("允许状态：planned, in_progress, finished, cancelled, ongoing")
    expect(messages).toContain("result.status 不应使用 draft")
    expect(messages).toContain("允许状态：produced, changed")
    expect(messages).toContain("goal.status 不应使用 active")
    expect(messages).toContain("允许状态：established, in_progress, completed, failed, cancelled, adjusted")
  })

  test("semantic validator rejects node fields outside each node type schema", async () => {
    const root = path.join(OUTPUT_ROOT, "semantic-invalid-fields")
    await fs.rm(root, { recursive: true, force: true })
    const storage = new GraphStorage(root)
    await storage.saveNode(GraphNode.parse({
      id: "goal_existing",
      type: "goal",
      summary: "已有目标",
      description: "",
      status: "established",
    }))
    const validator = new GraphSemanticValidator(storage)
    const command = GraphCommand.parse({
      change_id: "invalid_node_fields",
      timestamp: "2026-07-09T10:00:00+08:00",
      operations: [
        {
          type: "create_node",
          temp_id: "goal_bad_completion",
          data: { type: "goal", summary: "错误完成度字段", description: "", completion: 0 },
        },
        {
          type: "create_node",
          temp_id: "work_item_bad_goal_ref",
          data: { type: "work_item", summary: "错误目标引用字段", description: "", linked_goal_id: "goal_existing" },
        },
        {
          type: "update_node",
          node_id: "goal_existing",
          updates: { linked_goal_id: "goal_existing" },
        },
      ],
      history_descriptions: {},
    })

    const messages = (await validator.validateCommand(command)).map((issue) => issue.message).join("\n")
    expect(messages).toContain("goal.completion 不是合法字段")
    expect(messages).toContain("work_item.linked_goal_id 不是合法字段")
    expect(messages).toContain("goal.linked_goal_id 不是合法字段")
    expect(messages).toContain("completion_score")
    expect(messages).toContain("linked_work_block_id")
  })

  test("semantic validator rejects new nodes that cannot be placed by graph layout rules", async () => {
    const storage = new GraphStorage(path.join(OUTPUT_ROOT, "semantic-invalid"))
    await fs.rm(storage.root, { recursive: true, force: true })
    const validator = new GraphSemanticValidator(storage)
    const command = GraphCommand.parse({
      change_id: "step0_invalid",
      timestamp: "2025-01-01T00:00:00",
      operations: [
        {
          type: "create_node",
          temp_id: "work_block_orphan",
          data: { type: "work_block", summary: "孤立工作块", description: "" },
        },
        {
          type: "create_node",
          temp_id: "work_item_orphan",
          data: { type: "work_item", summary: "孤立工作项", description: "" },
        },
        {
          type: "create_node",
          temp_id: "result_orphan",
          data: { type: "result", summary: "孤立结果", description: "" },
        },
        {
          type: "create_node",
          temp_id: "issue_orphan",
          data: { type: "issue", summary: "孤立问题", description: "" },
        },
      ],
      history_descriptions: {},
    })

    expect((await validator.validateCommand(command)).map((issue) => issue.nodeId)).toEqual([
      "work_block_orphan",
      "work_item_orphan",
      "result_orphan",
      "issue_orphan",
    ])
  })

  test("history records strip duplicated version prefix from readable descriptions", async () => {
    const root = path.join(OUTPUT_ROOT, "version-prefix")
    await fs.rm(root, { recursive: true, force: true })
    const engine = new GraphEngine(new GraphStorage(root))
    const result = await engine.executeCommand(GraphCommand.parse({
      change_id: "demo_change",
      timestamp: "2026-07-06T10:00:00+08:00",
      operations: [
        {
          type: "create_node",
          temp_id: "goal_demo",
          data: {
            type: "goal",
            summary: "演示目标",
            description: "演示目标。\n\n历史记录：\n- [demo_change] 创建演示目标。",
          },
        },
      ],
      history_descriptions: {
        goal_demo: "[demo_change] 创建演示目标。",
      },
    }))

    expect(result.success).toBe(true)
    const node = await new GraphStorage(root).getNodeById("goal_demo")
    expect(node?.history[0]?.version).toBe("demo_change")
    expect(node?.history[0]?.description).toBe("创建演示目标。")
  })
})
