import { describe, expect, test } from "bun:test"
import { latestExplicitUserMessage, WorkflowActionTool, workflowActionResultForModel } from "./workflow-action"
import type { Tool } from "./tool"
import type { ProjectWorkflow } from "@/workflow/state"

function context(agent: string): Tool.Context {
  return {
    agent,
    sessionID: "ses_test" as any,
    messageID: "msg_test" as any,
    abort: new AbortController().signal,
    messages: [],
    metadata() {},
    async ask() {},
  }
}

describe("workflow_action tool", () => {
  test("is only executable by workflow primary agents", async () => {
    const tool = await WorkflowActionTool.init()

    await expect(tool.execute({
      project: "demo",
      action: "开始或恢复",
      payload: {},
    }, context("build"))).rejects.toThrow("workflow_action 只能由 project_workflow 或 project_workflow_correction agent 调用")

    await expect(tool.execute({
      project: "demo",
      action: "生成图操作草案",
      payload: { draft: {} },
    }, context("project_workflow_correction"))).rejects.toThrow("不能通过 workflow_action 传输草稿正文")
  })

  test("does not expose UI-only or internal actions in the chat tool schema", async () => {
    const tool = await WorkflowActionTool.init()
    const actionOptions = ((tool.parameters as any).shape.action.options || []) as string[]

    expect(actionOptions).not.toContain("放弃草案")
    expect(actionOptions).not.toContain("更新工作笔记")
    expect(actionOptions).not.toContain("生成预览")
    expect(actionOptions).not.toContain("应用图操作")
    expect(actionOptions).toContain("登记图操作复核")
    expect(actionOptions).toContain("确认沿用现有图操作")
  })

  test("rejects internal actions at schema validation", async () => {
    const tool = await WorkflowActionTool.init()

    expect(tool.parameters.safeParse({
      project: "demo",
      action: "更新工作笔记",
      payload: { content: "完整工作笔记内容" },
    }).success).toBe(false)
    expect(tool.parameters.safeParse({
      project: "demo",
      action: "生成预览",
      payload: {},
    }).success).toBe(false)
  })

  test("does not allow chat to send graph draft content through workflow_action", async () => {
    const tool = await WorkflowActionTool.init()

    await expect(tool.execute({
      project: "demo",
      action: "生成图操作草案",
      payload: {
        operation_notes: "很长的图操作说明正文",
        draft: { change_id: "demo", draft_operations: [] },
      },
    }, context("project_workflow"))).rejects.toThrow("不能通过 workflow_action 传输草稿正文")
  })

  test("requires a user message before chat can confirm operation reuse", async () => {
    const tool = await WorkflowActionTool.init()

    await expect(tool.execute({
      project: "demo",
      action: "确认沿用现有图操作",
      payload: { confirm: true },
    }, context("project_workflow"))).rejects.toThrow("用户明确同意消息")
  })

  test("does not treat synthetic note-update context as explicit reuse approval", () => {
    expect(latestExplicitUserMessage([
      {
        info: { id: "msg_older", role: "user" },
        parts: [{ type: "text", text: "生成上一版图操作" }],
      },
      {
        info: { id: "msg_synthetic", role: "user" },
        parts: [{ type: "text", text: "工作笔记已更新", synthetic: true }],
      },
    ] as any)).toBeUndefined()
    expect(String(latestExplicitUserMessage([{
      info: { id: "msg_explicit", role: "user", time: { created: 123 } },
      parts: [{ type: "text", text: "同意沿用现有图操作" }],
    }] as any)?.info.id)).toBe("msg_explicit")
  })

  test("redacts hard-correction internals from model-facing output", () => {
    const result = {
      ok: true,
      project: "demo",
      workflowID: "wf_demo",
      stage: "图操作已生成",
      availableActions: [
        { action: "放弃草案", reason: "放弃硬更正草案；只删除恢复出来的 active 现场，正式图数据不改变。" },
      ],
      blockedActions: [],
      recommendations: ["硬更正草案已恢复。"],
      state: {
        id: "wf_demo",
        project: "demo",
        stage: "图操作已生成",
        createdAt: 1,
        updatedAt: 2,
        artifacts: {
          messages: "messages.jsonl",
          resources: "resources.json",
          note: "note.md",
          noteReview: "note_review.json",
          operationNotes: "operation_notes.md",
          changelogEntry: "changelog_entry.txt",
          operationsDraft: "operations.draft.json",
          operations: "operations.json",
          operationIndex: "operation_index.json",
          operationBasis: "operation_basis.json",
          operationReview: "operation_review.json",
          operationReuseApproval: "operation_reuse_approval.json",
          validation: "validation.json",
          preview: "preview.json",
          previewGraph: "preview_graph",
        },
        hardCorrection: {
          ofChangeId: "step1_demo",
          sourceArchivePath: "workflows/applied/step1_demo",
          fixIndex: 1,
          expectedChangeId: "step1_demo_fix1",
          restoredAt: "2026-07-06T10:00:00.000Z",
        },
      },
      message: "当前阶段：图操作已生成。",
      data: {
        hardCorrection: { expectedChangeId: "step1_demo_fix1" },
        discardedHardCorrection: true,
      },
    } satisfies ProjectWorkflow.ActionResult

    const output = JSON.stringify(workflowActionResultForModel(result))
    expect(output).not.toContain("硬更正")
    expect(output).not.toContain("hard")
    expect(output).not.toContain("discardedHardCorrection")
    expect(output).not.toContain("hardCorrection")
    expect(output).toContain("当前草案")
  })
})
