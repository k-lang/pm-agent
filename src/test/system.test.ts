import { describe, expect, test } from "bun:test"
import path from "path"
import { Agent } from "../agent/agent"
import { Instance } from "../project/instance"
import { SystemPrompt } from "../session/system"
import { tmpdir } from "./fixture/fixture"
import { ToolRegistry } from "../tool/registry"
import { ModelID, ProviderID } from "../provider/schema"
import { Permission } from "../permission"

describe("session.system", () => {
  test("skills output is sorted by name and stable across calls", async () => {
    const projectDirName = "demo-project"
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const projectDir = path.join(dir, "project_graph_data", projectDirName)
        for (const [name, description] of [
          ["zeta-skill", "Zeta skill."],
          ["alpha-skill", "Alpha skill."],
          ["middle-skill", "Middle skill."],
        ]) {
          const skillDir = path.join(projectDir, ".agents", "skills", name)
          await Bun.write(
            path.join(skillDir, "SKILL.md"),
            `---
name: ${name}
description: ${description}
---

# ${name}
`,
          )
        }
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: path.join(tmp.path, "project_graph_data", projectDirName),
        fn: async () => {
          const build = await Agent.get("build")
          const first = await SystemPrompt.skills(build!)
          const second = await SystemPrompt.skills(build!)

          expect(first).toBe(second)

          const alpha = first!.indexOf("<name>alpha-skill</name>")
          const middle = first!.indexOf("<name>middle-skill</name>")
          const zeta = first!.indexOf("<name>zeta-skill</name>")

          expect(alpha).toBeGreaterThan(-1)
          expect(middle).toBeGreaterThan(alpha)
          expect(zeta).toBeGreaterThan(middle)
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

  test("project workflow skills are exposed to the intended agents", async () => {
    const projectDirName = "demo-project"
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const graphRoot = path.join(dir, "project_graph_data")
        const projectDir = path.join(graphRoot, projectDirName)
        await Bun.write(path.join(projectDir, "README.md"), "# demo\n")
        for (const [name, description] of [
          ["graph-project-reporting", "Generate project summary reports."],
          ["project-workflow-context-warmup", "Warm up project workflow context."],
          ["project-workflow-correction-draft", "Draft project workflow corrections."],
          ["project-workflow-graph-operation-draft", "Draft project workflow graph operations."],
        ]) {
          const skillDir = path.join(graphRoot, ".agents", "skills", name)
          await Bun.write(
            path.join(skillDir, "SKILL.md"),
            `---
name: ${name}
description: ${description}
---

# ${name}
`,
          )
        }
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: path.join(tmp.path, "project_graph_data", projectDirName),
        fn: async () => {
          const workflow = await Agent.get("project_workflow")
          const correction = await Agent.get("project_workflow_correction")
          const warmup = await Agent.get("project_workflow_warmup")
          const correctionWarmup = await Agent.get("project_workflow_correction_warmup")
          const reviewer = await Agent.get("project_workflow_graph_operation_reviewer")
          const workflowPrompt = (await SystemPrompt.skills(workflow!)) ?? ""
          const correctionPrompt = (await SystemPrompt.skills(correction!)) ?? ""
          const warmupPrompt = await SystemPrompt.skills(warmup!)
          const correctionWarmupPrompt = await SystemPrompt.skills(correctionWarmup!)
          const reviewerPrompt = (await SystemPrompt.skills(reviewer!)) ?? ""
          const model = { providerID: ProviderID.make("test"), modelID: ModelID.make("gpt-5") }
          const reviewerTools = await ToolRegistry.tools(model, reviewer!)
          const reviewerSkillTool = reviewerTools.find((tool) => tool.id === "skill")

          expect(workflowPrompt).not.toContain("<name>project-workflow-context-warmup</name>")
          expect(workflowPrompt).not.toContain("<name>project-workflow-correction-draft</name>")
          expect(workflowPrompt).toContain("<name>project-workflow-graph-operation-draft</name>")
          expect(workflowPrompt).not.toContain("<name>graph-project-reporting</name>")
          expect(correctionPrompt).toContain("<name>project-workflow-correction-draft</name>")
          expect(correctionPrompt).toContain("<name>project-workflow-graph-operation-draft</name>")
          expect(correctionPrompt).not.toContain("hardCorrection")
          expect(correctionPrompt).not.toContain("重做最近")
          expect(correction?.prompt).not.toContain("hardCorrection")
          expect(correction?.prompt).not.toContain("重做最近")
          expect(correctionWarmup?.prompt).not.toContain("hardCorrection")
          expect(correctionWarmup?.prompt).not.toContain("重做最近")
          expect(correctionPrompt).not.toContain("<name>project-workflow-context-warmup</name>")
          expect(correctionPrompt).not.toContain("<name>graph-project-reporting</name>")
          expect(warmupPrompt).toContain("<name>project-workflow-context-warmup</name>")
          expect(warmupPrompt).not.toContain("<name>project-workflow-graph-operation-draft</name>")
          expect(warmupPrompt).not.toContain("<name>graph-project-reporting</name>")
          expect(correctionWarmupPrompt || "").not.toContain("<name>project-workflow-graph-operation-draft</name>")
          expect(correctionWarmupPrompt || "").not.toContain("<name>project-workflow-context-warmup</name>")
          expect(correctionWarmupPrompt || "").not.toContain("<name>graph-project-reporting</name>")
          expect(reviewer?.mode).toBe("subagent")
          expect(reviewerPrompt).toContain("<name>project-workflow-graph-operation-draft</name>")
          expect(reviewerPrompt).not.toContain("<name>project-workflow-context-warmup</name>")
          expect(reviewerPrompt).not.toContain("<name>graph-project-reporting</name>")
          expect(reviewerSkillTool).toBeDefined()
          const loaded = await reviewerSkillTool!.execute({ name: "project-workflow-graph-operation-draft" }, {
            sessionID: "test-session" as any,
            messageID: "test-message" as any,
            agent: reviewer!.name,
            abort: new AbortController().signal,
            messages: [],
            metadata() {},
            ask: async () => {},
          })
          expect(loaded.output).toContain('<skill_content name="project-workflow-graph-operation-draft">')
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

  test("project workflow warmup agent cannot see edit or workflow state tools", async () => {
    const projectDirName = "demo-project"
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const graphRoot = path.join(dir, "project_graph_data")
        const projectDir = path.join(graphRoot, projectDirName)
        await Bun.write(path.join(projectDir, "README.md"), "# demo\n")
        const skillDir = path.join(graphRoot, ".agents", "skills", "project-workflow-context-warmup")
        await Bun.write(
          path.join(skillDir, "SKILL.md"),
          `---
name: project-workflow-context-warmup
description: Warm up project workflow context.
---

# project-workflow-context-warmup
`,
        )
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: path.join(tmp.path, "project_graph_data", projectDirName),
        fn: async () => {
          const workflow = await Agent.get("project_workflow")
          const correction = await Agent.get("project_workflow_correction")
          const warmup = await Agent.get("project_workflow_warmup")
          const correctionWarmup = await Agent.get("project_workflow_correction_warmup")
          const reviewer = await Agent.get("project_workflow_graph_operation_reviewer")
          const model = { providerID: ProviderID.make("test"), modelID: ModelID.make("gpt-5") }
          const workflowTools = await ToolRegistry.tools(model, workflow!)
          const correctionTools = await ToolRegistry.tools(model, correction!)
          const warmupTools = await ToolRegistry.tools(model, warmup!)
          const correctionWarmupTools = await ToolRegistry.tools(model, correctionWarmup!)
          const workflowIDs = workflowTools.map((tool) => tool.id)
          const correctionIDs = correctionTools.map((tool) => tool.id)
          const warmupIDs = warmupTools.map((tool) => tool.id)
          const correctionWarmupIDs = correctionWarmupTools.map((tool) => tool.id)
          const taskTool = workflowTools.find((tool) => tool.id === "task")
          const correctionTaskTool = correctionTools.find((tool) => tool.id === "task")
          const activeStatePath = path.join(tmp.path, "project_graph_data", projectDirName, "workflows", "active", "state.json")

          expect(workflowIDs).toContain("workflow_action")
          expect(workflowIDs).toContain("apply_patch")
          expect(workflowIDs).toContain("task")
          expect(taskTool?.description).toContain("project_workflow_graph_operation_reviewer")
          expect(taskTool?.description).not.toContain("- general:")
          expect(taskTool?.description).not.toContain("- explore:")
          expect(correctionIDs).toContain("workflow_action")
          expect(correctionIDs).toContain("apply_patch")
          expect(correctionIDs).toContain("task")
          expect(correctionTaskTool?.description).toContain("project_workflow_graph_operation_reviewer")
          expect(warmupIDs).not.toContain("workflow_action")
          expect(warmupIDs).not.toContain("apply_patch")
          expect(warmupIDs).not.toContain("edit")
          expect(warmupIDs).not.toContain("write")
          expect(warmupIDs).toContain("read")
          expect(warmupIDs).toContain("skill")
          expect(correctionWarmupIDs).not.toContain("workflow_action")
          expect(correctionWarmupIDs).not.toContain("apply_patch")
          expect(correctionWarmupIDs).not.toContain("edit")
          expect(correctionWarmupIDs).not.toContain("write")
          expect(correctionWarmupIDs).toContain("read")
          expect(Permission.evaluate("task", "project_workflow_graph_operation_reviewer", workflow!.permission).action).not.toBe("deny")
          expect(Permission.evaluate("task", "project_workflow_graph_operation_reviewer", correction!.permission).action).not.toBe("deny")
          expect(Permission.evaluate("task", "general", workflow!.permission).action).toBe("deny")
          expect(Permission.evaluate("task", "general", correction!.permission).action).toBe("deny")
          expect(Permission.evaluate("skill", "project-workflow-correction-draft", workflow!.permission).action).toBe("deny")
          expect(Permission.evaluate("skill", "project-workflow-correction-draft", correction!.permission).action).toBe("allow")
          expect(Permission.evaluate("skill", "project-workflow-correction-draft", reviewer!.permission).action).toBe("allow")
          expect(Permission.evaluate("skill", "project-workflow-graph-operation-draft", correction!.permission).action).toBe("allow")
          expect(Permission.evaluate("read", activeStatePath, workflow!.permission).action).toBe("deny")
          expect(Permission.evaluate("read", activeStatePath, warmup!.permission).action).toBe("deny")
          expect(Permission.evaluate("read", activeStatePath, reviewer!.permission).action).toBe("deny")
          expect(Permission.evaluate("read", activeStatePath, correction!.permission).action).toBe("deny")
          expect(Permission.evaluate("read", activeStatePath, correctionWarmup!.permission).action).toBe("deny")
          expect(Permission.evaluate("write", "*", reviewer!.permission).action).toBe("deny")
          expect(Permission.evaluate("edit", "*", reviewer!.permission).action).toBe("deny")
          expect(Permission.evaluate("apply_patch", "*", reviewer!.permission).action).toBe("deny")
          expect(Permission.evaluate("workflow_action", "*", reviewer!.permission).action).toBe("deny")
          expect(Permission.evaluate("read", "*", reviewer!.permission).action).toBe("allow")
          expect(Permission.evaluate("skill", "project-workflow-graph-operation-draft", reviewer!.permission).action).toBe("allow")
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })
})
