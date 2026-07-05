import { describe, expect, test } from "bun:test"
import path from "path"
import { Agent } from "../agent/agent"
import { Instance } from "../project/instance"
import { SystemPrompt } from "../session/system"
import { tmpdir } from "./fixture/fixture"
import { ToolRegistry } from "../tool/registry"
import { ModelID, ProviderID } from "../provider/schema"

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

  test("project workflow warmup skill is only exposed to warmup agent", async () => {
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
          const warmup = await Agent.get("project_workflow_warmup")
          const workflowPrompt = (await SystemPrompt.skills(workflow!)) ?? ""
          const warmupPrompt = await SystemPrompt.skills(warmup!)

          expect(workflowPrompt).not.toContain("<name>project-workflow-context-warmup</name>")
          expect(workflowPrompt).not.toContain("<name>graph-project-reporting</name>")
          expect(warmupPrompt).toContain("<name>project-workflow-context-warmup</name>")
          expect(warmupPrompt).not.toContain("<name>graph-project-reporting</name>")
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
          const warmup = await Agent.get("project_workflow_warmup")
          const model = { providerID: ProviderID.make("test"), modelID: ModelID.make("gpt-5") }
          const workflowTools = await ToolRegistry.tools(model, workflow!)
          const warmupTools = await ToolRegistry.tools(model, warmup!)
          const workflowIDs = workflowTools.map((tool) => tool.id)
          const warmupIDs = warmupTools.map((tool) => tool.id)

          expect(workflowIDs).toContain("workflow_action")
          expect(workflowIDs).toContain("apply_patch")
          expect(warmupIDs).not.toContain("workflow_action")
          expect(warmupIDs).not.toContain("apply_patch")
          expect(warmupIDs).not.toContain("edit")
          expect(warmupIDs).not.toContain("write")
          expect(warmupIDs).toContain("read")
          expect(warmupIDs).toContain("skill")
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })
})
