import z from "zod"
import { Tool } from "./tool"
import { ProjectWorkflow } from "@/workflow/state"
import { ProjectWorkflowExecution } from "@/workflow/execution"

const WorkflowChatAction = ProjectWorkflow.Action.exclude(["放弃草案", "更新工作笔记", "应用图操作", "重做最近提交", "开始软更正"])
type WorkflowChatAction = z.infer<typeof WorkflowChatAction>

const parameters = z.object({
  project: z.string().describe("项目名，对应 project_graph_data 下的项目目录名。"),
  action: WorkflowChatAction.describe("要执行的工作推进动作，使用中文枚举值。"),
  payload: z.record(z.string(), z.unknown()).default({}).describe("动作参数。不同 action 需要不同 payload。"),
})

const DESCRIPTION = `
工作推进状态机工具。只能用于工作推进页的 project_workflow 或 project_workflow_correction primary agent。

你不能直接写入项目图数据文件。需要更新工作推进草案时，调用本工具。
状态机不是强制 SOP。工具返回 availableActions、blockedActions 和 recommendations，用于告诉你哪些路径可选、哪些动作明显不安全、哪些事项建议和用户确认。

支持的 action：
- 开始或恢复：进入项目工作推进流程，读取或创建 workflows/active 草案。
- 追加消息：记录用户或助手消息。payload: { "role": "用户|助手|系统", "text": "..." }
- 登记资源：登记已上传或可引用资源。payload: { "path": "...", "title": "...", "note": "..." }
- 同步工作笔记变更：在 note.md 已通过人工导入或原版 write/edit/apply_patch 创建或更新后登记变化。若已有完整图操作，执行层会保留草案、校验和预览，但撤销提交资格并进入“图操作待复核”；随后必须启动只读 reviewer，不能直接修改图操作。payload: { "summary": "...", "source": "llm_draft|manual_import|manual_edit|llm_revision" }
- 检查笔记充分性：判断 note.md 是否足以支撑图操作。payload: { "sufficient": true|false, "blockingQuestions": [], "missingFields": [], "summary": "..." }
- 生成图操作草案：只登记已写入 active 目录的 operation_notes.md 和 operations.draft.json，不接收正文。先用 write/edit/apply_patch 写入 workflows/active/operation_notes.md 和 workflows/active/operations.draft.json；draft 应是压缩结构化语义 delta，只放模型必须判断的节点/边/字段增量、description_delta、history、note_filename 和 changelog_entry。note_filename 是必填的语义化工作笔记归档文件名；执行层会归档 note.md 并保证最终 notes 路径写入 changelog，但不会强制给节点补 detail_url。event/work_item 是否显式引用该笔记由模型判断并接受 reviewer 审查。changelog_entry 是大模型生成的本次 changelog 增量，后端确认提交时会追加到 changes/changelog.txt，不会机械生成正文。operations.json、operation_index.json、validation.json、changelog_entry.txt、preview.json 和 preview_graph 均由执行层生成或派生。执行层会把 draft 编译为 operations.json，生成索引并立刻自动校验；校验通过时同步生成图谱预览，校验失败时返回 validation.issues 并进入“图操作需修订”。payload: { "summary": "...", "change_id": "...", "artifacts": { "operationNotes": true, "operationsDraft": true } }
- 校验图操作：通常不需要在“生成图操作草案”后再手动调用；该动作用于重新登记已经存在的 validation.json。
- 登记图操作复核：仅在工作笔记更新后保留旧图操作的场景使用。必须先调用 project_workflow_graph_operation_reviewer 做只读检查，不修改任何图操作，再登记精简结论。payload: { "verdict": "consistent|issues", "issueCount": 0, "summary": "..." }
- 确认沿用现有图操作：只有 reviewer 已完成复核，并且用户在聊天中明确表示即使存在提示也同意沿用当前图操作时才能调用。该动作只开放页面提交按钮，不会直接应用图操作。payload: { "confirm": true }
- 提出修订意见：记录用户审核意见并进入对应修订状态。payload: { "target": "工作笔记|图操作|两者", "comment": "..." }

放弃草案、应用图操作和页面专用更正入口这类终态、准终态或模式入口不会暴露给 workflow_action，必须由工作推进页醒目的专用按钮触发后端接口。聊天中只能解释影响、提醒用户去点击对应按钮。更新工作笔记也不暴露给 workflow_action；应先由原版 write/edit/apply_patch 创建或修改 note.md，再调用“同步工作笔记变更”。
`.trim()

const GRAPH_DRAFT_CONTENT_FIELDS = new Set(["operation_notes", "draft", "operation_index", "command", "operations", "history_descriptions"])

export function latestExplicitUserMessage(messages: Tool.Context["messages"]) {
  const latestUserMessage = [...messages].reverse().find((message) => message.info.role === "user")
  const hasExplicitText = latestUserMessage?.parts.some((part) =>
    part.type === "text" && !part.synthetic && !part.ignored && part.text.trim(),
  )
  return hasExplicitText ? latestUserMessage : undefined
}

function redactHardCorrectionText(text: string) {
  return text
    .replaceAll("硬更正草案", "当前草案")
    .replaceAll("硬更正", "当前工作")
    .replaceAll("重做最近提交", "当前工作")
    .replaceAll("hard correction", "current workflow")
    .replaceAll("Hard correction", "Current workflow")
}

function redactHardCorrectionValue(value: unknown): unknown {
  if (typeof value === "string") return redactHardCorrectionText(value)
  if (Array.isArray(value)) return value.map(redactHardCorrectionValue)
  if (!value || typeof value !== "object") return value
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (key === "discardedHardCorrection") continue
    if (key === "discardedCorrection" && item === "hard") continue
    result[key] = redactHardCorrectionValue(item)
  }
  return result
}

export function workflowActionResultForModel(result: ProjectWorkflow.ActionResult): ProjectWorkflow.ActionResult {
  if (!result.state?.hardCorrection) return result
  const redacted = redactHardCorrectionValue(JSON.parse(JSON.stringify(result))) as ProjectWorkflow.ActionResult
  if (redacted.state) delete redacted.state.hardCorrection
  if (redacted.data) delete redacted.data.hardCorrection
  return redacted
}

export const WorkflowActionTool = Tool.define("workflow_action", {
  description: DESCRIPTION,
  parameters,
  async execute(args, ctx) {
    if (ctx.agent !== "project_workflow" && ctx.agent !== "project_workflow_correction") {
      throw new Error("workflow_action 只能由 project_workflow 或 project_workflow_correction agent 调用。")
    }
    if (args.action === "生成图操作草案") {
      const contentFields = Object.keys(args.payload ?? {}).filter((key) => GRAPH_DRAFT_CONTENT_FIELDS.has(key))
      if (contentFields.length) {
        throw new Error(`「生成图操作草案」不能通过 workflow_action 传输草稿正文或可执行 command（字段：${contentFields.join(", ")}）。请先写入 workflows/active/operation_notes.md 和 operations.draft.json，再用 artifacts 小清单登记。`)
      }
    }
    const explicitUserMessage = latestExplicitUserMessage(ctx.messages)
    if (args.action === "确认沿用现有图操作" && !explicitUserMessage) {
      throw new Error("确认沿用现有图操作必须对应当前聊天中的用户明确同意消息。")
    }
    const executionArgs = args.action === "确认沿用现有图操作"
      ? {
          ...args,
          payload: {
            ...args.payload,
            sessionID: ctx.sessionID,
            userMessageID: explicitUserMessage!.info.id,
            userMessageCreatedAt: explicitUserMessage!.info.time.created,
          },
        }
      : args
    const result = await ProjectWorkflowExecution.runAction(executionArgs)
    return {
      title: `工作推进：${args.action}`,
      metadata: {
        project: result.project,
        workflowID: result.workflowID,
        stage: result.stage,
        ok: result.ok,
      },
      output: JSON.stringify(workflowActionResultForModel(result), null, 2),
    }
  },
})
