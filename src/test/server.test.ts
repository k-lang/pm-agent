import { describe, test, expect, afterEach } from "bun:test"
import { Instance } from "../project/instance"
import { Server } from "../server/server"
import { tmpdir } from "./fixture/fixture"
import { Log } from "../util/log"
import { Session } from "../session"
import { ProjectDetail } from "../project/detail"
import { Database } from "../storage/db"
import { ProjectSummaryRecordTable } from "../project/project.sql"
import { SessionID } from "../session/schema"

Log.init({ print: false })

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
    await using tmp = await tmpdir()

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
    await using tmp = await tmpdir()
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
        expect(body.selectedThread?.turns.length).toBe(1)
        expect(body.selectedThread?.turns[0]?.questionText).toBe("followup question")
        expect(body.selectedThread?.turns[0]?.running).toBe(true)
      },
    })
  })

  test("POST /project/question returns hydrated project detail", async () => {
    await using tmp = await tmpdir()
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
})

