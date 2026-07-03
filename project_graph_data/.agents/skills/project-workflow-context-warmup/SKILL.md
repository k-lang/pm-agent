---
name: project-workflow-context-warmup
description: 用于已有图数据项目进入工作推进前的项目上下文预热。读取当前项目图谱、最近总结、关键 notes 和 source 资源，建立后续 workflow chat session 可继承的主干上下文；不生成正式汇报，不直接生成工作笔记或图操作。
---

# 项目上下文预热 Skill

本技能只用于已有图数据项目的工作推进预热。调用本技能的目的不是让 `skill` 工具结果本身成为最终上下文，而是给模型一套独立的阅读方法和取数路径，诱导模型在当前 warmup session 中形成一段可被后续 workflow chat session 继承的项目主干理解。

未初始化项目不要使用本技能，直接进入项目初始化流程。

## 预热目标

在 warmup session 的助手回复中形成一份紧凑、可继承的项目推进上下文，供后续工作推进对话 fork 使用。后端可以把这段助手回复保存到 `workflows/active/context_warmup.md`，但这不是本技能直接写文件的职责。

这段上下文应更像“项目主干地图”，而不是正式汇报。它要帮助后续模型判断：

- 当前项目主要在解决什么问题。
- 图数据体现了哪些目标、工作线、问题、结果和最近变化。
- 后续用户如果问某类工作、问题或计划，应优先沿哪些节点、分支、notes 或 source 资源继续查。
- 哪些内容只是预热阶段的弱理解，后续推进时仍需向用户确认或继续下钻。

必须覆盖：

- 项目背景和初始目标。
- 当前主要目标及状态。
- 主要工作块和关键工作项。
- 未完成或正在推进的工作。
- 关键问题、关键结果和最近变化。
- 可能影响后续工作推进的上下文缺口。
- 关键 notes/source 引用。

## 边界

你不负责：

- 生成正式项目总结报告。
- 写入 `report_output/`。
- 直接生成工作笔记。
- 直接生成图操作草案。
- 调用 `workflow_action` 修改 active workflow 状态。
- 替代外部变化、计划梳理、工作进展 Skill 的细粒度定位。

预热只建立主干上下文。后续用户输入到来后，三大推进 Skill 仍需按需查图、追溯 notes、核对 source 资源，并在相关节点映射不确定时向用户确认。

## 方法

本技能是独立技能，不依赖其他技能。开始前先阅读本技能目录下的资源：

- `resource/图数据索引阅读指南.md`

使用资源中的“索引驱动、按需深入”方法，但不要执行正式汇报流程，不要建立汇报输出目录，不要生成证据卡片文件。

优先使用：

1. `README.md`：项目背景。
2. `report_output/current_final_report.md` 或最近 `report_output/*/final_report.md`：当前项目总结。
3. `changes/changelog.txt`：时间线、最近变化、关键 step。
4. `descriptions_output/description_summary/` 和 `descriptions_output/history/`：快速定位目标、工作块、工作项、问题、结果。
5. `notes/`：关键判断和重要工作细节的权威来源。
6. `source/`：用户上传的项目资源清单和可预览文本资料。

不要批量读取所有节点或所有 notes。先从总结、changelog 和 summary/history 定位主干，再按需下钻到少量关键 notes。

证据权威级别：

```text
notes > nodes/descriptions_output > changelog
```

如果只能从 changelog 得到某个判断，应标记为弱证据。

## warmup session 回复格式

使用 Markdown，建议结构：

```md
# 项目上下文预热

## 项目主线

## 当前目标状态

## 关键工作线

## 关键问题与结果

## 最近变化

## 后续推进的查找地图

## 待确认的上下文缺口

## 关键来源
```

输出要面向后续工作推进，而不是面向项目汇报读者。保持紧凑，避免长篇叙事。

“后续推进的查找地图”应明确写出：

- 如果用户提到某条工作线，应优先查看哪些 goal/work_block/work_item/result/issue。
- 如果用户要了解某个结果或问题，应从哪些 history、summary 或 notes 下钻。
- 如果用户上传或引用了 source 资源，应如何和既有图数据对齐。

不要把目录结构介绍当作最终内容；目录和资源只是帮助后续模型定位项目事实的导航线索。
