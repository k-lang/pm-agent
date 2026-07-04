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

  test("does not allow chat to execute terminal UI-only actions", async () => {
    const tool = await WorkflowActionTool.init()

    await expect(tool.execute({
      project: "demo",
      action: "放弃草案",
      payload: {},
    }, context("project_workflow"))).rejects.toThrow("必须由工作推进页的专用确认按钮触发")

    await expect(tool.execute({
      project: "demo",
      action: "应用图操作",
      payload: { confirm: true },
    }, context("project_workflow"))).rejects.toThrow("必须由工作推进页的专用确认按钮触发")
  })

  test("does not allow chat to write full note content through workflow_action", async () => {
    const tool = await WorkflowActionTool.init()

    await expect(tool.execute({
      project: "demo",
      action: "更新工作笔记",
      payload: { content: "完整工作笔记内容" },
    }, context("project_workflow"))).rejects.toThrow("不能通过聊天工具执行")
  })
})
