# 项目工作推进图操作草案 Skill

## 目标

把当前 active workflow 的工作笔记转成可审核、可校验的图操作草案。

你不是直接修改正式图数据，也不要直接写最终 `operations.json`。你要先生成给人看的自然语言说明，再生成压缩的结构化 `operations.draft.json`，把它们写入 active workflow 草案区，最后通过 `workflow_action` 登记这些草案产物已经写好。后端执行层会从 draft 编译生成 `operations.json`、`operation_index.json`、`validation.json`、`preview.json` 和 `preview_graph`；校验通过时，图谱预览会同步生成。用户审核的是自然语言化的图操作说明、代码派生的图操作索引和图谱预览，不是让用户手改内部 JSON。

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
- 每个 item 使用 `kind` 字段，不要使用 `type`、`command` 或 `op` 字段表示操作。
- 合法 `kind` 只有：`create_node`、`update_node`、`create_edge`、`update_edge`。
- `create_node` 写：`kind`、`temp_id`、`node_type`、`summary`、`description`、可选 `fields`、`history`。
- `update_node` 写：`kind`、`node_id`、可选 `field_updates`、`description_delta` 或 `description`、`history`。
- `create_edge` 写：`kind`、`temp_id`、`from_node`、`to_node`、`edge_type`、`description`、`history`。
- `update_edge` 写：`kind`、`edge_id`、`new_description` 或 `description_delta`、可选 `reason`、`history`。
- `history` 只写本轮变化的历史说明。不要写完整旧历史数组。

### ID 引用格式

如果边或更新引用本轮新建节点，直接使用该节点 item 的 `temp_id` 原文。

示例：先创建 `temp_id: "work_item_plan_validation"`，后续边的 `from_node` 就写 `"work_item_plan_validation"`。不要加 `temp:` 前缀，也不要写成 `node:work_item_plan_validation`、`proposed_id` 或其他包装格式。

### history 字段写法

在 draft 里，模型只写每个 item 的 `history` 字符串。它是本轮新增到该节点或边上的一条可读历史说明，写清楚“为什么变更、依据是什么、影响是什么”。这条历史要尽量贴近旧图数据 description 里的格式：

- 开头使用 `[change_id]`，例如 `[step18_knowledge_scheme] ...`。
- 前半段写本节点/边本次发生了什么：创建、状态变化、完成度变化、描述更新、结果产出或问题认识变化。
- 后半段写图关系上下文：本次又和哪个目标、工作块、工作项、结果或问题建立/强化了联系，并写出节点 id，例如 `（结果节点id: result_x）`、`（工作块节点id: work_block_y）`。
- 不要只写“更新状态”“创建节点”“建立关系”这类过短说明。

后端会把 `item.history` 编译成 `operations.json.history_descriptions`。执行层会补齐缺失的 `[change_id]` 前缀，并根据本轮属性归属和边操作补充一部分确定性的图关系上下文；但语义主体必须由模型写好，不能把完整语义历史都推给代码。正式图数据里的节点/边 `history[]`、`serialized_data` 快照和去循环引用都由图引擎追加和维护。

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

只能使用以下小写边类型，严禁发明 `contains`、`produces`、`impacts`、`updates_issue_understanding`、`resolves_issue` 等不存在的边类型：

- 事件到工作项/目标/问题/结果：`leads_to`、`generates`、`adjusts`、`cancels`、`triggers`、`affects`、`forms`、`modifies`
- 工作项到工作项/问题/结果：`next`、`discovers`、`creates`、`modifies_work`
- 目标到目标：`subgoal`
- 问题到目标：`generates_goal`、`adjusts_goal`、`cancels_goal`
- 结果到问题/目标/工作项：`affects_issue`、`generates_result`、`adjusts_result`、`cancels_result`、`based_on`

边类型和节点类型必须匹配：

- `work_item -> result` 用 `creates` 或 `modifies_work`。
- `result -> goal` 用 `generates_result`、`adjusts_result` 或 `cancels_result`。
- `result -> issue` 用 `affects_issue`。
- `issue -> goal` 才用 `generates_goal`、`adjusts_goal` 或 `cancels_goal`。
- `work_item -> issue` 用 `discovers`。
- `work_item -> work_item` 只有存在明确顺承或前后依赖时才用 `next`。

选择边类型时先看起点节点类型。即使语义上是“调整目标”，只要起点是 `result`、终点是 `goal`，也应写 `adjusts_result`，不能写 `adjusts_goal`。

### 生成前硬自检

写入 `operations.draft.json` 前必须逐项自检。以下错误是历史迭代中实际出现过的低级错误，不能重复：

- 不要使用 `belongs_to`。它不是合法边类型，也不能用来表达归属。
- 不要使用 `contains`、`produces`、`impacts`、`updates_issue_understanding`、`resolves_issue`、`updates` 这类自然语言边类型。
- 不要给 `goal -> work_block`、`work_block -> goal`、`work_block -> work_item`、`work_item -> work_block` 建边；这些是属性关系，不允许用任何边类型绕开。
- 工作项归属工作块，只能在 `create_node.fields.linked_work_block_id` 或 `update_node.field_updates.linked_work_block_id` 里写。
- 工作块归属目标，只能在 `create_node.fields.linked_goal_id` 或 `update_node.field_updates.linked_goal_id` 里写。
- 不要在 compressed draft 里写 `linked_work_blocks` 或 `work_items` 反向列表；它们由图引擎根据 `linked_goal_id` / `linked_work_block_id` 维护。
- `result -> issue` 只能使用 `affects_issue`，不能使用 `adjusts_result`。
- `result -> goal` 才使用 `generates_result`、`adjusts_result` 或 `cancels_result`。
- `work_item -> result` 使用 `creates` 或 `modifies_work`；不要写 `produces`。
- `history` 是每个 item 内的一段本轮变更说明字符串。
- 顶层必须是 `change_id`、`timestamp`、`note_filename`、`changelog_entry`、`items`；不要写 `operations`、`commands`，执行层不会把旧 GraphCommand 或旧 commands schema 当作新草案兼容处理。

如果某个关系无法落到上面的合法组合，优先在 `operation_notes.md` 标成“需审核点”或追问用户，不要发明边类型。

### 属性关系不能建边

以下关系通过节点属性维护，不创建边：

- `goal` 和 `work_block`：compressed draft 只写 `work_block.linked_goal_id`，`goal.linked_work_blocks` 由图引擎维护。
- `work_block` 和 `work_item`：compressed draft 只写 `work_item.linked_work_block_id`，`work_block.work_items` 由图引擎维护。

因此不要创建“工作块包含工作项”“目标包含工作块”之类边。比如不要创建 `work_block -> work_item` 的 `contains` 边，也不要用任何替代边类型表达这个属性关系。

### 顺承关系检查

如果本轮工作笔记明确承接上一项工作、失败后的反思、基于前序结果继续推进，必须查找前序 `work_item`，并优先考虑创建 `work_item -> work_item` 的 `next` 边。

但 `next` 不能泛用。只有存在自然顺承、前后依赖、失败后转向、基于上一轮结果继续推进时才创建。若不确定，在 `operation_notes.md` 的“需审核点”里说明候选前序工作项，不要强行建边。

### 新结果归属检查

如果本轮新增 `result`，通常必须能追溯到产生它的工作项：

- 优先创建 `work_item -> result` 的 `creates` 边。
- 如果是修正既有工作产物，可考虑 `work_item -> result` 的 `modifies_work` 边。
- `result -> goal` 或 `result -> issue` 只说明结果影响了什么，不能替代“谁产生了这个结果”的归属关系。

如果无法判断哪个工作项产生了结果，先在 `operation_notes.md` 标出需确认点；若缺口会导致布局无法归属，应追问用户或建议补充工作笔记。

### Issue 更新要克制

不要因为工作笔记提到某个问题，就默认更新该 issue 的状态或解决度。优先判断：

- 这次是否真的改变了问题状态或解决进度。
- 是否只是一个结果节点中的观察、证据或局限。
- 人审 command 是否更适合把问题认识收敛到结果节点和目标/工作块描述里，而不是直接更新 issue。

如果只是补充认识，且没有明确治理动作或解决进展，优先在 `operation_notes.md` 标为“可选更新/需人工确认”，不要直接提高 `resolution_score`。

### 数字冲突要显式标注

工作笔记内出现不同数字、比例、时间或状态时，不要自行选择一个看起来合理的值。必须：

- 在 `operation_notes.md` 的“需确认点”里标出冲突。
- 除非上下文明确，否则不要把冲突数字写进最终判断性描述。

## 判断清单

一次工作笔记可能同时命中多个场景。不要把它们当作三个独立流程。

### 外部变化

判断：

- 是否有新事件、客户要求、时间窗口、资源约束或外部反馈。
- 它是产生目标、调整目标、取消目标，还是引发问题。
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

- 更新 `work_item.status`、`description`；不要手写 `detail_url`，执行层会根据 `operations.draft.json.note_filename` 统一补到相关 work_item 上
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
  "change_id": "workflow_...",
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
- 本次 changelog 增量草稿。这个内容必须同时写入 `operations.draft.json.changelog_entry`，提交时后端会使用该字段追加 `changes/changelog.txt`。

不要在 `operation_notes` 里贴大段 JSON。JSON 放到 `operations.draft.json`。

## operations.draft.json 写法

`operations.draft.json` 是模型写出的压缩结构化图操作草案。它不是最终执行文件，必须使用后端能机械编译的语义 delta 结构。顶层必须包含 `note_filename` 和 `changelog_entry`：

- `note_filename`：当前 `workflows/active/note.md` 在确认提交后归档到 `notes/` 下的语义化文件名。必须根据工作笔记主题命名，例如 `knowledge_entry_point.md`、`distinction_sort.md`、`improvement_plan.md`。不要用 change_id 机械命名。后端会做安全转义、补 `.md` 后缀和冲突处理，并把最终路径补到相关 `work_item.detail_url`。
- `changelog_entry`：本次要追加到 `changes/changelog.txt` 的完整记录。写法要像旧记录一样，用介绍项目进度的语言串起本轮工作、产生的结果或问题、对目标/工作块的影响，同时点明关键节点 ID。通常形如 `[YYYY-MM-DD HH:mm] change_id: ...`。

- `create_node`：模型写 `node_type`、`summary`、`description`、必要 `fields` 和 `history`；执行层补齐默认字段并生成最终 `create_node.data`。
- `update_node`：模型写要变更的 `field_updates`，并根据节点职责选择 `description` 或 `description_delta`。执行层会把 `description` 作为完整当前状态说明采用；若只提供 `description_delta`，执行层读取旧节点 description 后合并为最终 `updates.description`。
- `create_edge`：模型写端点、边类型和说明；执行层生成最终 `create_edge`。
- `update_edge`：模型写新说明或说明增量、原因；执行层生成最终 `update_edge`。
- 不使用 `op`、`command`、`operations`、`history_descriptions` 字段。

`temp_id` 本来就是最终图引擎支持的字段，不要另造 `proposed_id` 或让后端猜测 ID。

新建节点的 `description` 写当前节点说明。更新已有节点时要区分两类情况：

- `goal`、`work_block`、长期存在的 `issue`、核心 `result`：这些节点的 `description` 通常承担“当前状态/当前认知总结”的作用。更新它们时，优先写更新后的完整当前状态总结到 `description`，把历史演进消化成一段可读的现状说明，而不是简单追加一句。
- 普通 `work_item` 状态变化、局部事实补充、低风险描述追加：可以写 `description_delta`，由执行层机械追加到旧 description。

判断标准：如果用户打开这个节点时需要直接看到“截至当前这个节点到底是什么状态、有什么结论、还有什么限制”，就写完整 `description`；如果只是给原说明补一个局部事实，才写 `description_delta`。

`description` 写当前状态总结，`history` 写本轮为什么变、证据来自哪里、影响了什么，并按旧格式包含 `[change_id]` 和图关系上下文。本次历史说明写入每个 item 的 `history`。`note_filename` 写工作笔记归档文件名，`changelog_entry` 写本轮项目时间线记录，面向人阅读，不等同于 item history。执行层会从 draft 生成最终 `operations.json`、`history_descriptions` 和 `changelog_entry.txt`，并保留旧 `description` 里的可读 `历史记录：` 段，把本轮 `history` 插到最前面；图引擎在真正应用时负责追加节点/边结构化 `history[]` 和快照。

示例：

```json
{
  "change_id": "workflow_x",
  "timestamp": "2026-07-06T10:00:00+08:00",
  "note_filename": "pilot_validation_result.md",
  "changelog_entry": "[2026-07-06 10:00] workflow_x: 完成某项阶段工作(work_item_x)，产生某项结果(result_z)，并推动某个目标(goal_y)进展；图数据新增工作项、结果节点及工作项到结果的 creates 关系",
  "items": [
    {
      "kind": "update_node",
      "node_id": "goal_x",
      "field_updates": {
        "status": "in_progress",
        "completion_score": 40
      },
      "description": "目标当前状态总结：已完成试探性验证，验证结果支持继续推进；当前目标处于进行中状态，后续需要扩大样本范围并确认方案稳定性。",
      "history": "[workflow_x] 目标进度更新，因本轮试探性验证完成，completion_score从20提升到40，status保持\"in_progress\"；此目标被阶段验证结果影响，支持继续扩大样本范围（结果节点id: result_z）"
    }
  ]
}
```

新建节点示例：

```json
{
  "change_id": "workflow_x",
  "timestamp": "2026-07-06T10:00:00+08:00",
  "note_filename": "next_step_plan.md",
  "changelog_entry": "[2026-07-06 10:00] workflow_x: 创建工作项(work_item_x)以推进工作块(work_block_y)，记录本轮计划或进展；图数据新增工作项节点并关联工作块属性",
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
      "history": "[workflow_x] 创建工作项短标题，用于推进下一步计划；状态设置为planned，关联到work_block_y；工作项被对应工作块归属（工作块节点id: work_block_y）"
    }
  ]
}
```

新建边示例：

```json
{
  "change_id": "workflow_x",
  "timestamp": "2026-07-06T10:00:00+08:00",
  "note_filename": "stage_result_review.md",
  "changelog_entry": "[2026-07-06 10:00] workflow_x: 工作项(work_item_x)产生结果(result_z)，形成新的阶段产物；图数据新增工作项到结果的 creates 关系",
  "items": [
    {
      "kind": "create_edge",
      "temp_id": "edge_work_item_creates_result",
      "from_node": "work_item_x",
      "to_node": "result_z",
      "edge_type": "creates",
      "description": "工作项产生结果",
      "history": "[workflow_x] 建立工作项到结果的creates关系，表示工作项短标题产出某项结果（工作项节点id: work_item_x；结果节点id: result_z）"
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
    "change_id": "workflow_...",
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
