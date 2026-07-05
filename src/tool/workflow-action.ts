import z from "zod"
import { Tool } from "./tool"
import { ProjectWorkflow } from "@/workflow/state"

const parameters = z.object({
  project: z.string().describe("项目名，对应 project_graph_data 下的项目目录名。"),
  action: ProjectWorkflow.Action.describe("要执行的工作推进动作，使用中文枚举值。"),
  payload: z.record(z.string(), z.unknown()).default({}).describe("动作参数。不同 action 需要不同 payload。"),
})

const DESCRIPTION = `
工作推进状态机工具。只能用于工作推进页的 project_workflow primary agent。

你不能直接写入项目图数据文件。需要更新工作推进草案时，调用本工具。
状态机不是强制 SOP。工具返回 availableActions、blockedActions 和 recommendations，用于告诉你哪些路径可选、哪些动作明显不安全、哪些事项建议和用户确认。

支持的 action：
- 开始或恢复：进入项目工作推进流程，读取或创建 workflows/active 草案。
- 放弃草案：仅当用户明确要求放弃时调用；如已有 note.md 会保留工作笔记并清空图操作草案、校验、预览和聊天会话，没有 note.md 时清空 active 草案。
- 追加消息：记录用户或助手消息。payload: { "role": "用户|助手|系统", "text": "..." }
- 登记资源：登记已上传或可引用资源。payload: { "path": "...", "title": "...", "note": "..." }
- 同步工作笔记变更：在 note.md 已通过人工导入或原版 write/edit/apply_patch 创建或更新后，同步状态并清空旧图操作草案、校验和预览。payload: { "summary": "...", "source": "llm_draft|manual_import|manual_edit|llm_revision" }
- 更新工作笔记：仅供页面人工导入/人工修改接口直接调用；聊天工具不能执行该动作，避免大模型把整篇 note.md 作为 tool input 传入。
- 检查笔记充分性：判断 note.md 是否足以支撑图操作。payload: { "sufficient": true|false, "blockingQuestions": [], "missingFields": [], "summary": "..." }
- 生成图操作草案：保存 operations.json。payload 可提供完整 command，或 operations/change_id/description/history_descriptions。
- 校验图操作：执行图引擎基础校验和语义布局校验。
- 生成预览：基于最近一次通过的校验生成预览元数据。
- 提出修订意见：记录用户审核意见并进入对应修订状态。payload: { "target": "工作笔记|图操作|两者", "comment": "..." }
- 应用图操作：当前版本保留动作入口，但不执行真实写图；必须等待用户明确确认。

放弃草案、应用图操作这类终态或准终态动作不能通过聊天工具执行，必须由工作推进页醒目的专用按钮触发后端接口。聊天中只能解释影响、提醒用户去点击对应按钮。
`.trim()

const UI_ONLY_ACTIONS = new Set<ProjectWorkflow.Action>(["放弃草案", "应用图操作"])
const NON_CHAT_ACTIONS = new Set<ProjectWorkflow.Action>(["更新工作笔记"])

export const WorkflowActionTool = Tool.define("workflow_action", {
  description: DESCRIPTION,
  parameters,
  async execute(args, ctx) {
    if (ctx.agent !== "project_workflow") {
      throw new Error("workflow_action 只能由 project_workflow agent 调用。")
    }
    if (UI_ONLY_ACTIONS.has(args.action)) {
      throw new Error(`「${args.action}」不能通过聊天工具执行，必须由工作推进页的专用确认按钮触发。`)
    }
    if (NON_CHAT_ACTIONS.has(args.action)) {
      throw new Error(`「${args.action}」不能通过聊天工具执行。请使用原版 write/edit/apply_patch 创建或修改 note.md 后，再调用「同步工作笔记变更」。`)
    }
    const result = await ProjectWorkflow.runAction(args)
    return {
      title: `工作推进：${args.action}`,
      metadata: {
        project: result.project,
        workflowID: result.workflowID,
        stage: result.stage,
        ok: result.ok,
      },
      output: JSON.stringify(result, null, 2),
    }
  },
})
