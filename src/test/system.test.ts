import { describe, expect, test } from "bun:test"
import path from "path"
import { Agent } from "../agent/agent"
import { Instance } from "../project/instance"
import { SystemPrompt } from "../session/system"
import { tmpdir } from "./fixture/fixture"

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

  test("project workflow agent only exposes workflow skills", async () => {
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
          const prompt = await SystemPrompt.skills(workflow!)

          expect(prompt).toContain("<name>project-workflow-context-warmup</name>")
          expect(prompt).not.toContain("<name>graph-project-reporting</name>")
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })
})
