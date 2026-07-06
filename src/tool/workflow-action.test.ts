import { describe, expect, test } from "bun:test"
import { WorkflowActionTool } from "./workflow-action"
import type { Tool } from "./tool"

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
  test("is only executable by the project_workflow agent", async () => {
    const tool = await WorkflowActionTool.init()

    await expect(tool.execute({
      project: "demo",
      action: "开始或恢复",
      payload: {},
    }, context("build"))).rejects.toThrow("workflow_action 只能由 project_workflow agent 调用")
  })

  test("does not expose UI-only or internal actions in the chat tool schema", async () => {
    const tool = await WorkflowActionTool.init()
    const actionOptions = ((tool.parameters as any).shape.action.options || []) as string[]

    expect(actionOptions).not.toContain("放弃草案")
    expect(actionOptions).not.toContain("更新工作笔记")
    expect(actionOptions).not.toContain("生成预览")
    expect(actionOptions).not.toContain("应用图操作")
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
})
