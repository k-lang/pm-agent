import fs from "fs/promises"
import type { Dirent } from "fs"
import path from "path"
import { ulid } from "ulid"
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
  graphInitialized: z.boolean().default(false),
  initialWorkflowID: z.string().optional(),
}).meta({ ref: "ProjectDirectory" })

const CreateProjectInput = z.object({
  name: z.string(),
  background: z.string().optional(),
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

const ProjectStateFile = z.object({
  graphInitialized: z.boolean().default(false),
  createdAt: z.number().optional(),
  initialWorkflowID: z.string().optional(),
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

function projectStatePath(directory: string) {
  return path.join(directory, "metadata", "project_state.json")
}

async function readProjectState(directory: string) {
  const raw = await fs.readFile(projectStatePath(directory), "utf8").catch(() => undefined)
  if (!raw) return ProjectStateFile.parse({ graphInitialized: await inferGraphInitialized(directory) })
  return ProjectStateFile.parse(JSON.parse(raw))
}

async function hasJsonFiles(dir: string): Promise<boolean> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [] as Dirent[])
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory() && await hasJsonFiles(full)) return true
    if (entry.isFile() && entry.name.endsWith(".json")) return true
  }
  return false
}

async function inferGraphInitialized(directory: string) {
  const [hasSnapshots, hasNodes, hasEdges] = await Promise.all([
    hasJsonFiles(path.join(directory, "snapshots")),
    hasJsonFiles(path.join(directory, "nodes")),
    hasJsonFiles(path.join(directory, "edges")),
  ])
  return hasSnapshots || (hasNodes && hasEdges)
}

async function writeProjectState(directory: string, state: z.infer<typeof ProjectStateFile>) {
  await fs.mkdir(path.join(directory, "metadata"), { recursive: true })
  await fs.writeFile(projectStatePath(directory), JSON.stringify(ProjectStateFile.parse(state), null, 2) + "\n", "utf8")
}

async function ensureProjectStructure(directory: string) {
  const dirs = [
    "nodes/event",
    "nodes/goal",
    "nodes/issue",
    "nodes/result",
    "nodes/work_block",
    "nodes/work_item",
    "edges",
    "metadata",
    "notes",
    "source",
    "workflows",
    "changes",
    "snapshots",
    "report_output",
  ]
  await Promise.all(dirs.map((dir) => fs.mkdir(path.join(directory, dir), { recursive: true })))
}

async function createInitialWorkflow(directory: string, background: string | undefined, now: number) {
  const text = background?.trim()
  if (!text) return undefined
  const workflowID = ulid(now)
  const workflowDir = path.join(directory, "workflows", workflowID)
  await fs.mkdir(workflowDir, { recursive: true })
  await fs.writeFile(path.join(workflowDir, "input.md"), text + "\n", "utf8")
  await fs.writeFile(
    path.join(workflowDir, "state.json"),
    JSON.stringify({
      id: workflowID,
      type: "project_initialization",
      status: "drafting_input",
      createdAt: now,
      updatedAt: now,
    }, null, 2) + "\n",
    "utf8",
  )
  return workflowID
}

async function listDirectories() {
  const root = projectGraphRoot()
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [] as Dirent[])
  const directories = entries
    .filter((entry) => entry.isDirectory() && entry.name !== ".agents")
    .map((entry) => path.join(root, entry.name))
    .sort((a, b) => path.basename(a).localeCompare(path.basename(b)))
  return Promise.all(directories.map(async (directory) => {
    const state = await readProjectState(directory).catch(() => ProjectStateFile.parse({ graphInitialized: false }))
    return {
      name: path.basename(directory),
      directory,
      graphInitialized: !!state.graphInitialized,
      initialWorkflowID: state.initialWorkflowID,
    }
  }))
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
        const root = projectGraphRoot()
        const directory = path.join(root, name)
        const exists = await fs.stat(directory).then(() => true).catch(() => false)
        if (exists) badRequest(`Project already exists: ${name}`)
        const now = Date.now()
        await fs.mkdir(root, { recursive: true })
        await fs.mkdir(directory, { recursive: false })
        await ensureProjectStructure(directory)
        const initialWorkflowID = await createInitialWorkflow(directory, input.background, now)
        await writeProjectState(directory, {
          graphInitialized: false,
          createdAt: now,
          initialWorkflowID,
        })
        return c.json({ name, directory, graphInitialized: false, initialWorkflowID })
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
