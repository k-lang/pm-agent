import z from "zod"
import { Tool } from "./tool"
import { ProjectWorkflow } from "@/workflow/state"
import { ProjectWorkflowExecution } from "@/workflow/execution"

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
- 同步工作笔记变更：在 note.md 已通过人工导入或原版 write/edit/apply_patch 创建或更新后，登记笔记变化；执行层会清空旧图操作草案、校验和预览。payload: { "summary": "...", "source": "llm_draft|manual_import|manual_edit|llm_revision" }
- 更新工作笔记：兼容旧页面接口；聊天工具不能执行该动作，避免大模型把整篇 note.md 作为 tool input 传入。新流程应先由 note service 或原版编辑工具写 note.md，再调用“同步工作笔记变更”。
- 检查笔记充分性：判断 note.md 是否足以支撑图操作。payload: { "sufficient": true|false, "blockingQuestions": [], "missingFields": [], "summary": "..." }
- 生成图操作草案：只登记已写入 active 目录的 operation_notes.md 和 operations.draft.json，不接收正文。先用 write/edit/apply_patch 写入 workflows/active/operation_notes.md 和 workflows/active/operations.draft.json；draft 应是压缩结构化语义 delta，只放模型必须判断的节点/边/字段增量、description_delta 和 history。operations.json、operation_index.json、validation.json 和 preview.json 均由执行层生成。执行层会把 draft 编译为 operations.json，生成索引并立刻自动校验，返回 validation.issues；若失败，会进入“图操作需修订”。payload: { "summary": "...", "change_id": "...", "artifacts": { "operationNotes": true, "operationsDraft": true } }
- 校验图操作：通常不需要在“生成图操作草案”后再手动调用；该动作用于重新登记已经存在的 validation.json。
- 生成预览：由执行层生成 preview.json 后，状态机登记预览结果。
- 提出修订意见：记录用户审核意见并进入对应修订状态。payload: { "target": "工作笔记|图操作|两者", "comment": "..." }
- 应用图操作：当前版本保留动作入口，但不执行真实写图；必须等待用户明确确认。

放弃草案、应用图操作这类终态或准终态动作不能通过聊天工具执行，必须由工作推进页醒目的专用按钮触发后端接口。聊天中只能解释影响、提醒用户去点击对应按钮。
`.trim()

const UI_ONLY_ACTIONS = new Set<ProjectWorkflow.Action>(["放弃草案", "应用图操作"])
const NON_CHAT_ACTIONS = new Set<ProjectWorkflow.Action>(["更新工作笔记"])
const GRAPH_DRAFT_CONTENT_FIELDS = new Set(["operation_notes", "draft", "operation_index", "command", "operations", "history_descriptions"])

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
    if (args.action === "生成图操作草案") {
      const contentFields = Object.keys(args.payload ?? {}).filter((key) => GRAPH_DRAFT_CONTENT_FIELDS.has(key))
      if (contentFields.length) {
        throw new Error(`「生成图操作草案」不能通过 workflow_action 传输草稿正文或可执行 command（字段：${contentFields.join(", ")}）。请先写入 workflows/active/operation_notes.md 和 operations.draft.json，再用 artifacts 小清单登记。`)
      }
    }
    const result = await ProjectWorkflowExecution.runAction(args)
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
