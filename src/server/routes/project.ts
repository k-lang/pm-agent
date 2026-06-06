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
import { loadExpandedGraph, loadGraph, saveLayout } from "../../../standalone-graph/transform"

const ProjectDirectory = z.object({
  name: z.string(),
  directory: z.string(),
}).meta({ ref: "ProjectDirectory" })

const CreateProjectInput = z.object({
  name: z.string(),
})

const ProjectDirectoryQuery = z.object({
  directory: z.string().optional(),
  project: z.string().optional(),
  selectedQuestionID: z.string().optional(),
})

const ProjectNameQuery = z.object({
  project: z.string(),
  path: z.string().optional().default(""),
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

const GraphView = z.enum(["collapsed", "expanded"]).default("collapsed")

const GraphQuery = z.object({
  directory: z.string().optional(),
  project: z.string().optional(),
  view: GraphView.optional(),
})

const SavedLayoutInput = z.object({
  nodes: z.record(z.string(), z.object({ x: z.number(), y: z.number() })),
  edges: z.record(z.string(), z.object({ dx: z.number(), dy: z.number() })),
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

function projectDirectoryForName(project: string) {
  const name = validateProjectName(project)
  return path.join(projectGraphRoot(), name)
}

function resolveGraphDirectory(input: { directory?: string; project?: string }) {
  if (input.project) return projectDirectoryForName(input.project)
  if (input.directory) return input.directory
  badRequest("Project or directory is required")
}

function resolveProjectDirectoryQuery(input: { directory?: string; project?: string; selectedQuestionID?: string }) {
  return {
    directory: resolveGraphDirectory(input),
    selectedQuestionID: input.selectedQuestionID,
  }
}

function sanitizeProjectPayload<T>(payload: T, project?: string): T {
  if (!project) return payload
  const root = path.resolve(projectDirectoryForName(project))
  const visit = (value: unknown): unknown => {
    if (typeof value === "string") {
      const resolved = path.resolve(value)
      if (resolved === root) return project
      if (resolved.startsWith(root + path.sep)) return path.relative(root, resolved).replaceAll(path.sep, "/")
      return value
    }
    if (Array.isArray(value)) return value.map(visit)
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item)]))
    }
    return value
  }
  return visit(payload) as T
}

function resolveProjectFilePath(project: string, relativePath = "") {
  const directory = projectDirectoryForName(project)
  const clean = relativePath.replace(/^\/+/, "")
  const resolved = path.resolve(directory, clean)
  const root = path.resolve(directory)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    badRequest("Path escapes project directory")
  }
  return { directory, relativePath: clean, resolved }
}

function contentTypeForPath(filePath: string) {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === ".json") return "application/json"
  if (ext === ".md") return "text/markdown"
  if (ext === ".txt" || ext === ".log") return "text/plain"
  if (ext === ".yaml" || ext === ".yml") return "application/yaml"
  return "text/plain"
}

async function listProjectFiles(project: string, relativePath?: string) {
  const { directory, resolved } = resolveProjectFilePath(project, relativePath)
  const entries = await fs.readdir(resolved, { withFileTypes: true }).catch(() => [] as Dirent[])
  return entries
    .filter((entry) => entry.name !== ".DS_Store")
    .map((entry) => {
      const absolute = path.join(resolved, entry.name)
      return {
        name: entry.name,
        path: path.relative(directory, absolute).replaceAll(path.sep, "/"),
        type: entry.isDirectory() ? "directory" : "file",
      }
    })
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1
      return a.name.localeCompare(b.name)
    })
}

async function readProjectFile(project: string, relativePath?: string) {
  const { resolved } = resolveProjectFilePath(project, relativePath)
  const stats = await fs.stat(resolved).catch(() => undefined)
  if (!stats || stats.isDirectory()) badRequest("File not found")
  const content = await fs.readFile(resolved, "utf8").catch(() => undefined)
  if (content === undefined) return { type: "binary" as const, content: "" }
  return {
    type: "text" as const,
    content: content.trim(),
    mimeType: contentTypeForPath(resolved),
  }
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
      async (c) => {
        const query = c.req.valid("query")
        const detail = await ProjectDetail.getDetail(resolveProjectDirectoryQuery(query))
        return c.json(sanitizeProjectPayload(detail, query.project))
      },
    )
    .get(
      "/file",
      describeRoute({
        summary: "List project files by project name",
        operationId: "project.fileList",
        responses: {
          200: { description: "Project files", content: { "application/json": { schema: resolver(z.any()) } } },
          ...errors(400),
        },
      }),
      validator("query", ProjectNameQuery),
      async (c) => {
        const query = c.req.valid("query")
        return c.json(await listProjectFiles(query.project, query.path))
      },
    )
    .get(
      "/file/content",
      describeRoute({
        summary: "Read project file by project name",
        operationId: "project.fileContent",
        responses: {
          200: { description: "Project file content", content: { "application/json": { schema: resolver(z.any()) } } },
          ...errors(400),
        },
      }),
      validator("query", ProjectNameQuery),
      async (c) => {
        const query = c.req.valid("query")
        return c.json(await readProjectFile(query.project, query.path))
      },
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
      async (c) => {
        const query = c.req.valid("query")
        const summary = await ProjectDetail.runSummary({ directory: resolveGraphDirectory(query), source: "manual" })
        return c.json(sanitizeProjectPayload(summary, query.project))
      },
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
          200: { description: "Question result", content: { "application/json": { schema: resolver(ProjectDetail.AskQuestionResult) } } },
          ...errors(400),
        },
      }),
      validator("query", ProjectDirectoryQuery.pick({ directory: true, project: true })),
      validator("json", AskQuestionInput),
      async (c) => {
        const query = c.req.valid("query")
        const result = await ProjectDetail.askQuestion({
          directory: resolveGraphDirectory(query),
          ...c.req.valid("json"),
        })
        return c.json(sanitizeProjectPayload(result, query.project))
      },
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
      async (c) => {
        const query = c.req.valid("query")
        const questions = await ProjectDetail.listQuestions({ directory: resolveGraphDirectory(query) })
        return c.json(sanitizeProjectPayload(questions, query.project))
      },
    )
    .get(
      "/graph",
      describeRoute({
        summary: "Get project graph payload",
        operationId: "project.graph",
        responses: {
          200: { description: "Project graph payload", content: { "application/json": { schema: resolver(z.any()) } } },
          ...errors(400),
        },
      }),
      validator("query", GraphQuery),
      async (c) => {
        const query = c.req.valid("query")
        const directory = resolveGraphDirectory(query)
        const view = query.view || "collapsed"
        const graph = view === "expanded"
          ? await loadExpandedGraph(directory)
          : await loadGraph(directory)
        return c.json(graph)
      },
    )
    .put(
      "/graph/layout",
      describeRoute({
        summary: "Save project graph layout",
        operationId: "project.graphLayout",
        responses: {
          200: { description: "Saved graph layout", content: { "application/json": { schema: resolver(SavedLayoutInput) } } },
          ...errors(400),
        },
      }),
      validator("query", GraphQuery),
      validator("json", SavedLayoutInput),
      async (c) => {
        const query = c.req.valid("query")
        const layout = c.req.valid("json")
        return c.json(await saveLayout(layout, resolveGraphDirectory(query), query.view || "collapsed"))
      },
    ),
)
