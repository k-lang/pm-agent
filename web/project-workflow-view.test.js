import { describe, expect, test } from "bun:test"
import {
  allWorkflowDiffRecords,
  archivedNoteProgressLabel,
  canShowWorkflowGraphPreview,
  effectiveWorkflowWarmupStatus,
  editToolRecords,
  isEditTool,
  isWriteTool,
  markWorkflowPermissionRecord,
  mergeWorkflowReadiness,
  mergeWorkflowPermissionRecords,
  permissionListUrl,
  permissionReplyUrl,
  renderResourceItem,
  renderUnifiedDiff,
  renderWorkflowReviewBody,
  renderWorkflowToolPart,
  renderWriteContent,
  rejectedEditToolRecords,
  resetWorkflowViewState,
  shouldClearWorkflowAwaitingReply,
  shouldDiscardWorkflowFromRestoreChoice,
  upsertWorkflowPermissionRecord,
  visibleWorkflowPermissionRecords,
  writeToolRecords,
  workflowMaximizeBodyClass,
  workflowMaximizeButtonState,
  workflowChatLockReason,
  workflowCorrectionKind,
  workflowLoadBlocksInteraction,
  workflowMessageErrorText,
  workflowOperationArtifactsChanged,
  workflowRuntimeIsRunning,
  workflowTerminalActionsBlocked,
  workflowViewRequestMatches,
} from "./project-workflow-view.js"

describe("project workflow chat readiness", () => {
  const project = { name: "demo" }

  test("allows first chat on an empty graph without an active workflow", () => {
    expect(workflowChatLockReason({ project, workflow: { baseIsEmpty: true, sessionReady: false }, state: undefined })).toBe("")
  })

  test("requires explicit session recovery for an existing empty-base active", () => {
    expect(workflowChatLockReason({
      project,
      workflow: { baseIsEmpty: true, sessionReady: false },
      state: { stage: "笔记已生成" },
    })).toContain("恢复推进会话")
  })

  test("locks a nonempty graph before warmup and while warmup is running", () => {
    expect(workflowChatLockReason({ project, workflow: { baseIsEmpty: false }, state: undefined })).toContain("先预热")
    expect(workflowChatLockReason({
      project,
      workflow: { baseIsEmpty: false, sessionReady: false },
      state: { warmupStatus: "running" },
    })).toContain("预热中")
  })

  test("unlocks a nonempty graph only when warmup and session are ready", () => {
    expect(workflowChatLockReason({
      project,
      workflow: { baseIsEmpty: false, sessionReady: true },
      state: { warmupStatus: "completed" },
    })).toBe("")
  })

  test("keeps computed readiness when note or operation payload refreshes workflow state", () => {
    const merged = mergeWorkflowReadiness(
      { baseIsEmpty: false, sessionReady: true, warmupStatus: "completed", state: { stage: "收集材料" } },
      { state: { stage: "图操作已生成", warmupStatus: "completed" } },
    )
    expect(merged).toMatchObject({
      baseIsEmpty: false,
      sessionReady: true,
      warmupStatus: "completed",
      state: { stage: "图操作已生成" },
    })
    expect(workflowChatLockReason({ project, workflow: merged, state: merged.state })).toBe("")
  })

  test("does not lock an already rendered workflow during a background refresh", () => {
    const workflow = { baseIsEmpty: true, sessionReady: true, state: { stage: "图操作已生成" } }
    expect(workflowLoadBlocksInteraction({ loading: true, workflow })).toBe(false)
    expect(workflowChatLockReason({ project, workflow, state: workflow.state, loading: true })).toBe("")
    expect(workflowLoadBlocksInteraction({ loading: true, workflow: null })).toBe(true)
  })

  test("uses live session status and local request state instead of persisted message residue", () => {
    expect(workflowRuntimeIsRunning({ sessionStatuses: [{ type: "busy" }] })).toBe(true)
    expect(workflowRuntimeIsRunning({ sessionStatuses: [{ type: "retry" }] })).toBe(true)
    expect(workflowRuntimeIsRunning({ warmupStatus: "running" })).toBe(true)
    expect(workflowRuntimeIsRunning({ chatSending: true })).toBe(true)
    expect(workflowRuntimeIsRunning({ awaitingReply: true })).toBe(true)
    expect(workflowRuntimeIsRunning({ statusAvailable: false, statusRequired: true })).toBe(true)
    expect(workflowRuntimeIsRunning({ statusAvailable: false, statusRequired: false })).toBe(false)
    expect(workflowRuntimeIsRunning({ sessionStatuses: [] })).toBe(false)
  })

  test("derives running warmup state from its live session after status is available", () => {
    expect(effectiveWorkflowWarmupStatus({
      persistedStatus: "running",
      statusAvailable: true,
      sessionStatus: { type: "busy" },
    })).toBe("running")
    expect(effectiveWorkflowWarmupStatus({
      persistedStatus: "running",
      statusAvailable: true,
    })).toBe("stale")
    expect(effectiveWorkflowWarmupStatus({
      persistedStatus: "running",
      statusAvailable: false,
    })).toBe("running")
    expect(effectiveWorkflowWarmupStatus({
      persistedStatus: "failed",
      statusAvailable: true,
      sessionStatus: { type: "busy" },
    })).toBe("failed")
  })

  test("keeps terminal actions blocked until an interrupted persisted warmup is replaced", () => {
    expect(workflowTerminalActionsBlocked({
      runtimeRunning: false,
      persistedWarmupStatus: "running",
    })).toBe(true)
    expect(workflowTerminalActionsBlocked({
      runtimeRunning: false,
      persistedWarmupStatus: "completed",
    })).toBe(false)
    expect(workflowTerminalActionsBlocked({
      runtimeRunning: true,
      persistedWarmupStatus: "completed",
    })).toBe(true)
  })

  test("keeps the optimistic reply lock through startup but releases it after authoritative idle", () => {
    expect(shouldClearWorkflowAwaitingReply({
      chatSending: true,
      sessionStatuses: [],
      hasUnansweredUser: true,
    })).toBe(false)
    expect(shouldClearWorkflowAwaitingReply({
      chatSending: false,
      sessionStatuses: [{ type: "busy" }],
      hasUnansweredUser: true,
    })).toBe(false)
    expect(shouldClearWorkflowAwaitingReply({
      chatSending: false,
      sessionStatuses: [],
      statusAvailable: false,
      hasUnansweredUser: true,
    })).toBe(false)
    expect(shouldClearWorkflowAwaitingReply({
      chatSending: false,
      sessionStatuses: [],
      statusAvailable: true,
      hasUnansweredUser: true,
    })).toBe(true)
    expect(shouldClearWorkflowAwaitingReply({
      chatSending: false,
      sessionStatuses: [{ type: "busy" }],
      hasUnansweredUser: false,
    })).toBe(true)
  })

  test("extracts provider errors from assistant message metadata", () => {
    expect(workflowMessageErrorText({
      name: "APIError",
      data: { message: "Unauthorized: Invalid API key", statusCode: 401 },
    })).toBe("Unauthorized: Invalid API key")
    expect(workflowMessageErrorText({ name: "AbortedError" })).toBe("AbortedError")
    expect(workflowMessageErrorText(undefined)).toBe("")
  })

  test("refreshes operation artifacts when a generated workflow changes", () => {
    expect(workflowOperationArtifactsChanged(
      { stage: "笔记已生成", updatedAt: 1 },
      { stage: "图操作已生成", updatedAt: 2 },
    )).toBe(true)
    expect(workflowOperationArtifactsChanged(
      { stage: "图操作已生成", updatedAt: 2 },
      { stage: "图操作已生成", updatedAt: 3 },
    )).toBe(true)
    expect(workflowOperationArtifactsChanged(
      { stage: "图操作已生成", updatedAt: 3 },
      { stage: "图操作已生成", updatedAt: 3 },
    )).toBe(false)
    expect(workflowOperationArtifactsChanged(
      { stage: "图操作已生成", updatedAt: 3 },
      { stage: "笔记已生成", updatedAt: 4 },
    )).toBe(true)
    expect(workflowOperationArtifactsChanged(
      { stage: "收集材料", updatedAt: 3 },
      { stage: "笔记已生成", updatedAt: 4 },
    )).toBe(false)
  })

  test("rejects responses from an invalidated view or another project", () => {
    const current = { projectName: "demo", generation: 4 }
    expect(workflowViewRequestMatches({ projectName: "demo", generation: 4 }, current)).toBe(true)
    expect(workflowViewRequestMatches({ projectName: "demo", generation: 3 }, current)).toBe(false)
    expect(workflowViewRequestMatches({ projectName: "other", generation: 4 }, current)).toBe(false)
  })
})

describe("project workflow restore safety", () => {
  test("discards only after the explicit destructive choice", () => {
    expect(shouldDiscardWorkflowFromRestoreChoice("discard")).toBe(true)
    expect(shouldDiscardWorkflowFromRestoreChoice("continue")).toBe(false)
    expect(shouldDiscardWorkflowFromRestoreChoice(false)).toBe(false)
    expect(shouldDiscardWorkflowFromRestoreChoice(undefined)).toBe(false)
  })
})

describe("project workflow correction semantics", () => {
  test("distinguishes lifecycle correction kind for all unified active combinations", () => {
    expect(workflowCorrectionKind({})).toBe("")
    expect(workflowCorrectionKind({ correction: { expectedChangeId: "correction1_" } })).toBe("soft")
    expect(workflowCorrectionKind({ hardCorrection: { expectedChangeId: "step0_demo_fix1" } })).toBe("hard")
    expect(workflowCorrectionKind({
      correction: { expectedChangeId: "correction1_" },
      hardCorrection: { expectedChangeId: "correction1_demo_fix1" },
    })).toBe("hard")
  })
})

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
      input: {
        filePath: "workflows/active/note.md",
        content: "# 第一版工作笔记\n",
      },
      metadata: {
        filepath: "workflows/active/note.md",
        exists: false,
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

  test("distinguishes write content records from edit diff records", () => {
    expect(isWriteTool("write")).toBe(true)
    expect(isEditTool("write")).toBe(false)
    expect(isEditTool("edit")).toBe(true)
    expect(isEditTool("apply_patch")).toBe(true)
    expect(isEditTool("workflow_action")).toBe(false)
  })

  test("describes workflow panel maximize state", () => {
    expect(workflowMaximizeBodyClass("workspace")).toBe("workflow-maximized-workspace")
    expect(workflowMaximizeBodyClass("chat")).toBe("workflow-maximized-chat")
    expect(workflowMaximizeBodyClass("notes")).toBe("")

    expect(workflowMaximizeButtonState("", "workspace")).toEqual({
      expanded: false,
      label: "展开",
      title: "展开当前区域",
    })
    expect(workflowMaximizeButtonState("workspace", "workspace")).toEqual({
      expanded: true,
      label: "收起",
      title: "恢复默认布局",
    })
    expect(workflowMaximizeButtonState("workspace", "chat").expanded).toBe(false)
  })

  test("allows graph preview before first graph submit when draft preview graph exists", () => {
    expect(canShowWorkflowGraphPreview(false, true)).toBe(true)
    expect(canShowWorkflowGraphPreview(false, false)).toBe(false)
    expect(canShowWorkflowGraphPreview(true, false)).toBe(true)
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

  test("uses completed apply_patch metadata as executed diff history", () => {
    const records = editToolRecords([completedWriteMessage(), completedApplyPatchMessage()])

    expect(records).toMatchObject([
      { id: "tool:msg_1:call_patch", title: "已修改工作笔记", diff: expect.stringContaining("patched") },
    ])
  })

  test("uses completed write input as executed content history", () => {
    const records = writeToolRecords([completedWriteMessage()])

    expect(records).toMatchObject([{
      id: "tool-write:executed:msg_1:call_write",
      kind: "content",
      status: "executed",
      title: "已创建工作笔记",
      content: expect.stringContaining("第一版工作笔记"),
      buttonLabel: "查看写入内容",
    }])
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

  test("renders unified diff with line numbers and highlighted changed spans", () => {
    const html = renderUnifiedDiff("--- a/note.md\n+++ b/note.md\n@@ -2,2 +2,2 @@\n-old value\n+new value\n context\n")

    expect(html).toContain("diff-view")
    expect(html).toContain("diff-delete")
    expect(html).toContain("diff-add")
    expect(html).toContain("diff-hunk")
    expect(html).toContain('<span class="diff-line old">2</span>')
    expect(html).toContain('<span class="diff-line new">2</span>')
    expect(html).toContain('<span class="diff-word">old</span>')
    expect(html).toContain('<span class="diff-word">new</span>')
  })

  test("renders an empty diff fallback", () => {
    expect(renderUnifiedDiff("")).toContain("没有可展示的 diff")
  })

  test("renders write content without presenting it as a diff", () => {
    const html = renderWriteContent("# note\n")

    expect(html).toContain("write-content-view")
    expect(html).toContain("# note")
    expect(html).not.toContain("diff-add")
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

  test("renders stale running tools as interrupted without changing their stored state", () => {
    const part = {
      type: "tool",
      tool: "write",
      state: { status: "running", title: "写入工作笔记" },
    }
    const html = renderWorkflowToolPart(part, null, { interrupted: true })

    expect(html).toContain("写入工作笔记 · 执行已中断")
    expect(html).toContain("tool-error")
    expect(part.state.status).toBe("running")
  })

  test("renders completed write tool part with a content button", () => {
    const part = completedWriteMessage().parts[0]
    const html = renderWorkflowToolPart(part, completedWriteMessage())

    expect(html).toContain("已创建工作笔记 · 已执行")
    expect(html).toContain("data-tool-diff-open=\"tool-write:executed:msg_1:call_write\"")
    expect(html).toContain("查看写入内容")
    expect(html).not.toContain("查看 diff")
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

    expect(html).toContain("已拒绝修改工作笔记 · 用户已拒绝")
    expect(html).toContain("data-tool-diff-open=\"tool-rejected:msg_1:call_1\"")
    expect(rejectedEditToolRecords([{ ...message, parts: [part] }])).toMatchObject([{
      id: "tool-rejected:msg_1:call_1",
      status: "rejected",
      title: "已拒绝修改工作笔记",
      diff: expect.stringContaining("-old"),
    }])
  })

  test("renders rejected write as submitted content, not diff", () => {
    const message = {
      info: { id: "msg_rejected" },
      parts: [{
        type: "tool",
        tool: "write",
        callID: "call_write_rejected",
        state: {
          status: "error",
          input: { filePath: "workflows/active/note.md", content: "new note" },
          error: "The user rejected permission to use this specific tool call.",
        },
      }],
    }
    const records = writeToolRecords([message])
    const html = renderWorkflowToolPart(message.parts[0], message)

    expect(records).toMatchObject([{
      id: "tool-write:rejected:msg_rejected:call_write_rejected",
      title: "已拒绝写入工作笔记",
      content: "new note",
      buttonLabel: "查看模型提交的内容",
    }])
    expect(html).toContain("已拒绝写入工作笔记 · 用户已拒绝")
    expect(html).toContain("查看模型提交的内容")
    expect(renderWorkflowReviewBody(records[0])).toContain("new note")
  })

  test("reconstructs rejected apply_patch proposals from persisted tool input", () => {
    const message = {
      info: { id: "msg_rejected" },
      parts: [
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

  test("renders archived note resource without delete button", () => {
    const html = renderResourceItem({
      path: "notes/past.md",
      originalName: "past.md",
      name: "past.md",
    }, "notes/past.md", "42 B / 可预览", { showDelete: false })

    expect(html).toContain('data-path="notes/past.md"')
    expect(html).not.toContain('resource-delete')
  })

  test("labels archived notes with their workflow progression", () => {
    expect(archivedNoteProgressLabel({
      progressIndex: 3,
      changeId: "step2_delivery_review",
    })).toBe("第 3 次推进 · step2_delivery_review")
    expect(archivedNoteProgressLabel({})).toBe("未关联推进")

    const html = renderResourceItem({
      path: "notes/review.md",
      originalName: "review.md",
      name: "review.md",
    }, "", "第 3 次推进 · step2_delivery_review", {
      showDelete: false,
      detailText: "2026-07-20T10:00:00+08:00 · 42 B / 可预览",
    })
    expect(html).toContain("第 3 次推进 · step2_delivery_review")
    expect(html).toContain("2026-07-20T10:00:00+08:00 · 42 B / 可预览")
  })

  test("builds permission URLs with project directory so replies hit the correct instance", () => {
    const project = { directory: "/tmp/project graph/demo" }

    expect(permissionListUrl(project)).toBe("/permission?directory=%2Ftmp%2Fproject%20graph%2Fdemo")
    expect(permissionReplyUrl("per/a b", project)).toBe("/permission/per%2Fa%20b/reply?directory=%2Ftmp%2Fproject%20graph%2Fdemo")
  })
})
