import fs from "fs/promises"
import type { Dirent } from "fs"
import path from "path"
import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { lazy } from "@/util/lazy"
import { errors } from "@/server/error"
import { projectGraphRoot } from "@/project/root"
import { HTTPException } from "hono/http-exception"
import { ProjectDetail } from "@/project/detail"
import { SessionID } from "@/session/schema"

const ProjectDirectory = z.object({
  name: z.string(),
  directory: z.string(),
}).meta({ ref: "ProjectDirectory" })

const CreateProjectInput = z.object({
  name: z.string(),
})

const ProjectDirectoryQuery = z.object({
  directory: z.string(),
})

const UpdateSummaryInput = z.object({
  summaryText: z.string(),
})

const AskQuestionInput = z.object({
  text: z.string(),
  mode: ProjectDetail.QuestionMode,
  questionID: z.string().optional(),
  questionSessionID: SessionID.zod.optional(),
})

function badRequest(message: string): never {
  throw new HTTPException(400, { message })
}

function validateProjectName(input: string) {
  const name = input.trim()
  if (!name) badRequest("Project name is required")
  if (name === ".agents") badRequest("Project name is reserved")
  if (name === "." || name === "..") badRequest("Invalid project name")
  if (name.includes("/") || name.includes("\\")) {
    badRequest("Project name cannot contain path separators")
  }
  return name
}

async function listDirectories() {
  const root = projectGraphRoot()
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [] as Dirent[])
  return entries
    .filter((entry) => entry.isDirectory() && entry.name !== ".agents")
    .map((entry) => ({
      name: entry.name,
      directory: path.join(root, entry.name),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export const ProjectRoutes = lazy(() =>
  new Hono()
    .get(
      "/directories",
      describeRoute({
        summary: "List project directories",
        operationId: "project.directories",
        responses: {
          200: { description: "Project directories", content: { "application/json": { schema: resolver(ProjectDirectory.array()) } } },
        },
      }),
      async (c) => c.json(await listDirectories()),
    )
    .post(
      "/directories",
      describeRoute({
        summary: "Create project directory",
        operationId: "project.createDirectory",
        responses: {
          200: { description: "Created project directory", content: { "application/json": { schema: resolver(ProjectDirectory) } } },
          ...errors(400),
        },
      }),
      validator("json", CreateProjectInput),
      async (c) => {
        const input = c.req.valid("json")
        const name = validateProjectName(input.name)
        const directory = path.join(projectGraphRoot(), name)
        const exists = await fs.stat(directory).then(() => true).catch(() => false)
        if (exists) badRequest(`Project already exists: ${name}`)
        await fs.mkdir(directory, { recursive: false })
        return c.json({ name, directory })
      },
    )
    .get(
      "/detail",
      describeRoute({
        summary: "Get project detail",
        operationId: "project.detail",
        responses: {
          200: { description: "Project detail", content: { "application/json": { schema: resolver(ProjectDetail.Detail) } } },
          ...errors(400),
        },
      }),
      validator("query", ProjectDirectoryQuery),
      async (c) => c.json(await ProjectDetail.getDetail(c.req.valid("query"))),
    )
    .post(
      "/summary/run",
      describeRoute({
        summary: "Run project summary",
        operationId: "project.summaryRun",
        responses: {
          200: { description: "Summary record", content: { "application/json": { schema: resolver(ProjectDetail.SummaryRecord) } } },
          ...errors(400),
        },
      }),
      validator("query", ProjectDirectoryQuery),
      async (c) => c.json(await ProjectDetail.runSummary({ ...c.req.valid("query"), source: "manual" })),
    )
    .patch(
      "/summary/:id",
      describeRoute({
        summary: "Update project summary text",
        operationId: "project.summaryUpdate",
        responses: {
          200: { description: "Summary record", content: { "application/json": { schema: resolver(ProjectDetail.SummaryRecord) } } },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ id: z.string() })),
      validator("json", UpdateSummaryInput),
      async (c) => c.json(await ProjectDetail.updateSummary({ id: c.req.valid("param").id, ...c.req.valid("json") })),
    )
    .post(
      "/question",
      describeRoute({
        summary: "Ask project question",
        operationId: "project.question",
        responses: {
          200: { description: "Question record", content: { "application/json": { schema: resolver(ProjectDetail.QuestionRecord) } } },
          ...errors(400),
        },
      }),
      validator("query", ProjectDirectoryQuery),
      validator("json", AskQuestionInput),
      async (c) => c.json(await ProjectDetail.askQuestion({ ...c.req.valid("query"), ...c.req.valid("json") })),
    )
    .get(
      "/question",
      describeRoute({
        summary: "List project questions",
        operationId: "project.questionList",
        responses: {
          200: { description: "Question records", content: { "application/json": { schema: resolver(ProjectDetail.QuestionRecord.array()) } } },
          ...errors(400),
        },
      }),
      validator("query", ProjectDirectoryQuery),
      async (c) => c.json(await ProjectDetail.listQuestions(c.req.valid("query"))),
    ),
)
