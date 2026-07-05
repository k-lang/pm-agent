---
name: project-workflow-context-warmup
description: 用于已有图数据项目进入工作推进前的轻量项目上下文预热。只读取项目主干索引和少量 goal、issue、work_block 信息，建立后续 workflow chat session 可继承的大致上下文；不生成正式汇报，不下钻 notes，不直接生成工作笔记或图操作。
---

# 项目上下文预热 Skill

本技能只用于已有图数据项目的工作推进预热。预热要轻，只建立“大致项目主干”，不要试图在用户提出具体问题前完成深度定位。

未初始化项目不要使用本技能，直接进入项目初始化流程。

## 预热目标

在 warmup session 的助手回复中形成一份紧凑、可继承的项目推进上下文，供后续工作推进对话 fork 使用。后端可以把这段助手回复保存到 `workflows/active/context_warmup.md`，但这不是本技能直接写文件的职责。

这段上下文应更像“项目主干地图”，而不是正式汇报。它只需要帮助后续模型判断：

- 当前项目主要在解决什么问题。
- 图数据中有哪些主要目标、问题和工作块。
- 后续用户如果问某类工作、问题或计划，应优先沿哪些 goal、issue、work_block 继续查。
- 哪些内容只是预热阶段的弱理解，后续推进时仍需向用户确认或继续下钻。

必须覆盖：

- 项目主线的粗略判断。
- 当前主要 goal 的状态。
- 主要 issue。
- 主要 work_block。
- 最近变化的粗略线索。
- 后续推进时需要继续下钻确认的上下文缺口。

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

本技能是独立技能，不依赖其他技能，也不要求读取额外 resource 方法论文件。

读取顺序：

1. 如果存在 `changes/changelog.txt`，只快速读取最近若干 step 和开头若干 step，用于判断项目主线和最近变化；不要完整复盘每一步。
2. 优先读取 `descriptions_output/description_summary/` 下与 `goal_*.txt`、`issue_*.txt`、`work_block_*.txt` 对应的少量文件。
3. 如果 `description_summary` 缺失，再读取 `nodes/goal/`、`nodes/issue/`、`nodes/work_block/` 下的 JSON。只提取 `id`、`summary`、`description` 的当前概括、状态/完成度和关联 work_block/work_item 数量等主干字段。
4. 可以读取 `workflows/active/state.json`，了解当前 active 草案阶段；如果已有 `context_warmup.md`，可以参考但不要照抄。
5. 默认不要读取 `notes/`、`source/`、`nodes/work_item/`、`nodes/result/`、`edges/` 或完整 snapshots。只有在 goal/issue/work_block 完全无法判断项目主线时，才允许读取极少量最相关的文件，并在输出中说明这是预热阶段的弱理解。

硬性预算：

- 目标是快速停止并输出上下文，不追求完整。
- 工具读取总数应控制在约 10 次以内；大型项目更要保守。
- 输出长度控制在 800-1500 中文字左右。
- 如果索引缺失或信息不足，直接写“预热只能建立粗略理解，后续需按用户问题下钻”，不要为了补全而继续大量读取。

## 输出格式

使用 Markdown，建议结构：

```md
# 项目上下文预热

## 项目主线

## 当前目标状态

## 主要问题

## 主要工作块

## 最近变化

## 后续查找入口

## 待确认的上下文缺口
```

输出要面向后续工作推进，而不是面向项目汇报读者。保持紧凑，避免长篇叙事。不要列大量节点；每类只列最重要的主干入口。

“后续查找入口”只写主干节点和需要下钻的方向，例如“若用户问某目标的具体依据，再读取该 goal 关联的 work_block/work_item 和对应 notes”。不要在预热阶段提前完成这些下钻。
