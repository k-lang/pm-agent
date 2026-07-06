# 项目图数据目录说明

本目录存储单个项目的进展跟踪图数据、工作笔记、项目资源和工作推进草案。不同项目目录应遵循同一套结构，便于项目问答、工作推进、图谱预览和后续自动化处理复用。

## 目录结构

```text
├── README.md              # 本说明文件
├── nodes/                 # 节点数据，按节点类型分类
│   ├── event/             # 事件节点
│   ├── goal/              # 目标节点
│   ├── issue/             # 问题节点
│   ├── result/            # 结果节点
│   ├── work_block/        # 工作块节点
│   └── work_item/         # 工作项节点
├── edges/                 # 边数据，记录节点间关系
├── snapshots/             # 图数据快照
├── changes/               # 变更日志
├── notes/                 # 工作笔记，保存原始工作过程和判断依据
├── source/                # 用户上传或登记的项目资源文档
├── descriptions_output/   # 节点描述索引
│   ├── description_summary/
│   └── history/
├── workflows/             # 工作推进草案和 active workflow 状态
├── report_output/         # 项目总结或问答汇报输出
└── metadata/              # 项目元数据和资源登记信息
```

## 节点目录

`nodes/` 下按节点类型存储 JSON 文件：

| 目录 | 节点类型 | 含义 |
| --- | --- | --- |
| `event/` | 事件 | 外部事件、时间窗口变化、业务触发因素等 |
| `goal/` | 目标 | 项目目标、阶段目标及完成度 |
| `issue/` | 问题 | 项目推进中发现的问题、风险、阻塞和解决状态 |
| `result/` | 结果 | 工作产生的阶段产物、验证结果、分析结论 |
| `work_block/` | 工作块 | 一组相关工作项构成的工作线或阶段工作 |
| `work_item/` | 工作项 | 具体工作任务，通常关联一篇工作笔记 |

节点 JSON 通常包含：

- `id`：节点唯一标识。
- `type`：节点类型。
- `summary`：简短摘要。
- `description`：面向阅读的详细描述，通常包含总体概括和历史记录。
- `detail_url`：关联工作笔记路径，可选。
- `incoming_edges` / `outgoing_edges`：关联边 ID。
- `history`：节点版本历史，用于追溯和回滚。
- 类型特定字段，例如目标完成度、问题解决度、工作项状态等。

## 边目录

`edges/` 下每个 JSON 文件代表一条节点关系。边通常包含：

- `id`：边唯一标识。
- `from_node_id`：起点节点 ID。
- `to_node_id`：终点节点 ID。
- `type`：关系类型。
- `description`：关系说明。
- `history`：边版本历史。

常见关系包括工作顺承、工作产生结果、工作发现问题、结果影响目标、问题促成新目标、事件影响计划等。实际关系类型以图引擎 schema 为准。

## notes 与 source

`notes/` 保存工作推进过程中的原始工作笔记，是关键判断、方案调整、影响评估和结果依据的主要来源。

`source/` 保存用户上传或登记的项目资源，例如需求文档、架构设计、会议纪要、外部资料等。当前资源登记信息通常写入 `metadata/source_resources.json`。

当节点摘要和工作笔记不一致时，通常应优先相信原始工作笔记；当需要确认用户提供的外部资料时，应查看 `source/`。

## descriptions_output

`descriptions_output/` 是面向快速阅读和定位的索引：

- `description_summary/`：节点当前状态和总体概括。
- `history/`：节点历史变化和关联节点线索。

这些文件适合用于快速建立项目概览、定位关键节点和追溯关联关系。需要确认细节时，应继续下钻到 `notes/`、`source/` 或原始节点 JSON。

## changes 与 snapshots

`changes/changelog.txt` 记录图数据的 step 级变更摘要，适合用于建立时间线、识别最近变化和定位关键节点。

`snapshots/` 保存图数据快照，用于回溯历史状态、对比不同 step 的图结构，以及支撑回滚。

## workflows

`workflows/active/` 保存当前工作推进草案，包括状态机状态、工作笔记草案、图操作草案、校验结果和预览结果等。

常见文件包括：

- `state.json`：active workflow 状态。
- `messages.jsonl`：过程消息记录。
- `resources.json`：本轮登记资源。
- `note.md`：本轮工作笔记草案。
- `operation_notes.md`：给用户审核的自然语言图操作说明。
- `operations.draft.json`：模型写出的压缩结构化图操作草案，只保存语义增量。
- `operations.json`：后端执行层从 draft 编译生成的最终图操作命令。
- `operation_index.json`：后端执行层从最终图操作命令派生的自然语言索引。
- `validation.json`：后端执行层生成的图操作校验结果。
- `preview.json`：后端执行层生成的图谱预览元数据。
- `context_warmup.md`：项目上下文预热输出，可选。

active workflow 是草案区，不等同于正式图数据。只有用户明确确认并由后端应用后，图操作才会写入正式图数据。

## report_output

`report_output/` 用于保存项目总结、问答汇报或其他报告型输出。工作推进功能不应把普通草案写入这里。

## 阅读建议

理解项目时，优先读取：

1. `README.md`：确认目录结构和数据契约。
2. `report_output/current_final_report.md`：如果存在，可快速了解项目当前总结。
3. `changes/changelog.txt`：建立时间线和最近变化。
4. `descriptions_output/description_summary/` 与 `descriptions_output/history/`：定位关键节点和关系。
5. `notes/` 与 `source/`：确认关键事实、原因、方案和结果依据。

不要无目的地批量读取所有节点或所有笔记。应先利用索引定位，再按需下钻。
