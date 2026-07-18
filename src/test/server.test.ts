import { describe, test, expect, afterEach } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Instance } from "../project/instance"
import { Server } from "../server/server"
import { tmpdir } from "./fixture/fixture"
import { Log } from "../util/log"
import { Session } from "../session"
import { SessionPrompt } from "../session/prompt"
import { SessionStatus } from "../session/status"
import { ProjectDetail } from "../project/detail"
import { Database } from "../storage/db"
import { ProjectSummaryRecordTable } from "../project/project.sql"
import { SessionID } from "../session/schema"
import { ProjectWorkflow } from "../workflow/state"
import { ProjectWorkflowExecution } from "../workflow/execution"
import { GraphVersionStore } from "../graph/version-store"
import { requireWarmupContext, workflowAgentProfile } from "../server/routes/project"

Log.init({ print: false })

const TEST_MODEL_CONFIG = {
  model: "test/test-model",
  enabled_providers: ["test"],
  provider: {
    test: {
      options: {
        apiKey: "test-key",
        baseURL: "http://127.0.0.1:9/v1",
        timeout: 50,
      },
      models: {
        "test-model": {},
      },
    },
  },
}

async function insertBaselineSummary(
  directory: string,
  sessionID: SessionID,
  options: {
    now?: number
    source?: "auto" | "manual"
    graphVersion?: string
    reportExists?: boolean
    registerReportPath?: boolean
    summaryText?: string
  } = {},
) {
  const now = options.now ?? Date.now()
  const reportPath = path.join(directory, "report_output", `test-summary-${now}`, "final_report.md")
  if (options.reportExists !== false) {
    await fs.mkdir(path.dirname(reportPath), { recursive: true })
    await fs.writeFile(reportPath, options.summaryText ?? "summary body", "utf8")
  }
  Database.use((db) => {
    db.insert(ProjectSummaryRecordTable).values({
      id: `summary-${now}`,
      project_directory: directory,
      session_id: sessionID,
      status: "completed",
      kind: "summary",
      source: options.source ?? "manual",
      is_current_baseline: true,
      report_path: options.registerReportPath === false ? null : reportPath,
      report_link_path: path.join(directory, "report_output", "current_final_report.md"),
      graph_version: options.graphVersion ?? null,
      time_created: now,
      time_updated: now,
    }).run()
  })
  return reportPath
}

describe("server routes", () => {
  afterEach(async () => {
    await Instance.disposeAll()
  })

  test("workflow agent profile follows restored active semantics, not hard-correction lifecycle", () => {
    const normal = ProjectWorkflow.State.parse({
      id: "wf_normal",
      project: "demo",
      stage: "收集材料",
      createdAt: 1,
      updatedAt: 1,
    })
    const soft = ProjectWorkflow.State.parse({
      ...normal,
      id: "wf_soft",
      correction: { expectedChangeId: "correction1_", restoredAt: "2026-07-16T00:00:00.000Z" },
    })
    const hardNormal = ProjectWorkflow.State.parse({
      ...normal,
      id: "wf_hard_normal",
      hardCorrection: {
        ofChangeId: "step0_demo",
        sourceArchivePath: "workflows/applied/step0_demo",
        fixIndex: 1,
        expectedChangeId: "step0_demo_fix1",
        restoredAt: "2026-07-16T00:00:00.000Z",
      },
    })
    const hardSoft = ProjectWorkflow.State.parse({
      ...soft,
      id: "wf_hard_soft",
      hardCorrection: {
        ofChangeId: "correction1_demo",
        sourceArchivePath: "workflows/applied/correction1_demo",
        fixIndex: 1,
        expectedChangeId: "correction1_demo_fix1",
        restoredAt: "2026-07-16T00:00:00.000Z",
      },
    })

    expect(workflowAgentProfile(normal)).toEqual({
      primary: "project_workflow",
      warmup: "project_workflow_warmup",
    })
    expect(workflowAgentProfile(soft)).toEqual({
      primary: "project_workflow_correction",
      warmup: "project_workflow_correction_warmup",
    })
    expect(workflowAgentProfile(hardNormal)).toEqual({
      primary: "project_workflow",
      warmup: "project_workflow_warmup",
    })
    expect(workflowAgentProfile(hardSoft)).toEqual({
      primary: "project_workflow_correction",
      warmup: "project_workflow_correction_warmup",
    })
  })

  test("warmup must produce visible assistant context before a chat can be forked", () => {
    expect(requireWarmupContext("\n  项目主线上下文。  \n")).toBe("项目主线上下文。")
    expect(() => requireWarmupContext(" \n\t ")).toThrow("预热未生成有效内容")
  })

  test("GET /global/health returns healthy", async () => {
    const app = Server.createApp({})
    const res = await app.fetch(new Request("http://localhost/global/health"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.healthy).toBe(true)
    expect(typeof body.version).toBe("string")
  })

  test("GET /session/ returns array", async () => {
    await using tmp = await tmpdir()
    const app = Server.createApp({})
    const res = await app.fetch(
      new Request(`http://localhost/session?directory=${encodeURIComponent(tmp.path)}`),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
  })

  test("POST /session/ creates a session", async () => {
    await using tmp = await tmpdir()
    const app = Server.createApp({})
    const res = await app.fetch(
      new Request(`http://localhost/session?directory=${encodeURIComponent(tmp.path)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(typeof body.id).toBe("string")
  })

  test("GET /permission/ returns array", async () => {
    await using tmp = await tmpdir()
    const app = Server.createApp({})
    const res = await app.fetch(
      new Request(`http://localhost/permission?directory=${encodeURIComponent(tmp.path)}`),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
  })

  test("GET /question/ returns array", async () => {
    await using tmp = await tmpdir()
    const app = Server.createApp({})
    const res = await app.fetch(
      new Request(`http://localhost/question?directory=${encodeURIComponent(tmp.path)}`),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
  })

  test("GET /session/:id returns 404 for unknown session", async () => {
    await using tmp = await tmpdir()
    const app = Server.createApp({})
    const res = await app.fetch(
      new Request(`http://localhost/session/nonexistent?directory=${encodeURIComponent(tmp.path)}`),
    )
    expect(res.status === 400 || res.status === 404).toBe(true)
  })

  test("GET /path returns directory info", async () => {
    await using tmp = await tmpdir()
    const app = Server.createApp({})
    const res = await app.fetch(
      new Request(`http://localhost/path?directory=${encodeURIComponent(tmp.path)}`),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.directory).toBe(tmp.path)
  })

  test("GET /project/directories infers initialized graph when project state is stale", async () => {
    await using tmp = await tmpdir()
    const originalCwd = process.cwd()
    process.chdir(tmp.path)
    try {
      const app = Server.createApp({})
      const projectDir = path.join(tmp.path, "project_graph_data", "stale-state")
      await fs.mkdir(path.join(projectDir, "metadata"), { recursive: true })
      await fs.mkdir(path.join(projectDir, "nodes", "goal"), { recursive: true })
      await fs.mkdir(path.join(projectDir, "edges"), { recursive: true })
      await fs.writeFile(path.join(projectDir, "nodes", "goal", "goal_demo.json"), "{}", "utf8")
      await fs.writeFile(path.join(projectDir, "edges", "edge_demo.json"), "{}", "utf8")
      await fs.writeFile(
        path.join(projectDir, "metadata", "project_state.json"),
        JSON.stringify({ graphInitialized: false }, null, 2) + "\n",
        "utf8",
      )

      const res = await app.fetch(new Request("http://localhost/project/directories"))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.find((project: { name: string; graphInitialized: boolean }) => project.name === "stale-state")).toMatchObject({
        graphInitialized: true,
      })
    } finally {
      process.chdir(originalCwd)
    }
  })

  test("GET /mcp/ returns object", async () => {
    await using tmp = await tmpdir()
    const app = Server.createApp({})
    const res = await app.fetch(
      new Request(`http://localhost/mcp?directory=${encodeURIComponent(tmp.path)}`),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(typeof body).toBe("object")
  })

  test("project question list keeps thread title on first question after followups", async () => {
    await using tmp = await tmpdir({ config: TEST_MODEL_CONFIG })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const baseline = await Session.create({ title: "项目总结" })
        await insertBaselineSummary(tmp.path, baseline.id)

        const firstResult = await ProjectDetail.askQuestion({
          directory: tmp.path,
          text: "first question",
          mode: "question",
        })
        const first = firstResult.question
        await ProjectDetail.askQuestion({
          directory: tmp.path,
          text: "followup question",
          mode: "followup",
          questionID: first.id,
          questionSessionID: first.sessionID,
        })

        const questions = await ProjectDetail.listQuestions({ directory: tmp.path })
        const thread = questions.find((item) => item.sessionID === first.sessionID)
        expect(thread).toBeDefined()
        expect(thread?.previewText).toBe("first question")
        expect(thread?.threadStartUserMessageID).toBe(first.userMessageID)
        expect(thread?.userMessageID).not.toBe(first.userMessageID)
        expect(thread?.mode).toBe("followup")
      },
    })
  })

  test("GET /project/detail returns selected thread turns", async () => {
    await using tmp = await tmpdir({ config: TEST_MODEL_CONFIG })
    const app = Server.createApp({})

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const baseline = await Session.create({ title: "项目总结" })
        await insertBaselineSummary(tmp.path, baseline.id)

        const first = await ProjectDetail.askQuestion({
          directory: tmp.path,
          text: "first question",
          mode: "question",
        })
        await ProjectDetail.askQuestion({
          directory: tmp.path,
          text: "followup question",
          mode: "followup",
          questionID: first.question.id,
          questionSessionID: first.question.sessionID,
        })

        const res = await app.fetch(
          new Request(`http://localhost/project/detail?directory=${encodeURIComponent(tmp.path)}&selectedQuestionID=${first.question.id}`),
        )
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.selectedQuestionID).toBe(first.question.id)
        expect(body.selectedThread?.questionID).toBe(first.question.id)
        expect(body.selectedThread?.sessionID).toBe(first.question.sessionID)
        const followupTurn = body.selectedThread?.turns.find((turn: { questionText?: string }) => turn.questionText === "followup question")
        expect(followupTurn).toBeDefined()
        expect(typeof followupTurn?.running).toBe("boolean")
      },
    })
  })

  test("GET /project/detail marks completed summary expired when graph version differs", async () => {
    await using tmp = await tmpdir({ config: TEST_MODEL_CONFIG })
    const app = Server.createApp({})

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const baseline = await Session.create({ title: "项目总结" })
        await insertBaselineSummary(tmp.path, baseline.id, { graphVersion: "old_graph_version" })
      },
    })
    await fs.mkdir(path.join(tmp.path, "workflows", "applied", "new_graph_version"), { recursive: true })
    await fs.writeFile(path.join(tmp.path, "workflows", "applied", "new_graph_version", "apply_result.json"), JSON.stringify({
      appliedAt: new Date().toISOString(),
      change_id: "new_graph_version",
      success: true,
      snapshot: "new_graph_version",
    }, null, 2) + "\n", "utf8")

    const res = await app.fetch(
      new Request(`http://localhost/project/detail?directory=${encodeURIComponent(tmp.path)}`),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.currentSummary?.status).toBe("expired")
  })

  test("GET /project/detail expires an empty-graph summary after the first graph submission", async () => {
    await using tmp = await tmpdir({ config: TEST_MODEL_CONFIG })
    const app = Server.createApp({})

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const baseline = await Session.create({ title: "项目总结" })
        await insertBaselineSummary(tmp.path, baseline.id)
      },
    })
    await fs.mkdir(path.join(tmp.path, "workflows", "applied", "step0_first_submit"), { recursive: true })
    await fs.writeFile(path.join(tmp.path, "workflows", "applied", "step0_first_submit", "apply_result.json"), JSON.stringify({
      appliedAt: new Date().toISOString(),
      change_id: "step0_first_submit",
      success: true,
      snapshot: "step0_first_submit",
    }, null, 2) + "\n", "utf8")

    const res = await app.fetch(
      new Request(`http://localhost/project/detail?directory=${encodeURIComponent(tmp.path)}`),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.currentSummary?.graphVersion).toBeUndefined()
    expect(body.currentSummary?.status).toBe("expired")
  })

  test("GET /project/detail sees a published graph before its active workflow is archived", async () => {
    await using tmp = await tmpdir({ config: TEST_MODEL_CONFIG })
    const app = Server.createApp({})

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const baseline = await Session.create({ title: "项目总结" })
        await insertBaselineSummary(tmp.path, baseline.id, { graphVersion: "old_graph_version" })
      },
    })
    const { latest } = await GraphVersionStore.ensure(tmp.path)
    const candidate = await GraphVersionStore.createCandidate(tmp.path, latest)
    await GraphVersionStore.publish(tmp.path, latest, candidate)
    await fs.mkdir(path.join(tmp.path, "workflows", "active"), { recursive: true })
    await fs.writeFile(path.join(tmp.path, "workflows", "active", "apply_result.json"), JSON.stringify({
      appliedAt: new Date().toISOString(),
      change_id: "published_before_archive",
      snapshot: "published_before_archive",
      success: true,
      graphVersion: path.relative(tmp.path, candidate),
    }, null, 2) + "\n", "utf8")

    const res = await app.fetch(
      new Request(`http://localhost/project/detail?directory=${encodeURIComponent(tmp.path)}`),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.currentSummary?.status).toBe("expired")
  })

  test("GET /project/detail keeps summary completed when graph version matches", async () => {
    await using tmp = await tmpdir({ config: TEST_MODEL_CONFIG })
    const app = Server.createApp({})

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const baseline = await Session.create({ title: "项目总结" })
        await insertBaselineSummary(tmp.path, baseline.id, { graphVersion: "same_graph_version" })
      },
    })
    await fs.mkdir(path.join(tmp.path, "workflows", "applied", "same_graph_version"), { recursive: true })
    await fs.writeFile(path.join(tmp.path, "workflows", "applied", "same_graph_version", "apply_result.json"), JSON.stringify({
      appliedAt: new Date().toISOString(),
      change_id: "same_graph_version",
      success: true,
      snapshot: "same_graph_version",
    }, null, 2) + "\n", "utf8")
    await fs.mkdir(path.join(tmp.path, "nodes", "goal"), { recursive: true })
    await fs.writeFile(path.join(tmp.path, "nodes", "goal", "mtime_should_not_expire.json"), "{}", "utf8")

    const res = await app.fetch(
      new Request(`http://localhost/project/detail?directory=${encodeURIComponent(tmp.path)}`),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.currentSummary?.status).toBe("completed")
    expect(body.currentSummary?.summaryText).toBe("summary body")
  })

  test("GET /project/detail treats a completed summary without its report file as not generated", async () => {
    await using tmp = await tmpdir({ config: TEST_MODEL_CONFIG })
    const app = Server.createApp({})
    const now = Date.now()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const baseline = await Session.create({ title: "项目总结" })
        await insertBaselineSummary(tmp.path, baseline.id, { now, reportExists: false })
      },
    })

    const res = await app.fetch(
      new Request(`http://localhost/project/detail?directory=${encodeURIComponent(tmp.path)}`),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.currentSummary).toBeUndefined()
    expect(body.summaries).toEqual([])

    await expect(ProjectDetail.updateSummary({
      id: `summary-${now}`,
      summaryText: "must not recreate missing report",
    })).rejects.toMatchObject({
      data: { message: expect.stringContaining("Summary report file not found") },
    })
  })

  test("PATCH /project/summary writes the report file as the only summary body", async () => {
    await using tmp = await tmpdir({ config: TEST_MODEL_CONFIG })
    const app = Server.createApp({})
    const now = Date.now()
    let reportPath = ""

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const baseline = await Session.create({ title: "项目总结" })
        reportPath = await insertBaselineSummary(tmp.path, baseline.id, {
          now,
          graphVersion: "old_graph_version",
        })
      },
    })
    await fs.mkdir(path.join(tmp.path, "workflows", "applied", "new_graph_version"), { recursive: true })
    await fs.writeFile(path.join(tmp.path, "workflows", "applied", "new_graph_version", "apply_result.json"), JSON.stringify({
      appliedAt: new Date().toISOString(),
      change_id: "new_graph_version",
      success: true,
      snapshot: "new_graph_version",
    }, null, 2) + "\n", "utf8")

    const res = await app.fetch(
      new Request(`http://localhost/project/summary/summary-${now}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ summaryText: "updated report body" }),
      }),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.summaryText).toBe("updated report body")
    expect(body.status).toBe("expired")
    expect(await fs.readFile(reportPath, "utf8")).toBe("updated report body")
  })

  test("PATCH /project/summary rejects blank content without changing the report", async () => {
    await using tmp = await tmpdir({ config: TEST_MODEL_CONFIG })
    const app = Server.createApp({})
    const now = Date.now()
    let reportPath = ""

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const baseline = await Session.create({ title: "项目总结" })
        reportPath = await insertBaselineSummary(tmp.path, baseline.id, { now })
      },
    })

    const res = await app.fetch(
      new Request(`http://localhost/project/summary/summary-${now}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ summaryText: "  \n\t" }),
      }),
    )
    expect(res.status).toBe(400)
    expect(await fs.readFile(reportPath, "utf8")).toBe("summary body")
    const current = await ProjectDetail.currentSummary({ directory: tmp.path })
    expect(current?.status).toBe("completed")
    expect(current?.summaryText).toBe("summary body")
  })

  test("summary lookup and editing never infer a report from the project current link", async () => {
    await using tmp = await tmpdir({ config: TEST_MODEL_CONFIG })
    const now = Date.now()
    let reportPath = ""

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const baseline = await Session.create({ title: "项目总结" })
        reportPath = await insertBaselineSummary(tmp.path, baseline.id, {
          now,
          registerReportPath: false,
          summaryText: "previous report body",
        })
      },
    })
    const linkPath = path.join(tmp.path, "report_output", "current_final_report.md")
    await fs.symlink(path.relative(path.dirname(linkPath), reportPath), linkPath)

    const detail = await ProjectDetail.currentSummary({ directory: tmp.path })
    expect(detail).toBeUndefined()

    await expect(ProjectDetail.updateSummary({
      id: `summary-${now}`,
      summaryText: "must not overwrite previous report",
    })).rejects.toMatchObject({
      data: { message: expect.stringContaining("Summary report file not found") },
    })
    expect(await fs.readFile(reportPath, "utf8")).toBe("previous report body")
  })

  test("POST /project/summary/run records automatic summary source", async () => {
    await using tmp = await tmpdir({ config: TEST_MODEL_CONFIG })
    const app = Server.createApp({})
    await fs.mkdir(path.join(tmp.path, "workflows", "applied", "summary_graph_version"), { recursive: true })
    await fs.writeFile(path.join(tmp.path, "workflows", "applied", "summary_graph_version", "apply_result.json"), JSON.stringify({
      appliedAt: new Date().toISOString(),
      change_id: "summary_graph_version",
      success: true,
      snapshot: "summary_graph_version",
    }, null, 2) + "\n", "utf8")

    const res = await app.fetch(
      new Request(`http://localhost/project/summary/run?directory=${encodeURIComponent(tmp.path)}&source=auto`, {
        method: "POST",
      }),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe("running")
    expect(body.source).toBe("auto")
    expect(body.graphVersion).toBe("summary_graph_version")
  })

  test("POST /project/question returns hydrated project detail", async () => {
    await using tmp = await tmpdir({ config: TEST_MODEL_CONFIG })
    const app = Server.createApp({})

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const baseline = await Session.create({ title: "项目总结" })
        await insertBaselineSummary(tmp.path, baseline.id)
      },
    })

    const res = await app.fetch(
      new Request(`http://localhost/project/question?directory=${encodeURIComponent(tmp.path)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "fresh question", mode: "question" }),
      }),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.question?.id).toBeDefined()
    expect(body.detail?.selectedQuestionID).toBe(body.question.id)
    expect(body.detail?.selectedThread?.questionID).toBe(body.question.id)
    expect(body.detail?.selectedThread?.turns[0]?.questionText).toBe("fresh question")
    expect(body.detail?.questions.some((item: { id: string }) => item.id === body.question.id)).toBe(true)
  })

  test("POST /project/workflow/note/import stores manual note and invalidates stale workflow artifacts", async () => {
    await using tmp = await tmpdir()
    const originalCwd = process.cwd()
    process.chdir(tmp.path)
    try {
      const app = Server.createApp({})
      const projectDir = path.join(tmp.path, "project_graph_data", "demo")
      const activeDir = path.join(projectDir, "workflows", "active")
      await fs.mkdir(activeDir, { recursive: true })
      await fs.writeFile(path.join(projectDir, "README.md"), "# demo\n", "utf8")

      const first = await app.fetch(new Request("http://localhost/project/workflow/note/import?project=demo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "first note" }),
      }))
      expect(first.status).toBe(200)
      const firstBody = await first.json()
      expect(firstBody).toMatchObject({ exists: true, content: "first note\n", path: "workflows/active/note.md" })
      await fs.writeFile(path.join(activeDir, "operations.json"), "{}\n", "utf8")
      await fs.writeFile(path.join(activeDir, "validation.json"), "{}\n", "utf8")
      await fs.writeFile(path.join(activeDir, "preview.json"), "{}\n", "utf8")

      const second = await app.fetch(new Request("http://localhost/project/workflow/note/import?project=demo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "second note" }),
      }))
      expect(second.status).toBe(200)
      const secondBody = await second.json()
      expect(secondBody).toMatchObject({ exists: true, content: "second note\n" })
      await expect(fs.readFile(path.join(activeDir, "note.md"), "utf8")).resolves.toBe("second note\n")
      await expect(fs.stat(path.join(activeDir, "operations.draft.json"))).rejects.toThrow()
      await expect(fs.stat(path.join(activeDir, "operations.json"))).rejects.toThrow()
      await expect(fs.stat(path.join(activeDir, "validation.json"))).rejects.toThrow()
      await expect(fs.stat(path.join(activeDir, "preview.json"))).rejects.toThrow()
    } finally {
      process.chdir(originalCwd)
    }
  })

  test("POST /project/workflow/note/import preserves note and draft while workflow session is busy", async () => {
    await using tmp = await tmpdir()
    const originalCwd = process.cwd()
    process.chdir(tmp.path)
    try {
      const app = Server.createApp({})
      const projectDir = path.join(tmp.path, "project_graph_data", "demo")
      const activeDir = path.join(projectDir, "workflows", "active")
      await fs.mkdir(activeDir, { recursive: true })
      await fs.writeFile(path.join(projectDir, "README.md"), "# demo\n", "utf8")

      const first = await app.fetch(new Request("http://localhost/project/workflow/note/import?project=demo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "note before busy session" }),
      }))
      expect(first.status).toBe(200)
      await fs.writeFile(path.join(activeDir, "operations.draft.json"), "draft sentinel\n", "utf8")

      const session = await Instance.provide({
        directory: projectDir,
        fn: () => Session.create({ title: "工作推进" }),
      })
      await ProjectWorkflow.bindSessions({
        project: "demo",
        directory: projectDir,
        sessionID: session.id,
        warmupStatus: "completed",
      })
      await Instance.provide({
        directory: projectDir,
        fn: () => SessionStatus.set(session.id, { type: "busy" }),
      })

      const response = await app.fetch(new Request("http://localhost/project/workflow/note/import?project=demo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "replacement that must be rejected" }),
      }))

      expect(response.status).toBe(409)
      expect(await response.text()).toContain("不能修改工作笔记")
      await expect(fs.readFile(path.join(activeDir, "note.md"), "utf8")).resolves.toBe("note before busy session\n")
      await expect(fs.readFile(path.join(activeDir, "operations.draft.json"), "utf8")).resolves.toBe("draft sentinel\n")
      await Instance.provide({
        directory: projectDir,
        fn: () => SessionStatus.set(session.id, { type: "idle" }),
      })
    } finally {
      process.chdir(originalCwd)
    }
  })

  test("GET /project/workflow/operations returns active graph operation draft artifacts", async () => {
    await using tmp = await tmpdir()
    const originalCwd = process.cwd()
    process.chdir(tmp.path)
    try {
      const app = Server.createApp({})
      const projectDir = path.join(tmp.path, "project_graph_data", "demo")
      await fs.mkdir(projectDir, { recursive: true })
      await fs.writeFile(path.join(projectDir, "README.md"), "# demo\n", "utf8")

      await ProjectWorkflowExecution.runAction({ project: "demo", directory: projectDir, action: "开始或恢复", payload: {} })
      await ProjectWorkflowExecution.writeNote({
        directory: projectDir,
        content: "本轮准备把工作笔记转成图操作草案。",
      })
      await ProjectWorkflowExecution.runAction({
        project: "demo",
        directory: projectDir,
        action: "同步工作笔记变更",
        payload: { summary: "测试写入工作笔记。" },
      })
      const activeDir = path.join(projectDir, "workflows", "active")
      await fs.writeFile(path.join(activeDir, "operation_notes.md"), "## 图操作说明\n\n准备更新已有目标。\n", "utf8")
      await fs.writeFile(path.join(activeDir, "operations.draft.json"), JSON.stringify({
        change_id: "step0_demo_operations",
        timestamp: "2026-07-06T10:00:00+08:00",
        note_filename: "demo_operations_note.md",
        changelog_entry: "[2026-07-06 10:00] step0_demo_operations: 测试把工作笔记转成图操作草案(step0_demo_operations)，用于验证工作推进页图操作产物接口。",
        items: [],
      }, null, 2) + "\n", "utf8")
      await ProjectWorkflowExecution.runAction({
        project: "demo",
        directory: projectDir,
        action: "生成图操作草案",
        payload: {
          summary: "登记图操作产物。",
          change_id: "step0_demo_operations",
          artifacts: {
            operationNotes: true,
            operationsDraft: true,
          },
        },
      })

      const res = await app.fetch(new Request("http://localhost/project/workflow/operations?project=demo"))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.workflow.stage).toBe("图操作已生成")
      expect(body.files.find((file: { key: string; content?: string }) => file.key === "operationNotes")?.content).toContain("图操作说明")
      expect(body.files.find((file: { key: string; content?: string }) => file.key === "operationsDraft")?.content).toContain("step0_demo_operations")
      expect(body.files.find((file: { key: string; content?: string }) => file.key === "operationIndex")?.content).toContain("step0_demo_operations")
      expect(body.files.find((file: { key: string; content?: string }) => file.key === "operations")?.content).toContain("step0_demo_operations")
      expect(body.files.find((file: { key: string; content?: string }) => file.key === "preview")?.content).toContain("step0_demo_operations")
    } finally {
      process.chdir(originalCwd)
    }
  })

  test("GET /project/workflow/graph reads the active base instead of the latest formal graph", async () => {
    await using tmp = await tmpdir()
    const originalCwd = process.cwd()
    process.chdir(tmp.path)
    try {
      const app = Server.createApp({})
      const projectDir = path.join(tmp.path, "project_graph_data", "demo")
      await fs.mkdir(projectDir, { recursive: true })
      const { latest: empty } = await GraphVersionStore.ensure(projectDir)
      const submitted = await GraphVersionStore.createCandidate(projectDir, empty)
      await fs.writeFile(path.join(submitted, "nodes", "goal", "goal_submitted.json"), JSON.stringify({
        id: "goal_submitted",
        type: "goal",
        summary: "已提交目标",
        description: "只存在于最新正式图。",
        status: "active",
      }, null, 2) + "\n", "utf8")
      await GraphVersionStore.publish(projectDir, empty, submitted)

      await ProjectWorkflowExecution.runAction({
        project: "demo",
        directory: projectDir,
        action: "开始或恢复",
        payload: {},
      })
      await GraphVersionStore.bindActiveBase(projectDir, "previous", true)

      const formalRes = await app.fetch(new Request("http://localhost/project/graph?project=demo&view=expanded"))
      expect(formalRes.status).toBe(200)
      const formal = await formalRes.json()
      expect(formal.nodes.map((node: { id: string }) => node.id)).toEqual(["goal_submitted"])

      const workflowRes = await app.fetch(new Request("http://localhost/project/workflow/graph?project=demo&view=expanded"))
      expect(workflowRes.status).toBe(200)
      const workflowGraph = await workflowRes.json()
      expect(workflowGraph.nodes).toEqual([])
      expect(workflowGraph.edges).toEqual([])
    } finally {
      process.chdir(originalCwd)
    }
  })

  test("GET /project/workflow/messages hides forked warmup history", async () => {
    await using tmp = await tmpdir()
    const originalCwd = process.cwd()
    process.chdir(tmp.path)
    try {
      const app = Server.createApp({})
      const projectDir = path.join(tmp.path, "project_graph_data", "demo")
      await fs.mkdir(path.join(projectDir, "metadata"), { recursive: true })
      await fs.writeFile(path.join(projectDir, "README.md"), "# demo\n", "utf8")
      await fs.writeFile(
        path.join(projectDir, "metadata", "project_state.json"),
        JSON.stringify({ graphInitialized: true }, null, 2) + "\n",
        "utf8",
      )

      await Instance.provide({
        directory: projectDir,
        fn: async () => {
          const warmup = await Session.create({ title: "工作推进上下文预热" })
          await SessionPrompt.prompt({
            sessionID: warmup.id,
            noReply: true,
            parts: [{ type: "text", text: "warmup baseline should be hidden" }],
          })
          const chat = await Session.fork({ sessionID: warmup.id })

          await ProjectWorkflowExecution.runAction({ project: "demo", directory: projectDir, action: "开始或恢复", payload: {} })
          await ProjectWorkflow.bindSessions({
            project: "demo",
            directory: projectDir,
            sessionID: chat.id,
            warmupSessionID: warmup.id,
            warmupStatus: "completed",
          })
          await new Promise((resolve) => setTimeout(resolve, 2))
          await SessionPrompt.prompt({
            sessionID: chat.id,
            noReply: true,
            parts: [{ type: "text", text: "visible workflow message" }],
          })
        },
      })

      const res = await app.fetch(new Request("http://localhost/project/workflow/messages?project=demo"))
      expect(res.status).toBe(200)
      const body = await res.json()
      const text = JSON.stringify(body.messages)
      expect(text).toContain("visible workflow message")
      expect(text).not.toContain("warmup baseline should be hidden")

      const statePath = path.join(projectDir, "workflows", "active", "state.json")
      const state = JSON.parse(await fs.readFile(statePath, "utf8"))
      delete state.sessionStartedAt
      await fs.writeFile(statePath, JSON.stringify(state, null, 2) + "\n", "utf8")

      const legacyRes = await app.fetch(new Request("http://localhost/project/workflow/messages?project=demo"))
      expect(legacyRes.status).toBe(200)
      const legacyBody = await legacyRes.json()
      const legacyText = JSON.stringify(legacyBody.messages)
      expect(legacyText).toContain("visible workflow message")
      expect(legacyText).not.toContain("warmup baseline should be hidden")
    } finally {
      process.chdir(originalCwd)
    }
  })

  test("workflow readiness is derived from active base graph content", async () => {
    await using tmp = await tmpdir()
    const originalCwd = process.cwd()
    process.chdir(tmp.path)
    try {
      const app = Server.createApp({})
      const emptyProject = path.join(tmp.path, "project_graph_data", "empty")
      await fs.mkdir(path.join(emptyProject, "metadata"), { recursive: true })

      const emptyRes = await app.fetch(new Request("http://localhost/project/workflow/state?project=empty"))
      expect(emptyRes.status).toBe(200)
      const empty = await emptyRes.json()
      expect(empty.baseIsEmpty).toBe(true)
      expect(empty.sessionReady).toBe(false)

      await ProjectWorkflowExecution.runAction({
        project: "empty",
        directory: emptyProject,
        action: "开始或恢复",
        payload: {},
      })
      await fs.writeFile(path.join(emptyProject, "workflows", "active", "note.md"), "保留的工作笔记。\n")
      await fs.writeFile(path.join(emptyProject, "workflows", "active", "operations.draft.json"), "{\"change_id\":\"step0_keep\"}\n")
      const restoreRes = await app.fetch(new Request("http://localhost/project/workflow/warmup?project=empty", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force: true }),
      }))
      expect(restoreRes.status).toBe(200)
      const restored = await restoreRes.json()
      expect(restored.baseIsEmpty).toBe(true)
      expect(restored.sessionReady).toBe(true)
      expect(restored.state?.warmupSessionID).toBeUndefined()
      await expect(fs.readFile(path.join(emptyProject, "workflows", "active", "note.md"), "utf8")).resolves.toContain("保留的工作笔记")
      await expect(fs.readFile(path.join(emptyProject, "workflows", "active", "operations.draft.json"), "utf8")).resolves.toContain("step0_keep")

      const graphProject = path.join(tmp.path, "project_graph_data", "with-graph")
      await fs.mkdir(path.join(graphProject, "nodes", "goal"), { recursive: true })
      await fs.writeFile(path.join(graphProject, "nodes", "goal", "goal_demo.json"), "{}\n")
      const graphRes = await app.fetch(new Request("http://localhost/project/workflow/state?project=with-graph"))
      expect(graphRes.status).toBe(200)
      const graph = await graphRes.json()
      expect(graph.baseIsEmpty).toBe(false)
      expect(graph.sessionReady).toBe(false)
    } finally {
      process.chdir(originalCwd)
    }
  })

  test("GET /project/workflow/messages keeps restored hard-correction chat history", async () => {
    await using tmp = await tmpdir()
    const originalCwd = process.cwd()
    process.chdir(tmp.path)
    try {
      const app = Server.createApp({})
      const projectDir = path.join(tmp.path, "project_graph_data", "demo")
      await fs.mkdir(path.join(projectDir, "metadata"), { recursive: true })
      await fs.writeFile(path.join(projectDir, "README.md"), "# demo\n", "utf8")
      await fs.writeFile(
        path.join(projectDir, "metadata", "project_state.json"),
        JSON.stringify({ graphInitialized: true }, null, 2) + "\n",
        "utf8",
      )

      await Instance.provide({
        directory: projectDir,
        fn: async () => {
          const warmup = await Session.create({ title: "工作推进上下文预热" })
          await SessionPrompt.prompt({
            sessionID: warmup.id,
            noReply: true,
            parts: [{ type: "text", text: "restored warmup baseline should be hidden" }],
          })
          const originalChat = await Session.fork({ sessionID: warmup.id })
          await SessionPrompt.prompt({
            sessionID: originalChat.id,
            noReply: true,
            parts: [{ type: "text", text: "original workflow discussion should stay visible" }],
          })

          await ProjectWorkflowExecution.runAction({ project: "demo", directory: projectDir, action: "开始或恢复", payload: {} })
          await ProjectWorkflow.bindSessions({
            project: "demo",
            directory: projectDir,
            sessionID: originalChat.id,
            warmupSessionID: warmup.id,
            warmupStatus: "completed",
          })
          await ProjectWorkflow.writeHardCorrectionState({
            project: "demo",
            directory: projectDir,
            payload: {
              ofChangeId: "step01_demo",
              sourceArchivePath: "workflows/applied/step01_demo",
              fixIndex: 1,
              expectedChangeId: "step01_demo_fix1",
            },
          })

          const restoredChat = await Session.fork({ sessionID: originalChat.id })
          await ProjectWorkflow.bindRestoredWorkflowChat({
            project: "demo",
            directory: projectDir,
            sessionID: restoredChat.id,
            warmupSessionID: warmup.id,
            warmupStatus: "completed",
          })
          await SessionPrompt.prompt({
            sessionID: restoredChat.id,
            noReply: true,
            parts: [{ type: "text", text: "restored workflow follow-up" }],
          })
        },
      })

      const res = await app.fetch(new Request("http://localhost/project/workflow/messages?project=demo"))
      expect(res.status).toBe(200)
      const body = await res.json()
      const text = JSON.stringify(body.messages)
      expect(text).toContain("original workflow discussion should stay visible")
      expect(text).toContain("restored workflow follow-up")
      expect(text).not.toContain("restored warmup baseline should be hidden")
    } finally {
      process.chdir(originalCwd)
    }
  })

  test("GET /project/workflow/messages does not restore hard-correction active without session id", async () => {
    await using tmp = await tmpdir()
    const originalCwd = process.cwd()
    process.chdir(tmp.path)
    try {
      const app = Server.createApp({})
      const projectDir = path.join(tmp.path, "project_graph_data", "demo")
      await fs.mkdir(path.join(projectDir, "metadata"), { recursive: true })
      await fs.writeFile(path.join(projectDir, "README.md"), "# demo\n", "utf8")
      await fs.writeFile(
        path.join(projectDir, "metadata", "project_state.json"),
        JSON.stringify({ graphInitialized: true }, null, 2) + "\n",
        "utf8",
      )

      await Instance.provide({
        directory: projectDir,
        fn: async () => {
          const originalChat = await Session.create({ title: "工作推进" })
          await SessionPrompt.prompt({
            sessionID: originalChat.id,
            noReply: true,
            parts: [{ type: "text", text: "legacy active source chat should be restored" }],
          })

          await ProjectWorkflowExecution.runAction({ project: "demo", directory: projectDir, action: "开始或恢复", payload: {} })
          const active = await ProjectWorkflow.getActive({ project: "demo", directory: projectDir })
          await fs.writeFile(
            path.join(projectDir, "workflows", "active", "state.json"),
            JSON.stringify({
              ...active.state,
              hardCorrection: {
                ofChangeId: "step0_demo",
                sourceArchivePath: "workflows/applied/step0_demo",
                fixIndex: 1,
                expectedChangeId: "step0_demo_fix1",
                restoredAt: new Date().toISOString(),
              },
            },
            null,
            2,
          ) + "\n", "utf8")
        },
      })

      const res = await app.fetch(new Request("http://localhost/project/workflow/messages?project=demo"))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.sessionID).toBeUndefined()
      expect(body.messages).toEqual([])
      expect(body.workflow.state?.sessionID).toBeUndefined()
      expect(JSON.stringify(body)).not.toContain("legacy active source chat should be restored")

      const chatRes = await app.fetch(new Request("http://localhost/project/workflow/chat?project=demo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "继续硬更正" }),
      }))
      expect(chatRes.status).toBe(409)
      const afterChat = await ProjectWorkflow.getActive({ project: "demo", directory: projectDir })
      expect(afterChat.state?.sessionID).toBeUndefined()
    } finally {
      process.chdir(originalCwd)
    }
  })

  test("POST /project/workflow/action rejects apply while the workflow session is busy", async () => {
    await using tmp = await tmpdir()
    const originalCwd = process.cwd()
    process.chdir(tmp.path)
    try {
      const app = Server.createApp({})
      const projectDir = path.join(tmp.path, "project_graph_data", "demo")
      await fs.mkdir(path.join(projectDir, "metadata"), { recursive: true })
      await fs.writeFile(path.join(projectDir, "README.md"), "# demo\n", "utf8")
      await ProjectWorkflowExecution.runAction({
        project: "demo",
        directory: projectDir,
        action: "开始或恢复",
        payload: {},
      })
      const session = await Instance.provide({
        directory: projectDir,
        fn: () => Session.create({ title: "工作推进" }),
      })
      await ProjectWorkflow.bindSessions({
        project: "demo",
        directory: projectDir,
        sessionID: session.id,
        warmupStatus: "completed",
      })
      await Instance.provide({
        directory: projectDir,
        fn: () => SessionStatus.set(session.id, { type: "busy" }),
      })

      const response = await app.fetch(new Request("http://localhost/project/workflow/action?project=demo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "应用图操作", payload: { confirm: true } }),
      }))

      expect(response.status).toBe(409)
      expect(await response.text()).toContain("大模型仍在处理当前工作推进")
      await Instance.provide({
        directory: projectDir,
        fn: () => SessionStatus.set(session.id, { type: "idle" }),
      })
    } finally {
      process.chdir(originalCwd)
    }
  })

  test("POST /project/workflow/action rejects correction mode switches while warmup is running", async () => {
    await using tmp = await tmpdir()
    const originalCwd = process.cwd()
    process.chdir(tmp.path)
    try {
      const app = Server.createApp({})
      const projectDir = path.join(tmp.path, "project_graph_data", "demo")
      await fs.mkdir(path.join(projectDir, "metadata"), { recursive: true })
      await fs.writeFile(path.join(projectDir, "README.md"), "# demo\n", "utf8")
      const started = await ProjectWorkflowExecution.runAction({
        project: "demo",
        directory: projectDir,
        action: "开始或恢复",
        payload: {},
      })
      await ProjectWorkflow.bindSessions({
        project: "demo",
        directory: projectDir,
        warmupStatus: "running",
      })

      for (const action of ["开始软更正", "重做最近提交"]) {
        const response = await app.fetch(new Request("http://localhost/project/workflow/action?project=demo", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, payload: { confirm: true } }),
        }))
        expect(response.status).toBe(409)
        expect(await response.text()).toContain("项目上下文仍在预热")
      }

      const current = await ProjectWorkflow.getActive({ project: "demo", directory: projectDir })
      expect(current.state?.id).toBe(started.state?.id)
      expect(current.state?.warmupStatus).toBe("running")
      expect(current.state?.correction).toBeUndefined()
    } finally {
      process.chdir(originalCwd)
    }
  })

  test("POST /project/workflow/action restores chat history even when the archived warmup is missing", async () => {
    await using tmp = await tmpdir()
    const originalCwd = process.cwd()
    process.chdir(tmp.path)
    let archivedWarmupSessionID: SessionID | undefined
    try {
      const app = Server.createApp({})
      const projectDir = path.join(tmp.path, "project_graph_data", "demo")
      await fs.mkdir(path.join(projectDir, "metadata"), { recursive: true })
      await fs.writeFile(path.join(projectDir, "README.md"), "# demo\n", "utf8")

      await ProjectWorkflowExecution.runAction({
        project: "demo",
        directory: projectDir,
        action: "开始或恢复",
        payload: {},
      })
      await ProjectWorkflowExecution.runAction({
        project: "demo",
        directory: projectDir,
        action: "更新工作笔记",
        payload: {
          content: "首轮工作推进笔记。",
          summary: "首轮工作推进。",
        },
      })

      await Instance.provide({
        directory: projectDir,
        fn: async () => {
          const warmup = await Session.create({ title: "工作推进上下文预热" })
          archivedWarmupSessionID = warmup.id
          await SessionPrompt.prompt({
            sessionID: warmup.id,
            noReply: true,
            parts: [{ type: "text", text: "warmup baseline before apply should stay hidden" }],
          })
          const chat = await Session.fork({ sessionID: warmup.id })
          await Bun.sleep(2)
          await ProjectWorkflow.bindSessions({
            project: "demo",
            directory: projectDir,
            sessionID: chat.id,
            warmupSessionID: warmup.id,
            warmupStatus: "completed",
          })
          await SessionPrompt.prompt({
            sessionID: chat.id,
            noReply: true,
            parts: [{ type: "text", text: "original chat before apply should be restored" }],
          })
        },
      })

      const activeDir = path.join(projectDir, "workflows", "active")
      await fs.writeFile(path.join(activeDir, "operation_notes.md"), "## 图操作说明\n\n首轮最小建图提交。\n", "utf8")
      await fs.writeFile(path.join(activeDir, "operations.draft.json"), JSON.stringify({
        change_id: "step0_initial_workflow",
        timestamp: "2026-07-06T10:00:00+08:00",
        note_filename: "initial_workflow.md",
        changelog_entry: "[2026-07-06 10:00] step0_initial_workflow: 首轮创建目标、工作块和计划工作项，用于验证硬更正会话恢复。",
        items: [
          {
            kind: "create_node",
            temp_id: "goal_initial_workflow",
            node_type: "goal",
            summary: "首轮目标",
            description: "首轮目标当前状态。",
            fields: { status: "established", completion_score: 0 },
            history: "[step0_initial_workflow] 创建首轮目标。",
          },
          {
            kind: "create_node",
            temp_id: "work_block_initial_workflow",
            node_type: "work_block",
            summary: "首轮工作块",
            description: "首轮工作块当前状态。",
            fields: { status: "active", linked_goal_id: "goal_initial_workflow" },
            history: "[step0_initial_workflow] 创建首轮工作块。",
          },
          {
            kind: "create_node",
            temp_id: "work_item_initial_workflow",
            node_type: "work_item",
            summary: "首轮工作项",
            description: "首轮工作项当前状态。",
            fields: { status: "planned", linked_work_block_id: "work_block_initial_workflow" },
            history: "[step0_initial_workflow] 创建首轮计划工作项。",
          },
        ],
      }, null, 2) + "\n", "utf8")
      await ProjectWorkflowExecution.runAction({
        project: "demo",
        directory: projectDir,
        action: "生成图操作草案",
        payload: {
          summary: "登记首轮建图草案。",
          change_id: "step0_initial_workflow",
          artifacts: { operationNotes: true, operationsDraft: true },
        },
      })
      await ProjectWorkflowExecution.runAction({
        project: "demo",
        directory: projectDir,
        action: "应用图操作",
        payload: { confirm: true },
      })
      if (!archivedWarmupSessionID) throw new Error("test warmup session was not created")
      await Instance.provide({
        directory: projectDir,
        fn: () => Session.remove(archivedWarmupSessionID!),
      })

      const res = await app.fetch(new Request("http://localhost/project/workflow/action?project=demo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "重做最近提交", payload: { confirm: true } }),
      }))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.state?.correction).toBeUndefined()
      expect(body.state?.hardCorrection?.expectedChangeId).toBe("step0_initial_workflow_fix1")
      expect(body.state?.sessionID).toMatch(/^ses_/)
      expect(body.state?.warmupSessionID).toMatch(/^ses_/)
      expect(body.data?.restoredSession).toBeUndefined()

      const messagesRes = await app.fetch(new Request("http://localhost/project/workflow/messages?project=demo"))
      expect(messagesRes.status).toBe(200)
      const messagesBody = await messagesRes.json()
      const messagesText = JSON.stringify(messagesBody.messages)
      expect(messagesText).toContain("original chat before apply should be restored")
      expect(messagesText).not.toContain("warmup baseline before apply should stay hidden")
    } finally {
      process.chdir(originalCwd)
    }
  })

  test("hard correction forks the archived warmup when the archived chat no longer exists", async () => {
    await using tmp = await tmpdir()
    const originalCwd = process.cwd()
    process.chdir(tmp.path)
    try {
      const app = Server.createApp({})
      const projectDir = path.join(tmp.path, "project_graph_data", "demo")
      await fs.mkdir(path.join(projectDir, "metadata"), { recursive: true })
      await fs.writeFile(path.join(projectDir, "README.md"), "# demo\n", "utf8")
      await ProjectWorkflowExecution.runAction({ project: "demo", directory: projectDir, action: "开始或恢复", payload: {} })
      await ProjectWorkflowExecution.runAction({
        project: "demo",
        directory: projectDir,
        action: "更新工作笔记",
        payload: { content: "首轮事件记录。", summary: "首轮事件。" },
      })

      let warmupSessionID = ""
      let chatSessionID = ""
      await Instance.provide({
        directory: projectDir,
        fn: async () => {
          const warmup = await Session.create({ title: "工作推进上下文预热" })
          warmupSessionID = warmup.id
          await SessionPrompt.prompt({
            sessionID: warmup.id,
            noReply: true,
            parts: [{ type: "text", text: "archived warmup should remain hidden" }],
          })
          const chat = await Session.fork({ sessionID: warmup.id })
          chatSessionID = chat.id
          await ProjectWorkflow.bindSessions({
            project: "demo",
            directory: projectDir,
            sessionID: chat.id,
            warmupSessionID: warmup.id,
            warmupStatus: "completed",
          })
        },
      })

      const activeDir = path.join(projectDir, "workflows", "active")
      await fs.writeFile(path.join(activeDir, "operation_notes.md"), "# 图操作说明\n\n创建首轮事件。\n", "utf8")
      await fs.writeFile(path.join(activeDir, "operations.draft.json"), JSON.stringify({
        change_id: "step0_initial_event",
        timestamp: "2026-07-06T10:00:00+08:00",
        note_filename: "initial_event.md",
        changelog_entry: "[2026-07-06 10:00] step0_initial_event: 记录首轮项目事件并建立初始图数据。",
        items: [
          {
            kind: "create_node",
            temp_id: "goal_initial_event",
            node_type: "goal",
            summary: "首轮项目目标",
            description: "项目首轮目标已经建立。",
            fields: { status: "established", completion_score: 0 },
            history: "[step0_initial_event] 建立首轮项目目标。",
          },
          {
            kind: "create_node",
            temp_id: "work_block_initial_event",
            node_type: "work_block",
            summary: "首轮工作块",
            description: "首轮工作块用于组织初始工作。",
            fields: { status: "active", linked_goal_id: "goal_initial_event" },
            history: "[step0_initial_event] 创建首轮工作块并归属首轮目标。",
          },
          {
            kind: "create_node",
            temp_id: "work_item_initial_event",
            node_type: "work_item",
            summary: "首轮计划工作项",
            description: "首轮工作项尚未开始。",
            fields: { status: "planned", linked_work_block_id: "work_block_initial_event" },
            history: "[step0_initial_event] 创建首轮计划工作项并归属首轮工作块。",
          },
        ],
      }, null, 2) + "\n", "utf8")
      await ProjectWorkflowExecution.runAction({
        project: "demo",
        directory: projectDir,
        action: "生成图操作草案",
        payload: {
          summary: "登记首轮事件图操作。",
          change_id: "step0_initial_event",
          artifacts: { operationNotes: true, operationsDraft: true },
        },
      })
      await ProjectWorkflowExecution.runAction({
        project: "demo",
        directory: projectDir,
        action: "应用图操作",
        payload: { confirm: true },
      })
      await Instance.provide({ directory: projectDir, fn: () => Session.remove(chatSessionID as SessionID) })

      const res = await app.fetch(new Request("http://localhost/project/workflow/action?project=demo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "重做最近提交", payload: { confirm: true } }),
      }))

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.state?.sessionID).toMatch(/^ses_/)
      expect(body.state?.sessionID).not.toBe(chatSessionID)
      expect(body.state?.warmupSessionID).toBe(warmupSessionID)
      const messagesRes = await app.fetch(new Request("http://localhost/project/workflow/messages?project=demo"))
      const messages = await messagesRes.json()
      expect(JSON.stringify(messages.messages)).not.toContain("archived warmup should remain hidden")
    } finally {
      process.chdir(originalCwd)
    }
  })

  test("POST /project/workflow/note/import accepts markdown file without registering source resource", async () => {
    await using tmp = await tmpdir()
    const originalCwd = process.cwd()
    process.chdir(tmp.path)
    try {
      const app = Server.createApp({})
      const projectDir = path.join(tmp.path, "project_graph_data", "demo")
      await fs.mkdir(projectDir, { recursive: true })
      await fs.writeFile(path.join(projectDir, "README.md"), "# demo\n", "utf8")
      const form = new FormData()
      form.append("file", new File(["# Imported\n\nbody\n"], "note.md", { type: "text/markdown" }))

      const res = await app.fetch(new Request("http://localhost/project/workflow/note/import?project=demo", {
        method: "POST",
        body: form,
      }))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toMatchObject({ exists: true, content: "# Imported\n\nbody\n", path: "workflows/active/note.md" })
      await expect(fs.readFile(path.join(projectDir, "workflows", "active", "note.md"), "utf8")).resolves.toBe("# Imported\n\nbody\n")
      await expect(fs.stat(path.join(projectDir, "metadata", "source_resources.json"))).rejects.toThrow()
      await expect(fs.stat(path.join(projectDir, "source", "note.md"))).rejects.toThrow()
      await expect(fs.stat(path.join(projectDir, "workflows", "active", "resources.json"))).rejects.toThrow()
    } finally {
      process.chdir(originalCwd)
    }
  })

  test("GET /project/notes lists and previews archived work notes", async () => {
    await using tmp = await tmpdir()
    const originalCwd = process.cwd()
    process.chdir(tmp.path)
    try {
      const app = Server.createApp({})
      const projectDir = path.join(tmp.path, "project_graph_data", "demo")
      await fs.mkdir(path.join(projectDir, "notes"), { recursive: true })
      await fs.writeFile(path.join(projectDir, "README.md"), "# demo\n", "utf8")
      await fs.writeFile(path.join(projectDir, "notes", "past_note.md"), "# Past note\n\nbody\n", "utf8")
      await fs.writeFile(path.join(projectDir, "notes", "past_diagram.svg"), "<svg></svg>\n", "utf8")

      const listRes = await app.fetch(new Request("http://localhost/project/notes?project=demo"))
      expect(listRes.status).toBe(200)
      const notes = await listRes.json()
      expect(notes).toHaveLength(2)
      expect(notes.find((item: { path: string }) => item.path === "notes/past_note.md")).toMatchObject({
        originalName: "past_note.md",
        path: "notes/past_note.md",
        previewable: true,
      })
      expect(notes.find((item: { path: string }) => item.path === "notes/past_diagram.svg")).toMatchObject({
        originalName: "past_diagram.svg",
        path: "notes/past_diagram.svg",
        previewable: true,
      })

      const previewRes = await app.fetch(new Request("http://localhost/project/notes/preview?project=demo&path=notes%2Fpast_note.md"))
      expect(previewRes.status).toBe(200)
      const preview = await previewRes.json()
      expect(preview).toMatchObject({
        type: "text",
        path: "notes/past_note.md",
        content: "# Past note\n\nbody\n",
      })

      const imagePreviewRes = await app.fetch(new Request("http://localhost/project/notes/preview?project=demo&path=notes%2Fpast_diagram.svg"))
      expect(imagePreviewRes.status).toBe(200)
      const imagePreview = await imagePreviewRes.json()
      expect(imagePreview).toMatchObject({
        type: "image",
        path: "notes/past_diagram.svg",
        mimeType: "image/svg+xml",
        content: "",
        imageUrl: "/project/notes/raw?project=demo&path=notes%2Fpast_diagram.svg",
      })

      const rawRes = await app.fetch(new Request("http://localhost/project/notes/raw?project=demo&path=notes%2Fpast_diagram.svg"))
      expect(rawRes.status).toBe(200)
      expect(rawRes.headers.get("content-type")).toBe("image/svg+xml")
      expect(await rawRes.text()).toBe("<svg></svg>\n")
    } finally {
      process.chdir(originalCwd)
    }
  })

  test("GET /project/source previews html and image resources", async () => {
    await using tmp = await tmpdir()
    const originalCwd = process.cwd()
    process.chdir(tmp.path)
    try {
      const app = Server.createApp({})
      const projectDir = path.join(tmp.path, "project_graph_data", "demo")
      const sourceDir = path.join(projectDir, "source")
      await fs.mkdir(sourceDir, { recursive: true })
      await fs.writeFile(path.join(projectDir, "README.md"), "# demo\n", "utf8")
      await fs.writeFile(path.join(sourceDir, "overview.html"), "<main><h1>Overview</h1></main>\n", "utf8")
      await fs.writeFile(
        path.join(sourceDir, "diagram.svg"),
        '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><text x="4" y="20">demo</text></svg>',
        "utf8",
      )

      const listRes = await app.fetch(new Request("http://localhost/project/source?project=demo"))
      expect(listRes.status).toBe(200)
      const resources = await listRes.json()
      expect(resources.find((item: { path: string }) => item.path === "source/overview.html")).toMatchObject({
        previewable: true,
      })
      expect(resources.find((item: { path: string }) => item.path === "source/diagram.svg")).toMatchObject({
        previewable: true,
      })

      const htmlRes = await app.fetch(new Request("http://localhost/project/source/preview?project=demo&path=source%2Foverview.html"))
      expect(htmlRes.status).toBe(200)
      const htmlPreview = await htmlRes.json()
      expect(htmlPreview).toMatchObject({
        type: "html",
        path: "source/overview.html",
        mimeType: "text/html",
        content: "<main><h1>Overview</h1></main>\n",
      })

      const imageRes = await app.fetch(new Request("http://localhost/project/source/preview?project=demo&path=source%2Fdiagram.svg"))
      expect(imageRes.status).toBe(200)
      const imagePreview = await imageRes.json()
      expect(imagePreview).toMatchObject({
        type: "image",
        path: "source/diagram.svg",
        mimeType: "image/svg+xml",
        content: "",
        imageUrl: "/project/source/raw?project=demo&path=source%2Fdiagram.svg",
      })
      expect(imagePreview.dataUrl).toBeUndefined()

      const rawRes = await app.fetch(new Request("http://localhost/project/source/raw?project=demo&path=source%2Fdiagram.svg"))
      expect(rawRes.status).toBe(200)
      expect(rawRes.headers.get("content-type")).toBe("image/svg+xml")
      expect(rawRes.headers.get("cache-control")).toBe("private, max-age=300")
      expect(rawRes.headers.get("x-content-type-options")).toBe("nosniff")
      const rawContent = await rawRes.text()
      expect(rawContent).toContain("<svg")

      const etag = rawRes.headers.get("etag")
      expect(etag).toBeTruthy()
      const cachedRes = await app.fetch(new Request("http://localhost/project/source/raw?project=demo&path=source%2Fdiagram.svg", {
        headers: { "If-None-Match": etag || "" },
      }))
      expect(cachedRes.status).toBe(304)

      const htmlRawRes = await app.fetch(new Request("http://localhost/project/source/raw?project=demo&path=source%2Foverview.html"))
      expect(htmlRawRes.status).toBe(400)
    } finally {
      process.chdir(originalCwd)
    }
  })

  test("POST /project/workflow/note/import rejects non-text note files", async () => {
    await using tmp = await tmpdir()
    const originalCwd = process.cwd()
    process.chdir(tmp.path)
    try {
      const app = Server.createApp({})
      const projectDir = path.join(tmp.path, "project_graph_data", "demo")
      await fs.mkdir(projectDir, { recursive: true })
      await fs.writeFile(path.join(projectDir, "README.md"), "# demo\n", "utf8")
      const form = new FormData()
      form.append("file", new File(["binary"], "note.pdf", { type: "application/pdf" }))

      const res = await app.fetch(new Request("http://localhost/project/workflow/note/import?project=demo", {
        method: "POST",
        body: form,
      }))
      expect(res.status).toBe(400)
      await expect(fs.stat(path.join(projectDir, "workflows", "active", "note.md"))).rejects.toThrow()
      await expect(fs.stat(path.join(projectDir, "source", "note.pdf"))).rejects.toThrow()
    } finally {
      process.chdir(originalCwd)
    }
  })

  test("POST /project/workflow/note/import rejects html preview files", async () => {
    await using tmp = await tmpdir()
    const originalCwd = process.cwd()
    process.chdir(tmp.path)
    try {
      const app = Server.createApp({})
      const projectDir = path.join(tmp.path, "project_graph_data", "demo")
      await fs.mkdir(projectDir, { recursive: true })
      await fs.writeFile(path.join(projectDir, "README.md"), "# demo\n", "utf8")
      const form = new FormData()
      form.append("file", new File(["<h1>not a note</h1>"], "note.html", { type: "text/html" }))

      const res = await app.fetch(new Request("http://localhost/project/workflow/note/import?project=demo", {
        method: "POST",
        body: form,
      }))
      expect(res.status).toBe(400)
      await expect(fs.stat(path.join(projectDir, "workflows", "active", "note.md"))).rejects.toThrow()
      await expect(fs.stat(path.join(projectDir, "source", "note.html"))).rejects.toThrow()
    } finally {
      process.chdir(originalCwd)
    }
  })

  test("DELETE /project/source removes source file and registry entry", async () => {
    await using tmp = await tmpdir()
    const originalCwd = process.cwd()
    process.chdir(tmp.path)
    try {
      const app = Server.createApp({})
      const projectDir = path.join(tmp.path, "project_graph_data", "demo")
      const sourceDir = path.join(projectDir, "source")
      const metadataDir = path.join(projectDir, "metadata")
      await fs.mkdir(sourceDir, { recursive: true })
      await fs.mkdir(metadataDir, { recursive: true })
      await fs.writeFile(path.join(sourceDir, "keep.md"), "keep\n", "utf8")
      await fs.writeFile(path.join(sourceDir, "delete.md"), "delete\n", "utf8")
      await fs.writeFile(
        path.join(metadataDir, "source_resources.json"),
        JSON.stringify({
          resources: [
            {
              id: "res_keep",
              name: "keep.md",
              originalName: "keep.md",
              path: "source/keep.md",
              size: 5,
              uploadedAt: "2026-01-01T00:00:00.000Z",
              previewable: true,
            },
            {
              id: "res_delete",
              name: "delete.md",
              originalName: "delete.md",
              path: "source/delete.md",
              size: 7,
              uploadedAt: "2026-01-02T00:00:00.000Z",
              previewable: true,
            },
          ],
        }),
        "utf8",
      )

      const res = await app.fetch(
        new Request("http://localhost/project/source?project=demo&path=source%2Fdelete.md", {
          method: "DELETE",
        }),
      )
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true, path: "source/delete.md" })
      await expect(fs.stat(path.join(sourceDir, "delete.md"))).rejects.toThrow()
      await expect(fs.readFile(path.join(sourceDir, "keep.md"), "utf8")).resolves.toBe("keep\n")

      const registry = JSON.parse(await fs.readFile(path.join(metadataDir, "source_resources.json"), "utf8"))
      expect(registry.resources.map((item: { path: string }) => item.path)).toEqual(["source/keep.md"])

      const listRes = await app.fetch(new Request("http://localhost/project/source?project=demo"))
      expect(listRes.status).toBe(200)
      const list = await listRes.json()
      expect(list.map((item: { path: string }) => item.path)).toEqual(["source/keep.md"])
    } finally {
      process.chdir(originalCwd)
    }
  })

  test("DELETE /project/source rejects paths outside source directory", async () => {
    await using tmp = await tmpdir()
    const originalCwd = process.cwd()
    process.chdir(tmp.path)
    try {
      const app = Server.createApp({})
      const projectDir = path.join(tmp.path, "project_graph_data", "demo")
      await fs.mkdir(path.join(projectDir, "source"), { recursive: true })
      await fs.writeFile(path.join(projectDir, "README.md"), "readme\n", "utf8")

      const res = await app.fetch(
        new Request("http://localhost/project/source?project=demo&path=source%2F..%2FREADME.md", {
          method: "DELETE",
        }),
      )
      expect(res.status).toBe(400)
      await expect(fs.readFile(path.join(projectDir, "README.md"), "utf8")).resolves.toBe("readme\n")
    } finally {
      process.chdir(originalCwd)
    }
  })
})
