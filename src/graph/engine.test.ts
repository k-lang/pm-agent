import { afterAll, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { spawnSync } from "child_process"
import { loadCommandAndExecute } from "./engine"
import { GraphSemanticValidator } from "./semantic-validation"
import { GraphCommand } from "./schema"
import { GraphStorage } from "./storage"
import { loadExpandedGraph, loadGraph } from "../../standalone-graph/transform"

const TRACKER_ROOT = "/mnt/sda/test_claude_code/proj5_pm/project_progress_tracker"
const COMMANDS_DIR = path.join(TRACKER_ROOT, "jiedaidan_trace", "commands")
const PYTHON_SRC = path.join(TRACKER_ROOT, "src")
const OUTPUT_ROOT = path.join(os.tmpdir(), "pm-agent-graph-engine-test")
const PYTHON_OUT = path.join(OUTPUT_ROOT, "python")
const TS_OUT = path.join(OUTPUT_ROOT, "ts")

async function stepFiles() {
  const files = await fs.readdir(COMMANDS_DIR)
  return files
    .filter((file) => /^step\d+\.json$/.test(file))
    .sort((a, b) => Number(a.match(/\d+/)?.[0] || 0) - Number(b.match(/\d+/)?.[0] || 0))
    .map((file) => path.join(COMMANDS_DIR, file))
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

function normalizeHistory(history: unknown) {
  if (!Array.isArray(history)) return []
  return history.map((entry) => {
    const item = entry as Record<string, unknown>
    return {
      timestamp: item.timestamp,
      version: item.version,
      description: item.description,
    }
  })
}

function normalizeGraphObject(value: Record<string, unknown>) {
  const copy = { ...value }
  if ("history" in copy) copy.history = normalizeHistory(copy.history)
  return copy
}

async function normalizedDirectory(root: string) {
  const files = await listJsonFiles(root)
  const result: Record<string, unknown> = {}
  for (const file of files) {
    const rel = path.relative(root, file)
    if (rel.startsWith(`metadata${path.sep}`)) continue
    result[rel.replaceAll(path.sep, "/")] = normalizeGraphObject(await readJson(file))
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

  test("jiedaidan steps satisfy graph semantic layout requirements before each step is applied", async () => {
    const files = await stepFiles()
    await fs.rm(TS_OUT, { recursive: true, force: true })
    const storage = new GraphStorage(TS_OUT)
    const validator = new GraphSemanticValidator(storage)

    for (const file of files) {
      const command = GraphCommand.parse(await readJson(file))
      expect(await validator.validateCommand(command), path.basename(file)).toEqual([])
      await runTsStep(file)
    }
  }, 30000)

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
})
