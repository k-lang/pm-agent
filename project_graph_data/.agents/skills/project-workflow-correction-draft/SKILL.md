---
name: project-workflow-correction-draft
description: 指导具有软更正语义的工作现场生成更正工作笔记、operation_notes.md 和 operations.draft.json，约束 correction 语义、create/update 和逻辑废弃级联影响。
---

# 项目图谱软更正 Skill

## 目标

把用户指出的历史图数据错误、遗漏事实、错误关系或需要废弃的节点/边，整理成一轮可审核的 correction 提交。

更正语义不是普通项目推进。本轮在后端准备好的固定基线上形成 correction 结果：

- 不修改旧 history。
- 草案阶段不修改正式图数据。
- 不删除旧节点或旧边文件。
- change_id 使用后端直接给出的前缀或完整 ID，模型不自行推算序号。

## 必须配合的 Skill

本 Skill 只定义软更正语义和审计边界，不重复维护完整图操作 schema、边类型、节点状态白名单、history/changelog/note_filename 规则。

生成 `operation_notes.md` 和 `operations.draft.json` 时，必须同时使用 `project-workflow-graph-operation-draft` Skill，并遵守其中所有结构、字段、状态、边类型和 reviewer 流程要求。

如果两套规则看起来冲突：

1. 图操作结构、字段、边类型、状态白名单，以 `project-workflow-graph-operation-draft` 为准。
2. 是否属于软更正、能否改旧 history、是否需要 correction change_id、逻辑废弃如何覆盖级联，以本 Skill 为准。

## 输入与确认

开始生成软更正图操作前，先读取：

1. `workflows/active/note.md`，确认用户要更正的事实、原因、证据和时间。
2. 当前项目 `README.md`，确认图数据目录结构。
3. `workflows/active/base_graph/` 下相关 `descriptions_output/description_summary/`、`nodes/`、`edges/`、`notes/`；用户上传资料仍从项目根目录 `source/` 读取。

不要读取 `workflows/active/state.json`；更正模式、恢复过程和序号由后端管理。

如果 `note.md` 不足以说明更正原因、证据、时间或对象，先追问或修订工作笔记。不要为了生成图操作自行编造 timestamp、事实来源或更正原因。

## change_id

`operations.draft.json.change_id` 必须遵循预热请求、工具反馈或既有草案中由后端提供的约束。后端提供前缀时，在其后补语义短名：

```text
backend_prefix + semantic_slug
```

例如后端给出 `correction1_`，草案可以写：

```text
correction1_correct_wrong_edge
```

后端提供完整 ID 或既有草案已经带有完整 ID 时，必须原样保留，不能再追加语义短名。任何更正语义都不要写 `step...`，不要自行计算或改变序号。

## 允许的操作

软更正允许使用 `project-workflow-graph-operation-draft` 支持的四类 item：

- `create_node`：补充历史上遗漏但现在需要入图的事实、问题、目标、工作块、工作项或结果。
- `create_edge`：补充历史上遗漏的关系。
- `update_node`：修正已有节点当前概述、状态、分数、归属、detail_url 或追加 correction history。
- `update_edge`：修正已有边当前说明或追加 correction history。

不要发明：

- `delete_node`
- `delete_edge`
- `deprecate_node`
- `deprecate_edge`
- `remove_node`
- `remove_edge`

## 新增关系的端点可读历史

软更正通过 `create_edge` 补充一条关系时，起点和终点的 `description` 可读“历史记录：”段都必须体现本轮新增关系：

- 端点是本轮新建节点：对应 `create_node` item 已覆盖该端点，不再额外写 `update_node`。
- 端点是 `base_graph` 中已有节点：必须为该端点补一个 `update_node` item，使编译器把本轮关系上下文追加到该节点 `description` 的可读历史段。两端都是已有节点时，两端都要补。
- 新关系没有改变端点的当前事实或当前判断时，不要为了凑 update 机械改写 description 当前概述；可以只让该 `update_node` 承载本轮可读历史。
- `incoming_edges`、`outgoing_edges` 和节点顶层结构化 `history[]` 仍由图引擎自动维护，模型不得填写。这里要求的是 `description` 内的可读历史，不是让模型维护结构化 `history[]`。

执行层会检查每条 `create_edge` 对已有端点的 `update_node` 覆盖；缺失时返回 validation issue。模型负责可读历史的业务语义，执行层负责补充可确定的边类型和另一端节点上下文。

## 逻辑废弃

如果用户要“删除”“作废”“废弃”已有节点或边，第一版不做物理删除，只做逻辑废弃。

逻辑废弃已有边：

- 写 `update_edge`。
- 在 item 上写 `deprecation: true` 或 `correction_intent: "deprecate"`。
- 必须使用上述结构化标记；执行层不会根据 description、reason 或 history 中出现“删除/废弃”等文字猜测意图。
- 更新该边的当前说明，表达“这条关系不再有效/不应继续作为有效关系解释”。
- 追加本轮 `history`，说明为什么废弃。
- 同时补充两端节点的 `update_node`，让起点、终点节点的当前概述或 history 体现该关系已被更正。
- 执行层会保留 edge 文件用于审计，但从两端节点邻接列表中移除该边，使其不再进入当前图、语义校验和新 snapshot。

逻辑废弃已有节点：

- 写 `update_node`。
- 在 item 上写 `deprecation: true` 或 `correction_intent: "deprecate"`。
- 更新该节点的当前概述，表达废弃后的有效性状态。summary 可以简洁体现“已废弃”，但不要把当前概述写成流水账。
- 追加本轮 `history`，说明为什么废弃。
- 同时补充所有相邻边的 `update_edge`。
- 同时补充所有相邻节点的 `update_node`。
- 如果节点参与 `linked_goal_id`、`linked_work_block_id`、`linked_work_blocks` 或 `work_items` 这类属性关系，也要补充相关节点的 `update_node`。
- 执行层会机械解除相邻边引用和上述结构归属；模型不能直接填写这些派生列表，但必须为每个受影响对象提供相应 update 的当前概述和 history。

执行层会根据当前图结构检查级联覆盖是否缺失，并在 `validation.issues` 中指出缺哪些节点/边 update。执行层不会替你生成这些 update 的业务内容。

## description 与 history

软更正不能改旧 history，但可以让当前概述变成修正后的状态。

- `description` 当前概述：只写修正后的当前事实、当前判断或废弃后的有效性状态，读起来应像这份信息一直是当前有效版本。
- `description` 当前概述严禁出现“本次更正”“追加更正后”“修正后”“原图遗漏”“补录错误”等更正过程、旧记录缺陷或审计措辞。
- `history`：必须写本轮 correction 的修正原因、证据、影响和关联对象；“原来哪里错了、漏了什么、本次如何更正”只能写在这里。
- 不要把旧 `历史记录：` 整段复制进 draft。
- 不要在当前概述前后追加一段更正说明；应重写为更正后的完整现状，并把审计信息放进本轮 `history`。
- `descriptions_output/description_summary/` 应展示修正后的当前概述。
- `descriptions_output/history/` 应展示追加的 correction 历史记录。

提交 reviewer 前，逐项分开检查：遮住 `history` 后，`description` / `new_description` / `description_delta` 是否仍能作为当前有效概述独立成立；遮住当前概述后，`history` 是否清楚记录了更正原因和变化。如果当前概述仍在讲“做过一次更正”，必须先改稿。

## 更正工作笔记归档

软更正同样必须提供 `note.md` 和语义化 `note_filename`。后端会把笔记归档到 `notes/`，并保证本轮 changelog 包含最终笔记路径。

软更正笔记通常记录跨对象的错误、证据和更正原因，不应默认挂到任何节点的 `detail_url`。只有当该笔记本身将成为某个本轮 create/update 的 event 或 work_item 的长期当前详情来源时，才按基础 Skill 的规则显式填写 `fields.detail_url` / `field_updates.detail_url`。不要因为修改了某个节点，就用更正笔记覆盖它原有的长期详情链接。`operation_notes.md` 必须说明本轮是否挂载及理由。

## 用户审核

用户审核的是：

- `operation_notes.md` 的自然语言说明。
- 后端生成的 `operation_index.json` 和图谱预览。
- 关键节点/边的当前概述和 correction history。

不要要求用户逐条口述节点、边和字段。节点/边选择、级联覆盖、history 写法是你的分析任务。只有证据不足、时间缺失、修正对象不明确或业务取舍无法判断时，才追问用户。
