import { describe, expect, test } from "bun:test"
import {
  allWorkflowDiffRecords,
  editToolRecords,
  isEditTool,
  markWorkflowPermissionRecord,
  mergeWorkflowPermissionRecords,
  permissionListUrl,
  permissionReplyUrl,
  renderResourceItem,
  renderWorkflowToolPart,
  rejectedEditToolRecords,
  resetWorkflowViewState,
  upsertWorkflowPermissionRecord,
  visibleWorkflowPermissionRecords,
} from "./project-workflow-view.js"

function permission(overrides = {}) {
  return {
    id: "per_1",
    sessionID: "ses_1",
    permission: "edit",
    patterns: ["workflows/active/note.md"],
    always: [],
    metadata: {
      filepath: "workflows/active/note.md",
      diff: "--- old\n+++ new\n@@\n-old\n+new\n",
    },
    tool: { messageID: "msg_1", callID: "call_1" },
    ...overrides,
  }
}

function completedEditMessage(overrides = {}) {
  return {
    info: { id: "msg_1", role: "assistant" },
    parts: [{
      type: "tool",
      tool: "edit",
      callID: "call_1",
      messageID: "msg_1",
      state: {
        status: "completed",
        title: "workflows/active/note.md",
        metadata: {
          filepath: "workflows/active/note.md",
          diff: "--- actual\n+++ actual\n@@\n-old\n+actual\n",
          filediff: { file: "workflows/active/note.md" },
        },
      },
      ...overrides,
    }],
  }
}

function completedWriteMessage() {
  return completedEditMessage({
    tool: "write",
    callID: "call_write",
    state: {
      status: "completed",
      title: "workflows/active/note.md",
      metadata: {
        filepath: "workflows/active/note.md",
        diff: "--- old\n+++ new\n@@\n+first note\n",
        filediff: { file: "workflows/active/note.md" },
      },
    },
  })
}

function completedApplyPatchMessage() {
  return completedEditMessage({
    tool: "apply_patch",
    callID: "call_patch",
    state: {
      status: "completed",
      title: "Patch applied",
      metadata: {
        filepath: "workflows/active/note.md",
        files: [{
          relativePath: "workflows/active/note.md",
          diff: "--- old\n+++ new\n@@\n-old\n+patched\n",
        }],
      },
    },
  })
}

describe("project workflow view helpers", () => {
  test("reset state clears stale workflow note preview data", () => {
    expect(resetWorkflowViewState()).toEqual({
      workflow: null,
      workflowNote: null,
      workflowMessages: [],
      workflowPermissions: [],
      workflowPermissionRecords: [],
      pendingUserText: "",
      activePermissionReviewID: "",
      workflowAwaitingReply: false,
    })
  })

  test("treats original write/edit/apply_patch tools as edit diff sources", () => {
    expect(isEditTool("write")).toBe(true)
    expect(isEditTool("edit")).toBe(true)
    expect(isEditTool("apply_patch")).toBe(true)
    expect(isEditTool("workflow_action")).toBe(false)
  })

  test("keeps rejected permission diff visible when the permission request captured a real diff", () => {
    const pending = upsertWorkflowPermissionRecord([], permission(), "pending")
    const rejected = markWorkflowPermissionRecord(pending, "per_1", "reject")

    expect(visibleWorkflowPermissionRecords(rejected, [])).toMatchObject([{
      id: "per_1",
      status: "rejected",
      diff: expect.stringContaining("+new"),
    }])
    expect(allWorkflowDiffRecords(rejected, [])).toMatchObject([{
      id: "per_1",
      status: "rejected",
    }])
  })

  test("does not expose rejected permission history when no captured diff exists", () => {
    const pending = upsertWorkflowPermissionRecord([], permission({
      metadata: {},
      patterns: ["workflows/active/note.md"],
    }), "pending")
    const rejected = markWorkflowPermissionRecord(pending, "per_1", "reject")

    expect(visibleWorkflowPermissionRecords(rejected, [])).toEqual([])
    expect(allWorkflowDiffRecords(rejected, [])).toEqual([])
  })

  test("uses completed edit tool metadata as executed diff history", () => {
    const messages = [completedEditMessage()]
    const records = editToolRecords(messages)

    expect(records).toMatchObject([{
      id: "tool:msg_1:call_1",
      status: "executed",
      file: "workflows/active/note.md",
      diff: expect.stringContaining("+actual"),
      title: "已修改工作笔记",
    }])
  })

  test("uses completed write and apply_patch metadata as executed diff history", () => {
    const records = editToolRecords([completedWriteMessage(), completedApplyPatchMessage()])

    expect(records).toMatchObject([
      { id: "tool:msg_1:call_write", title: "已修改工作笔记", diff: expect.stringContaining("first note") },
      { id: "tool:msg_1:call_patch", title: "已修改工作笔记", diff: expect.stringContaining("patched") },
    ])
  })

  test("hides approved permission entry when matching executed tool diff exists", () => {
    const pending = upsertWorkflowPermissionRecord([], permission(), "pending")
    const approved = markWorkflowPermissionRecord(pending, "per_1", "once")
    const messages = [completedEditMessage()]

    expect(visibleWorkflowPermissionRecords(approved, messages)).toEqual([])
    expect(allWorkflowDiffRecords(approved, messages)).toMatchObject([
      { id: "tool:msg_1:call_1", status: "executed" },
    ])
  })

  test("merges pending permissions without dropping handled records", () => {
    const handled = markWorkflowPermissionRecord(upsertWorkflowPermissionRecord([], permission(), "pending"), "per_1", "reject")
    const next = mergeWorkflowPermissionRecords(handled, [permission({ id: "per_2" })])

    expect(next.map((item) => [item.id, item.status])).toEqual([
      ["per_2", "pending"],
      ["per_1", "rejected"],
    ])
  })

  test("renders completed edit tool part with a diff button", () => {
    const part = completedEditMessage().parts[0]
    const html = renderWorkflowToolPart(part)

    expect(html).toContain("workflows/active/note.md · 已执行")
    expect(html).toContain("data-tool-diff-open=\"tool:msg_1:call_1\"")
    expect(html).toContain("查看 diff")
  })

  test("does not render a diff button for unrelated tools", () => {
    const html = renderWorkflowToolPart({
      type: "tool",
      tool: "workflow_action",
      state: { status: "completed", title: "状态机动作" },
    })

    expect(html).toContain("状态机动作 · completed")
    expect(html).not.toContain("data-tool-diff-open")
  })

  test("renders rejected edit tool errors with a diff button reconstructed from tool input", () => {
    const message = { info: { id: "msg_1" } }
    const part = {
      type: "tool",
      tool: "edit",
      callID: "call_1",
      state: {
        status: "error",
        input: { filePath: "workflows/active/note.md", oldString: "old", newString: "new" },
        error: "The user rejected permission to use this specific tool call.",
      },
    }
    const html = renderWorkflowToolPart(part, message)

    expect(html).toContain("edit · 用户已拒绝")
    expect(html).toContain("data-tool-diff-open=\"tool-rejected:msg_1:call_1\"")
    expect(rejectedEditToolRecords([{ ...message, parts: [part] }])).toMatchObject([{
      id: "tool-rejected:msg_1:call_1",
      status: "rejected",
      title: "已拒绝修改工作笔记",
      diff: expect.stringContaining("-old"),
    }])
  })

  test("reconstructs rejected write and apply_patch proposals from persisted tool input", () => {
    const message = {
      info: { id: "msg_rejected" },
      parts: [
        {
          type: "tool",
          tool: "write",
          callID: "call_write_rejected",
          state: {
            status: "error",
            input: { filePath: "workflows/active/note.md", content: "new note" },
            error: "The user rejected permission to use this specific tool call.",
          },
        },
        {
          type: "tool",
          tool: "apply_patch",
          callID: "call_patch_rejected",
          state: {
            status: "error",
            input: { patchText: "*** Begin Patch\n*** Update File: workflows/active/note.md\n@@\n-old\n+new\n*** End Patch" },
            error: "The user rejected permission to use this specific tool call.",
          },
        },
      ],
    }

    expect(rejectedEditToolRecords([message])).toMatchObject([
      {
        id: "tool-rejected:msg_rejected:call_write_rejected",
        title: "已拒绝修改工作笔记",
        diff: expect.stringContaining("+new note"),
      },
      {
        id: "tool-rejected:msg_rejected:call_patch_rejected",
        title: "已拒绝修改工作笔记",
        diff: expect.stringContaining("*** Begin Patch"),
      },
    ])
  })

  test("renders resource delete as an independent button inside a clickable row", () => {
    const html = renderResourceItem({
      path: "source/a.md",
      originalName: "a.md",
      name: "a.md",
    }, "source/a.md", "12 B / 可预览")

    expect(html).toContain('<div class="resource-item active" role="button" tabindex="0" data-path="source/a.md">')
    expect(html).toContain('<button type="button" class="resource-delete" data-path="source/a.md" title="删除资源">删除</button>')
    expect(html).not.toContain('<button type="button" class="resource-item')
  })

  test("builds permission URLs with project directory so replies hit the correct instance", () => {
    const project = { directory: "/tmp/project graph/demo" }

    expect(permissionListUrl(project)).toBe("/permission?directory=%2Ftmp%2Fproject%20graph%2Fdemo")
    expect(permissionReplyUrl("per/a b", project)).toBe("/permission/per%2Fa%20b/reply?directory=%2Ftmp%2Fproject%20graph%2Fdemo")
  })
})
