import fs from "fs/promises"
import os from "os"
import path from "path"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ProjectWorkflow } from "./state"
import { loadCommandAndExecute } from "@/graph/engine"

const TRACKER_ROOT = "/mnt/sda/test_claude_code/proj5_pm/project_progress_tracker"
const TRACE_ROOT = path.join(TRACKER_ROOT, "jiedaidan_trace")
const NOTES_DIR = path.join(TRACE_ROOT, "graph_data", "notes")
const COMMANDS_DIR = path.join(TRACE_ROOT, "commands")

describe("ProjectWorkflow", () => {
  let root: string
  let directory: string

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "pm-agent-workflow-"))
    directory = path.join(root, "demo")
    await fs.mkdir(directory, { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  function action(action: ProjectWorkflow.Action, payload: Record<string, unknown> = {}) {
    return ProjectWorkflow.runAction({ project: "demo", directory, action, payload })
  }

  async function readOriginalNote(file: string) {
    return fs.readFile(path.join(NOTES_DIR, file), "utf8")
  }

  async function readStepCommand(step: number) {
    return JSON.parse(await fs.readFile(path.join(COMMANDS_DIR, `step${step}.json`), "utf8"))
  }

  async function replayStepsBefore(step: number) {
    for (let i = 0; i < step; i++) {
      const result = await loadCommandAndExecute(path.join(COMMANDS_DIR, `step${i}.json`), directory)
      if (!result.success) throw new Error(`replay step${i} failed: ${result.errors.join("; ")}`)
    }
  }

  test("uses jiedaidan original note for a mid-project normal draft-check-validate-preview flow", async () => {
    await replayStepsBefore(18)
    const started = await action("开始或恢复")
    expect(started.stage).toBe("收集材料")
    expect(started.blockedActions.map((item) => item.action)).toContain("同步工作笔记变更")
    expect(started.blockedActions.map((item) => item.action)).toContain("生成图操作草案")
    expect(started.recommendations.join("\n")).toContain("工作笔记")

    const note = await readOriginalNote("knowledge_entry_point.txt")
    const command = await readStepCommand(18)
    const noted = await action("更新工作笔记", { content: note, summary: "使用 jiedaidan step18 原始工作笔记生成工作笔记。" })
    expect(noted.stage).toBe("笔记已生成")

    const reviewed = await action("检查笔记充分性", {
      sufficient: true,
      summary: "step18 原始笔记包含知识梳理方案、验证结果和目标影响，足以生成图操作。",
    })
    expect(reviewed.stage).toBe("笔记已生成")

    const drafted = await action("生成图操作草案", { command })
    expect(drafted.stage).toBe("图操作已生成")

    const validated = await action("校验图操作")
    expect(validated.stage).toBe("校验已通过")

    const previewed = await action("生成预览")
    expect(previewed.stage).toBe("预览已生成")
    expect(previewed.data?.preview).toMatchObject({
      change_id: "step18_knowledge_scheme",
      operationCount: 7,
    })
    expect(previewed.availableActions.map((item) => item.action)).toContain("应用图操作")

    const stateRaw = await fs.readFile(path.join(directory, "workflows", "active", "state.json"), "utf8")
    expect(stateRaw).toContain("预览已生成")
  })

  test("uses a truncated jiedaidan note to cover note-needs-supplement then returns to note-ready", async () => {
    await action("开始或恢复")
    const note = await readOriginalNote("improvement_plan.txt")
    await action("更新工作笔记", {
      content: note.slice(0, 260),
      summary: "只记录了标签推荐改进的一小段背景。",
    })

    const reviewed = await action("检查笔记充分性", {
      sufficient: false,
      summary: "缺少图操作判断需要的影响目标、工作归属和结果关系。",
      blockingQuestions: [
        "这次改进方案应归入哪个已有工作块？",
        "它影响知识梳理目标、低延时目标，还是两者都影响？",
      ],
      missingFields: ["linked_work_block", "affected_goals", "result_edges"],
    })

    expect(reviewed.stage).toBe("笔记需补充")
    expect(reviewed.data?.review).toMatchObject({
      sufficient: false,
      canDraftOperations: false,
    })
    expect(reviewed.recommendations.join("\n")).toContain("笔记不足")

    const completed = await action("更新工作笔记", {
      content: await readOriginalNote("improvement_plan.txt"),
      summary: "补充完整 step19 原始工作笔记。",
    })
    expect(completed.stage).toBe("笔记已生成")
  })

  test("uses jiedaidan step17 material and a damaged command to enter graph-operation revision", async () => {
    await replayStepsBefore(17)
    await action("开始或恢复")
    await action("更新工作笔记", {
      content: await readOriginalNote("distinction_sort.txt"),
      summary: "使用 step17 对应原始工作笔记生成工作笔记。",
    })
    const command = await readStepCommand(17)
    const damaged = structuredClone(command)
    damaged.operations = damaged.operations.map((operation: any) => {
      if (operation.type === "create_node" && operation.data?.type === "work_item") {
        const data = { ...operation.data }
        delete data.linked_work_block_id
        return { ...operation, data }
      }
      return operation
    })
    await action("生成图操作草案", { command: damaged })

    const validated = await action("校验图操作")
    expect(validated.stage).toBe("图操作需修订")
    expect(validated.data?.validation).toMatchObject({ passed: false })
    expect(validated.recommendations.join("\n")).toContain("修订图操作")
    expect(validated.availableActions.map((item) => item.action)).toContain("生成图操作草案")
    expect(validated.availableActions.map((item) => item.action)).toContain("同步工作笔记变更")
  })

  test("uses jiedaidan step19 multi-source plan material for operations-only review feedback", async () => {
    await replayStepsBefore(19)
    await action("开始或恢复")
    await action("更新工作笔记", {
      content: await readOriginalNote("improvement_plan.txt"),
      summary: "使用 step19 对应原始工作笔记生成工作笔记。",
    })
    await action("检查笔记充分性", {
      sufficient: true,
      summary: "step19 包含工作归属、前序来源、结果和目标影响，足以生成图操作。",
    })
    await action("生成图操作草案", { command: await readStepCommand(19) })
    await action("校验图操作")
    await action("生成预览")
    await expect(fs.stat(path.join(directory, "workflows", "active", "preview.json"))).resolves.toBeTruthy()

    const revised = await action("提出修订意见", {
      target: "图操作",
      comment: "不要新增目标，改为更新已有目标。",
    })

    expect(revised.stage).toBe("图操作需修订")
    await expect(fs.stat(path.join(directory, "workflows", "active", "note.md"))).resolves.toBeTruthy()
    await expect(fs.stat(path.join(directory, "workflows", "active", "preview.json"))).rejects.toThrow()
  })

  test("regenerating operations invalidates validation and preview artifacts", async () => {
    await replayStepsBefore(18)
    await action("开始或恢复")
    await action("更新工作笔记", { content: await readOriginalNote("knowledge_entry_point.txt"), summary: "使用 step18 对应原始工作笔记。" })
    const command = await readStepCommand(18)
    await action("生成图操作草案", { command })
    await action("校验图操作")
    await action("生成预览")

    const regenerated = await action("生成图操作草案", {
      command: {
        ...command,
        change_id: "step18_knowledge_scheme_revised",
        description: "根据审核意见重新生成 step18 图操作草案。",
      },
    })
    expect(regenerated.stage).toBe("图操作已生成")
    await expect(fs.stat(path.join(directory, "workflows", "active", "operations.json"))).resolves.toBeTruthy()
    await expect(fs.stat(path.join(directory, "workflows", "active", "validation.json"))).rejects.toThrow()
    await expect(fs.stat(path.join(directory, "workflows", "active", "preview.json"))).rejects.toThrow()
  })

  test("updating note invalidates graph operation draft and downstream artifacts", async () => {
    await replayStepsBefore(18)
    await action("开始或恢复")
    await action("更新工作笔记", {
      content: await readOriginalNote("knowledge_entry_point.txt"),
      summary: "使用 step18 对应原始工作笔记。",
      source: "manual_import",
      sourcePath: "source/knowledge_entry_point.txt",
    })
    await action("生成图操作草案", { command: await readStepCommand(18) })
    await action("校验图操作")
    await action("生成预览")

    const activeDir = path.join(directory, "workflows", "active")
    await expect(fs.stat(path.join(activeDir, "operations.json"))).resolves.toBeTruthy()
    await expect(fs.stat(path.join(activeDir, "validation.json"))).resolves.toBeTruthy()
    await expect(fs.stat(path.join(activeDir, "preview.json"))).resolves.toBeTruthy()

    const updated = await action("更新工作笔记", {
      content: `${await readOriginalNote("knowledge_entry_point.txt")}\n\n补充：人工修订后需要重生成图操作。\n`,
      summary: "人工修订工作笔记，旧图操作草案过期。",
      source: "manual_edit",
    })

    expect(updated.stage).toBe("笔记已生成")
    await expect(fs.stat(path.join(activeDir, "note.md"))).resolves.toBeTruthy()
    await expect(fs.stat(path.join(activeDir, "note_review.json"))).rejects.toThrow()
    await expect(fs.stat(path.join(activeDir, "operations.json"))).rejects.toThrow()
    await expect(fs.stat(path.join(activeDir, "validation.json"))).rejects.toThrow()
    await expect(fs.stat(path.join(activeDir, "preview.json"))).rejects.toThrow()
  })

  test("syncing an externally edited note invalidates graph operation draft without rewriting note content", async () => {
    await replayStepsBefore(18)
    await action("开始或恢复")
    await action("更新工作笔记", {
      content: await readOriginalNote("knowledge_entry_point.txt"),
      summary: "使用 step18 对应原始工作笔记。",
    })
    await action("生成图操作草案", { command: await readStepCommand(18) })
    await action("校验图操作")
    await action("生成预览")

    const activeDir = path.join(directory, "workflows", "active")
    const notePath = path.join(activeDir, "note.md")
    const externallyEdited = `${await fs.readFile(notePath, "utf8")}\n补充：通过原版 edit 工具追加的事实。\n`
    await fs.writeFile(notePath, externallyEdited, "utf8")

    const synced = await action("同步工作笔记变更", {
      summary: "原版 edit 修改工作笔记后同步状态。",
      source: "llm_revision",
    })

    expect(synced.stage).toBe("笔记已生成")
    await expect(fs.readFile(notePath, "utf8")).resolves.toBe(externallyEdited)
    await expect(fs.stat(path.join(activeDir, "note_review.json"))).rejects.toThrow()
    await expect(fs.stat(path.join(activeDir, "operations.json"))).rejects.toThrow()
    await expect(fs.stat(path.join(activeDir, "validation.json"))).rejects.toThrow()
    await expect(fs.stat(path.join(activeDir, "preview.json"))).rejects.toThrow()
  })

  test("replacing active workflow for warmup carries note and resources but clears graph draft artifacts", async () => {
    await replayStepsBefore(18)
    await action("开始或恢复")
    const note = await readOriginalNote("knowledge_entry_point.txt")
    const command = await readStepCommand(18)
    await action("登记资源", {
      path: "source/knowledge.md",
      title: "知识梳理材料",
      note: "用于本次预热迁移校验。",
    })
    await action("更新工作笔记", { content: note, summary: "使用 step18 对应原始工作笔记。" })
    await action("生成图操作草案", { command })
    await action("校验图操作")
    await action("生成预览")

    const activeDir = path.join(directory, "workflows", "active")
    await expect(fs.stat(path.join(activeDir, "operations.json"))).resolves.toBeTruthy()
    await expect(fs.stat(path.join(activeDir, "validation.json"))).resolves.toBeTruthy()
    await expect(fs.stat(path.join(activeDir, "preview.json"))).resolves.toBeTruthy()

    const replaced = await ProjectWorkflow.replaceActiveForWarmup({
      project: "demo",
      directory,
      sessionID: "ses_workflow_after_warmup",
      warmupSessionID: "ses_warmup",
      warmupStatus: "completed",
    })

    expect(replaced.stage).toBe("笔记已生成")
    expect(replaced.state).toMatchObject({
      sessionID: "ses_workflow_after_warmup",
      warmupSessionID: "ses_warmup",
      warmupStatus: "completed",
    })
    await expect(fs.readFile(path.join(activeDir, "note.md"), "utf8")).resolves.toContain(note.trim().slice(0, 120))
    await expect(fs.readFile(path.join(activeDir, "resources.json"), "utf8")).resolves.toContain("source/knowledge.md")
    await expect(fs.stat(path.join(activeDir, "operations.json"))).rejects.toThrow()
    await expect(fs.stat(path.join(activeDir, "validation.json"))).rejects.toThrow()
    await expect(fs.stat(path.join(activeDir, "preview.json"))).rejects.toThrow()
  })

  test("blocks unsafe actions but allows flexible non-destructive actions", async () => {
    await action("开始或恢复")

    await expect(action("生成图操作草案", { command: await readStepCommand(18) })).rejects.toThrow("尚未生成工作笔记")
    await expect(action("校验图操作")).rejects.toThrow("尚未生成图操作草案")

    const messaged = await action("追加消息", {
      role: "用户",
      text: "我先补充一些背景，不急着生成图操作。",
    })
    expect(messaged.stage).toBe("收集材料")
  })

  test("exposes terminal actions for dedicated UI buttons with state-machine guards", async () => {
    const started = await action("开始或恢复")
    const discard = started.availableActions.find((item) => item.action === "放弃草案")
    expect(discard).toMatchObject({
      action: "放弃草案",
      requiresUserConfirmation: true,
    })
    expect(started.blockedActions.find((item) => item.action === "应用图操作")?.reason).toContain("尚未生成可审核的预览")

    await replayStepsBefore(18)
    await action("更新工作笔记", {
      content: await readOriginalNote("knowledge_entry_point.txt"),
      summary: "使用 step18 对应原始工作笔记。",
    })
    await action("生成图操作草案", { command: await readStepCommand(18) })
    await action("校验图操作")
    const previewed = await action("生成预览")
    const apply = previewed.availableActions.find((item) => item.action === "应用图操作")
    expect(apply).toMatchObject({
      action: "应用图操作",
      requiresUserConfirmation: true,
    })
  })

  test("dedicated discard action clears the active draft and allows a fresh workflow", async () => {
    await action("开始或恢复")
    await action("追加消息", {
      role: "用户",
      text: "这轮先记录一段还没形成图操作的推进背景。",
    })
    await expect(fs.stat(path.join(directory, "workflows", "active", "state.json"))).resolves.toBeTruthy()

    const discarded = await action("放弃草案")
    expect(discarded.stage).toBeUndefined()
    expect(discarded.availableActions).toEqual([
      { action: "开始或恢复", reason: "当前没有 active 草案，可以创建或恢复工作推进。" },
    ])
    await expect(fs.stat(path.join(directory, "workflows", "active", "state.json"))).rejects.toThrow()

    const restarted = await action("开始或恢复")
    expect(restarted.stage).toBe("收集材料")
    expect(restarted.data).toMatchObject({ restored: false })
  })

  test("discard keeps note.md when the draft has a working note", async () => {
    await action("开始或恢复")
    await action("更新工作笔记", {
      content: "这是一份需要保留的工作笔记。",
      summary: "人工整理工作笔记。",
    })
    await action("追加消息", {
      role: "用户",
      text: "先放弃当前图操作草案。",
    })
    const activeDir = path.join(directory, "workflows", "active")
    await fs.writeFile(path.join(activeDir, "operations.json"), "{}\n", "utf8")
    await fs.writeFile(path.join(activeDir, "validation.json"), "{}\n", "utf8")
    await fs.writeFile(path.join(activeDir, "preview.json"), "{}\n", "utf8")
    await ProjectWorkflow.bindSessions({
      project: "demo",
      directory,
      sessionID: "ses_demo_chat" as any,
      warmupSessionID: "ses_demo_warmup" as any,
      warmupStatus: "completed",
    })

    const discarded = await action("放弃草案")

    expect(discarded.stage).toBe("笔记已生成")
    expect(discarded.message).toContain("保留工作笔记")
    expect(discarded.state?.sessionID).toBeUndefined()
    expect(discarded.state?.warmupSessionID).toBe("ses_demo_warmup")
    await expect(fs.readFile(path.join(activeDir, "note.md"), "utf8")).resolves.toBe("这是一份需要保留的工作笔记。\n")
    await expect(fs.stat(path.join(activeDir, "messages.jsonl"))).rejects.toThrow()
    await expect(fs.stat(path.join(activeDir, "operations.json"))).rejects.toThrow()
    await expect(fs.stat(path.join(activeDir, "validation.json"))).rejects.toThrow()
    await expect(fs.stat(path.join(activeDir, "preview.json"))).rejects.toThrow()
  })

  test("discard removes the forked workflow chat session but keeps the warmup baseline session", async () => {
    const { Instance } = await import("@/project/instance")
    const { Session } = await import("@/session")
    let warmupSessionID = ""
    let workflowChatSessionID = ""

    await Instance.provide({
      directory,
      fn: async () => {
        const warmup = await Session.create({ title: "工作推进上下文预热" })
        const chat = await Session.fork({ sessionID: warmup.id })
        warmupSessionID = warmup.id
        workflowChatSessionID = chat.id

        await action("开始或恢复")
        await ProjectWorkflow.bindSessions({
          project: "demo",
          directory,
          sessionID: workflowChatSessionID,
          warmupSessionID,
          warmupStatus: "completed",
        })

        await action("放弃草案")
      },
    })

    await Instance.provide({
      directory,
      fn: async () => {
        await expect(Session.get(workflowChatSessionID as any)).rejects.toThrow()
        await expect(Session.get(warmupSessionID as any)).resolves.toMatchObject({
          id: warmupSessionID,
          title: "工作推进上下文预热",
        })
        await Session.remove(warmupSessionID as any)
      },
    })
  })

  test("dedicated apply action is guarded before and after preview generation", async () => {
    await action("开始或恢复")
    await expect(action("应用图操作", { confirm: true })).rejects.toThrow("尚未生成可审核的预览")

    await replayStepsBefore(18)
    await action("更新工作笔记", {
      content: await readOriginalNote("knowledge_entry_point.txt"),
      summary: "使用 step18 对应原始工作笔记。",
    })
    await action("生成图操作草案", { command: await readStepCommand(18) })
    await action("校验图操作")
    await action("生成预览")

    await expect(action("应用图操作", { confirm: false })).rejects.toThrow("应用图操作需要 payload.confirm = true")
    await expect(action("应用图操作", { confirm: true })).rejects.toThrow("当前版本只实现状态机、草案文件和校验/预览")
  })
})
