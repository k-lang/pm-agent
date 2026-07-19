import { describe, test, expect } from "bun:test"
import { SessionTable } from "../session/session.sql"
import { Database, eq } from "../storage/db"
import { ProjectID } from "../project/schema"
import { MessageID } from "../session/schema"

describe("Session CRUD", () => {
  test("create and get session", async () => {
    const { Instance } = await import("../project/instance")
    const { Session } = await import("../session/index")

    await Instance.provide({
      directory: "/workspace/opencode",
      fn: async () => {
        const session = await Session.create()
        expect(session.id).toBeDefined()
        expect(session.slug).toBeDefined()
        expect(session.projectID).toBe(Instance.project.id)
        expect(session.title).toMatch(/^New session - /)

        const fetched = await Session.get(session.id)
        expect(fetched.id).toBe(session.id)
        expect(fetched.title).toBe(session.title)
      },
    })
  })

  test("list sessions for project", async () => {
    const { Instance } = await import("../project/instance")
    const { Session } = await import("../session/index")

    await Instance.provide({
      directory: "/workspace/opencode",
      fn: async () => {
        const s1 = await Session.create({ title: "alpha" })
        const s2 = await Session.create({ title: "beta" })

        const sessions = [...Session.list()]
        const ids = sessions.map((s) => s.id)
        expect(ids).toContain(s1.id)
        expect(ids).toContain(s2.id)
      },
    })
  })

  test("list sessions by directory even when project ids differ", async () => {
    const { Instance } = await import("../project/instance")
    const { Session } = await import("../session/index")

    await Instance.provide({
      directory: "/workspace/pm-agent/project_graph_data/jiedaidan",
      fn: async () => {
        const first = await Session.create({ title: "first" })
        const second = await Session.create({ title: "second" })

        Database.use((db) => {
          db
            .update(SessionTable)
            .set({ project_id: ProjectID.global })
            .where(eq(SessionTable.id, first.id))
            .run()
        })

        const sessions = [...Session.list()]
        const ids = sessions.map((s) => s.id)
        expect(ids).toContain(first.id)
        expect(ids).toContain(second.id)
      },
    })
  })

  test("setTitle updates session title", async () => {
    const { Instance } = await import("../project/instance")
    const { Session } = await import("../session/index")

    await Instance.provide({
      directory: "/workspace/opencode",
      fn: async () => {
        const session = await Session.create()
        const updated = await Session.setTitle({ sessionID: session.id, title: "my new title" })
        expect(updated.title).toBe("my new title")

        const fetched = await Session.get(session.id)
        expect(fetched.title).toBe("my new title")
      },
    })
  })

  test("remove session", async () => {
    const { Instance } = await import("../project/instance")
    const { Session } = await import("../session/index")
    const { NotFoundError } = await import("../storage/db")

    await Instance.provide({
      directory: "/workspace/opencode",
      fn: async () => {
        const session = await Session.create({ title: "to-be-deleted" })
        await Session.remove(session.id)

        await expect(Session.get(session.id)).rejects.toThrow()
      },
    })
  })

  test("appendSyntheticContext appends hidden context to a normal workflow session", async () => {
    const { Instance } = await import("../project/instance")
    const { Session } = await import("../session/index")

    await Instance.provide({
      directory: "/workspace/opencode",
      fn: async () => {
        const session = await Session.create({ title: "workflow context" })
        await Session.updateMessage({
          id: MessageID.ascending(),
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "project_workflow",
          model: { providerID: "test", modelID: "test-model" } as any,
        })

        const appended = await Session.appendSyntheticContext({
          sessionID: session.id,
          text: "workflow note changed",
          metadata: { workflowContextEvent: "manual_note_updated" },
        })

        expect(appended.appended).toBe(true)
        const messages = await Session.messages({ sessionID: session.id })
        const context = messages.flatMap((message) => message.parts).find((part) =>
          part.type === "text" && part.metadata?.workflowContextEvent === "manual_note_updated")
        expect(context).toMatchObject({
          type: "text",
          text: "workflow note changed",
          synthetic: true,
        })
      },
    })
  })
})
