---
name: project-workflow-graph-operation-draft
description: 将工作推进 active workflow 的工作笔记转成可审核、可校验的图操作草案，并指导主 Agent 生成 operation_notes.md 与 operations.draft.json。
---

# 项目工作推进图操作草案 Skill

本轮所有现有图数据都以 `workflows/active/base_graph/` 为固定基线。读取 nodes、edges、changes、snapshots、descriptions_output 和已归档 notes 时必须从该目录读取；不要改读项目根目录中可能已经变化的兼容入口。active 草案文件仍写在 `workflows/active/`。

## 目标

把当前 active workflow 的工作笔记转成可审核、可校验的图操作草案。

你不是直接修改正式图数据，也不要直接写最终 `operations.json`。你要先生成给人看的自然语言说明，再生成压缩的结构化 `operations.draft.json`，把它们写入 active workflow 草案区，最后通过 `workflow_action` 登记这些草案产物已经写好。后端执行层会从 draft 编译生成 `operations.json`、`operation_index.json`、`validation.json`、`preview.json` 和 `preview_graph`；校验通过时，图谱预览会同步生成。用户审核的是自然语言化的图操作说明、代码派生的图操作索引和图谱预览，不是让用户手改内部 JSON。

## 使用前提

只有在用户明确要求或明确同意生成/预览/更新图操作、更新项目图谱、生成图操作草案之后，主 Agent 才能使用本 Skill。工作笔记充分、状态机允许生成图操作，只代表“可以建议进入下一步”，不代表可以自动生成。若用户尚未明确授权，主 Agent 应先询问是否现在生成图操作草案。

本 Skill 只处理图操作说明和图操作草案，不负责写工作笔记。`workflows/active/note.md` 只能记录项目事实、背景材料、计划调整、工作过程、结果、评审结论、影响评估、附件引用和待确认问题；不要把图操作、项目图谱、节点、边、校验、预览或 operations 文件信息写进工作笔记。

## 必须独立审查

写入 `workflows/active/operation_notes.md` 和 `workflows/active/operations.draft.json` 后，不要直接调用 `workflow_action` 登记图操作草案。必须先调用 Task 工具启动 `project_workflow_graph_operation_reviewer` subagent 做独立只读审查。

这样做是为了避免主上下文已经生成 draft 后受到自身推理污染，导致自检只重复确认自己的结果。reviewer subagent 必须从文件重新读取 `note.md`、`operation_notes.md`、`operations.draft.json` 和必要图索引，按本 Skill 的状态白名单、边类型、节点新旧、planned work_item、result/issue 建模、history、changelog 和 note_filename 规则检查。reviewer 只审当前草案本身，不用 stale `validation.json` 判定当前草案是否通过。

流程要求：

1. 主 Agent 生成或修改 `operation_notes.md` 和 `operations.draft.json`。
2. 主 Agent 调用 Task：`subagent_type` 必须是 `project_workflow_graph_operation_reviewer`。
3. reviewer 返回“审查结论：通过”时，主 Agent 才能调用 `workflow_action` action="生成图操作草案"。
4. reviewer 返回“不通过”时，主 Agent 必须先修订草案文件，再重新调用 reviewer；不能带着已知问题登记。
5. 如果 reviewer 通过后，`workflow_action` 的自动校验失败，优先按 `validation.issues` 修订 `operations.draft.json` 并重新登记。只有修订涉及语义建模大改、取舍不确定或用户要求复审时，才再次调用 reviewer；不要让 reviewer 审查旧 `validation.json`。

## 最高优先级禁令

以下规则优先级高于其他建模建议。只要违反其中任意一条，就不要写入 `operations.draft.json`，先修改草案。

### 未进行的工作不能发现问题

还没有实际推进的工作，只能是 `planned`。不能因为它紧急、重要、客户要求、当前优先、需要尽快开展、用于评估、将要暴露风险，就把它写成 `active`、`in_progress` 或其他看起来“已经启动”的状态。

没有已推进证据的工作项，不能作为“已推进后产生新事实”的边的起点。工作还没有推进，就不可能“发现问题”、产出结果、修正结果，或基于执行过程自然引出后续工作。不要把未推进工作写成 `active` 来绕过 planned 限制。

禁止模式：

- 新建一个 `work_item`，描述为“需要/计划/将要/用于/希望/准备”做某事，却把 `fields.status` 写成 `active`、`in_progress` 或 `finished`。
- 新建一个没有已推进证据的 `work_item`，然后创建 `discovers`、`creates`、`modifies_work` 这类表示已发现、已产出、已修正的出边。
- 新建一个没有已推进证据的 `work_item`，然后把它作为 `next` 边的起点来表达“完成该工作后自然承接下一项”。如果只是计划拆分，优先写在 work_block/work_item 描述或需审核点，不要用 `next` 伪造成已发生顺承。
- 把“这项工作未来需要识别风险、暴露问题、验证可行性”写成 `discovers`。这只是工作项的任务要求或成功标准，不是已发生的发现关系。

正确处理：

- 如果工作笔记只说某项工作需要开展、计划开展、刚被客户提出、后续要做，`work_item.status` 写 `planned`。
- 新建 work_item 不要用 `active` 表示“当前有效/当前重要/当前优先”；如果没有已推进证据，就写 `planned`。
- 如果问题来自外部事实、背景约束、客户要求或工作笔记本身，不要硬连到未推进的 work_item；可以用 event、issue 自身 description/history、或 `operation_notes.md` 的需审核点承载。
- 如果未来工作需要识别风险，把这写进 `work_item.description`，不要创建 `discovers` 边。
- 只有工作笔记明确说明某项工作已经开展，并且问题是在该工作推进、分析、验证、实施、沟通或复盘过程中被发现/澄清/暴露，才允许 `work_item -> issue` 使用 `discovers`。
- 只有工作笔记明确说明某项工作已经推进并产生结果，才允许该 work_item 作为 `creates` 或 `modifies_work` 的起点。
- 只有工作笔记明确说明某项工作与后一项工作存在已发生的承接、失败后转向、基于上一轮结果继续推进等关系，才允许该 work_item 作为 `next` 的起点。

### 未进行的工作不能产出结果

`planned` 工作项也不能作为 `creates` 或 `modifies_work` 边的起点来产出 result。工作还没有推进，就不可能已经产生结果、结论、交付物或阶段进展。

只有工作笔记明确说明工作已经完成或至少已经推进，并产生了结论、验证结果、阶段进展、交付物或可复用沉淀，才可以创建 `work_item -> result` 的 `creates` / `modifies_work` 边。

### 外部事实不能被重复建成问题

不要把同一段外部背景同时建成 `event` 和 `issue`，再让它们共同指向同一个 goal。这样会把同一个原因重复表达两次。

`event` 记录外部事实、客户动作、供应商反馈、资源变化、时间窗口变化。`issue` 必须是项目推进中待解决、待澄清、待验证或需要持续管理的实际问题。

禁止模式：

- 同一段事实既创建 `event`，又创建语义几乎相同的 `issue`。
- `event -> goal` 已经表达了外部事实触发目标，又创建同义 `issue -> goal` 再表达同一个触发原因。
- 把 event description 里的背景、原因、约束直接复制成 issue summary/description。

正确处理：

- 如果只是外部事实或背景约束，用 `event` 或相关节点 description/history 表达。
- 只有当这段事实进一步暴露出一个项目团队需要处理的具体缺口时，才创建 `issue`；issue 的 summary 应指向待解决缺口，而不是重复外部事实。
- 如果 event 和 issue 都存在，它们必须表达不同职责：event 是触发事实，issue 是由此暴露的待处理缺口。不要让二者用近似描述重复连接同一个目标。

## 输入

优先读取：

1. `workflows/active/note.md`
2. 当前项目 `README.md`
3. `descriptions_output/description_summary/` 中相关 goal、issue、work_block 索引
4. 必要时读取相关 `nodes/<type>/<id>.json`
5. 必要时追溯 `notes/` 或 `source/` 中被工作笔记引用的材料

不要为了生成草案无差别读取全部 nodes、edges、notes、source。先根据工作笔记定位候选节点和边，再按需下钻。

## 强约束

这些约束来自当前图引擎 schema 和历史人审 command。违反这些约束会导致后端校验失败，不能依赖人工审核兜底。

### 操作字段

`operations.draft.json` 是压缩的结构化语义 delta，不是最终 `GraphCommand`。它只存模型必须判断的内容，能由代码派生的不要写。

- 顶层必须包含 `change_id`、`timestamp`、`note_filename`、`changelog_entry`、`items`。
- 顶层使用 `items` 数组，不要使用 `operations` 或 `commands` 数组。
- 顶层不要写 `description`。自然语言说明写入 `operation_notes.md`，不要塞进结构化 draft 顶层。
- 每个 item 使用 `kind` 字段，不要使用 `type`、`command` 或 `op` 字段表示操作。
- 合法 `kind` 只有：`create_node`、`update_node`、`create_edge`、`update_edge`。
- `create_node` 写：`kind`、`temp_id`、`node_type`、`summary`、`description`、可选 `fields`、`history`。
- `update_node` 写：`kind`、`node_id`、可选 `field_updates`、`description_delta` 或 `description`、`history`。
- `create_edge` 写：`kind`、`temp_id`、`from_node`、`to_node`、`edge_type`、`description`、`history`。
- `update_edge` 写：`kind`、`edge_id`、`new_description` 或 `description_delta`、可选 `reason`、`history`。
- `history` 只写本轮变化的历史说明。不要写完整旧历史数组。
- 软更正也使用这四类 `kind`。软更正可以用 `create_node` / `create_edge` 补充历史遗漏事实，也可以用 `update_node` / `update_edge` 修正或逻辑废弃已有节点/边；不要发明 `delete_node`、`delete_edge`、`deprecate_node`、`deprecate_edge`。
- 如果软更正要逻辑废弃已有节点或边，在对应 `update_node` / `update_edge` item 上明确写 `deprecation: true` 或 `correction_intent: "deprecate"`。同时显式补齐受影响的相邻节点/边 update；执行层会根据图结构检查是否漏掉级联对象，但不会替你写这些对象的业务描述。

### ID 引用格式

如果边或更新引用本轮新建节点，直接使用该节点 item 的 `temp_id` 原文。

示例：先创建 `temp_id: "work_item_plan_validation"`，后续边的 `from_node` 就写 `"work_item_plan_validation"`。不要加 `temp:` 前缀，也不要写成 `node:work_item_plan_validation`、`proposed_id` 或其他包装格式。

### 节点状态白名单

`fields.status` 和 `field_updates.status` 只能使用下表白名单。不要发明 `active` work_item、`todo` work_item、`draft` result、`open` issue 等状态。

| 节点类型 | 合法 status | 含义 |
| --- | --- | --- |
| `event` | `occurred`, `changed` | 外部事实已发生，或外部事实/约束发生变化。 |
| `issue` | `discovered`, `resolving`, `resolved`, `shelved`, `ignored` | 问题被发现、正在处理、已解决、暂缓处理或明确忽略。不要写 `open`。 |
| `goal` | `established`, `in_progress`, `completed`, `failed`, `cancelled`, `adjusted` | 目标已建立、推进中、已完成、失败、取消或被调整。不要写 `active`。 |
| `work_item` | `planned`, `in_progress`, `finished`, `cancelled`, `ongoing` | 工作已计划、正在推进、已完成、取消或长期持续。不要写 `active` 或 `todo`。 |
| `result` | `produced`, `changed` | 结果已产出，或已有结果被改变。不要写 `draft`。 |
| `work_block` | `active`, `completed`, `cancelled` | 工作块当前有效、已完成或已取消。`active` 只属于 work_block。 |

状态选择必须和工作笔记证据一致：

- 新建未开始的 `work_item` 写 `planned`。
- 已经开始执行、正在推进、有过程材料或已分工的 `work_item` 才写 `in_progress`。
- 已经完成并产生交付物、结论、阶段进展或可复用沉淀的 `work_item` 才写 `finished`。
- 长期持续性工作才写 `ongoing`，不要用它表达“刚计划要做”。
- 没有产出证据时不要创建 `result`，更不要把 result 写成 `draft`。
- `active` 不是“当前重要”的通用状态，只能用于 `work_block`。

### 工作项状态、结果、发现问题的硬约束

生成 `operations.draft.json` 前，必须先判断工作笔记里是否有“工作已经发生”的证据。严格遵守前文“最高优先级禁令”：未进行的工作只能是 `planned`，不能写成 `active`，也不能作为 `discovers`、`creates`、`modifies_work` 或表示已发生顺承的 `next` 的起点。

`work_item.status` 按证据判断：

- 只说明需要做、计划做、刚被提出、客户要求做、后续要做：写 `planned`，不要写 `active` 或 `in_progress`。
- 明确说明已经开始执行、正在推进、已有过程材料、已经分工或已有中间产物：才写 `in_progress`。
- 明确说明已经完成，并产生交付物、结论、阶段进展或可复用沉淀：才写 `finished`。
- 如果不能从工作笔记中找到已经开始或完成的证据，默认不要把新建 work_item 写成 `active`、`in_progress` 或 `finished`。

硬自检问题：每写一个 `in_progress` / `finished` work_item、每写一个 result、每写一条 `discovers` 边，都要能在工作笔记中指出对应的已发生工作证据。没有证据就改成计划描述或需审核点。

### history 字段写法

在 draft 里，模型只写每个 item 的 `history` 字符串。它是本轮新增到该节点或边上的一条可读历史说明，写清楚“为什么变更、依据是什么、影响是什么”。这条历史要尽量贴近旧图数据 description 里的格式：

- 开头使用 `[change_id]`，例如 `[step18_knowledge_scheme] ...`。
- 前半段写本节点/边本次发生了什么：创建、状态变化、完成度变化、描述更新、结果产出或问题认识变化。
- 后半段写必要的图关系上下文：本次又和哪个目标、工作块、工作项、结果或问题建立/强化了联系，并写出节点 id，例如 `（结果节点id: result_x）`、`（工作块节点id: work_block_y）`。
- 不要只写“更新状态”“创建节点”“建立关系”这类过短说明。
- 不要在同一条 `history` 里把同一个节点关系重复写两遍。比如已经写了“归属于 X（目标节点id: goal_x）”，就不要再写“服务于 X（目标节点id: goal_x）”；已经写了“创建 A 到 B 的 generates 关系（事件节点id: event_x；目标节点id: goal_y）”，就不要再补一句“建立 A 到 B 的 generates 关系”。

后端会把 `item.history` 编译成 `operations.json.history_descriptions`。执行层会补齐缺失的 `[change_id]` 前缀，并根据本轮属性归属和边操作补充一部分确定性的图关系上下文；如果 `item.history` 已经提到同一个关联节点 id，执行层会避免重复追加同类上下文。语义主体必须由模型写好，不能把完整语义历史都推给代码。正式图数据里的节点/边 `history[]`、`serialized_data` 快照和去循环引用都由图引擎追加和维护。

旧格式参考：

- `[step18_knowledge_scheme] 目标领域知识梳理进度大幅提升，因知识梳理方案设计并验证成功，completion_score从30提升到60，status保持"in_progress"；此目标被知识梳理方案验证结果影响，找到可行的知识梳理方法并消除标签定义重叠现象（结果节点id: result_knowledge_organization_scheme）`
- `[step18_knowledge_scheme] 创建工作项知识梳理方案设计并验证，通过深入分析偏好和额外知识点的特征发现区分方法；状态设置为finished，关联到work_block_knowledge_organization；工作项被领域知识梳理工作块归属（工作块节点id: work_block_knowledge_organization）`

上一版常见错误必须避免：

- ❌ `{ "commands": [{ "command": "create_node" }] }`
- ✅ `{ "items": [{ "kind": "create_node" }] }`
- ❌ `{ "operations": [{ "type": "create_node" }] }`
- ✅ `{ "items": [{ "kind": "create_node" }] }`
- ❌ `create_edge` 里写 `{ "data": { "description": "..." } }`
- ✅ `create_edge` item 里直接写 `{ "description": "..." }`

### 时间字段

`timestamp` 表示这次工作进展/事件/计划调整实际发生或被记录的时间，不一定等于当前系统时间。它会进入图历史和快照，因此不能随意编造。

- 如果工作笔记明确给出时间，使用该时间并转成 ISO 格式。
- 如果用户明确说“就按今天记录”或“现在记录”，才可以使用当前会话日期时间。
- 如果工作笔记没有时间，必须先追问用户补充发生/记录时间，或建议先修改 `note.md` 补上时间；不要自己从当前系统时间、文件时间、会话时间里猜。
- 如果时间只精确到日期，可以使用该日期的本地时间并在 `operation_notes.md` 标明“时间精度仅到日期，具体时刻待确认”。

### 模型分析职责与追问边界

除 `timestamp` 这类必须由用户提供或确认的事实字段外，不要把图操作判断责任推给用户。你应该先基于 `note.md`、项目 README、description_summary、相关节点/边和历史 notes 自己分析并生成一版可预览、可审核的图操作草案。

以下事项默认是你在“工作笔记 -> 图操作”转换中要分析的内容，而不是要求用户逐项口述：

- 本轮工作更适合归入哪个已有 `goal` / `work_block` / `work_item`。
- 新结果影响哪个目标或问题。
- 新问题是否真的改变已有 issue 状态、解决度，还是只应作为结果里的观察。
- 是否存在前后顺承关系，以及是否应创建 `work_item -> work_item` 的 `next` 边。
- 哪些节点/边应该新增、更新，哪些 history 说明应写入。

只有当工作笔记和项目图数据都不足以支持一个可审核判断时，才追问用户或建议先修订 `note.md`。追问应说明缺口为什么会影响图操作，例如“无法判断本次结果应归属哪个工作块，会影响 work_item.linked_work_block_id 和后续布局归属”。如果可以生成有依据但存在不确定性的草案，应在 `operation_notes.md` 的“需审核点”标注，并生成可供用户审核的图操作预览，而不是提前要求用户逐项设计操作。

关键数字、比例、样本量、时间窗口存在冲突时，不要自行选择一个看起来合理的值；先在 `operation_notes.md` 的“需确认点”标出冲突。若冲突值会直接进入节点描述、分数或状态判断，且无法形成可靠草案，应追问用户或建议修订 `note.md`。

### 合法边类型

边不是“能连就连”的标签，而是表达两个节点之间的因果、产出、顺承或认知关系。选择边类型时，先判断起点节点是什么，再判断它对终点节点产生了什么作用。

只能使用本节列出的边类型和起点/终点组合。白名单以外一律非法，不要根据自然语言近义词自行发明、替换或扩展边类型。比如 `contains`、`produces`、`impacts`、`triggers_work`、`updates_issue_understanding`、`resolves_issue` 只是常见错误示例，不是完整错误清单。

事件 `event` 表达外部事实、客户动作、时间窗口变化、约束变化或关键反馈：

- `event -> work_item` 用 `leads_to`：事件直接导致要做一项工作，例如客户电话要求快速出架构方案。若同一个事件已经用 `event -> goal` 的 `generates` 产生某个目标，而该工作项只是该目标下工作块派生出的计划或任务，不要再给这个工作项补一条 `leads_to`；目标、工作块、工作项的归属已经表达了这层关系。只有事件独立、直接导致这项具体工作，且不是通过该目标/工作块自然派生时，才使用 `leads_to`。
- `event -> goal` 用 `generates`：事件使一个新目标成立或被明确识别。若只是本轮首次建档识别项目主目标，要非常谨慎，很多时候写进 goal/event 的 description 更自然；不要为了表达“项目背景导致项目存在”而机械连一条 `event -> goal`。
- `event -> goal` 用 `adjusts`：事件改变已有目标的范围、节奏、优先级、状态或成功标准。只有目标在当前图中已经存在时才适合。
- `event -> goal` 用 `cancels`：事件使已有目标不再成立或被放弃。
- `event -> issue` 用 `triggers`：事件触发一个新的、需要处理的问题。
- `event -> issue` 用 `affects`：事件加重、改变或暴露已有问题。
- `event -> result` 用 `forms`：事件本身形成一个可记录结果。
- `event -> result` 用 `modifies`：事件修正或改变已有结果的含义。

工作项 `work_item` 表达实际推进动作：

- `work_item -> work_item` 用 `next`：后一项工作自然承接前一项，存在明确顺承、前后依赖、失败后转向或基于上一轮结果继续推进。
- `work_item -> issue` 用 `discovers`：工作推进过程中已经发现、澄清或暴露出一个需要处理的问题。它不是“这个工作未来需要识别风险/问题”的计划关系。
- `work_item -> result` 用 `creates`：工作产出了一个新结果。
- `work_item -> result` 用 `modifies_work`：工作修正、补充或替换了已有结果。

目标 `goal` 表达目标层级：

- `goal -> goal` 用 `subgoal`：一个目标拆分出子目标。不要用它表达工作块归属或工作项归属。

问题 `issue` 表达待解决缺口对目标的影响：

- `issue -> goal` 用 `generates_goal`：问题促成一个新目标。历史图数据里可能存在 `issue -> goal` 的 `generates` 旧写法，但新草案不要再这样写；`generates` 优先留给 `event -> goal`。
- `issue -> goal` 用 `adjusts_goal`：问题改变已有目标的范围、优先级、节奏或成功标准。
- `issue -> goal` 用 `cancels_goal`：问题使已有目标不再成立或需要取消。

结果 `result` 表达工作产物、结论或验证结果带来的影响：

- `result -> issue` 用 `affects_issue`：结果直接修正了对问题的认识、严重性、处理方式或认知边界。它不是“问题解决度推进”的主表达；issue 的 `status` / `resolution_score` 通常应由具体 `work_item` 的分析、验证、修复、复盘和后续 `update_node issue` 推进。
- `result -> goal` 用 `generates_result`：结果促成一个新目标或使目标成立。
- `result -> goal` 用 `adjusts_result`：结果改变已有目标的状态、范围、完成度或判断。
- `result -> goal` 用 `cancels_result`：结果使已有目标不再成立。
- `result -> work_item` 用 `based_on`：后续工作项基于这个结果开展。

选择边类型时必须同时匹配节点类型和语义。比如语义上像“调整目标”，但起点是 `result`、终点是 `goal`，就应写 `adjusts_result`，不能写 `adjusts_goal`；起点是 `issue`、终点是 `goal`，才写 `adjusts_goal`。

### 边类型要匹配目标节点的新旧状态

边类型不仅要匹配起点/终点类型，还要匹配终点节点是“本轮新建”还是“图中已有”。如果终点是本轮刚创建的节点，不要使用表示调整、影响、修改或取消已有对象的边；如果终点是图中已有节点，不要使用表示产生、触发或创建新对象的边。

表示“产生/触发/创建新对象”的边，终点通常应是本轮新建节点：

- `event -> goal` 的 `generates`：事件产生新目标。
- `event -> issue` 的 `triggers`：事件触发新问题。
- `event -> result` 的 `forms`：事件形成新结果。
- `work_item -> result` 的 `creates`：工作项产出新结果。
- `issue -> goal` 的 `generates_goal`：问题促成新目标。
- `result -> goal` 的 `generates_result`：结果促成新目标。

表示“调整/影响/修改/取消已有对象”的边，终点必须是图中已有节点：

- `event -> goal` 的 `adjusts` / `cancels`：事件调整或取消已有目标。
- `event -> issue` 的 `affects`：事件影响已有问题；如果是新问题，用 `triggers`。
- `event -> result` 的 `modifies`：事件修改已有结果；如果是新结果，用 `forms`。
- `work_item -> result` 的 `modifies_work`：工作项修改已有结果；如果是新结果，用 `creates`。
- `issue -> goal` 的 `adjusts_goal` / `cancels_goal`：问题调整或取消已有目标；如果问题促成新目标，用 `generates_goal`。
- `result -> issue` 的 `affects_issue`：结果影响已有问题；如果工作中发现新问题，优先用 `work_item -> issue` 的 `discovers`。
- `result -> goal` 的 `adjusts_result` / `cancels_result`：结果调整或取消已有目标；如果结果促成新目标，用 `generates_result`。

`adjusts` / `adjusts_goal` / `adjusts_result` 表示“已有对象被本轮事实调整”。它不是“背景看起来改变了计划”的通用表达。`cancels` / `cancels_goal` / `cancels_result` 同理，表示已有对象被取消，不用于本轮新建节点。

- `event -> goal` 的 `adjusts` 通常只用于目标已经存在于当前图数据中，且本轮事件改变了这个已有目标的范围、节奏、优先级、状态或成功标准。
- 如果这个 goal 是本轮才被识别/创建出来的，不管当前图谱是不是空图，都不要创建 `event -> adjusts -> goal` 或 `issue/result -> adjusts_* -> goal`。这时更合适的表达通常是：
  - 只创建 goal，并在 goal.description/history 里写清楚它为什么成为当前主线；
  - 若事件直接催生了一个新工作项，用 `event -> work_item` 的 `leads_to`；
  - 若事件引出了一个需要处理的问题，用 `event -> issue` 的 `triggers` 或 `affects`；
  - 若问题或结果确实促成了新目标，用 `generates_goal` / `generates_result`；
  - 若事件确实“产生”了一个新目标，可谨慎使用 `event -> goal` 的 `generates`，但不要把“新目标被识别”写成“已有目标被调整”。
- 如果工作笔记里的背景描述大于当前项目范围，看起来像行业、客户策略或历史计划调整，但图里没有被调整的旧目标，不要为了表达背景而强行建调整类边；把这部分写进 event/goal/work_item 的 description 和 history 更稳。

### 新建节点不是被调整对象

影响一条边是否合法的关键不是“是不是首图”，而是终点节点在本轮操作前是否已经存在。只要终点是本轮新建节点，它就不是“被调整、被影响、被修改、被取消”的既有对象；这条规则在空图、非空图、项目初始化、普通推进、计划调整场景都适用。

当工作笔记描述某个事实改变了计划、目标、约束、风险或优先级时，先判断图中是否已有被调整的目标、问题或结果：

- 如果已有目标/问题/结果确实被本轮事实改变，可以使用对应调整类边或更新既有节点。
- 如果没有已有对象可被调整，而是本轮新建目标、问题或结果，不要为了表达“变化感”使用调整类边。
- 如果背景事实只是解释新目标为什么成立，优先写入新节点的 `description` 和 `history`。
- 如果一个事件直接导致新工作项，用 `event -> work_item` 的 `leads_to`。如果这个事件已经产生目标，而新工作项只是该目标下工作块的派生任务，不要重复创建 `event -> work_item`。
- 如果一个事件触发新问题，用 `event -> issue` 的 `triggers`。
- 如果一个问题或结果确实促成新目标，用 `issue -> goal` 的 `generates_goal` 或 `result -> goal` 的 `generates_result`。

项目第一次建图没有特殊的节点优先级，也不意味着要压低 `event` 或 `issue`。首图只说明“当前图中没有已有对象可被调整”，因此会影响 `adjusts`、`affects`、`modifies`、`cancels` 这类边能否使用；它不改变工作笔记中事实、问题、目标、工作和结果的语义判断。

- 如果工作笔记明确描述外部事实、客户动作、时间窗口变化、供应商反馈或资源约束变化，可以创建 `event`；是否创建取决于它是否是项目推进中的关键事实，而不是取决于是否首图。
- 如果工作笔记明确暴露出项目团队需要解决、澄清、验证或持续管理的实际缺口，可以创建 `issue`；是否创建取决于问题是否具体且有处理价值，而不是取决于是否首图。
- 如果工作笔记明确提出目标、阶段目标或目标调整，可以创建或更新 `goal`；首图中新建目标不能被写成“已有目标被调整”。
- 如果工作笔记明确提出一条工作线或下一步工作，可以创建 `work_block` / `work_item` 并用属性表达归属；未开始的工作项写 `planned`。
- 如果工作笔记记录了已经发生的工作产出、结论、验证结果或阶段进展，可以创建 `result`；没有已发生工作支撑时不要创建 result。
- 如果某个事实、问题、目标或工作在语义上成立，就正常建模；如果只是为了满足连通、套范式或让图看起来完整，不要创建额外节点。

### 常见图更新范式

生成草案时，先判断本轮属于下面哪些范式的组合，再填具体节点、边、状态、description 和 history。范式只是收敛思路，不是绕开合法性检查；每条边仍必须满足“起点/终点类型”和“终点新旧状态”两类规则。

| 范式 | 适用情况 | 常见操作 | 合法前提与解释 |
| --- | --- | --- | --- |
| 项目或阶段初始化 | 工作笔记给出了足以建立项目主线、阶段目标、外部触发事实或起步工作的材料 | 按证据新建 `event`、`goal`、`work_block`、`work_item`、`issue` 中实际成立的节点；可用 `event -> generates -> goal` 或 `event -> leads_to -> work_item` | 不存在固定必建组合。`work_block` 用 `linked_goal_id` 归属目标；`work_item` 用 `linked_work_block_id` 归属工作块；未开始 work_item 写 `planned`。只有事件确实使新目标成立时才用 `event -> generates -> goal`，不要为了首图完整性机械建边。若事件已经产生目标，该目标下工作项不要再机械直连同一事件。 |
| 外部事件推动具体工作 | 客户催办、资源变化、时间窗口变化直接导致要做某项工作 | 新建或更新 `event`、新建 `work_item`；用 `event -> leads_to -> work_item` | 适合表达“事件导致要做这项工作”。不要用 `triggers` 连接 event 和 work_item；`triggers` 只用于 event 触发 issue。 |
| 工作推进产出结果 | 某项工作已经推进或完成，并产生结论、交付物、验证结果或阶段进展 | 更新 `work_item`；新建 `result`；用 `work_item -> creates -> result`；必要时 `result -> adjusts_result -> existing_goal` | `work_item` 不能是未开始的 `planned`；`result` 必须有已发生工作支撑。`adjusts_result` 只能指向已有 goal；如果目标也是本轮新建，不要用调整类边。 |
| 工作修正已有结果 | 本轮工作补充、修正、替换或推翻已有结果 | 更新 `work_item`；更新已有 `result`；用 `work_item -> modifies_work -> existing_result` | `result` 必须已存在。若本轮产生的是新结果，用 `creates`，不要用 `modifies_work`。 |
| 工作中发现问题 | 问题是在分析、验证、实施、沟通或复盘过程中被发现或澄清 | 新建或更新 `issue`；用 `work_item -> discovers -> issue` | 起点 work_item 必须有已推进证据。planned work_item 不能 discovers。issue 应是可处理、可澄清、可验证或需持续管理的实际缺口，不是泛化风险感受。 |
| 问题促成新目标 | 一个具体问题足以拉出新的目标或工作线 | 新建 `goal`；可新建 `work_block` 和起步 `work_item`；用 `issue -> generates_goal -> goal` | `goal` 必须是本轮新建；不要用旧写法 `issue -> generates -> goal`。如果问题只是调整已有目标，用 `adjusts_goal` 指向已有 goal。 |
| 已有目标被事件调整 | 外部事件改变已有目标的范围、节奏、优先级、状态或成功标准 | 新建或更新 `event`；更新已有 `goal`；用 `event -> adjusts -> existing_goal` | 目标必须已存在。不要把本轮新建 goal 写成“被调整”；新目标成立通常用 description/history 或 `generates` 表达。 |
| 顺承推进 | 新工作明确承接前序工作、失败后转向、基于上一轮结果继续推进 | 新建后续 `work_item`；用 `previous_work_item -> next -> new_work_item` | `next` 表示已发生或明确的推进顺承，不表示普通计划拆分。若只是计划中的并列任务，写进 work_block/work_item 描述或需审核点。 |
| 结果驱动后续工作 | 已有结果成为后续工作依据 | 新建或更新 `work_item`；用 `result -> based_on -> work_item` | 这是低频关系，只在工作笔记明确说“基于该结果开展后续工作”时使用。不要用它替代 `next` 或工作块归属。 |

范式选择时优先保持图更新克制：

- 一个事实不要同时拆成同义 `event` 和 `issue` 再共同指向同一目标。
- 一个 planned 工作项通常只创建计划节点和归属关系，不创建 result，也不 discovers issue。
- 一个 result 通常要能回答“哪项工作产生或修正了它”；找不到来源时先标需审核点。
- 更新已有 goal/work_block/issue/result 时，description 应表达更新后的当前认知；history 写本轮变化原因和图关系上下文。

### 生成前硬自检

写入 `operations.draft.json` 前必须逐项自检。以下错误是历史迭代中实际出现过的低级错误，不能重复：

- 所有 `edge_type` 必须来自“合法边类型”白名单，并且起点/终点类型必须匹配该白名单。
- 不要使用任何白名单以外的边类型；常见错误包括 `belongs_to`、`contains`、`produces`、`impacts`、`triggers_work`、`updates_issue_understanding`、`resolves_issue`、`updates`，但错误类型不止这些。
- `event -> work_item` 只能使用 `leads_to`，不能使用 `triggers`、`triggers_work` 或其他近义词。
- 如果同一个 `event` 已经 `generates` 某个 `goal`，而某个 `work_item` 通过 `linked_work_block_id -> work_block.linked_goal_id` 归属于该 `goal` 或其子目标链下，不要再创建这个 `event -> work_item` 的 `leads_to`。这会把“目标派生出的工作”重复建成“事件直接导致的工作”。
- 不要给 `goal -> work_block`、`work_block -> goal`、`work_block -> work_item`、`work_item -> work_block` 建边；这些是属性关系，不允许用任何边类型绕开。
- 工作项归属工作块，只能在 `create_node.fields.linked_work_block_id` 或 `update_node.field_updates.linked_work_block_id` 里写。
- 工作块归属目标，只能在 `create_node.fields.linked_goal_id` 或 `update_node.field_updates.linked_goal_id` 里写。
- 不要在 compressed draft 里写 `linked_work_blocks` 或 `work_items` 反向列表；它们由图引擎根据 `linked_goal_id` / `linked_work_block_id` 维护。
- 不要把“需要做/计划做/客户要求做/后续要做”的 work_item 写成 `active` 或 `in_progress`；没有已经开始推进的证据时，写 `planned`。
- 不要从 planned work_item 创建 `discovers` 边；工作还没推进就不能发现问题。
- 不要从 planned work_item 创建 `creates` / `modifies_work` result 边；工作还没推进就不能产出或修正结果。
- 不要从 planned work_item 创建表示已发生承接的 `next` 边；只有已推进工作产生了自然承接、失败后转向或基于上一轮结果继续推进，才使用 `next`。
- 不要把“未来需要识别风险/暴露问题/验证可行性”写成 `discovers`；这是 work_item 的预期任务或成功标准，不是已发生发现关系。
- `result -> issue` 只能使用 `affects_issue`，不能使用 `adjusts_result`。
- `result -> goal` 才使用 `generates_result`、`adjusts_result` 或 `cancels_result`。
- `work_item -> result` 使用 `creates` 或 `modifies_work`；不要写 `produces`。
- `history` 是每个 item 内的一段本轮变更说明字符串。
- 顶层必须是 `change_id`、`timestamp`、`note_filename`、`changelog_entry`、`items`；不要写 `description`、`operations`、`commands`，执行层不会把旧 GraphCommand 或旧 commands schema 当作新草案兼容处理。

如果某个关系无法落到上面的合法组合，优先在 `operation_notes.md` 标成“需审核点”或追问用户，不要发明边类型。

### 属性关系不能建边

以下关系通过节点属性维护，不创建边：

- `goal` 和 `work_block`：compressed draft 只写 `work_block.linked_goal_id`，`goal.linked_work_blocks` 由图引擎维护。
- `work_block` 和 `work_item`：compressed draft 只写 `work_item.linked_work_block_id`，`work_block.work_items` 由图引擎维护。

因此不要创建“工作块包含工作项”“目标包含工作块”之类边。比如不要创建 `work_block -> work_item` 的 `contains` 边，也不要用任何替代边类型表达这个属性关系。

### 顺承关系检查

如果本轮工作笔记明确承接上一项工作、失败后的反思、基于前序结果继续推进，必须查找前序 `work_item`，并优先考虑创建 `work_item -> work_item` 的 `next` 边。

但 `next` 不能泛用。只有存在自然顺承、前后依赖、失败后转向、基于上一轮结果继续推进时才创建。若不确定，在 `operation_notes.md` 的“需审核点”里说明候选前序工作项，不要强行建边。

### 工作项状态和发现关系

`work_item.status` 必须反映工作是否已经实际开始或完成，不要把“需要做、计划做、客户要求做、后续要做”直接写成 `in_progress`。

- 如果工作笔记只说明某项工作需要开展、计划开展或刚被提出，状态通常是 `planned`。
- 只有工作笔记明确说明已经开始推进、正在产出、已经分配执行或已有过程材料时，才写 `in_progress`。
- 只有工作笔记明确说明已经完成并产生交付物、结论或阶段进展时，才写 `finished`。

`work_item -> issue` 的 `discovers` 也必须有已发生的工作过程支撑：

- 如果问题是在工作推进、分析、验证、实施、沟通或复盘过程中被发现或澄清，可以创建 `work_item -> issue` 的 `discovers`。
- 如果工作项只是计划要做，不能说它已经发现了问题；这类问题应由触发事件、背景事实或工作笔记本身来承载，必要时创建 issue 但不创建 `discovers` 边。
- 如果某项工作未来需要识别风险或暴露问题，把这写进 work_item.description、成功标准或需审核点，不要创建 `discovers` 边。

### 先区分事实、问题和结果

从工作笔记抽图时，先判断一段内容是在说外部事实、待处理问题，还是工作产出。不要因为一句话看起来有“影响”就拆成多个节点。

- `event`：外部发生的事实、客户动作、时间窗口变化、供应商反馈、资源约束变化。它解释为什么要调整推进方式，但不一定是项目团队能直接解决的问题。
- `issue`：项目推进中需要被解决、澄清、验证或持续管理的缺口。它应该能自然引出后续工作项、验证动作、治理动作或决策动作。
- `result`：某项工作已经得到的产物、结论、验证结果、阶段进展或沉淀物。它和工作动作强相关，通常应能回答“哪项工作产生了这个结果”。

如果内容只是“因为某外部事实 A，所以带来风险或压力 B”，不要机械拆成两个 issue。先判断 A 是否只是触发事实：

- 如果 A 是外部反馈、外部约束、资源变化或时间窗口变化，通常更接近 `event`，或作为相关节点 description/history 的原因背景。
- 如果 B 只是泛化的风险、压力或不确定性表述，不要直接建 issue；必须先识别出其中具体需要处理、澄清、验证或决策的缺口。
- 如果 A 和 B 本质上描述同一条因果链，优先保留一个真正需要处理的 issue，把原因写进它的 description/history；不要创建“原因 issue”和“结果 issue”两个节点。

### 新结果归属检查

`result` 一般偏向“因为某项工作而得到的结论或产生的进展”。如果本轮新增 `result`，通常必须能追溯到产生它的工作项：

- 优先创建 `work_item -> result` 的 `creates` 边。
- 如果是修正既有工作产物，可考虑 `work_item -> result` 的 `modifies_work` 边。
- `result -> goal` 或 `result -> issue` 只说明结果影响了什么，不能替代“谁产生了这个结果”的归属关系。

不要把以下内容轻易建成 `result`：

- 还没有实际开展的 planned 工作“将要”得到的判断。
- 工作笔记作者对背景变化做出的初步影响判断，但没有对应的已完成工作、分析过程、验证动作或交付物。
- 只是对目标、计划、约束或风险的重新理解，但没有对应工作产出、验证结论或交付物。

如果工作项仍是 `planned`，通常不能说它已经 `creates` 了一个 result。除非工作笔记明确说明“本轮已经完成了某项分析/沟通/验证，并得出了该结论”，否则不要创建 `work_item -> result` 的 `creates` 边。

如果无法判断哪个工作项产生了结果，先在 `operation_notes.md` 标出需确认点；若缺口会导致布局无法归属，应追问用户或建议补充工作笔记。

### Issue 更新要克制

不要因为工作笔记提到某个问题，就默认更新该 issue 的状态或解决度。优先判断：

- 这次是否真的改变了问题状态或解决进度。
- 是否只是一个结果节点中的观察、证据或局限。
- 人审 command 是否更适合把问题认识收敛到结果节点和目标/工作块描述里，而不是直接更新 issue。

如果只是补充认识，且没有明确治理动作或解决进展，优先在 `operation_notes.md` 标为“可选更新/需人工确认”，不要直接提高 `resolution_score`。

### Issue 创建要有处理价值

`issue` 偏向“需要被解决、澄清或持续管理的实际问题”，不是对风险、压力或情绪的笼统感受。新建 issue 前必须同时满足：

- 它是一个可被处理的问题：后续可以拉出工作项、验证动作、治理动作或决策动作来应对。
- 它有一定主题性：足够影响一条工作线或一个工作块的推进，不是某个很细碎的实现点、一次性疑问或泛泛的风险提示。
- 它的表述要指向问题本体和待处理缺口，而不是只写“风险上升”“压力很大”“不确定性增加”。

不推荐把下面这类泛化表述直接作为 issue：

- 某类风险上升。
- 压力变大。
- 不确定性增加。

更推荐把它改写成可处理的问题，例如：

- 某个范围或边界尚未收敛。
- 某个集成路径、责任边界或验证标准需要澄清。
- 某个关键假设、可行性或约束需要验证。

如果工作笔记只是给出泛化风险判断，但没有说明具体待解决缺口，优先在 `operation_notes.md` 写成需审核点；不要为了连一条 `event -> issue` 边而创建虚泛 issue。

当工作笔记描述一条因果链时，issue 要落在“需要处理的缺口”上，而不是把原因和风险各建一个 issue：

- 外部原因本身不一定是 issue；只有项目团队需要处理、澄清、验证或持续管理的缺口才是 issue。
- “风险上升”“压力增大”“不确定性增加”不能直接成为 issue；必须落到具体缺口。
- 如果原因事实已经用 `event` 或节点 description 表达，就不要再创建一个同义 issue。

### 数字冲突要显式标注

工作笔记内出现不同数字、比例、时间或状态时，不要自行选择一个看起来合理的值。必须：

- 在 `operation_notes.md` 的“需确认点”里标出冲突。
- 除非上下文明确，否则不要把冲突数字写进最终判断性描述。

## 判断清单

一次工作笔记可能同时命中多个场景。不要把它们当作三个独立流程。

### 外部变化

判断：

- 是否有新事件、客户要求、时间窗口、资源约束或外部反馈。
- 它是产生目标、调整已有目标、取消已有目标，还是引发需要处理的问题。若当前图里没有被调整的旧目标，不要使用 `adjusts` 表达“新目标被识别/提前成为主线”。
- 是否需要更新已有工作项的范围、优先级、状态或描述。

常见图更新：

- 新建或更新 `event`
- 更新 `goal`、`issue`、`work_item`
- 创建 `generates`、`adjusts`、`cancels`、`triggers`、`affects` 等边

### 计划梳理

判断：

- 这是新目标、新工作块、新工作项，还是已有工作项的后续。
- 是否是试探性验证、低成本实验、备选路径或临时调整。
- 是否存在前置条件、假设、成功标准、停止条件或软依赖。

常见图更新：

- 新建或更新 `goal`、`work_block`、`work_item`
- 创建 `subgoal`、`next`、`based_on`、`generates_goal`、`adjusts_goal` 等边

### 工作进展

判断：

- 是已有工作项完成/推进，还是新工作项。
- 是否产生新结果、修正旧结果、发现新问题或验证/推翻原判断。
- 是否影响目标状态、完成度、描述和后续计划。

常见图更新：

- 更新 `work_item.status`、`description`；根据本轮工作笔记是否适合作为长期详情来源，决定是否显式更新 `detail_url`
- 新建或更新 `result`、`issue`
- 更新 `goal`、`work_block`
- 创建 `creates`、`modifies_work`、`discovers`、`adjusts_result` 等边

## 输出产物

先使用原版 `write` / `edit` / `apply_patch` 写入 active workflow 产物文件：

- `workflows/active/operation_notes.md`
- `workflows/active/operations.draft.json`

不要写入以下文件，它们由后端执行层生成：

- `workflows/active/operations.json`
- `workflows/active/operation_index.json`
- `workflows/active/validation.json`
- `workflows/active/preview.json`
- `workflows/active/preview_graph/`

然后通过 `workflow_action` 的 `生成图操作草案` 动作登记产物。payload 只包含小清单，不包含草稿正文：

```json
{
  "summary": "本轮图操作草案摘要",
  "change_id": "stepN_...",
  "artifacts": {
    "operationNotes": true,
    "operationsDraft": true
  }
}
```

不要通过 `workflow_action` 传 `operation_notes`、`draft`、`operation_index`、`command`、`operations` 或 `history_descriptions` 正文。`workflow_action` 是轻量状态机工具，不是大文件写入工具。

如果信息不足以生成 `operations.draft.json`，不要强行写一个猜测版本；应先在聊天框追问用户，或建议先补充 `note.md`。

## operation_notes 写法

`operation_notes` 是给用户看的自然语言草稿，风格接近项目历史的 `steps*.txt`。它应该包含：

- 本轮工作笔记表达了什么变化。
- 这次准备新增哪些节点、更新哪些节点、创建哪些边。
- 为什么这么更新。
- 哪些节点/边映射不确定，需要用户确认。
- 本次准备追加哪些 history 语义。
- 本次工作笔记归档文件名草稿。这个内容必须写入 `operations.draft.json.note_filename`，用语义化英文/拼音 snake_case 文件名，不能机械使用 change_id。
- 本次工作笔记与 event/work_item 的挂载判断：逐个说明哪些节点适合把该笔记作为长期详情来源、哪些不适合，以及理由。没有合适节点时明确说明“不挂节点，通过 changelog 查找”。
- 本次 changelog 增量草稿。这个内容必须同时写入 `operations.draft.json.changelog_entry`，提交时后端会使用该字段追加 `changes/changelog.txt`。

不要在 `operation_notes` 里贴大段 JSON。JSON 放到 `operations.draft.json`。

## operations.draft.json 写法

`operations.draft.json` 是模型写出的压缩结构化图操作草案。它不是最终执行文件，必须使用后端能机械编译的语义 delta 结构。顶层必须包含 `note_filename` 和 `changelog_entry`：

- `change_id`：新建普通工作推进草案必须使用 `step数字_语义短名`。首轮提交从 `step0_` 开始，后续按已提交普通推进递增，例如 `step1_...`、`step2_...`。软更正按 `project-workflow-correction-draft` Skill 使用后端指定的 `correction数字_` 前缀；如果后端给出完整 ID 或既有草案已经带有完整 ID，必须原样保留。任何模式都不要写 `workflow_...`，也不要自行跳号；如果后端校验返回期望前缀或完整 ID，必须按返回值修订。
- `note_filename`：当前 `workflows/active/note.md` 在确认提交后归档到 `notes/` 下的语义化文件名。它必填，工作笔记也必须存在并归档。必须根据工作笔记主题命名，例如 `knowledge_entry_point.md`、`distinction_sort.md`、`improvement_plan.md`，不要用 change_id 机械命名。后端会做安全转义、补 `.md` 后缀和冲突处理，并保证最终路径出现在 changelog 中；后端不会因此强制修改任何节点的 `detail_url`。
- `changelog_entry`：本次要追加到 `changes/changelog.txt` 的完整记录。写法要像旧记录一样，用介绍项目进度的语言串起本轮工作、产生的结果或问题、对目标/工作块的影响，同时点明关键节点 ID。通常形如 `[YYYY-MM-DD HH:mm] change_id: ...`。

- `create_node`：模型写 `node_type`、`summary`、`description`、必要 `fields` 和 `history`；执行层补齐默认字段并生成最终 `create_node.data`。
- `update_node`：模型写要变更的 `field_updates`，并根据节点职责选择 `description` 或 `description_delta`。执行层会把 `description` 作为完整当前状态说明采用；若只提供 `description_delta`，执行层读取旧节点 description 后合并为最终 `updates.description`。
- `create_edge`：模型写端点、边类型和说明；执行层生成最终 `create_edge`。
- `update_edge`：模型写新说明或说明增量、原因；执行层生成最终 `update_edge`。
- 不使用 `op`、`command`、`operations`、`history_descriptions` 字段。
- 不使用顶层 `description` 字段；自然语言说明只写入 `operation_notes.md`。

`temp_id` 本来就是最终图引擎支持的字段，不要另造 `proposed_id` 或让后端猜测 ID。

### 工作笔记归档与 detail_url

工作笔记归档和节点详情挂载是两件事：

- 每轮必须有 `note.md` 和 `note_filename`。提交时后端一定把笔记归档到 `notes/`，并把最终路径追加到本轮 changelog；即使没有节点引用它，用户也能从项目时间线找到笔记。
- 如果本轮 create/update 了 `event` 或 `work_item`，逐个判断该笔记是否是该节点长期有效、主题匹配的详情来源。适合时在 `create_node.fields.detail_url` 或 `update_node.field_updates.detail_url` 中显式写 `notes/<note_filename>`。
- 笔记只是跨节点过程记录、主题不专属于某个节点，或不适合取代节点原有详情时，不写 `detail_url`。不能为了让笔记“有地方挂”而强行关联。
- `goal`、`work_block`、`issue`、`result` 通常不直接挂本轮工作笔记。不要把 `detail_url` 写成执行层自动派生字段，也不要依赖后端替模型选择节点。
- `operation_notes.md` 必须记录上述判断，独立 reviewer 会同时检查不当挂载和明显漏挂。
- 若最终归档因重名产生后缀，后端只会把草案中明确写成 `notes/<note_filename>` 的引用改成实际路径；模型无需猜测后缀。

新建节点的 `description` 写当前节点说明。更新已有节点时要区分两类情况：

- `goal`、`work_block`、长期存在的 `issue`、核心 `result`：这些节点的 `description` 通常承担“当前状态/当前认知总结”的作用。更新它们时，优先写更新后的完整当前状态总结到 `description`，把历史演进消化成一段可读的现状说明，而不是简单追加一句。
- 普通 `work_item` 状态变化、局部事实补充、低风险描述追加：可以写 `description_delta`，由执行层机械追加到旧 description。

判断标准：如果用户打开这个节点时需要直接看到“截至当前这个节点到底是什么状态、有什么结论、还有什么限制”，就写完整 `description`；如果只是给原说明补一个局部事实，才写 `description_delta`。

`description` 写当前状态总结，`history` 写本轮为什么变、证据来自哪里、影响了什么，并按旧格式包含 `[change_id]` 和必要图关系上下文。本次历史说明写入每个 item 的 `history`。`note_filename` 写工作笔记归档文件名，`changelog_entry` 写本轮项目时间线记录，面向人阅读，不等同于 item history。执行层会从 draft 生成最终 `operations.json`、`history_descriptions` 和 `changelog_entry.txt`，并保留旧 `description` 里的可读 `历史记录：` 段，把本轮 `history` 插到最前面；图引擎在真正应用时负责追加节点/边结构化 `history[]` 和快照。

示例：

```json
{
  "change_id": "step0_pilot_validation",
  "timestamp": "2026-07-06T10:00:00+08:00",
  "note_filename": "pilot_validation_result.md",
  "changelog_entry": "[2026-07-06 10:00] step0_pilot_validation: 完成某项阶段工作(work_item_x)，产生某项结果(result_z)，并推动某个目标(goal_y)进展；图数据新增工作项、结果节点及工作项到结果的 creates 关系",
  "items": [
    {
      "kind": "update_node",
      "node_id": "goal_x",
      "field_updates": {
        "status": "in_progress",
        "completion_score": 40
      },
      "description": "目标当前状态总结：已完成试探性验证，验证结果支持继续推进；当前目标处于进行中状态，后续需要扩大样本范围并确认方案稳定性。",
      "history": "[step0_pilot_validation] 目标进度更新，因本轮试探性验证完成，completion_score从20提升到40，status保持\"in_progress\"；此目标被阶段验证结果影响，支持继续扩大样本范围（结果节点id: result_z）"
    }
  ]
}
```

新建节点示例：

```json
{
  "change_id": "step1_next_step_plan",
  "timestamp": "2026-07-06T10:00:00+08:00",
  "note_filename": "next_step_plan.md",
  "changelog_entry": "[2026-07-06 10:00] step1_next_step_plan: 创建工作项(work_item_x)以推进工作块(work_block_y)，记录本轮计划或进展；图数据新增工作项节点并关联工作块属性",
  "items": [
    {
      "kind": "create_node",
      "temp_id": "work_item_x",
      "node_type": "work_item",
      "summary": "工作项短标题",
      "description": "新工作项当前说明",
      "fields": {
        "status": "planned",
        "linked_work_block_id": "work_block_y"
      },
      "history": "[step1_next_step_plan] 创建工作项短标题，用于推进下一步计划；状态设置为planned，关联到work_block_y；工作项被对应工作块归属（工作块节点id: work_block_y）"
    }
  ]
}
```

新建边示例：

```json
{
  "change_id": "step2_stage_result_review",
  "timestamp": "2026-07-06T10:00:00+08:00",
  "note_filename": "stage_result_review.md",
  "changelog_entry": "[2026-07-06 10:00] step2_stage_result_review: 工作项(work_item_x)产生结果(result_z)，形成新的阶段产物；图数据新增工作项到结果的 creates 关系",
  "items": [
    {
      "kind": "create_edge",
      "temp_id": "edge_work_item_creates_result",
      "from_node": "work_item_x",
      "to_node": "result_z",
      "edge_type": "creates",
      "description": "工作项产生结果",
      "history": "[step2_stage_result_review] 建立工作项到结果的creates关系，表示工作项短标题产出某项结果（工作项节点id: work_item_x；结果节点id: result_z）"
    }
  ]
}
```

## 重要边界

- 不直接写 `nodes/`、`edges/`、`snapshots/`、`descriptions_output/`、`changes/changelog.txt`。
- 不直接用原版 `write` / `edit` / `apply_patch` 修改图数据文件。
- 可读 `description` 里的旧历史记录保留和本次 history 插入由执行层编译 draft 时负责；结构化 `history[]` 追加和 snapshot 写入由图引擎 apply 时负责。模型只写每个 item 的最新一条历史说明字符串。
- graph schema、节点边引用、布局语义归属、dry-run、preview、apply 都由后端代码负责。
- 后端会把 `operations.draft.json` 编译为 `operations.json` 后做硬校验：非法 `type`、非法 `edge_type`、不存在节点引用、属性关系建边、布局语义无法归属都会被拒绝。
- 如果工作笔记事实不足以判断图操作，先指出缺口并建议补充工作笔记，不要强行生成。
- 如果用户只指出图操作判断不对，优先修订图操作草案，不默认要求修改工作笔记。
- 如果用户补充了新的事实依据，应先建议修改 `note.md`，再重新生成草案。

## 调用建议

完成图操作说明和 `operations.draft.json` 写入后调用：

```json
{
  "action": "生成图操作草案",
  "payload": {
    "summary": "已生成图操作说明和结构化 draft。",
    "change_id": "stepN_...",
    "artifacts": {
      "operationNotes": true,
      "operationsDraft": true
    }
  }
}
```

保存后向用户说明：

- 已生成图操作草案，并已由 workflow 执行层自动校验。
- 用户可以在页面的图操作预览区域查看自然语言说明和后续图谱预览。
- 如果 workflow_action 返回 `validation.passed=false`，必须根据返回的 `validation.issues` 或 `validation.json` 修订 `operations.draft.json` 后重新调用 `生成图操作草案`。
- 如果需要人工修改，请在聊天框提出意见。
