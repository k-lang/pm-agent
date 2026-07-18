import { Config } from "../config/config"
import z from "zod"
import { Provider } from "../provider/provider"
import { ModelID, ProviderID } from "../provider/schema"
import { generateObject, streamObject, type ModelMessage } from "ai"
import { SystemPrompt } from "../session/system"
import { Instance } from "../project/instance"
import { Truncate } from "../tool/truncate"
import { Auth } from "../auth"
import { ProviderTransform } from "../provider/transform"

import PROMPT_GENERATE from "./generate.txt"
import PROMPT_COMPACTION from "./prompt/compaction.txt"
import PROMPT_EXPLORE from "./prompt/explore.txt"
import PROMPT_SUMMARY from "./prompt/summary.txt"
import PROMPT_TITLE from "./prompt/title.txt"
import PROMPT_PROJECT_WORKFLOW from "./prompt/project-workflow.txt"
import PROMPT_PROJECT_WORKFLOW_CORRECTION from "./prompt/project-workflow-correction.txt"
import PROMPT_PROJECT_WORKFLOW_CORRECTION_WARMUP from "./prompt/project-workflow-correction-warmup.txt"
import PROMPT_PROJECT_WORKFLOW_WARMUP from "./prompt/project-workflow-warmup.txt"
import PROMPT_PROJECT_WORKFLOW_GRAPH_OPERATION_REVIEWER from "./prompt/project-workflow-graph-operation-reviewer.txt"
import { Permission } from "@/permission"
import { mergeDeep, pipe, sortBy, values } from "remeda"
import { Global } from "@/global"
import path from "path"
import { Plugin } from "@/plugin"
import { Skill } from "../skill"

export namespace Agent {
  export const Info = z
    .object({
      name: z.string(),
      description: z.string().optional(),
      mode: z.enum(["subagent", "primary", "all"]),
      native: z.boolean().optional(),
      hidden: z.boolean().optional(),
      topP: z.number().optional(),
      temperature: z.number().optional(),
      color: z.string().optional(),
      permission: Permission.Ruleset,
      model: z
        .object({
          modelID: ModelID.zod,
          providerID: ProviderID.zod,
        })
        .optional(),
      variant: z.string().optional(),
      prompt: z.string().optional(),
      options: z.record(z.string(), z.any()),
      steps: z.number().int().positive().optional(),
    })
    .meta({
      ref: "Agent",
    })
  export type Info = z.infer<typeof Info>

  const state = Instance.state(async () => {
    const cfg = await Config.get()

    const skillDirs = await Skill.dirs()
    const whitelistedDirs = [Truncate.GLOB, ...skillDirs.map((dir) => path.join(dir, "*"))]
    const defaults = Permission.fromConfig({
      "*": "allow",
      doom_loop: "ask",
      external_directory: {
        "*": "ask",
        ...Object.fromEntries(whitelistedDirs.map((dir) => [dir, "allow"])),
      },
      question: "deny",
      plan_enter: "deny",
      plan_exit: "deny",
      // mirrors github.com/github/gitignore Node.gitignore pattern for .env files
      read: {
        "*": "allow",
        "*.env": "ask",
        "*.env.*": "ask",
        "*.env.example": "allow",
      },
    })
    const user = Permission.fromConfig(cfg.permission ?? {})

    const result: Record<string, Info> = {
      build: {
        name: "build",
        description: "The default agent. Executes tools based on configured permissions.",
        options: {},
        permission: Permission.merge(
          defaults,
          Permission.fromConfig({
            question: "allow",
            plan_enter: "allow",
          }),
          user,
        ),
        mode: "primary",
        native: true,
      },
      plan: {
        name: "plan",
        description: "Plan mode. Disallows all edit tools.",
        options: {},
        permission: Permission.merge(
          defaults,
          Permission.fromConfig({
            question: "allow",
            plan_exit: "allow",
            external_directory: {
              [path.join(Global.Path.data, "plans", "*")]: "allow",
            },
            edit: {
              "*": "deny",
              [path.join(".opencode", "plans", "*.md")]: "allow",
              [path.relative(Instance.worktree, path.join(Global.Path.data, path.join("plans", "*.md")))]: "allow",
            },
          }),
          user,
        ),
        mode: "primary",
        native: true,
      },
      general: {
        name: "general",
        description: `General-purpose agent for researching complex questions and executing multi-step tasks. Use this agent to execute multiple units of work in parallel.`,
        permission: Permission.merge(
          defaults,
          Permission.fromConfig({
            todoread: "deny",
            todowrite: "deny",
          }),
          user,
        ),
        options: {},
        mode: "subagent",
        native: true,
      },
      explore: {
        name: "explore",
        permission: Permission.merge(
          defaults,
          Permission.fromConfig({
            "*": "deny",
            grep: "allow",
            glob: "allow",
            list: "allow",
            bash: "allow",
            webfetch: "allow",
            websearch: "allow",
            codesearch: "allow",
            read: "allow",
            external_directory: {
              "*": "ask",
              ...Object.fromEntries(whitelistedDirs.map((dir) => [dir, "allow"])),
            },
          }),
          user,
        ),
        description: `Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx"), search code for keywords (eg. "API endpoints"), or answer questions about the codebase (eg. "how do API endpoints work?"). When calling this agent, specify the desired thoroughness level: "quick" for basic searches, "medium" for moderate exploration, or "very thorough" for comprehensive analysis across multiple locations and naming conventions.`,
        prompt: PROMPT_EXPLORE,
        options: {},
        mode: "subagent",
        native: true,
      },
      compaction: {
        name: "compaction",
        mode: "primary",
        native: true,
        hidden: true,
        prompt: PROMPT_COMPACTION,
        permission: Permission.merge(
          defaults,
          Permission.fromConfig({
            "*": "deny",
          }),
          user,
        ),
        options: {},
      },
      title: {
        name: "title",
        mode: "primary",
        options: {},
        native: true,
        hidden: true,
        temperature: 0.5,
        permission: Permission.merge(
          defaults,
          Permission.fromConfig({
            "*": "deny",
          }),
          user,
        ),
        prompt: PROMPT_TITLE,
      },
      summary: {
        name: "summary",
        mode: "primary",
        options: {},
        native: true,
        hidden: true,
        permission: Permission.merge(
          defaults,
          Permission.fromConfig({
            "*": "deny",
          }),
          user,
        ),
        prompt: PROMPT_SUMMARY,
      },
      project_workflow: {
        name: "project_workflow",
        description: "项目工作推进主 Agent。用于生成工作笔记、图操作草案，并通过受控状态机推进审核流程。",
        mode: "primary",
        native: true,
        hidden: true,
        options: {},
        permission: Permission.merge(
          defaults,
          Permission.fromConfig({
            "*": "deny",
            workflow_action: "allow",
            task: {
              "*": "deny",
              project_workflow_graph_operation_reviewer: "allow",
            },
            edit: {
              "*": "deny",
              [path.relative(Instance.worktree, path.join(Instance.directory, "workflows", "active", "note.md")).replaceAll("\\", "/")]: "ask",
              [path.relative(Instance.worktree, path.join(Instance.directory, "workflows", "active", "operation_notes.md")).replaceAll("\\", "/")]: "allow",
              [path.relative(Instance.worktree, path.join(Instance.directory, "workflows", "active", "operations.draft.json")).replaceAll("\\", "/")]: "allow",
            },
            skill: {
              "*": "deny",
              "project-workflow-graph-operation-draft": "allow",
            },
            read: {
              "*": "allow",
              [path.join(Instance.directory, "workflows", "active", "state.json")]: "deny",
            },
          }),
          user,
        ),
        prompt: PROMPT_PROJECT_WORKFLOW,
      },
      project_workflow_graph_operation_reviewer: {
        name: "project_workflow_graph_operation_reviewer",
        description: "项目工作推进图操作草案只读审查 Agent。用于在主 Agent 登记图操作草案前，按图操作 Skill 和图引擎约束检查 operation_notes.md 与 operations.draft.json。",
        mode: "subagent",
        native: true,
        hidden: true,
        options: {},
        permission: Permission.merge(
          defaults,
          Permission.fromConfig({
            "*": "deny",
            read: {
              "*": "allow",
              [path.join(Instance.directory, "workflows", "active", "state.json")]: "deny",
            },
            grep: "allow",
            glob: "allow",
            skill: {
              "*": "deny",
              "project-workflow-graph-operation-draft": "allow",
              "project-workflow-correction-draft": "allow",
            },
          }),
          user,
        ),
        prompt: PROMPT_PROJECT_WORKFLOW_GRAPH_OPERATION_REVIEWER,
      },
      project_workflow_correction: {
        name: "project_workflow_correction",
        description: "项目图谱软更正主 Agent。用于追加 correction 提交，修正、补充或逻辑废弃历史图数据。",
        mode: "primary",
        native: true,
        hidden: true,
        options: {},
        permission: Permission.merge(
          defaults,
          Permission.fromConfig({
            "*": "deny",
            workflow_action: "allow",
            task: {
              "*": "deny",
              project_workflow_graph_operation_reviewer: "allow",
            },
            edit: {
              "*": "deny",
              [path.relative(Instance.worktree, path.join(Instance.directory, "workflows", "active", "note.md")).replaceAll("\\", "/")]: "ask",
              [path.relative(Instance.worktree, path.join(Instance.directory, "workflows", "active", "operation_notes.md")).replaceAll("\\", "/")]: "allow",
              [path.relative(Instance.worktree, path.join(Instance.directory, "workflows", "active", "operations.draft.json")).replaceAll("\\", "/")]: "allow",
            },
            skill: {
              "*": "deny",
              "project-workflow-correction-draft": "allow",
              "project-workflow-graph-operation-draft": "allow",
            },
            read: {
              "*": "allow",
              [path.join(Instance.directory, "workflows", "active", "state.json")]: "deny",
            },
          }),
          user,
        ),
        prompt: PROMPT_PROJECT_WORKFLOW_CORRECTION,
      },
      project_workflow_correction_warmup: {
        name: "project_workflow_correction_warmup",
        description: "项目图谱软更正上下文预热 Agent。只读当前正式图谱和最近提交，为 correction chat 建立轻量上下文。",
        mode: "primary",
        native: true,
        hidden: true,
        options: {},
        permission: Permission.merge(
          defaults,
          Permission.fromConfig({
            "*": "deny",
            read: {
              "*": "allow",
              [path.join(Instance.directory, "workflows", "active", "state.json")]: "deny",
            },
            grep: "allow",
            glob: "allow",
          }),
          user,
        ),
        prompt: PROMPT_PROJECT_WORKFLOW_CORRECTION_WARMUP,
      },
      project_workflow_warmup: {
        name: "project_workflow_warmup",
        description: "项目工作推进上下文预热 Agent。只读项目主干索引和少量 goal、issue、work_block 信息，建立后续 workflow chat 可 fork 的轻量上下文。",
        mode: "primary",
        native: true,
        hidden: true,
        options: {},
        permission: Permission.merge(
          defaults,
          Permission.fromConfig({
            "*": "deny",
            read: {
              "*": "allow",
              [path.join(Instance.directory, "workflows", "active", "state.json")]: "deny",
            },
            grep: "allow",
            glob: "allow",
            skill: {
              "*": "deny",
              "project-workflow-context-warmup": "allow",
            },
          }),
          user,
        ),
        prompt: PROMPT_PROJECT_WORKFLOW_WARMUP,
      },
    }

    for (const [key, value] of Object.entries(cfg.agent ?? {})) {
      if (value.disable) {
        delete result[key]
        continue
      }
      let item = result[key]
      if (!item)
        item = result[key] = {
          name: key,
          mode: "all",
          permission: Permission.merge(defaults, user),
          options: {},
          native: false,
        }
      if (value.model) item.model = Provider.parseModel(value.model)
      item.variant = value.variant ?? item.variant
      item.prompt = value.prompt ?? item.prompt
      item.description = value.description ?? item.description
      item.temperature = value.temperature ?? item.temperature
      item.topP = value.top_p ?? item.topP
      item.mode = value.mode ?? item.mode
      item.color = value.color ?? item.color
      item.hidden = value.hidden ?? item.hidden
      item.name = value.name ?? item.name
      item.steps = value.steps ?? item.steps
      item.options = mergeDeep(item.options, value.options ?? {})
      item.permission = Permission.merge(item.permission, Permission.fromConfig(value.permission ?? {}))
    }

    // Ensure Truncate.GLOB is allowed unless explicitly configured
    for (const name in result) {
      const agent = result[name]
      const explicit = agent.permission.some((r) => {
        if (r.permission !== "external_directory") return false
        if (r.action !== "deny") return false
        return r.pattern === Truncate.GLOB
      })
      if (explicit) continue

      result[name].permission = Permission.merge(
        result[name].permission,
        Permission.fromConfig({ external_directory: { [Truncate.GLOB]: "allow" } }),
      )
    }

    return result
  })

  export async function get(agent: string) {
    return state().then((x) => x[agent])
  }

  export async function list() {
    const cfg = await Config.get()
    return pipe(
      await state(),
      values(),
      sortBy(
        [(x) => (cfg.default_agent ? x.name === cfg.default_agent : x.name === "build"), "desc"],
        [(x) => x.name, "asc"],
      ),
    )
  }

  export async function defaultAgent() {
    const cfg = await Config.get()
    const agents = await state()

    if (cfg.default_agent) {
      const agent = agents[cfg.default_agent]
      if (!agent) throw new Error(`default agent "${cfg.default_agent}" not found`)
      if (agent.mode === "subagent") throw new Error(`default agent "${cfg.default_agent}" is a subagent`)
      if (agent.hidden === true) throw new Error(`default agent "${cfg.default_agent}" is hidden`)
      return agent.name
    }

    const primaryVisible = Object.values(agents).find((a) => a.mode !== "subagent" && a.hidden !== true)
    if (!primaryVisible) throw new Error("no primary visible agent found")
    return primaryVisible.name
  }

  export async function generate(input: { description: string; model?: { providerID: ProviderID; modelID: ModelID } }) {
    const cfg = await Config.get()
    const defaultModel = input.model ?? (await Provider.defaultModel())
    const model = await Provider.getModel(defaultModel.providerID, defaultModel.modelID)
    const language = await Provider.getLanguage(model)

    const system = [PROMPT_GENERATE]
    await Plugin.trigger("experimental.chat.system.transform", { model }, { system })
    const existing = await list()

    const params = {
      experimental_telemetry: {
        isEnabled: cfg.experimental?.openTelemetry,
        metadata: {
          userId: cfg.username ?? "unknown",
        },
      },
      temperature: 0.3,
      messages: [
        ...system.map(
          (item): ModelMessage => ({
            role: "system",
            content: item,
          }),
        ),
        {
          role: "user",
          content: `Create an agent configuration based on this request: \"${input.description}\".\n\nIMPORTANT: The following identifiers already exist and must NOT be used: ${existing.map((i) => i.name).join(", ")}\n  Return ONLY the JSON object, no other text, do not wrap in backticks`,
        },
      ],
      model: language,
      schema: z.object({
        identifier: z.string(),
        whenToUse: z.string(),
        systemPrompt: z.string(),
      }),
    } satisfies Parameters<typeof generateObject>[0]

    // TODO: clean this up so provider specific logic doesnt bleed over
    if (defaultModel.providerID === "openai" && (await Auth.get(defaultModel.providerID))?.type === "oauth") {
      const result = streamObject({
        ...params,
        providerOptions: ProviderTransform.providerOptions(model, {
          store: false,
        }),
        onError: () => {},
      })
      for await (const part of result.fullStream) {
        if (part.type === "error") throw part.error
      }
      return result.object
    }

    const result = await generateObject(params)
    return result.object
  }
}
