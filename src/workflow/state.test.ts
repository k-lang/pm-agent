import fs from "fs/promises"
import os from "os"
import path from "path"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ProjectWorkflow } from "./state"
import { ProjectWorkflowExecution } from "./execution"
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
    return ProjectWorkflowExecution.runAction({ project: "demo", directory, action, payload })
  }

  function stateAction(action: ProjectWorkflow.Action, payload: Record<string, unknown> = {}) {
    return ProjectWorkflow.runAction({ project: "demo", directory, action, payload })
  }

  async function readOriginalNote(file: string) {
    return fs.readFile(path.join(NOTES_DIR, file), "utf8")
  }

  async function readStepCommand(step: number) {
    return JSON.parse(await fs.readFile(path.join(COMMANDS_DIR, `step${step}.json`), "utf8"))
  }

  function testChangelogEntry(command: any, override?: string) {
    return override ?? `[${command.timestamp || "2026-07-06 10:00"}] ${command.change_id}: 测试素材登记图操作草案(${command.change_id})，用于验证工作推进流程中的图操作生成、校验、预览和提交路径。`
  }

  function commandToCompressedDraft(command: any, options: { changelogEntry?: string; noteFilename?: string } = {}) {
    const modelOwnedFields = (fields: Record<string, unknown>) => {
      const { linked_work_blocks: _linkedWorkBlocks, work_items: _workItems, ...rest } = fields
      return rest
    }
    return {
      change_id: command.change_id,
      timestamp: command.timestamp,
      note_filename: options.noteFilename ?? "workflow_progress_note.md",
      changelog_entry: testChangelogEntry(command, options.changelogEntry),
      items: command.operations.map((operation: any) => {
        if (operation.type === "create_node") {
          const { type, summary, description, ...fields } = operation.data ?? {}
          return {
            kind: "create_node",
            temp_id: operation.temp_id,
            node_type: type,
            summary,
            description,
            fields: modelOwnedFields(fields),
            history: command.history_descriptions?.[operation.temp_id],
          }
        }
        if (operation.type === "update_node") {
          const { description, ...fieldUpdates } = operation.updates ?? {}
          return {
            kind: "update_node",
            node_id: operation.node_id,
            field_updates: modelOwnedFields(fieldUpdates),
            description,
            history: command.history_descriptions?.[operation.node_id],
          }
        }
        if (operation.type === "create_edge") {
          return {
            kind: "create_edge",
            temp_id: operation.temp_id,
            from_node: operation.from_node,
            to_node: operation.to_node,
            edge_type: operation.edge_type,
            description: operation.description,
            history: operation.temp_id ? command.history_descriptions?.[operation.temp_id] : undefined,
          }
        }
        if (operation.type === "update_edge") {
          return {
            kind: "update_edge",
            edge_id: operation.edge_id,
            new_description: operation.new_description,
            reason: operation.reason,
            history: command.history_descriptions?.[operation.edge_id],
          }
        }
        throw new Error(`unsupported operation type in test command: ${operation.type}`)
      }),
    }
  }

  async function writeOperationDraft(command: any, options: { changelogEntry?: string; noteFilename?: string } = {}) {
    const activeDir = path.join(directory, "workflows", "active")
    await fs.mkdir(activeDir, { recursive: true })
    await fs.writeFile(path.join(activeDir, "operation_notes.md"), `# 图操作说明\n\n${command.change_id || "未命名变更"}\n`, "utf8")
    await fs.writeFile(path.join(activeDir, "operations.draft.json"), JSON.stringify(commandToCompressedDraft(command, options), null, 2) + "\n", "utf8")
  }

  async function registerOperationDraft(command: any, summary = "登记已写入的图操作 draft。", options: { changelogEntry?: string; noteFilename?: string } = {}) {
    await writeOperationDraft(command, options)
    return action("生成图操作草案", {
      summary,
      change_id: command.change_id,
      artifacts: { operationNotes: true, operationsDraft: true },
    })
  }

  async function registerCompressedDraft(draft: any, summary = "登记已写入的压缩图操作 draft。") {
    const activeDir = path.join(directory, "workflows", "active")
    await fs.mkdir(activeDir, { recursive: true })
    const draftWithChangelog = draft.changelog_entry ? draft : {
      ...draft,
      note_filename: draft.note_filename ?? "workflow_progress_note.md",
      changelog_entry: testChangelogEntry(draft),
    }
    await fs.writeFile(path.join(activeDir, "operation_notes.md"), `# 图操作说明\n\n${draft.change_id || "未命名变更"}\n`, "utf8")
    await fs.writeFile(path.join(activeDir, "operations.draft.json"), JSON.stringify(draftWithChangelog, null, 2) + "\n", "utf8")
    return action("生成图操作草案", {
      summary,
      change_id: draft.change_id,
      artifacts: { operationNotes: true, operationsDraft: true },
    })
  }

  const step18ChangelogEntry = "[2025-08-20 00:30] step18_knowledge_scheme: 语料分析失败后开展知识梳理方案设计并验证工作项(work_item_knowledge_scheme_design)，通过深入分析偏好和额外知识点的特征发现偏好集中在操作动作上、额外知识点集中在主体实体上的区分角度；设计针对性处理手段(偏好通过大模型总结原始诉求并聚类策略去重合并、额外知识点通过资深座席整理后大模型辅助判断)；在91条U宝相关标签评测集上验证方案切实有效消除标签定义重叠现象；产生知识梳理方案验证结果(result_knowledge_organization_scheme)推动知识梳理目标(goal_knowledge_organization)进度从30%大幅提升至60%，更新工作块(work_block_knowledge_organization)补充方案设计验证情况"

  async function replayStepsBefore(step: number) {
    for (let i = 0; i < step; i++) {
      const result = await loadCommandAndExecute(path.join(COMMANDS_DIR, `step${i}.json`), directory)
      if (!result.success) throw new Error(`replay step${i} failed: ${result.errors.join("; ")}`)
    }
  }

  async function countFiles(dir: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    return entries.filter((entry) => entry.isFile()).length
  }

  test("rejects active state files that still use removed workflow stages", async () => {
    const activeDir = path.join(directory, "workflows", "active")
    await fs.mkdir(activeDir, { recursive: true })
    await fs.writeFile(path.join(activeDir, "state.json"), JSON.stringify({
      id: "legacy_state",
      project: "demo",
      stage: "预览已生成",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      history: [{
        time: Date.now(),
        action: "生成预览",
        from: "校验已通过",
        to: "预览已生成",
        summary: "旧状态机遗留状态。",
      }],
    }, null, 2) + "\n", "utf8")

    await expect(ProjectWorkflow.getActive({ project: "demo", directory })).rejects.toThrow()
  })

  test("rejects active state files that still contain hidden state history", async () => {
    const activeDir = path.join(directory, "workflows", "active")
    await fs.mkdir(activeDir, { recursive: true })
    await fs.writeFile(path.join(activeDir, "state.json"), JSON.stringify({
      id: "legacy_state",
      project: "demo",
      stage: "收集材料",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      history: [{
        time: Date.now(),
        action: "开始或恢复",
        to: "收集材料",
        summary: "旧实现写入的隐藏状态历史。",
      }],
    }, null, 2) + "\n", "utf8")

    await expect(ProjectWorkflow.getActive({ project: "demo", directory })).rejects.toThrow()
  })

  test("uses jiedaidan original note for a mid-project draft-check-and-preview flow", async () => {
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

    const drafted = await registerOperationDraft(command)
    expect(drafted.stage).toBe("图操作已生成")
    expect(drafted.data?.validation).toMatchObject({ passed: true })

    const preview = JSON.parse(await fs.readFile(path.join(directory, "workflows", "active", "preview.json"), "utf8"))
    expect(preview).toMatchObject({
      change_id: "step18_knowledge_scheme",
      operationCount: 7,
      graphDirectory: "workflows/active/preview_graph",
    })
    expect(preview.mode).toBe("full-graph")
    expect(Array.isArray(preview.graph?.nodes)).toBe(true)
    expect(Array.isArray(preview.graph?.edges)).toBe(true)
    expect(preview.change.createdNodeIds.length + preview.change.updatedNodeIds.length).toBeGreaterThan(0)
    expect(preview.change.createdEdgeIds.length + preview.change.updatedEdgeIds.length).toBeGreaterThan(0)
    const index = JSON.parse(await fs.readFile(path.join(directory, "workflows", "active", "operation_index.json"), "utf8"))
    const firstEdgeOperation = command.operations.find((operation: any) => operation.type === "create_edge")
    expect(firstEdgeOperation).toBeTruthy()
    const expectedRenderEdgeID = `${firstEdgeOperation.from_node}|${firstEdgeOperation.to_node}|${firstEdgeOperation.edge_type}`
    const matchingGroup = index.groups.find((group: any) => group.edgeIds?.includes(expectedRenderEdgeID))
    expect(matchingGroup).toBeTruthy()
    expect(matchingGroup.nodeIds).toEqual([firstEdgeOperation.from_node, firstEdgeOperation.to_node])
    const matchingEdgeChild = matchingGroup.children.find((child: any) => child.edgeIds?.includes(expectedRenderEdgeID))
    expect(matchingEdgeChild).toBeTruthy()
    expect(matchingEdgeChild.nodeIds || []).toEqual([])
    for (const group of index.groups) {
      if (group.kind !== "关系组") continue
      expect(group.nodeIds).toHaveLength(2)
      expect(group.edgeIds).toHaveLength(1)
      const edgeChildren = group.children.filter((child: any) => child.edgeIds?.length)
      expect(edgeChildren).toHaveLength(1)
      expect(edgeChildren[0].edgeIds).toEqual(group.edgeIds)
      expect(edgeChildren[0].nodeIds || []).toEqual([])
      for (const child of group.children.filter((item: any) => item.nodeIds?.length && !item.edgeIds?.length)) {
        expect(child.nodeIds.every((nodeId: string) => group.nodeIds.includes(nodeId))).toBe(true)
      }
    }
    await expect(fs.stat(path.join(directory, "workflows", "active", "preview_graph", "nodes"))).resolves.toBeTruthy()
    await expect(fs.stat(path.join(directory, "workflows", "active", "preview_graph", "edges"))).resolves.toBeTruthy()
    expect(drafted.availableActions.map((item) => item.action)).toContain("应用图操作")

    const stateRaw = await fs.readFile(path.join(directory, "workflows", "active", "state.json"), "utf8")
    expect(stateRaw).toContain("图操作已生成")
  })

  test("groups update_edge operations by existing source edge and target", async () => {
    await replayStepsBefore(18)
    await action("开始或恢复")
    await action("更新工作笔记", {
      content: "验证已有边更新时，图操作索引仍按起点、边、终点组织。",
      summary: "建立测试工作笔记。",
    })
    const edgeIDs = (await fs.readdir(path.join(directory, "edges"))).filter((name) => name.endsWith(".json"))
    const edgeID = path.basename(edgeIDs[0], ".json")
    const edge = JSON.parse(await fs.readFile(path.join(directory, "edges", `${edgeID}.json`), "utf8"))

    await registerOperationDraft({
      change_id: "update_edge_group_index",
      timestamp: "2026-07-06T10:00:00+08:00",
      description: "更新已有边说明，验证索引分组。",
      operations: [
        {
          type: "update_edge",
          edge_id: edgeID,
          new_description: "更新后的边说明。",
          reason: "验证索引生成。",
        },
      ],
      history_descriptions: {
        [edgeID]: "更新已有边说明。",
      },
    })

    const index = JSON.parse(await fs.readFile(path.join(directory, "workflows", "active", "operation_index.json"), "utf8"))
    const renderEdgeID = `${edge.from_node_id}|${edge.to_node_id}|${edge.type}`
    expect(index.groups).toHaveLength(1)
    expect(index.groups[0]).toMatchObject({
      kind: "关系组",
      sourceNodeId: edge.from_node_id,
      targetNodeId: edge.to_node_id,
      edgeId: renderEdgeID,
      nodeIds: [edge.from_node_id, edge.to_node_id],
      edgeIds: [renderEdgeID],
    })
    expect(index.groups[0].children).toHaveLength(1)
    expect(index.groups[0].children[0]).toMatchObject({
      kind: "更新关系",
      nodeIds: [],
      edgeIds: [renderEdgeID],
    })
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

  test("compiles compressed operation draft into executable operations and generated index", async () => {
    await replayStepsBefore(18)
    await action("开始或恢复")
    await action("更新工作笔记", {
      content: await readOriginalNote("knowledge_entry_point.txt"),
      summary: "使用 step18 对应原始工作笔记。",
    })

    const drafted = await registerCompressedDraft({
      change_id: "compressed_step18_delta",
      timestamp: "2026-07-06T10:00:00+08:00",
      items: [
        {
          kind: "update_node",
          node_id: "goal_knowledge_organization",
          field_updates: { completion_score: 31 },
          description_delta: "本轮用压缩 draft 记录：知识梳理目标补充了一次可校验的进展增量。",
          history: "压缩 draft 更新目标完成度并追加说明增量。",
        },
        {
          kind: "create_node",
          temp_id: "result_compressed_draft_demo",
          node_type: "result",
          summary: "压缩 draft 编译验证结果",
          description: "用于验证模型只写语义增量，最终 GraphCommand 由执行层生成。",
          fields: { status: "produced" },
          history: "创建压缩 draft 编译验证结果节点。",
        },
        {
          kind: "create_edge",
          temp_id: "edge_distinction_sort_creates_compressed_result",
          from_node: "work_item_distinction_sort",
          to_node: "result_compressed_draft_demo",
          edge_type: "creates",
          description: "已有语料分析工作项产出压缩 draft 编译验证结果。",
          history: "建立工作项到压缩 draft 编译验证结果的 creates 关系。",
        },
        {
          kind: "create_edge",
          temp_id: "edge_compressed_result_adjusts_goal",
          from_node: "result_compressed_draft_demo",
          to_node: "goal_knowledge_organization",
          edge_type: "adjusts_result",
          description: "压缩 draft 编译结果影响知识梳理目标。",
          history: "建立压缩 draft 验证结果到知识梳理目标的影响关系。",
        },
      ],
    })

    expect(drafted.stage).toBe("图操作已生成")
    const activeDir = path.join(directory, "workflows", "active")
    const command = JSON.parse(await fs.readFile(path.join(activeDir, "operations.json"), "utf8"))
    expect(command).toMatchObject({
      change_id: "compressed_step18_delta",
      operations: [
        {
          type: "update_node",
          node_id: "goal_knowledge_organization",
        },
        {
          type: "create_node",
          temp_id: "result_compressed_draft_demo",
        },
        {
          type: "create_edge",
          temp_id: "edge_distinction_sort_creates_compressed_result",
        },
        {
          type: "create_edge",
          temp_id: "edge_compressed_result_adjusts_goal",
        },
      ],
    })
    expect(command.operations[0].updates.description).toContain("基于标签易混淆点分析")
    expect(command.operations[0].updates.description).toContain("本轮用压缩 draft 记录")
    expect(command.operations[0].updates.description).toContain("历史记录：")
    expect(command.operations[0].updates.description).toContain("压缩 draft 更新目标完成度")
    expect(command.operations[0].updates.description).toContain("语料分析实验")
    expect(command.operations[0].updates.description).not.toContain("\n- - [")
    expect(command.operations[0].updates.description).not.toContain("\n- 发生变动")
    const historyLines = command.operations[0].updates.description.split("历史记录：\n")[1].split("\n")
    expect(historyLines[0]).toContain("[compressed_step18_delta]")
    expect(historyLines[0]).toContain("压缩 draft 更新目标完成度")
    expect(historyLines[0]).toContain("此目标被压缩 draft 编译验证结果影响")
    expect(historyLines[0]).toContain("结果节点id: result_compressed_draft_demo")
    expect(historyLines[1]).toContain("语料分析实验")
    expect(command.history_descriptions.goal_knowledge_organization).toContain("[compressed_step18_delta]")
    expect(command.history_descriptions.goal_knowledge_organization).toContain("此目标被压缩 draft 编译验证结果影响")
    expect(command.history_descriptions.result_compressed_draft_demo).toContain("[compressed_step18_delta]")
    expect(command.history_descriptions.result_compressed_draft_demo).toContain("结果由通过大模型分析语料挖掘标签细粒度区分依据")
    expect(command.history_descriptions.result_compressed_draft_demo).toContain("结果影响找到高效梳理领域知识的办法并评估工作量")
    expect(command.history_descriptions.edge_distinction_sort_creates_compressed_result).toContain("[compressed_step18_delta]")
    expect(command.history_descriptions.edge_distinction_sort_creates_compressed_result).toContain("工作项节点id: work_item_distinction_sort")
    expect(command.history_descriptions.edge_compressed_result_adjusts_goal).toContain("[compressed_step18_delta]")
    expect(command.history_descriptions.edge_compressed_result_adjusts_goal).toContain("目标节点id: goal_knowledge_organization")
    const index = JSON.parse(await fs.readFile(path.join(activeDir, "operation_index.json"), "utf8"))
    expect(index.items).toHaveLength(4)
    expect(index.items[0].history_entry).toContain("压缩 draft")
  })

  test("compressed draft can provide full current-state descriptions for summary nodes", async () => {
    await replayStepsBefore(18)
    await action("开始或恢复")
    await action("更新工作笔记", {
      content: await readOriginalNote("knowledge_entry_point.txt"),
      summary: "使用 step18 对应原始工作笔记。",
    })

    const fullDescription = "领域知识梳理目标的当前状态总结：已完成代表性标签分析、资深座席反馈消化和语料实验复盘；当前认识是偏好问题和额外知识点需要分治处理，后续应扩大标签范围继续验证。"
    const drafted = await registerCompressedDraft({
      change_id: "compressed_full_description",
      timestamp: "2026-07-06T10:00:00+08:00",
      items: [
        {
          kind: "update_node",
          node_id: "goal_knowledge_organization",
          field_updates: { completion_score: 32 },
          description: fullDescription,
          history: "用完整当前状态总结更新领域知识梳理目标，而不是机械追加一句 delta。",
        },
      ],
    })

    expect(drafted.stage).toBe("图操作已生成")
    const command = JSON.parse(await fs.readFile(path.join(directory, "workflows", "active", "operations.json"), "utf8"))
    expect(command.operations[0]).toMatchObject({
      type: "update_node",
      node_id: "goal_knowledge_organization",
      updates: {
        completion_score: 32,
      },
    })
    expect(command.operations[0].updates.description).toContain(fullDescription)
    expect(command.operations[0].updates.description).toContain("历史记录：")
    expect(command.operations[0].updates.description).toContain("用完整当前状态总结更新领域知识梳理目标")
    expect(command.operations[0].updates.description).toContain("语料分析实验")
    expect(command.operations[0].updates.description).not.toContain("\n- - [")
    expect(command.operations[0].updates.description.split("历史记录：")[0]).not.toContain("基于标签易混淆点分析")
    const previewGoal = JSON.parse(await fs.readFile(path.join(directory, "workflows", "active", "preview_graph", "nodes", "goal", "goal_knowledge_organization.json"), "utf8"))
    expect(previewGoal.description).toContain(fullDescription)
    expect(previewGoal.description).toContain("历史记录：")
    expect(previewGoal.description).toContain("用完整当前状态总结更新领域知识梳理目标")
    const index = JSON.parse(await fs.readFile(path.join(directory, "workflows", "active", "operation_index.json"), "utf8"))
    expect(index.groups).toHaveLength(1)
    expect(index.groups[0]).toMatchObject({
      kind: "更新节点",
      nodeIds: ["goal_knowledge_organization"],
      edgeIds: [],
    })
  })

  test("compressed draft preserves readable history from description instead of structured fallback history", async () => {
    await action("开始或恢复")
    await action("更新工作笔记", {
      content: "人工验证历史记录合成逻辑。",
      summary: "建立测试工作笔记。",
    })
    const nodeDir = path.join(directory, "nodes", "goal")
    await fs.mkdir(nodeDir, { recursive: true })
    await fs.writeFile(path.join(nodeDir, "goal_history_format.json"), JSON.stringify({
      id: "goal_history_format",
      type: "goal",
      summary: "验证历史格式",
      description: [
        "这是当前目标说明。",
        "",
        "历史记录：",
        "- [old_step_2] 旧的第二条可读历史。",
        "- - [old_step_1] 旧数据里带重复 bullet 的第一条可读历史。",
      ].join("\n"),
      status: "in_progress",
      completion_score: 10,
      linked_work_blocks: [],
      history: [
        {
          timestamp: "2025-01-01T00:00:00",
          version: "old_step_1",
          description: "发生变动",
          serialized_data: "{}",
        },
        {
          timestamp: "2025-01-02T00:00:00",
          version: "old_step_2",
          description: "发生变动",
          serialized_data: "{}",
        },
      ],
    }, null, 2) + "\n", "utf8")

    await registerCompressedDraft({
      change_id: "history_format_regression",
      timestamp: "2026-07-06T10:00:00+08:00",
      items: [
        {
          kind: "update_node",
          node_id: "goal_history_format",
          field_updates: { completion_score: 20 },
          description_delta: "本轮新增当前说明。",
          history: "[new_step] 本轮新增可读历史。",
        },
      ],
    })

    const command = JSON.parse(await fs.readFile(path.join(directory, "workflows", "active", "operations.json"), "utf8"))
    const description = command.operations[0].updates.description
    expect(description).toContain("这是当前目标说明。")
    expect(description).toContain("本轮新增当前说明。")
    expect(description).toContain("历史记录：")
    expect(description).toContain("[new_step] 本轮新增可读历史。")
    expect(description).toContain("[old_step_2] 旧的第二条可读历史。")
    expect(description).toContain("[old_step_1] 旧数据里带重复 bullet 的第一条可读历史。")
    expect(description).not.toContain("\n- - [")
    expect(description).not.toContain("\n- 发生变动")
    const lines = description.split("历史记录：\n")[1].split("\n")
    expect(lines[0]).toBe("- [new_step] 本轮新增可读历史。")
    expect(lines[1]).toBe("- [old_step_2] 旧的第二条可读历史。")
    expect(lines[2]).toBe("- [old_step_1] 旧数据里带重复 bullet 的第一条可读历史。")
  })

  test("refreshes descriptions_output as lightweight node-only graph indexes", async () => {
    await replayStepsBefore(17)
    await fs.rm(path.join(directory, "descriptions_output"), { recursive: true, force: true })
    const nodePath = path.join(directory, "nodes", "goal", "goal_knowledge_organization.json")
    const node = JSON.parse(await fs.readFile(nodePath, "utf8"))
    node.history.push({
      timestamp: "2026-07-06T10:00:00+08:00",
      version: "duplicate_prefix_check",
      description: "[duplicate_prefix_check] 测试已有结构化 history.description 带 change_id 前缀时索引不重复渲染。",
      serialized_data: JSON.stringify({ id: node.id, type: node.type }, null, 2),
    })
    await fs.writeFile(nodePath, JSON.stringify(node, null, 2) + "\n", "utf8")

    await ProjectWorkflowExecution.refreshDescriptionOutputs(directory)

    const nodeTypes = ["event", "issue", "goal", "work_item", "result", "work_block"]
    const nodeCount = (await Promise.all(nodeTypes.map((type) => countFiles(path.join(directory, "nodes", type))))).reduce((sum, count) => sum + count, 0)
    expect(await countFiles(path.join(directory, "descriptions_output", "description_summary"))).toBe(nodeCount)
    expect(await countFiles(path.join(directory, "descriptions_output", "history"))).toBe(nodeCount)
    await expect(fs.stat(path.join(directory, "descriptions_output", "history", "edge_distinction_sort_next_knowledge_scheme.txt"))).rejects.toThrow()
    const history = await fs.readFile(path.join(directory, "descriptions_output", "history", "goal_knowledge_organization.txt"), "utf8")
    expect(history).toContain("- [duplicate_prefix_check] 测试已有结构化")
    expect(history).not.toContain("- [duplicate_prefix_check] [duplicate_prefix_check]")
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
    await registerOperationDraft(damaged)

    const validated = await action("校验图操作")
    expect(validated.stage).toBe("图操作需修订")
    expect(validated.data?.validation).toMatchObject({ passed: false })
    expect(validated.recommendations.join("\n")).toContain("修订图操作")
    expect(validated.availableActions.map((item) => item.action)).toContain("生成图操作草案")
    expect(validated.availableActions.map((item) => item.action)).toContain("同步工作笔记变更")
    expect(validated.availableActions.map((item) => item.action)).not.toContain("生成预览")
    expect(validated.blockedActions.map((item) => item.action)).not.toContain("生成预览")
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
    await registerOperationDraft(await readStepCommand(19))
    await expect(fs.stat(path.join(directory, "workflows", "active", "preview.json"))).resolves.toBeTruthy()
    await expect(fs.stat(path.join(directory, "workflows", "active", "preview_graph"))).resolves.toBeTruthy()

    const revised = await action("提出修订意见", {
      target: "图操作",
      comment: "不要新增目标，改为更新已有目标。",
    })

    expect(revised.stage).toBe("图操作需修订")
    await expect(fs.stat(path.join(directory, "workflows", "active", "note.md"))).resolves.toBeTruthy()
    await expect(fs.stat(path.join(directory, "workflows", "active", "preview.json"))).rejects.toThrow()
    await expect(fs.stat(path.join(directory, "workflows", "active", "preview_graph"))).rejects.toThrow()
  })

  test("regenerating operations invalidates validation and preview artifacts", async () => {
    await replayStepsBefore(18)
    await action("开始或恢复")
    await action("更新工作笔记", { content: await readOriginalNote("knowledge_entry_point.txt"), summary: "使用 step18 对应原始工作笔记。" })
    const command = await readStepCommand(18)
    await registerOperationDraft(command)
    const originalPreview = JSON.parse(await fs.readFile(path.join(directory, "workflows", "active", "preview.json"), "utf8"))

    const regenerated = await registerOperationDraft({
      ...command,
      change_id: "step18_knowledge_scheme_revised",
      description: "根据审核意见重新生成 step18 图操作草案。",
    }, "根据审核意见重新登记 step18 图操作草案。")
    expect(regenerated.stage).toBe("图操作已生成")
    await expect(fs.stat(path.join(directory, "workflows", "active", "operations.json"))).resolves.toBeTruthy()
    await expect(fs.stat(path.join(directory, "workflows", "active", "validation.json"))).resolves.toBeTruthy()
    const regeneratedPreview = JSON.parse(await fs.readFile(path.join(directory, "workflows", "active", "preview.json"), "utf8"))
    expect(regeneratedPreview.change_id).toBe("step18_knowledge_scheme_revised")
    expect(regeneratedPreview.generatedAt).not.toBe(originalPreview.generatedAt)
  })

  test("requires operations.draft.json when registering graph operations", async () => {
    await action("开始或恢复")
    await action("更新工作笔记", {
      content: "完成了一次试探性验证，准备更新已有目标和工作项。\n",
      summary: "人工写入一份用于生成图操作草案的工作笔记。",
    })
    const activeDir = path.join(directory, "workflows", "active")
    await fs.writeFile(
      path.join(activeDir, "operation_notes.md"),
      "## 图操作说明\n\n准备更新已有目标，并追加本次试探性验证的历史条目。\n",
      "utf8",
    )

    await expect(action("生成图操作草案", {
      summary: "只登记自然语言说明不应该推进图操作状态。",
      change_id: "workflow_without_operations",
      artifacts: {
        operationNotes: true,
        operationsDraft: false,
      },
    })).rejects.toThrow("生成图操作必须先写入 workflows/active/operations.draft.json")
  })

  test("keeps previous operation files when command content is submitted to the state machine", async () => {
    await action("开始或恢复")
    await action("更新工作笔记", {
      content: "完成了一次试探性验证，准备更新已有目标和工作项。\n",
      summary: "人工写入一份用于生成图操作草案的工作笔记。",
    })
    const activeDir = path.join(directory, "workflows", "active")
    await fs.writeFile(path.join(activeDir, "operation_notes.md"), "旧图操作说明\n", "utf8")
    await fs.writeFile(path.join(activeDir, "operations.draft.json"), JSON.stringify({
      change_id: "old_operations",
      timestamp: "2026-07-05T10:00:00+08:00",
      note_filename: "old_operations_note.md",
      changelog_entry: "[2026-07-05 10:00] old_operations: 测试登记旧图操作草案(old_operations)。",
      items: [],
    }, null, 2) + "\n", "utf8")
    await action("生成图操作草案", {
      summary: "登记旧图操作说明和草案。",
      change_id: "old_operations",
      artifacts: {
        operationNotes: true,
        operationsDraft: true,
      },
    })

    await expect(action("生成图操作草案", {
      command: { change_id: "bad_command" },
    })).rejects.toThrow()

    await expect(fs.readFile(path.join(activeDir, "operation_notes.md"), "utf8")).resolves.toContain("旧图操作说明")
    await expect(fs.readFile(path.join(activeDir, "operations.json"), "utf8")).resolves.toContain("old_operations")
  })

  test("requires declared operation draft artifacts to exist before lightweight registration", async () => {
    await action("开始或恢复")
    await action("更新工作笔记", {
      content: "完成了一次试探性验证，准备更新已有目标和工作项。\n",
      summary: "人工写入一份用于生成图操作草案的工作笔记。",
    })

    await expect(action("生成图操作草案", {
      summary: "登记尚未写入的图操作草稿。",
      artifacts: {
        operationNotes: true,
        operationsDraft: true,
      },
    })).rejects.toThrow("图操作草案产物尚未写入")
  })

  test("requires lightweight operation draft registration to declare at least one produced artifact", async () => {
    await action("开始或恢复")
    await action("更新工作笔记", {
      content: "完成了一次试探性验证，准备更新已有目标和工作项。\n",
      summary: "人工写入一份用于生成图操作草案的工作笔记。",
    })

    await expect(action("生成图操作草案", {
      summary: "空登记不应该推进图操作状态。",
      artifacts: {
        operationNotes: false,
        operationsDraft: false,
      },
    })).rejects.toThrow("生成图操作必须先写入 workflows/active/operations.draft.json")
  })

  test("unified graph validation reports operations.draft.json schema errors", async () => {
    await action("开始或恢复")
    await action("更新工作笔记", {
      content: "完成了一次试探性验证，准备更新已有目标和工作项。\n",
      summary: "人工写入一份用于生成图操作草案的工作笔记。",
    })
    const activeDir = path.join(directory, "workflows", "active")
    await fs.writeFile(path.join(activeDir, "operations.draft.json"), JSON.stringify({
      change_id: "bad_op_field",
      note_filename: "operation_schema_error_note.md",
      changelog_entry: "[2026-07-05 10:00] bad_op_field: 测试错误字段图操作草案(bad_op_field)。",
      operations: [
        {
          op: "create_node",
          temp_id: "work_item_bad_op",
          data: { type: "work_item", summary: "错误字段草稿" },
        },
      ],
    }, null, 2) + "\n", "utf8")

    const registered = await action("生成图操作草案", {
      summary: "登记错误字段图操作。",
      change_id: "bad_op_field",
      artifacts: { operationsDraft: true },
    })
    expect(registered.stage).toBe("图操作需修订")
    expect(JSON.stringify(registered.data?.validation)).toContain("operations.draft.json")
    const validation = JSON.parse(await fs.readFile(path.join(activeDir, "validation.json"), "utf8"))
    expect(validation.issues.map((issue: { message: string }) => issue.message).join("\n")).toContain("operations.draft.json")
  })

  test("automatic validation rejects old command schemas for model iteration", async () => {
    await action("开始或恢复")
    await action("更新工作笔记", {
      content: "完成了一次试探性验证，准备更新已有目标和工作项。\n",
      summary: "人工写入一份用于生成图操作草案的工作笔记。",
    })
    const activeDir = path.join(directory, "workflows", "active")
    await fs.writeFile(path.join(activeDir, "operations.draft.json"), JSON.stringify({
      change_id: "legacy_commands_schema",
      note_filename: "legacy_schema_error_note.md",
      changelog_entry: "[2026-07-05 10:00] legacy_commands_schema: 测试旧 commands schema 错误(legacy_commands_schema)。",
      description: "错误使用旧 commands schema。",
      commands: [
        {
          command: "create_node",
          temp_id: "work_item_legacy",
          data: { type: "work_item", summary: "错误旧格式工作项" },
        },
      ],
    }, null, 2) + "\n", "utf8")

    const registered = await action("生成图操作草案", {
      summary: "登记旧 schema 图操作。",
      change_id: "legacy_commands_schema",
      artifacts: { operationsDraft: true },
    })

    expect(registered.stage).toBe("图操作需修订")
    expect(JSON.stringify(registered.data?.validation)).toContain("timestamp")
    expect(JSON.stringify(registered.data?.validation)).toContain("operations")
  })

  test("compressed draft requires model-authored changelog entry before compiling operations", async () => {
    await action("开始或恢复")
    await action("更新工作笔记", {
      content: "完成了一次试探性验证，准备更新已有目标和工作项。\n",
      summary: "人工写入一份用于生成图操作草案的工作笔记。",
    })
    const activeDir = path.join(directory, "workflows", "active")
    await fs.writeFile(path.join(activeDir, "operations.draft.json"), JSON.stringify({
      change_id: "missing_changelog_entry",
      timestamp: "2026-07-05T10:00:00+08:00",
      note_filename: "validation_probe_note.md",
      items: [],
    }, null, 2) + "\n", "utf8")

    const registered = await action("生成图操作草案", {
      summary: "登记缺少 changelog_entry 的压缩草案。",
      change_id: "missing_changelog_entry",
      artifacts: { operationsDraft: true },
    })
    expect(registered.stage).toBe("图操作需修订")
    const validation = JSON.parse(await fs.readFile(path.join(activeDir, "validation.json"), "utf8"))
    const messages = validation.issues.map((issue: { message: string }) => issue.message).join("\n")
    expect(messages).toContain("changelog_entry")
    await expect(fs.stat(path.join(activeDir, "operations.json"))).rejects.toThrow()
    await expect(fs.stat(path.join(activeDir, "changelog_entry.txt"))).rejects.toThrow()
  })

  test("compressed draft requires semantic note filename before compiling operations", async () => {
    await action("开始或恢复")
    await action("更新工作笔记", {
      content: "完成了一次试探性验证，准备更新已有目标和工作项。\n",
      summary: "人工写入一份用于生成图操作草案的工作笔记。",
    })
    const activeDir = path.join(directory, "workflows", "active")
    await fs.writeFile(path.join(activeDir, "operations.draft.json"), JSON.stringify({
      change_id: "missing_note_filename",
      timestamp: "2026-07-05T10:00:00+08:00",
      changelog_entry: "[2026-07-05 10:00] missing_note_filename: 测试缺少语义化笔记文件名(missing_note_filename)。",
      items: [],
    }, null, 2) + "\n", "utf8")

    const registered = await action("生成图操作草案", {
      summary: "登记缺少 note_filename 的压缩草案。",
      change_id: "missing_note_filename",
      artifacts: { operationsDraft: true },
    })
    expect(registered.stage).toBe("图操作需修订")
    const validation = JSON.parse(await fs.readFile(path.join(activeDir, "validation.json"), "utf8"))
    const messages = validation.issues.map((issue: { message: string }) => issue.message).join("\n")
    expect(messages).toContain("note_filename")
    await expect(fs.stat(path.join(activeDir, "operations.json"))).rejects.toThrow()
  })

  test("compressed draft rejects note filename mechanically copied from change id", async () => {
    await action("开始或恢复")
    await action("更新工作笔记", {
      content: "完成了一次试探性验证，准备更新已有目标和工作项。\n",
      summary: "人工写入一份用于生成图操作草案的工作笔记。",
    })
    const activeDir = path.join(directory, "workflows", "active")
    await fs.writeFile(path.join(activeDir, "operations.draft.json"), JSON.stringify({
      change_id: "mechanical_change_name",
      timestamp: "2026-07-05T10:00:00+08:00",
      note_filename: "mechanical_change_name.md",
      changelog_entry: "[2026-07-05 10:00] mechanical_change_name: 测试机械命名应被拒绝(mechanical_change_name)。",
      items: [],
    }, null, 2) + "\n", "utf8")

    const registered = await action("生成图操作草案", {
      summary: "登记机械使用 change_id 的 note_filename。",
      change_id: "mechanical_change_name",
      artifacts: { operationsDraft: true },
    })
    expect(registered.stage).toBe("图操作需修订")
    const validation = JSON.parse(await fs.readFile(path.join(activeDir, "validation.json"), "utf8"))
    const messages = validation.issues.map((issue: { message: string }) => issue.message).join("\n")
    expect(messages).toContain("不能机械使用 change_id")
    await expect(fs.stat(path.join(activeDir, "operations.json"))).rejects.toThrow()
  })

  test("compressed draft rejects note filename that cannot survive safe path conversion semantically", async () => {
    await action("开始或恢复")
    await action("更新工作笔记", {
      content: "完成了一次试探性验证，准备更新已有目标和工作项。\n",
      summary: "人工写入一份用于生成图操作草案的工作笔记。",
    })
    const activeDir = path.join(directory, "workflows", "active")
    await fs.writeFile(path.join(activeDir, "operations.draft.json"), JSON.stringify({
      change_id: "semantic_note_name_required",
      timestamp: "2026-07-05T10:00:00+08:00",
      note_filename: "知识梳理.md",
      changelog_entry: "[2026-07-05 10:00] semantic_note_name_required: 测试全中文文件名应被拒绝(semantic_note_name_required)。",
      items: [],
    }, null, 2) + "\n", "utf8")

    const registered = await action("生成图操作草案", {
      summary: "登记无法安全保留语义的 note_filename。",
      change_id: "semantic_note_name_required",
      artifacts: { operationsDraft: true },
    })
    expect(registered.stage).toBe("图操作需修订")
    const validation = JSON.parse(await fs.readFile(path.join(activeDir, "validation.json"), "utf8"))
    const messages = validation.issues.map((issue: { message: string }) => issue.message).join("\n")
    expect(messages).toContain("英文或数字语义片段")
    await expect(fs.stat(path.join(activeDir, "operations.json"))).rejects.toThrow()
  })

  test("unified graph validation rejects compiled operations that invent edge types", async () => {
    await action("开始或恢复")
    await action("更新工作笔记", {
      content: "完成了一次试探性验证，准备更新已有目标和工作项。\n",
      summary: "人工写入一份用于生成图操作草案的工作笔记。",
    })
    const activeDir = path.join(directory, "workflows", "active")
    await fs.writeFile(path.join(activeDir, "operations.draft.json"), JSON.stringify({
      change_id: "bad_edge_type",
      timestamp: "2026-07-05T10:00:00+08:00",
      note_filename: "edge_type_validation_note.md",
      changelog_entry: "[2026-07-05 10:00] bad_edge_type: 测试非法边类型图操作草案(bad_edge_type)。",
      operations: [
        {
          type: "create_node",
          temp_id: "work_item_bad_edge_type",
          data: {
            type: "work_item",
            summary: "错误边类型工作项",
            linked_work_block_id: "work_block_knowledge_organization",
          },
        },
        {
          type: "create_node",
          temp_id: "result_bad_edge_type",
          data: { type: "result", summary: "错误边类型结果" },
        },
        {
          type: "create_edge",
          temp_id: "edge_bad_produces",
          from_node: "work_item_bad_edge_type",
          to_node: "result_bad_edge_type",
          edge_type: "produces",
          description: "错误使用 produces。",
        },
      ],
      history_descriptions: {},
    }, null, 2) + "\n", "utf8")

    const registered = await action("生成图操作草案", {
      summary: "登记非法边类型图操作。",
      change_id: "bad_edge_type",
      artifacts: { operationsDraft: true },
    })
    expect(registered.stage).toBe("图操作需修订")
    const validation = JSON.parse(await fs.readFile(path.join(activeDir, "validation.json"), "utf8"))
    expect(validation.passed).toBe(false)
    expect(validation.issues.map((issue: { message: string }) => issue.message).join("\n")).toContain("operations.draft.json")
  })

  test("unified graph validation rejects compiled operations that creates edges for attribute relationships", async () => {
    await action("开始或恢复")
    await action("更新工作笔记", {
      content: "完成了一次试探性验证，准备更新已有目标和工作项。\n",
      summary: "人工写入一份用于生成图操作草案的工作笔记。",
    })
    const activeDir = path.join(directory, "workflows", "active")
    await fs.writeFile(path.join(activeDir, "operations.draft.json"), JSON.stringify({
      change_id: "bad_attribute_edge",
      timestamp: "2026-07-05T10:00:00+08:00",
      note_filename: "attribute_relation_validation_note.md",
      changelog_entry: "[2026-07-05 10:00] bad_attribute_edge: 测试属性关系错误建边草案(bad_attribute_edge)。",
      items: [
        {
          kind: "create_node",
          temp_id: "work_block_bad_attribute_edge",
          node_type: "work_block",
          summary: "错误属性关系工作块",
          fields: {
            linked_goal_id: "goal_knowledge_organization",
          },
        },
        {
          kind: "create_node",
          temp_id: "work_item_bad_attribute_edge",
          node_type: "work_item",
          summary: "错误属性关系工作项",
          fields: {
            linked_work_block_id: "work_block_knowledge_organization",
          },
        },
        {
          kind: "create_edge",
          temp_id: "edge_bad_block_to_work_item",
          from_node: "work_block_bad_attribute_edge",
          to_node: "work_item_bad_attribute_edge",
          edge_type: "next",
          description: "错误地把工作块到工作项关系建成边。",
        },
      ],
    }, null, 2) + "\n", "utf8")

    const registered = await action("生成图操作草案", {
      summary: "登记属性关系建边图操作。",
      change_id: "bad_attribute_edge",
      artifacts: { operationsDraft: true },
    })
    expect(registered.stage).toBe("图操作需修订")
    const validation = JSON.parse(await fs.readFile(path.join(activeDir, "validation.json"), "utf8"))
    expect(validation.passed).toBe(false)
    expect(validation.issues.map((issue: { message: string }) => issue.message).join("\n")).toContain("属性关系")
    expect(JSON.stringify(registered.data?.validation)).toContain("属性关系")
  })

  test("automatic validation rejects result-to-issue with goal-only edge type", async () => {
    await replayStepsBefore(17)
    await action("开始或恢复")
    await action("更新工作笔记", {
      content: await readOriginalNote("distinction_sort.txt"),
      summary: "使用 step17 对应原始工作笔记生成工作笔记。",
    })
    const activeDir = path.join(directory, "workflows", "active")
    await fs.writeFile(path.join(activeDir, "operations.draft.json"), JSON.stringify({
      change_id: "bad_result_issue_edge",
      timestamp: "2026-07-05T10:00:00+08:00",
      note_filename: "result_issue_relation_note.md",
      changelog_entry: "[2026-07-05 10:00] bad_result_issue_edge: 测试 result 到 issue 的错误边类型(bad_result_issue_edge)。",
      items: [
        {
          kind: "create_node",
          temp_id: "result_bad_issue_relation",
          node_type: "result",
          summary: "错误影响问题的结果",
          description: "用于验证 result -> issue 不能使用 adjusts_result。",
          history: "创建用于验证错误边类型的结果节点。",
        },
        {
          kind: "create_edge",
          temp_id: "edge_existing_work_item_creates_bad_result",
          from_node: "work_item_daily_metric_monitoring",
          to_node: "result_bad_issue_relation",
          edge_type: "creates",
          description: "已有工作项产生该结果，避免结果归属校验掩盖 result->issue 边类型错误。",
          history: "建立已有工作项到测试结果的 creates 关系。",
        },
        {
          kind: "create_edge",
          temp_id: "edge_bad_result_issue_relation",
          from_node: "result_bad_issue_relation",
          to_node: "issue_labeling_quality",
          edge_type: "adjusts_result",
          description: "错误地用目标关系边描述结果影响问题。",
          history: "错误建立 result 到 issue 的 adjusts_result 关系。",
        },
      ],
    }, null, 2) + "\n", "utf8")

    const registered = await action("生成图操作草案", {
      summary: "登记错误 result->issue 边类型草案。",
      change_id: "bad_result_issue_edge",
      artifacts: { operationsDraft: true },
    })
    expect(registered.stage).toBe("图操作需修订")
    const validation = JSON.parse(await fs.readFile(path.join(activeDir, "validation.json"), "utf8"))
    expect(validation.passed).toBe(false)
    expect(validation.issues.map((issue: { message: string }) => issue.message).join("\n")).toContain("result -> issue 不应使用 adjusts_result")
    expect(validation.issues.map((issue: { message: string }) => issue.message).join("\n")).toContain("affects_issue")
  })

  test("automatic validation rejects event adjusts newly created goal", async () => {
    await action("开始或恢复")
    await action("更新工作笔记", {
      content: "6 月 1 日，客户原成熟产品路线受阻，自研 agent 框架提前成为短期主路径，需要快速形成粗版架构方案。\n",
      summary: "使用首轮项目初始化材料生成工作笔记。",
    })
    const activeDir = path.join(directory, "workflows", "active")
    await fs.writeFile(path.join(activeDir, "operations.draft.json"), JSON.stringify({
      change_id: "bad_event_adjusts_new_goal",
      timestamp: "2026-06-01T10:00:00+08:00",
      note_filename: "agent_framework_acceleration.md",
      changelog_entry: "[2026-06-01 10:00] bad_event_adjusts_new_goal: 测试首轮图操作中 event 不应 adjusts 本轮新建 goal。",
      items: [
        {
          kind: "create_node",
          temp_id: "goal_phone_app_agent_framework",
          node_type: "goal",
          summary: "建设手机端智能助手自研 agent 框架",
          description: "客户成熟产品路线受阻后，自研 agent 框架提前成为短期主路径。",
          fields: { status: "active" },
          history: "创建手机端智能助手自研 agent 框架目标。",
        },
        {
          kind: "create_node",
          temp_id: "event_mature_product_skill_gap",
          node_type: "event",
          summary: "成熟产品无法满足 skill 等硬性需求",
          description: "成熟产品无法满足 skill 等硬性需求且供应商不愿定制。",
          history: "创建成熟产品路线受阻事件。",
        },
        {
          kind: "create_edge",
          temp_id: "edge_event_adjusts_new_goal",
          from_node: "event_mature_product_skill_gap",
          to_node: "goal_phone_app_agent_framework",
          edge_type: "adjusts",
          description: "错误地把新目标识别写成已有目标被调整。",
          history: "错误建立 event 到本轮新建 goal 的 adjusts 关系。",
        },
      ],
    }, null, 2) + "\n", "utf8")

    const registered = await action("生成图操作草案", {
      summary: "登记错误 event->adjusts->new goal 草案。",
      change_id: "bad_event_adjusts_new_goal",
      artifacts: { operationsDraft: true },
    })
    expect(registered.stage).toBe("图操作需修订")
    const validation = JSON.parse(await fs.readFile(path.join(activeDir, "validation.json"), "utf8"))
    expect(validation.passed).toBe(false)
    const messages = validation.issues.map((issue: { message: string }) => issue.message).join("\n")
    expect(messages).toContain("adjusts 表示调整、取消、影响或修改已有对象")
    expect(messages).toContain("goal_phone_app_agent_framework 是本轮新建")
  })

  test("automatic validation rejects node statuses outside type whitelist from compressed draft", async () => {
    await action("开始或恢复")
    await action("更新工作笔记", {
      content: "2026-07-05，客户提出需要制定手机端智能助手粗版架构方案，但该工作尚未实际启动。\n",
      summary: "使用非法状态草案测试自动校验。",
    })
    const activeDir = path.join(directory, "workflows", "active")
    await fs.writeFile(path.join(activeDir, "operations.draft.json"), JSON.stringify({
      change_id: "bad_node_statuses",
      timestamp: "2026-07-05T10:00:00+08:00",
      note_filename: "architecture_status_validation.md",
      changelog_entry: "[2026-07-05 10:00] bad_node_statuses: 测试节点状态必须符合类型白名单。",
      items: [
        {
          kind: "create_node",
          temp_id: "goal_mobile_assistant_architecture",
          node_type: "goal",
          summary: "形成手机端智能助手粗版架构",
          description: "需要形成手机端智能助手粗版架构。",
          fields: { status: "established" },
          history: "创建手机端智能助手粗版架构目标。",
        },
        {
          kind: "create_node",
          temp_id: "work_block_architecture",
          node_type: "work_block",
          summary: "架构方案工作块",
          description: "围绕粗版架构方案开展工作。",
          fields: { status: "active", linked_goal_id: "goal_mobile_assistant_architecture" },
          history: "创建架构方案工作块。",
        },
        {
          kind: "create_node",
          temp_id: "work_item_architecture_plan",
          node_type: "work_item",
          summary: "制定粗版架构方案",
          description: "客户提出需要制定粗版架构方案，但尚未实际启动。",
          fields: { status: "active", linked_work_block_id: "work_block_architecture" },
          history: "错误地把尚未启动的工作项写成 active。",
        },
        {
          kind: "create_node",
          temp_id: "event_customer_architecture_request",
          node_type: "event",
          summary: "客户要求制定粗版架构方案",
          description: "客户提出需要制定手机端智能助手粗版架构方案。",
          fields: { status: "occurred" },
          history: "创建客户要求事件。",
        },
        {
          kind: "create_node",
          temp_id: "issue_architecture_scope",
          node_type: "issue",
          summary: "架构范围尚未收敛",
          description: "粗版架构范围和边界尚未收敛。",
          fields: { status: "open" },
          history: "错误地把 issue 状态写成 open。",
        },
        {
          kind: "create_node",
          temp_id: "result_architecture_draft",
          node_type: "result",
          summary: "粗版架构草稿",
          description: "测试非法 result 状态。",
          fields: { status: "draft" },
          history: "错误地把 result 状态写成 draft。",
        },
        {
          kind: "create_edge",
          temp_id: "edge_event_triggers_issue",
          from_node: "event_customer_architecture_request",
          to_node: "issue_architecture_scope",
          edge_type: "triggers",
          description: "客户要求触发架构范围需澄清的问题。",
          history: "建立客户要求到架构范围问题的触发关系。",
        },
        {
          kind: "create_edge",
          temp_id: "edge_issue_generates_goal",
          from_node: "issue_architecture_scope",
          to_node: "goal_mobile_assistant_architecture",
          edge_type: "generates_goal",
          description: "架构范围问题促成形成粗版架构目标。",
          history: "建立问题到目标的促成关系。",
        },
      ],
    }, null, 2) + "\n", "utf8")

    const registered = await action("生成图操作草案", {
      summary: "登记非法节点状态草案。",
      change_id: "bad_node_statuses",
      artifacts: { operationsDraft: true },
    })
    expect(registered.stage).toBe("图操作需修订")
    const validation = JSON.parse(await fs.readFile(path.join(activeDir, "validation.json"), "utf8"))
    expect(validation.passed).toBe(false)
    const messages = validation.issues.map((issue: { message: string }) => issue.message).join("\n")
    expect(messages).toContain("work_item.status 不应使用 active")
    expect(messages).toContain("issue.status 不应使用 open")
    expect(messages).toContain("result.status 不应使用 draft")
  })

  test("compressed draft rejects node fields outside each node type schema", async () => {
    await action("开始或恢复")
    await action("更新工作笔记", {
      content: "2026-07-05，客户提出需要制定手机端智能助手粗版架构方案，但该工作尚未实际启动。\n",
      summary: "使用错误字段草案测试自动校验。",
    })
    const activeDir = path.join(directory, "workflows", "active")
    await fs.writeFile(path.join(activeDir, "operations.draft.json"), JSON.stringify({
      change_id: "bad_node_fields",
      timestamp: "2026-07-05T10:00:00+08:00",
      note_filename: "architecture_field_validation.md",
      changelog_entry: "[2026-07-05 10:00] bad_node_fields: 测试节点字段必须符合类型白名单。",
      items: [
        {
          kind: "create_node",
          temp_id: "goal_mobile_assistant_architecture",
          node_type: "goal",
          summary: "形成手机端智能助手粗版架构",
          description: "需要形成手机端智能助手粗版架构。",
          fields: { status: "established", completion: 0 },
          history: "错误地把 goal 完成度写成 completion。",
        },
        {
          kind: "create_node",
          temp_id: "work_block_architecture",
          node_type: "work_block",
          summary: "架构方案工作块",
          description: "围绕粗版架构方案开展工作。",
          fields: { status: "active", linked_goal_id: "goal_mobile_assistant_architecture", priority: "high" },
          history: "错误地给 work_block 写入 schema 外 priority。",
        },
        {
          kind: "create_node",
          temp_id: "work_item_architecture_plan",
          node_type: "work_item",
          summary: "制定粗版架构方案",
          description: "客户提出需要制定粗版架构方案，但尚未实际启动。",
          fields: { status: "planned", linked_work_block_id: "work_block_architecture", linked_goal_id: "goal_mobile_assistant_architecture" },
          history: "错误地给 work_item 写入 linked_goal_id。",
        },
      ],
    }, null, 2) + "\n", "utf8")

    const registered = await action("生成图操作草案", {
      summary: "登记错误节点字段草案。",
      change_id: "bad_node_fields",
      artifacts: { operationsDraft: true },
    })
    expect(registered.stage).toBe("图操作需修订")
    const validation = JSON.parse(await fs.readFile(path.join(activeDir, "validation.json"), "utf8"))
    expect(validation.passed).toBe(false)
    const messages = validation.issues.map((issue: { message: string }) => issue.message).join("\n")
    expect(messages).toContain("goal.completion 不是合法 draft 字段")
    expect(messages).toContain("work_block.priority 不是合法 draft 字段")
    expect(messages).toContain("work_item.linked_goal_id 不是合法 draft 字段")
    expect(messages).toContain("completion_score")
    expect(messages).toContain("linked_work_block_id")
  })

  test("automatic validation rejects issue adjusts newly created goal", async () => {
    await action("开始或恢复")
    await action("更新工作笔记", {
      content: "发现压缩交付窗口问题，因此需要设立手机端智能助手 demo 与上线目标。\n",
      summary: "使用问题和新目标材料生成工作笔记。",
    })
    const activeDir = path.join(directory, "workflows", "active")
    await fs.writeFile(path.join(activeDir, "operations.draft.json"), JSON.stringify({
      change_id: "bad_issue_adjusts_new_goal",
      timestamp: "2026-07-05T10:00:00+08:00",
      note_filename: "issue_adjusts_new_goal.md",
      changelog_entry: "[2026-07-05 10:00] bad_issue_adjusts_new_goal: 测试 issue 不应 adjusts 本轮新建 goal。",
      items: [
        {
          kind: "create_node",
          temp_id: "issue_compressed_delivery_window",
          node_type: "issue",
          summary: "压缩交付窗口下 demo 边界未收敛",
          description: "当前交付窗口被压缩，需要澄清 demo 范围、集成边界和上线责任。",
          history: "创建压缩交付窗口问题。",
        },
        {
          kind: "create_node",
          temp_id: "goal_mobile_agent_demo_launch",
          node_type: "goal",
          summary: "手机端智能助手 demo 与上线",
          description: "为应对交付窗口压缩，设立手机端智能助手 demo 与上线目标。",
          history: "创建手机端智能助手 demo 与上线目标。",
        },
        {
          kind: "create_edge",
          temp_id: "edge_bad_issue_adjusts_new_goal",
          from_node: "issue_compressed_delivery_window",
          to_node: "goal_mobile_agent_demo_launch",
          edge_type: "adjusts_goal",
          description: "错误地把新目标设立写成已有目标被问题调整。",
          history: "错误建立 issue 到本轮新建 goal 的 adjusts_goal 关系。",
        },
      ],
    }, null, 2) + "\n", "utf8")

    const registered = await action("生成图操作草案", {
      summary: "登记错误 issue->adjusts_goal->new goal 草案。",
      change_id: "bad_issue_adjusts_new_goal",
      artifacts: { operationsDraft: true },
    })
    expect(registered.stage).toBe("图操作需修订")
    const validation = JSON.parse(await fs.readFile(path.join(activeDir, "validation.json"), "utf8"))
    expect(validation.passed).toBe(false)
    const messages = validation.issues.map((issue: { message: string }) => issue.message).join("\n")
    expect(messages).toContain("adjusts_goal 表示调整、取消、影响或修改已有对象")
    expect(messages).toContain("goal_mobile_agent_demo_launch 是本轮新建")
  })

  test("automatic validation rejects result adjusts newly created goal", async () => {
    await action("开始或恢复")
    await action("更新工作笔记", {
      content: "形成自研方案替代定位，因此需要设立手机端智能助手 demo 与上线目标。\n",
      summary: "使用结果和新目标材料生成工作笔记。",
    })
    const activeDir = path.join(directory, "workflows", "active")
    await fs.writeFile(path.join(activeDir, "operations.draft.json"), JSON.stringify({
      change_id: "bad_result_adjusts_new_goal",
      timestamp: "2026-07-05T10:00:00+08:00",
      note_filename: "result_adjusts_new_goal.md",
      changelog_entry: "[2026-07-05 10:00] bad_result_adjusts_new_goal: 测试 result 不应 adjusts 本轮新建 goal。",
      items: [
        {
          kind: "create_node",
          temp_id: "result_self_developed_positioning",
          node_type: "result",
          summary: "自研方案定位为短期替代方案",
          description: "本轮形成自研 agent 框架需要承担短期替代角色的阶段结论。",
          history: "创建自研方案定位结果。",
        },
        {
          kind: "create_node",
          temp_id: "goal_mobile_agent_demo_launch",
          node_type: "goal",
          summary: "手机端智能助手 demo 与上线",
          description: "基于自研方案替代定位，设立手机端智能助手 demo 与上线目标。",
          history: "创建手机端智能助手 demo 与上线目标。",
        },
        {
          kind: "create_edge",
          temp_id: "edge_bad_result_adjusts_new_goal",
          from_node: "result_self_developed_positioning",
          to_node: "goal_mobile_agent_demo_launch",
          edge_type: "adjusts_result",
          description: "错误地把新目标设立写成已有目标被结果调整。",
          history: "错误建立 result 到本轮新建 goal 的 adjusts_result 关系。",
        },
      ],
    }, null, 2) + "\n", "utf8")

    const registered = await action("生成图操作草案", {
      summary: "登记错误 result->adjusts_result->new goal 草案。",
      change_id: "bad_result_adjusts_new_goal",
      artifacts: { operationsDraft: true },
    })
    expect(registered.stage).toBe("图操作需修订")
    const validation = JSON.parse(await fs.readFile(path.join(activeDir, "validation.json"), "utf8"))
    expect(validation.passed).toBe(false)
    const messages = validation.issues.map((issue: { message: string }) => issue.message).join("\n")
    expect(messages).toContain("adjusts_result 表示调整、取消、影响或修改已有对象")
    expect(messages).toContain("goal_mobile_agent_demo_launch 是本轮新建")
  })

  test("automatic validation rejects issue-to-goal with event-only generates edge type", async () => {
    await action("开始或恢复")
    await action("更新工作笔记", {
      content: "发现缺乏精准评测数据的问题，因此需要设立构建评测数据集目标。\n",
      summary: "使用问题促成目标的材料生成工作笔记。",
    })
    const activeDir = path.join(directory, "workflows", "active")
    await fs.writeFile(path.join(activeDir, "operations.draft.json"), JSON.stringify({
      change_id: "bad_issue_goal_generates",
      timestamp: "2026-07-05T10:00:00+08:00",
      note_filename: "issue_goal_validation.md",
      changelog_entry: "[2026-07-05 10:00] bad_issue_goal_generates: 测试 issue -> goal 不应使用 event 专用 generates。",
      items: [
        {
          kind: "create_node",
          temp_id: "issue_missing_eval_dataset",
          node_type: "issue",
          summary: "缺乏精准评测数据",
          description: "当前缺乏精准评测数据，影响模型效果判断。",
          history: "创建缺乏精准评测数据问题。",
        },
        {
          kind: "create_node",
          temp_id: "goal_build_eval_dataset",
          node_type: "goal",
          summary: "构建精准评测数据集",
          description: "为解决缺乏精准评测数据的问题，设立构建评测数据集目标。",
          history: "创建构建精准评测数据集目标。",
        },
        {
          kind: "create_edge",
          temp_id: "edge_bad_issue_generates_goal",
          from_node: "issue_missing_eval_dataset",
          to_node: "goal_build_eval_dataset",
          edge_type: "generates",
          description: "错误地使用 event -> goal 的 generates 描述 issue 促成 goal。",
          history: "错误建立 issue 到 goal 的 generates 关系。",
        },
      ],
    }, null, 2) + "\n", "utf8")

    const registered = await action("生成图操作草案", {
      summary: "登记错误 issue->generates->goal 草案。",
      change_id: "bad_issue_goal_generates",
      artifacts: { operationsDraft: true },
    })
    expect(registered.stage).toBe("图操作需修订")
    const validation = JSON.parse(await fs.readFile(path.join(activeDir, "validation.json"), "utf8"))
    expect(validation.passed).toBe(false)
    const messages = validation.issues.map((issue: { message: string }) => issue.message).join("\n")
    expect(messages).toContain("issue -> goal 不应使用 generates")
    expect(messages).toContain("generates_goal")
  })

  test("automatic validation rejects redundant event-to-work leads under generated goal", async () => {
    await action("开始或恢复")
    await action("更新工作笔记", {
      content: "2026-07-05，客户提出需要制定手机端智能助手粗版架构方案，因此形成 demo 与上线目标，并计划先制定粗版架构方案。\n",
      summary: "使用事件生成目标并派生工作项的材料生成工作笔记。",
    })
    const activeDir = path.join(directory, "workflows", "active")
    await fs.writeFile(path.join(activeDir, "operations.draft.json"), JSON.stringify({
      change_id: "bad_redundant_event_work_leads",
      timestamp: "2026-07-05T10:00:00+08:00",
      note_filename: "event_goal_work_validation.md",
      changelog_entry: "[2026-07-05 10:00] bad_redundant_event_work_leads: 测试 event 生成目标后不应重复直连该目标下工作项。",
      items: [
        {
          kind: "create_node",
          temp_id: "event_customer_architecture_request",
          node_type: "event",
          summary: "客户要求制定粗版架构方案",
          description: "客户提出需要制定手机端智能助手粗版架构方案。",
          history: "创建客户要求事件。",
        },
        {
          kind: "create_node",
          temp_id: "goal_mobile_agent_demo_launch",
          node_type: "goal",
          summary: "手机端智能助手 demo 与上线",
          description: "客户要求促成手机端智能助手 demo 与上线目标。",
          history: "创建手机端智能助手 demo 与上线目标。",
        },
        {
          kind: "create_node",
          temp_id: "work_block_architecture",
          node_type: "work_block",
          summary: "架构方案工作块",
          description: "围绕粗版架构方案开展工作。",
          fields: { linked_goal_id: "goal_mobile_agent_demo_launch" },
          history: "创建架构方案工作块。",
        },
        {
          kind: "create_node",
          temp_id: "work_item_rough_architecture_plan",
          node_type: "work_item",
          summary: "制定粗版架构方案",
          description: "计划制定手机端智能助手粗版架构方案。",
          fields: { status: "planned", linked_work_block_id: "work_block_architecture" },
          history: "创建粗版架构方案计划工作项。",
        },
        {
          kind: "create_edge",
          temp_id: "edge_event_generates_goal",
          from_node: "event_customer_architecture_request",
          to_node: "goal_mobile_agent_demo_launch",
          edge_type: "generates",
          description: "客户要求促成 demo 与上线目标。",
          history: "建立客户要求到目标的生成关系。",
        },
        {
          kind: "create_edge",
          temp_id: "edge_event_leads_to_work_item",
          from_node: "event_customer_architecture_request",
          to_node: "work_item_rough_architecture_plan",
          edge_type: "leads_to",
          description: "错误地在事件生成目标后又直接连到该目标下的工作项。",
          history: "错误建立事件到派生工作项的重复直连关系。",
        },
      ],
    }, null, 2) + "\n", "utf8")

    const registered = await action("生成图操作草案", {
      summary: "登记冗余 event->work_item 草案。",
      change_id: "bad_redundant_event_work_leads",
      artifacts: { operationsDraft: true },
    })
    expect(registered.stage).toBe("图操作需修订")
    const validation = JSON.parse(await fs.readFile(path.join(activeDir, "validation.json"), "utf8"))
    expect(validation.passed).toBe(false)
    const messages = validation.issues.map((issue: { message: string }) => issue.message).join("\n")
    expect(messages).toContain("已经通过 generates 产生目标 goal_mobile_agent_demo_launch")
    expect(messages).toContain("不要再创建 event -> work_item 的 leads_to")
  })

  test("compressed draft schema rejects top-level history_descriptions array", async () => {
    await action("开始或恢复")
    await action("更新工作笔记", {
      content: "完成了一次试探性验证，准备更新已有目标和工作项。\n",
      summary: "人工写入一份用于生成图操作草案的工作笔记。",
    })
    const activeDir = path.join(directory, "workflows", "active")
    await fs.writeFile(path.join(activeDir, "operations.draft.json"), JSON.stringify({
      change_id: "bad_history_descriptions_array",
      timestamp: "2026-07-05T10:00:00+08:00",
      note_filename: "history_field_validation_note.md",
      changelog_entry: "[2026-07-05 10:00] bad_history_descriptions_array: 测试顶层 history_descriptions 错误(bad_history_descriptions_array)。",
      items: [],
      history_descriptions: ["错误地把历史说明写成顶层数组"],
    }, null, 2) + "\n", "utf8")

    const registered = await action("生成图操作草案", {
      summary: "登记错误 history_descriptions 结构草案。",
      change_id: "bad_history_descriptions_array",
      artifacts: { operationsDraft: true },
    })
    expect(registered.stage).toBe("图操作需修订")
    const validation = JSON.parse(await fs.readFile(path.join(activeDir, "validation.json"), "utf8"))
    expect(validation.passed).toBe(false)
    const messages = validation.issues.map((issue: { message: string }) => issue.message).join("\n")
    expect(messages).toContain("history_descriptions")
    expect(messages).toContain("压缩 draft 顶层不允许写")
  })

  test("compressed draft schema rejects top-level description", async () => {
    await action("开始或恢复")
    await action("更新工作笔记", {
      content: "准备登记一版首轮建图草案。\n",
      summary: "人工写入一份用于生成图操作草案的工作笔记。",
    })
    const activeDir = path.join(directory, "workflows", "active")
    await fs.writeFile(path.join(activeDir, "operation_notes.md"), "# 图操作说明\n\n说明应写在这里。\n", "utf8")
    await fs.writeFile(path.join(activeDir, "operations.draft.json"), JSON.stringify({
      change_id: "bad_top_level_description",
      timestamp: "2026-07-05T10:00:00+08:00",
      note_filename: "top_level_description_validation.md",
      description: "错误地把自然语言说明写进 draft 顶层。",
      changelog_entry: "[2026-07-05 10:00] bad_top_level_description: 测试顶层 description 错误。",
      items: [],
    }, null, 2) + "\n", "utf8")

    const registered = await action("生成图操作草案", {
      summary: "登记错误 description 结构草案。",
      change_id: "bad_top_level_description",
      artifacts: { operationNotes: true, operationsDraft: true },
    })
    expect(registered.stage).toBe("图操作需修订")
    const validation = JSON.parse(await fs.readFile(path.join(activeDir, "validation.json"), "utf8"))
    expect(validation.passed).toBe(false)
    const messages = validation.issues.map((issue: { message: string }) => issue.message).join("\n")
    expect(messages).toContain("description")
    expect(messages).toContain("自然语言说明写入 operation_notes.md")
  })

  test("compiled history does not duplicate deterministic contexts already covered by node ids", async () => {
    await action("开始或恢复")
    await action("更新工作笔记", {
      content: "2026-07-05，客户要求快速建立项目主线并规划第一项工作。\n",
      summary: "使用首轮建图材料生成工作笔记。",
    })
    const activeDir = path.join(directory, "workflows", "active")
    await fs.writeFile(path.join(activeDir, "operation_notes.md"), "# 图操作说明\n\n测试 history 去重。\n", "utf8")
    await fs.writeFile(path.join(activeDir, "operations.draft.json"), JSON.stringify({
      change_id: "history_context_dedupe",
      timestamp: "2026-07-05T10:00:00+08:00",
      note_filename: "initial_project_plan.md",
      changelog_entry: "[2026-07-05 10:00] history_context_dedupe: 测试 history 上下文去重。",
      items: [
        {
          kind: "create_node",
          temp_id: "event_customer_request",
          node_type: "event",
          summary: "客户提出项目要求",
          description: "客户提出项目要求。",
          fields: { status: "occurred" },
          history: "[history_context_dedupe] 创建客户提出项目要求事件，并说明它产生项目主目标（目标节点id: goal_customer_project）。",
        },
        {
          kind: "create_node",
          temp_id: "goal_customer_project",
          node_type: "goal",
          summary: "完成客户项目目标",
          description: "完成客户项目目标。",
          fields: { status: "established" },
          history: "[history_context_dedupe] 创建客户项目目标，该目标由客户要求事件产生，并由启动工作块承接（事件节点id: event_customer_request；工作块节点id: work_block_startup）。",
        },
        {
          kind: "create_node",
          temp_id: "work_block_startup",
          node_type: "work_block",
          summary: "启动工作块",
          description: "承接项目启动工作。",
          fields: { status: "active", linked_goal_id: "goal_customer_project" },
          history: "[history_context_dedupe] 创建启动工作块，归属于客户项目目标（目标节点id: goal_customer_project）。",
        },
        {
          kind: "create_node",
          temp_id: "work_item_initial_plan",
          node_type: "work_item",
          summary: "制定初始计划",
          description: "计划制定初始方案。",
          fields: { status: "planned", linked_work_block_id: "work_block_startup" },
          history: "[history_context_dedupe] 创建制定初始计划工作项，归属于启动工作块（工作块节点id: work_block_startup）。",
        },
        {
          kind: "create_edge",
          temp_id: "edge_event_generates_goal",
          from_node: "event_customer_request",
          to_node: "goal_customer_project",
          edge_type: "generates",
          description: "客户要求产生项目目标。",
          history: "[history_context_dedupe] 创建客户要求事件到客户项目目标的 generates 关系（事件节点id: event_customer_request；目标节点id: goal_customer_project）。",
        },
      ],
    }, null, 2) + "\n", "utf8")

    const registered = await action("生成图操作草案", {
      summary: "登记 history 去重草案。",
      change_id: "history_context_dedupe",
      artifacts: { operationNotes: true, operationsDraft: true },
    })
    expect(registered.stage).toBe("图操作已生成")
    const command = JSON.parse(await fs.readFile(path.join(activeDir, "operations.json"), "utf8"))
    expect(command.history_descriptions.event_customer_request).not.toContain("事件通过generates关系连接")
    expect(command.history_descriptions.goal_customer_project).not.toContain("此目标被客户提出项目要求通过generates关系连接")
    expect(command.history_descriptions.work_block_startup).not.toContain("工作块服务于")
    expect(command.history_descriptions.work_item_initial_plan).not.toContain("工作项被启动工作块归属")
    expect(command.history_descriptions.edge_event_generates_goal).not.toContain("；建立客户提出项目要求到完成客户项目目标的generates关系")
  })

  test("compressed draft schema rejects derived reverse relationship lists", async () => {
    await action("开始或恢复")
    await action("更新工作笔记", {
      content: "完成了一次试探性验证，准备更新已有目标和工作项。\n",
      summary: "人工写入一份用于生成图操作草案的工作笔记。",
    })
    const activeDir = path.join(directory, "workflows", "active")
    await fs.writeFile(path.join(activeDir, "operations.draft.json"), JSON.stringify({
      change_id: "bad_reverse_lists",
      timestamp: "2026-07-05T10:00:00+08:00",
      note_filename: "reverse_relation_validation_note.md",
      changelog_entry: "[2026-07-05 10:00] bad_reverse_lists: 测试反向派生列表错误(bad_reverse_lists)。",
      items: [
        {
          kind: "create_node",
          temp_id: "work_block_bad_reverse",
          node_type: "work_block",
          summary: "错误反向列表工作块",
          fields: {
            linked_goal_id: "goal_knowledge_organization",
            work_items: ["work_item_later"],
          },
        },
        {
          kind: "update_node",
          node_id: "goal_knowledge_organization",
          field_updates: {
            linked_work_blocks: ["work_block_bad_reverse"],
          },
        },
      ],
    }, null, 2) + "\n", "utf8")

    const registered = await action("生成图操作草案", {
      summary: "登记错误反向关系列表草案。",
      change_id: "bad_reverse_lists",
      artifacts: { operationsDraft: true },
    })
    expect(registered.stage).toBe("图操作需修订")
    const validation = JSON.parse(await fs.readFile(path.join(activeDir, "validation.json"), "utf8"))
    expect(validation.passed).toBe(false)
    const messages = validation.issues.map((issue: { message: string }) => issue.message).join("\n")
    expect(messages).toContain("linked_work_blocks/work_items")
    expect(messages).toContain("反向")
  })

  test("state machine rejects full note content and expects note service to write note.md first", async () => {
    await stateAction("开始或恢复")

    await expect(stateAction("更新工作笔记", {
      content: "状态机不应该接收整篇工作笔记。",
      summary: "错误入口。",
    })).rejects.toThrow("不再由状态机接收整篇 note 内容")

    const activeDir = path.join(directory, "workflows", "active")
    await fs.writeFile(path.join(activeDir, "note.md"), "由 note service 写入的工作笔记。\n", "utf8")
    const synced = await stateAction("同步工作笔记变更", {
      summary: "note service 写入后同步状态。",
      source: "manual_edit",
    })
    expect(synced.stage).toBe("笔记已生成")
  })

  test("state machine registers validation only after validation service writes validation artifact", async () => {
    await replayStepsBefore(18)
    await stateAction("开始或恢复")
    const activeDir = path.join(directory, "workflows", "active")
    await fs.writeFile(path.join(activeDir, "note.md"), await readOriginalNote("knowledge_entry_point.txt"), "utf8")
    await stateAction("同步工作笔记变更", {
      summary: "state-only 写入工作笔记后同步状态。",
      source: "manual_edit",
    })
    await writeOperationDraft(await readStepCommand(18))
    await stateAction("生成图操作草案", {
      summary: "state-only 登记图操作。",
      change_id: "step18_knowledge_scheme",
      artifacts: { operationsDraft: true },
    })
    await expect(stateAction("校验图操作")).rejects.toThrow()

    const compiled = await ProjectWorkflowExecution.compileOperationDraft({ directory })
    expect(compiled.ok).toBe(true)
    const validation = await ProjectWorkflowExecution.validateOperations({ directory })
    expect(validation.passed).toBe(true)
    const registered = await stateAction("校验图操作", {
      passed: validation.passed,
      summary: "validation service 已写入校验结果。",
    })
    expect(registered.stage).toBe("图操作已生成")
  })

  test("state machine syncs note state without managing downstream artifact cleanup", async () => {
    await stateAction("开始或恢复")
    const activeDir = path.join(directory, "workflows", "active")
    await fs.writeFile(path.join(activeDir, "note.md"), "由外部写入的工作笔记。\n", "utf8")
    await fs.writeFile(path.join(activeDir, "operations.json"), "{}\n", "utf8")
    await fs.writeFile(path.join(activeDir, "validation.json"), "{}\n", "utf8")
    await fs.writeFile(path.join(activeDir, "preview.json"), "{}\n", "utf8")

    const synced = await stateAction("同步工作笔记变更", {
      summary: "只同步状态，不处理产物文件。",
      source: "manual_edit",
    })

    expect(synced.stage).toBe("笔记已生成")
    await expect(fs.stat(path.join(activeDir, "operations.json"))).resolves.toBeTruthy()
    await expect(fs.stat(path.join(activeDir, "validation.json"))).resolves.toBeTruthy()
    await expect(fs.stat(path.join(activeDir, "preview.json"))).resolves.toBeTruthy()
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
    await registerOperationDraft(await readStepCommand(18), "登记 step18 图操作和 changelog 草稿。", {
      changelogEntry: step18ChangelogEntry,
      noteFilename: "knowledge_entry_point.md",
    })

    const activeDir = path.join(directory, "workflows", "active")
    await expect(fs.stat(path.join(activeDir, "changelog_entry.txt"))).resolves.toBeTruthy()
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
    await expect(fs.stat(path.join(activeDir, "changelog_entry.txt"))).rejects.toThrow()
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
    await registerOperationDraft(await readStepCommand(18))

    const activeDir = path.join(directory, "workflows", "active")
    const notePath = path.join(activeDir, "note.md")
    await expect(fs.stat(path.join(activeDir, "changelog_entry.txt"))).resolves.toBeTruthy()
    const externallyEdited = `${await fs.readFile(notePath, "utf8")}\n补充：通过原版 edit 工具追加的事实。\n`
    await fs.writeFile(notePath, externallyEdited, "utf8")

    const synced = await action("同步工作笔记变更", {
      summary: "原版 edit 修改工作笔记后同步状态。",
      source: "llm_revision",
    })

    expect(synced.stage).toBe("笔记已生成")
    await expect(fs.readFile(notePath, "utf8")).resolves.toBe(externallyEdited)
    await expect(fs.stat(path.join(activeDir, "note_review.json"))).rejects.toThrow()
    await expect(fs.stat(path.join(activeDir, "changelog_entry.txt"))).rejects.toThrow()
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
    await registerOperationDraft(command)

    const activeDir = path.join(directory, "workflows", "active")
    await expect(fs.stat(path.join(activeDir, "changelog_entry.txt"))).resolves.toBeTruthy()
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
    await expect(fs.stat(path.join(activeDir, "changelog_entry.txt"))).rejects.toThrow()
    await expect(fs.stat(path.join(activeDir, "operations.json"))).rejects.toThrow()
    await expect(fs.stat(path.join(activeDir, "validation.json"))).rejects.toThrow()
    await expect(fs.stat(path.join(activeDir, "preview.json"))).rejects.toThrow()
  })

  test("blocks unsafe actions but allows flexible non-destructive actions", async () => {
    await action("开始或恢复")

    await expect(action("生成图操作草案", { artifacts: { operationsDraft: true } })).rejects.toThrow("尚未生成工作笔记")
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
    expect(started.blockedActions.find((item) => item.action === "应用图操作")?.reason).toContain("尚未生成可审核的图操作预览")

    await replayStepsBefore(18)
    await action("更新工作笔记", {
      content: await readOriginalNote("knowledge_entry_point.txt"),
      summary: "使用 step18 对应原始工作笔记。",
    })
    await registerOperationDraft(await readStepCommand(18))
    const generated = await action("校验图操作")
    const apply = generated.availableActions.find((item) => item.action === "应用图操作")
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

    expect(discarded.stage).toBeUndefined()
    expect(discarded.message).toContain("保留工作笔记")
    expect(discarded.state).toBeUndefined()
    expect(discarded.data).toMatchObject({ preservedNote: true })
    await expect(fs.readFile(path.join(activeDir, "note.md"), "utf8")).resolves.toBe("这是一份需要保留的工作笔记。\n")
    await expect(fs.stat(path.join(activeDir, "state.json"))).rejects.toThrow()
    await expect(fs.stat(path.join(activeDir, "messages.jsonl"))).rejects.toThrow()
    await expect(fs.stat(path.join(activeDir, "operations.json"))).rejects.toThrow()
    await expect(fs.stat(path.join(activeDir, "validation.json"))).rejects.toThrow()
    await expect(fs.stat(path.join(activeDir, "preview.json"))).rejects.toThrow()

    const restarted = await action("开始或恢复")
    expect(restarted.stage).toBe("笔记已生成")
    expect(restarted.data).toMatchObject({ restored: false, preservedNote: true })
    const stateRaw = await fs.readFile(path.join(activeDir, "state.json"), "utf8")
    expect(stateRaw).not.toContain("\"history\"")
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

  test("dedicated apply action applies graph data and archives the active workflow", async () => {
    await replayStepsBefore(18)
    await action("开始或恢复")
    await action("更新工作笔记", {
      content: await readOriginalNote("knowledge_entry_point.txt"),
      summary: "使用 step18 对应原始工作笔记。",
    })
    const command = await readStepCommand(18)
    await registerOperationDraft(command, "登记 step18 图操作和 changelog 草稿。", {
      changelogEntry: step18ChangelogEntry,
      noteFilename: "knowledge_entry_point.md",
    })

    const applied = await action("应用图操作", { confirm: true })

    expect(applied.stage).toBeUndefined()
    expect(applied.message).toContain("已应用")
    const archivePath = String(applied.data?.archivePath)
    expect(archivePath).toContain("workflows/applied/step18_knowledge_scheme")
    const archiveDir = path.join(directory, archivePath)
    await expect(fs.stat(path.join(archiveDir, "apply_result.json"))).resolves.toBeTruthy()
    await expect(fs.stat(path.join(archiveDir, "step.md"))).resolves.toBeTruthy()
    await expect(fs.stat(path.join(archiveDir, "operations.json"))).resolves.toBeTruthy()
    await expect(fs.stat(path.join(archiveDir, "apply_backup.building"))).rejects.toThrow()
    await expect(fs.stat(path.join(directory, "workflows", "active", "state.json"))).rejects.toThrow()

    const applyResult = JSON.parse(await fs.readFile(path.join(archiveDir, "apply_result.json"), "utf8"))
    expect(applyResult).toMatchObject({
      change_id: "step18_knowledge_scheme",
      success: true,
      snapshot: "step18_knowledge_scheme",
      operationsPath: `${archivePath}/operations.json`,
      archivePath,
      notePath: "notes/knowledge_entry_point.md",
    })
    const stepArtifact = await fs.readFile(path.join(archiveDir, "step.md"), "utf8")
    expect(stepArtifact).toContain(`- apply_result：${archivePath}/apply_result.json`)
    expect(stepArtifact).not.toContain("workflows/active/apply_result.json")
    await expect(fs.stat(path.join(directory, "snapshots", "step18_knowledge_scheme.json"))).resolves.toBeTruthy()
    const createdNode = command.operations.find((operation: any) => operation.type === "create_node")
    expect(createdNode).toBeTruthy()
    await expect(fs.stat(path.join(directory, "descriptions_output", "description_summary", `${createdNode.temp_id}.txt`))).resolves.toBeTruthy()
    await expect(fs.readFile(path.join(directory, "notes", "knowledge_entry_point.md"), "utf8")).resolves.toContain("知识梳理")
    const createdWorkItem = JSON.parse(await fs.readFile(path.join(directory, "nodes", "work_item", "work_item_knowledge_scheme_design.json"), "utf8"))
    expect(createdWorkItem.detail_url).toBe("notes/knowledge_entry_point.md")
    const archivedOperations = JSON.parse(await fs.readFile(path.join(archiveDir, "operations.json"), "utf8"))
    const archivedWorkItemOperation = archivedOperations.operations.find((operation: any) => operation.type === "create_node" && operation.temp_id === "work_item_knowledge_scheme_design")
    expect(archivedWorkItemOperation.data.detail_url).toBe("notes/knowledge_entry_point.md")
    const updatedNode = command.operations.find((operation: any) => operation.type === "update_node" && operation.node_id)
    expect(updatedNode).toBeTruthy()
    const summary = await fs.readFile(path.join(directory, "descriptions_output", "description_summary", `${updatedNode.node_id}.txt`), "utf8")
    expect(summary).not.toContain("历史记录：")
    const changelog = await fs.readFile(path.join(directory, "changes", "changelog.txt"), "utf8")
    expect(changelog).toContain("step18_knowledge_scheme")
    expect(changelog).toContain("语料分析失败后开展知识梳理方案设计并验证工作项")
    expect(changelog).toContain("产生知识梳理方案验证结果")
    expect(changelog).toContain("推动知识梳理目标")
    expect(changelog).not.toContain("图数据变化")
  })

  test("apply archives workflow note with semantic filename and avoids existing note collisions", async () => {
    await replayStepsBefore(18)
    await fs.mkdir(path.join(directory, "notes"), { recursive: true })
    await fs.writeFile(path.join(directory, "notes", "knowledge_entry_point.md"), "已有同名历史笔记。\n", "utf8")
    await action("开始或恢复")
    await action("更新工作笔记", {
      content: await readOriginalNote("knowledge_entry_point.txt"),
      summary: "使用 step18 对应原始工作笔记。",
    })
    await registerOperationDraft(await readStepCommand(18), "登记 step18 图操作和 changelog 草稿。", {
      changelogEntry: step18ChangelogEntry,
      noteFilename: "knowledge_entry_point.md",
    })

    const applied = await action("应用图操作", { confirm: true })

    const archivePath = String(applied.data?.archivePath)
    const archiveDir = path.join(directory, archivePath)
    const applyResult = JSON.parse(await fs.readFile(path.join(archiveDir, "apply_result.json"), "utf8"))
    expect(applyResult.notePath).toBe("notes/knowledge_entry_point_2.md")
    await expect(fs.readFile(path.join(directory, "notes", "knowledge_entry_point.md"), "utf8")).resolves.toContain("已有同名历史笔记")
    await expect(fs.readFile(path.join(directory, "notes", "knowledge_entry_point_2.md"), "utf8")).resolves.toContain("知识梳理")
    const createdWorkItem = JSON.parse(await fs.readFile(path.join(directory, "nodes", "work_item", "work_item_knowledge_scheme_design.json"), "utf8"))
    expect(createdWorkItem.detail_url).toBe("notes/knowledge_entry_point_2.md")
    const archivedOperations = JSON.parse(await fs.readFile(path.join(archiveDir, "operations.json"), "utf8"))
    const archivedWorkItemOperation = archivedOperations.operations.find((operation: any) => operation.type === "create_node" && operation.temp_id === "work_item_knowledge_scheme_design")
    expect(archivedWorkItemOperation.data.detail_url).toBe("notes/knowledge_entry_point_2.md")
  })

  test("failed apply restores formal graph data and keeps active workflow for revision", async () => {
    await replayStepsBefore(18)
    await action("开始或恢复")
    await action("更新工作笔记", {
      content: await readOriginalNote("knowledge_entry_point.txt"),
      summary: "使用 step18 对应原始工作笔记。",
    })
    await registerOperationDraft(await readStepCommand(18))
    const activeDir = path.join(directory, "workflows", "active")
    const beforeNodes = await fs.readdir(path.join(directory, "nodes", "work_item"))
    const brokenCommand = JSON.parse(await fs.readFile(path.join(activeDir, "operations.json"), "utf8"))
    const updateOperation = brokenCommand.operations.find((operation: any) => operation.type === "update_node")
    expect(updateOperation).toBeTruthy()
    updateOperation.node_id = "missing_node_for_apply_failure"
    brokenCommand.change_id = "broken_apply"
    brokenCommand.history_descriptions = {
      ...brokenCommand.history_descriptions,
      missing_node_for_apply_failure: "测试 apply 失败后的图数据回滚。",
    }
    await fs.writeFile(path.join(activeDir, "operations.json"), JSON.stringify(brokenCommand, null, 2) + "\n", "utf8")

    await expect(action("应用图操作", { confirm: true })).rejects.toThrow("节点 'missing_node_for_apply_failure' 在storage中不存在")

    const afterNodes = await fs.readdir(path.join(directory, "nodes", "work_item"))
    expect(afterNodes.sort()).toEqual(beforeNodes.sort())
    await expect(fs.stat(path.join(activeDir, "state.json"))).resolves.toBeTruthy()
    await expect(fs.stat(path.join(activeDir, "apply_result.json"))).rejects.toThrow()
    await expect(fs.stat(path.join(directory, "workflows", "applied", "broken_apply"))).rejects.toThrow()
  })

  test("apply requires model-authored changelog entry before mutating graph data", async () => {
    await replayStepsBefore(18)
    await action("开始或恢复")
    await action("更新工作笔记", {
      content: await readOriginalNote("knowledge_entry_point.txt"),
      summary: "使用 step18 对应原始工作笔记。",
    })
    await registerOperationDraft(await readStepCommand(18))
    await fs.rm(path.join(directory, "workflows", "active", "changelog_entry.txt"), { force: true })

    await expect(action("应用图操作", { confirm: true })).rejects.toThrow("缺少 workflows/active/changelog_entry.txt")
    await expect(fs.stat(path.join(directory, "workflows", "active", "state.json"))).resolves.toBeTruthy()
    const changelog = await fs.readFile(path.join(directory, "changes", "changelog.txt"), "utf8").catch(() => "")
    expect(changelog).not.toContain("step18_knowledge_scheme")
  })

  test("dedicated apply action is guarded before graph operation preview is generated", async () => {
    await action("开始或恢复")
    await expect(action("应用图操作", { confirm: true })).rejects.toThrow("尚未生成可审核的图操作预览")

    await replayStepsBefore(18)
    await action("更新工作笔记", {
      content: await readOriginalNote("knowledge_entry_point.txt"),
      summary: "使用 step18 对应原始工作笔记。",
    })
    await registerOperationDraft(await readStepCommand(18))

    await expect(action("应用图操作", { confirm: false })).rejects.toThrow("应用图操作需要 payload.confirm = true")
    await expect(stateAction("应用图操作", { confirm: true })).rejects.toThrow("必须由执行层完成正式写图")
  })
})
