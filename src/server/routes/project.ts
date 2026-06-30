import fs from "fs/promises"
import type { Dirent } from "fs"
import path from "path"
import { Buffer } from "buffer"
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
import { ProjectWorkflow } from "@/workflow/state"
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

const ProjectOnlyQuery = z.object({
  project: z.string(),
})

const ProjectSourceQuery = z.object({
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

const SourceResource = z.object({
  id: z.string(),
  name: z.string(),
  originalName: z.string(),
  path: z.string(),
  size: z.number(),
  mimeType: z.string().optional(),
  uploadedAt: z.string().optional(),
  previewable: z.boolean().default(false),
})

const SourceResourceRegistry = z.object({
  resources: z.array(SourceResource).default([]),
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

function sourceRegistryPath(directory: string) {
  return path.join(directory, "metadata", "source_resources.json")
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

async function ensureExistingProject(directory: string) {
  const stats = await fs.stat(directory).catch(() => undefined)
  if (!stats?.isDirectory()) badRequest("Project not found")
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

function sanitizeSourceFileName(input: string) {
  const name = path.basename(input || "resource").replaceAll("\0", "").trim()
  const cleaned = name.replace(/[\\/]/g, "_").replace(/\s+/g, " ")
  if (!cleaned || cleaned === "." || cleaned === "..") return "resource"
  if (cleaned.startsWith(".")) return `resource${cleaned}`
  return cleaned
}

function isPreviewableSourcePath(filePath: string) {
  const ext = path.extname(filePath).toLowerCase()
  return ext === ".txt" || ext === ".md" || ext === ".markdown"
}

function resolveSourcePath(project: string, relativePath = "") {
  const directory = projectDirectoryForName(project)
  const sourceRoot = path.resolve(directory, "source")
  const clean = relativePath.replace(/^\/+/, "").replace(/^source\/+/, "")
  const resolved = path.resolve(sourceRoot, clean)
  if (resolved !== sourceRoot && !resolved.startsWith(sourceRoot + path.sep)) {
    badRequest("Path escapes project source directory")
  }
  return {
    directory,
    sourceRoot,
    sourceRelativePath: clean,
    projectRelativePath: clean ? `source/${clean}` : "source",
    resolved,
  }
}

async function readSourceRegistry(directory: string) {
  const raw = await fs.readFile(sourceRegistryPath(directory), "utf8").catch(() => undefined)
  if (!raw) return SourceResourceRegistry.parse({})
  return SourceResourceRegistry.parse(JSON.parse(raw))
}

async function writeSourceRegistry(directory: string, registry: z.infer<typeof SourceResourceRegistry>) {
  await fs.mkdir(path.join(directory, "metadata"), { recursive: true })
  await fs.writeFile(sourceRegistryPath(directory), JSON.stringify(SourceResourceRegistry.parse(registry), null, 2) + "\n", "utf8")
}

async function uniqueSourceFilePath(project: string, originalName: string) {
  const safeName = sanitizeSourceFileName(originalName)
  const parsed = path.parse(safeName)
  const base = parsed.name || "resource"
  const ext = parsed.ext
  const initial = resolveSourcePath(project, safeName)
  if (!await fs.stat(initial.resolved).catch(() => undefined)) return initial
  const nextName = `${base}-${ulid()}${ext}`
  return resolveSourcePath(project, nextName)
}

async function listSourceResources(project: string) {
  const { directory, sourceRoot } = resolveSourcePath(project)
  await ensureExistingProject(directory)
  await fs.mkdir(sourceRoot, { recursive: true })
  const registry = await readSourceRegistry(directory)
  const byPath = new Map(registry.resources.map((resource) => [resource.path, resource]))
  const entries = await fs.readdir(sourceRoot, { withFileTypes: true }).catch(() => [] as Dirent[])
  const resources: z.infer<typeof SourceResource>[] = []

  for (const entry of entries) {
    if (!entry.isFile() || entry.name === ".DS_Store") continue
    const full = path.join(sourceRoot, entry.name)
    const stats = await fs.stat(full)
    const resourcePath = `source/${entry.name}`
    const recorded = byPath.get(resourcePath)
    resources.push(SourceResource.parse({
      id: recorded?.id ?? ulid(stats.mtimeMs),
      name: entry.name,
      originalName: recorded?.originalName ?? entry.name,
      path: resourcePath,
      size: stats.size,
      mimeType: recorded?.mimeType,
      uploadedAt: recorded?.uploadedAt ?? stats.birthtime.toISOString(),
      previewable: isPreviewableSourcePath(entry.name),
    }))
  }

  resources.sort((a, b) => (b.uploadedAt || "").localeCompare(a.uploadedAt || "") || a.name.localeCompare(b.name))
  return resources
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

async function previewSourceResource(project: string, relativePath: string) {
  const { directory, resolved, projectRelativePath, sourceRelativePath } = resolveSourcePath(project, relativePath)
  await ensureExistingProject(directory)
  if (!sourceRelativePath) badRequest("Source file path is required")
  const stats = await fs.stat(resolved).catch(() => undefined)
  if (!stats || !stats.isFile()) badRequest("Source file not found")
  const previewable = isPreviewableSourcePath(resolved)
  const resource = {
    name: path.basename(resolved),
    path: projectRelativePath,
    size: stats.size,
    mimeType: contentTypeForPath(resolved),
    previewable,
  }
  if (!previewable) {
    return {
      ...resource,
      type: "unsupported" as const,
      content: "",
      message: "当前只支持预览 .txt、.md、.markdown 文件；该文件已保存，可作为附件引用。",
    }
  }
  const maxPreviewBytes = 512 * 1024
  if (stats.size > maxPreviewBytes) {
    return {
      ...resource,
      type: "too_large" as const,
      content: "",
      message: "文件超过 512KB，当前版本暂不预览大文本文件。",
    }
  }
  const content = await fs.readFile(resolved, "utf8")
  return {
    ...resource,
    type: "text" as const,
    content,
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
      "/workflow/state",
      describeRoute({
        summary: "Get active project workflow state",
        operationId: "project.workflowState",
        responses: {
          200: { description: "Workflow state", content: { "application/json": { schema: resolver(ProjectWorkflow.ActionResult) } } },
          ...errors(400),
        },
      }),
      validator("query", ProjectOnlyQuery),
      async (c) => c.json(await ProjectWorkflow.getActive(c.req.valid("query"))),
    )
    .post(
      "/workflow/action",
      describeRoute({
        summary: "Run project workflow action",
        operationId: "project.workflowAction",
        responses: {
          200: { description: "Workflow action result", content: { "application/json": { schema: resolver(ProjectWorkflow.ActionResult) } } },
          ...errors(400),
        },
      }),
      validator("query", ProjectOnlyQuery),
      validator("json", ProjectWorkflow.ActionRequest.omit({ project: true })),
      async (c) => {
        const query = c.req.valid("query")
        return c.json(await ProjectWorkflow.runAction({ project: query.project, ...c.req.valid("json") }))
      },
    )
    .get(
      "/source",
      describeRoute({
        summary: "List project source resources",
        operationId: "project.sourceList",
        responses: {
          200: { description: "Project source resources", content: { "application/json": { schema: resolver(SourceResource.array()) } } },
          ...errors(400),
        },
      }),
      validator("query", ProjectOnlyQuery),
      async (c) => c.json(await listSourceResources(c.req.valid("query").project)),
    )
    .post(
      "/source",
      describeRoute({
        summary: "Upload project source resource",
        operationId: "project.sourceUpload",
        responses: {
          200: { description: "Uploaded project source resource", content: { "application/json": { schema: resolver(SourceResource) } } },
          ...errors(400),
        },
      }),
      validator("query", ProjectOnlyQuery),
      async (c) => {
        const { project } = c.req.valid("query")
        const directory = projectDirectoryForName(project)
        await ensureExistingProject(directory)
        const body = await c.req.parseBody({ all: true })
        const file = Array.isArray(body.file) ? body.file[0] : body.file
        if (!(file instanceof File)) badRequest("Upload field 'file' is required")

        const target = await uniqueSourceFilePath(project, file.name)
        await fs.mkdir(target.sourceRoot, { recursive: true })
        const buffer = Buffer.from(await file.arrayBuffer())
        await fs.writeFile(target.resolved, buffer)

        const now = new Date().toISOString()
        const resource = SourceResource.parse({
          id: ulid(),
          name: path.basename(target.resolved),
          originalName: file.name,
          path: target.projectRelativePath,
          size: buffer.byteLength,
          mimeType: file.type || undefined,
          uploadedAt: now,
          previewable: isPreviewableSourcePath(target.resolved),
        })

        const registry = await readSourceRegistry(target.directory)
        const resources = [
          resource,
          ...registry.resources.filter((item) => item.path !== resource.path),
        ]
        await writeSourceRegistry(target.directory, { resources })

        await ProjectWorkflow.runAction({
          project,
          action: "登记资源",
          payload: {
            path: resource.path,
            title: resource.originalName,
            note: resource.previewable ? "上传的文本资源，可在工作推进页预览。" : "上传的附件资源，当前版本不支持内容预览。",
          },
        }).catch(() => undefined)

        return c.json(resource)
      },
    )
    .get(
      "/source/preview",
      describeRoute({
        summary: "Preview project source resource",
        operationId: "project.sourcePreview",
        responses: {
          200: { description: "Project source preview", content: { "application/json": { schema: resolver(z.any()) } } },
          ...errors(400),
        },
      }),
      validator("query", ProjectSourceQuery),
      async (c) => {
        const query = c.req.valid("query")
        return c.json(await previewSourceResource(query.project, query.path))
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
