import { describe, test, expect, afterEach } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Instance } from "../project/instance"
import { Server } from "../server/server"
import { tmpdir } from "./fixture/fixture"
import { Log } from "../util/log"
import { Session } from "../session"
import { SessionPrompt } from "../session/prompt"
import { ProjectDetail } from "../project/detail"
import { Database } from "../storage/db"
import { ProjectSummaryRecordTable } from "../project/project.sql"
import { SessionID } from "../session/schema"
import { ProjectWorkflow } from "../workflow/state"
import { ProjectWorkflowExecution } from "../workflow/execution"

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

function insertBaselineSummary(directory: string, sessionID: SessionID) {
  const now = Date.now()
  Database.use((db) => {
    db.insert(ProjectSummaryRecordTable).values({
      id: `summary-${now}`,
      project_directory: directory,
      session_id: sessionID,
      status: "completed",
      kind: "summary",
      source: "manual",
      is_current_baseline: true,
      summary_text: "summary body",
      report_path: null,
      report_link_path: null,
      time_created: now,
      time_updated: now,
    }).run()
  })
}

describe("server routes", () => {
  afterEach(async () => {
    await Instance.disposeAll()
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
        insertBaselineSummary(tmp.path, baseline.id)

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
        insertBaselineSummary(tmp.path, baseline.id)

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
        expect(followupTurn?.running).toBe(true)
      },
    })
  })

  test("POST /project/question returns hydrated project detail", async () => {
    await using tmp = await tmpdir({ config: TEST_MODEL_CONFIG })
    const app = Server.createApp({})

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const baseline = await Session.create({ title: "项目总结" })
        insertBaselineSummary(tmp.path, baseline.id)
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

  test("GET /project/workflow/operations returns active graph operation draft artifacts", async () => {
    await using tmp = await tmpdir()
    const originalCwd = process.cwd()
    process.chdir(tmp.path)
    try {
      const app = Server.createApp({})
      const projectDir = path.join(tmp.path, "project_graph_data", "demo")
      await fs.mkdir(projectDir, { recursive: true })
      await fs.writeFile(path.join(projectDir, "README.md"), "# demo\n", "utf8")

      await ProjectWorkflow.runAction({ project: "demo", directory: projectDir, action: "开始或恢复", payload: {} })
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
        change_id: "demo_operations",
        timestamp: "2026-07-06T10:00:00+08:00",
        note_filename: "demo_operations_note.md",
        changelog_entry: "[2026-07-06 10:00] demo_operations: 测试把工作笔记转成图操作草案(demo_operations)，用于验证工作推进页图操作产物接口。",
        items: [],
      }, null, 2) + "\n", "utf8")
      await ProjectWorkflowExecution.runAction({
        project: "demo",
        directory: projectDir,
        action: "生成图操作草案",
        payload: {
          summary: "登记图操作产物。",
          change_id: "demo_operations",
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
      expect(body.files.find((file: { key: string; content?: string }) => file.key === "operationsDraft")?.content).toContain("demo_operations")
      expect(body.files.find((file: { key: string; content?: string }) => file.key === "operationIndex")?.content).toContain("demo_operations")
      expect(body.files.find((file: { key: string; content?: string }) => file.key === "operations")?.content).toContain("demo_operations")
      expect(body.files.find((file: { key: string; content?: string }) => file.key === "preview")?.content).toContain("demo_operations")
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

          await ProjectWorkflow.runAction({ project: "demo", directory: projectDir, action: "开始或恢复", payload: {} })
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

  test("POST /project/workflow/note/import accepts markdown file and registers source resource", async () => {
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
      const registry = JSON.parse(await fs.readFile(path.join(projectDir, "metadata", "source_resources.json"), "utf8"))
      expect(registry.resources).toHaveLength(1)
      expect(registry.resources[0]).toMatchObject({
        originalName: "note.md",
        path: "source/note.md",
        previewable: true,
      })
      await expect(fs.readFile(path.join(projectDir, "source", "note.md"), "utf8")).resolves.toBe("# Imported\n\nbody\n")
      const resourcesRaw = await fs.readFile(path.join(projectDir, "workflows", "active", "resources.json"), "utf8")
      expect(resourcesRaw).toContain("source/note.md")
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
