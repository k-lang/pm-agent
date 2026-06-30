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
- 放弃草案：仅当用户明确要求放弃时调用，清空 active 草案。
- 追加消息：记录用户或助手消息。payload: { "role": "用户|助手|系统", "text": "..." }
- 登记资源：登记已上传或可引用资源。payload: { "path": "...", "title": "...", "note": "..." }
- 更新工作笔记：保存 note.md。payload: { "content": "...", "summary": "..." }
- 检查笔记充分性：判断 note.md 是否足以支撑图操作。payload: { "sufficient": true|false, "blockingQuestions": [], "missingFields": [], "summary": "..." }
- 生成图操作草案：保存 operations.json。payload 可提供完整 command，或 operations/change_id/description/history_descriptions。
- 校验图操作：执行图引擎基础校验和语义布局校验。
- 生成预览：基于最近一次通过的校验生成预览元数据。
- 提出修订意见：记录用户审核意见并进入对应修订状态。payload: { "target": "工作笔记|图操作|两者", "comment": "..." }
- 应用图操作：当前版本保留动作入口，但不执行真实写图；必须等待用户明确确认。

涉及放弃草案或应用图操作时，必须先得到用户明确确认。
`.trim()

export const WorkflowActionTool = Tool.define("workflow_action", {
  description: DESCRIPTION,
  parameters,
  async execute(args, ctx) {
    if (ctx.agent !== "project_workflow") {
      throw new Error("workflow_action 只能由 project_workflow agent 调用。")
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
