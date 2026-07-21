import fs from "fs/promises"
import type { Dirent, Stats } from "fs"
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
import { Session } from "@/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionStatus } from "@/session/status"
import { Permission } from "@/permission"
import { Instance } from "@/project/instance"
import { MessageV2 } from "@/session/message-v2"
import { ProjectWorkflow } from "@/workflow/state"
import { ProjectWorkflowExecution } from "@/workflow/execution"
import { GraphVersionStore } from "@/graph/version-store"
import { Log } from "@/util/log"
import { loadExpandedGraph, loadGraph, saveLayout } from "../../../standalone-graph/transform"

const log = Log.create({ service: "project.routes" })

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

const ProjectSummaryRunQuery = ProjectDirectoryQuery.extend({
  source: ProjectDetail.SummarySource.default("manual"),
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
  summaryText: z.string().refine((value) => value.trim().length > 0, "Summary text cannot be empty"),
})

const AskQuestionInput = z.object({
  text: z.string(),
  mode: ProjectDetail.QuestionMode,
  questionID: z.string().optional(),
  questionSessionID: SessionID.zod.optional(),
})

const WorkflowChatInput = z.object({
  text: z.string().min(1),
})

const WorkflowWarmupInput = z.object({
  force: z.boolean().default(false),
})

const WorkflowNoteImportInput = z.object({
  content: z.string().min(1),
})

const WorkflowNote = z.object({
  exists: z.boolean(),
  content: z.string(),
  path: z.string().optional(),
  workflow: ProjectWorkflow.ActionResult,
})

const WorkflowOperationArtifacts = ProjectWorkflowExecution.OperationArtifactSnapshot

const GraphView = z.enum(["collapsed", "expanded"]).default("collapsed")

const GraphQuery = z.object({
  directory: z.string().optional(),
  project: z.string().optional(),
  view: GraphView.optional(),
})

const WorkflowGraphQuery = ProjectOnlyQuery.extend({
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
  changeId: z.string().optional(),
  progressIndex: z.number().int().positive().optional(),
  workTimestamp: z.string().optional(),
  appliedAt: z.string().optional(),
})

const ArchivedWorkflowApplyResult = z.object({
  appliedAt: z.string(),
  change_id: z.string(),
  success: z.boolean(),
  notePath: z.string().optional(),
}).passthrough()

const ArchivedWorkflowOperations = z.object({
  timestamp: z.string().optional(),
}).passthrough()

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

function projectReadmeTemplatePath() {
  return path.join(import.meta.dirname, "../../project/template/project-readme.md")
}

function sourceRegistryPath(directory: string) {
  return path.join(directory, "metadata", "source_resources.json")
}

async function readProjectState(directory: string) {
  const raw = await fs.readFile(projectStatePath(directory), "utf8").catch(() => undefined)
  if (!raw) return ProjectStateFile.parse({ graphInitialized: await inferGraphInitialized(directory) })
  const state = ProjectStateFile.parse(JSON.parse(raw))
  if (!state.graphInitialized && await inferGraphInitialized(directory)) {
    return { ...state, graphInitialized: true }
  }
  return state
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
    "descriptions_output/description_summary",
    "descriptions_output/history",
    "report_output",
  ]
  await Promise.all(dirs.map((dir) => fs.mkdir(path.join(directory, dir), { recursive: true })))
  const readmePath = path.join(directory, "README.md")
  const exists = await fs.stat(readmePath).then(() => true).catch(() => false)
  if (!exists) {
    const template = await fs.readFile(projectReadmeTemplatePath(), "utf8")
    await fs.writeFile(readmePath, template.endsWith("\n") ? template : `${template}\n`, "utf8")
  }
  await GraphVersionStore.ensure(directory)
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
  return isTextPreviewPath(filePath) || isHtmlPreviewPath(filePath) || isImagePreviewPath(filePath)
}

function isTextPreviewPath(filePath: string) {
  const ext = path.extname(filePath).toLowerCase()
  return ext === ".txt" || ext === ".md" || ext === ".markdown"
}

function isHtmlPreviewPath(filePath: string) {
  const ext = path.extname(filePath).toLowerCase()
  return ext === ".html" || ext === ".htm"
}

function isImagePreviewPath(filePath: string) {
  const ext = path.extname(filePath).toLowerCase()
  return ext === ".png" || ext === ".jpg" || ext === ".jpeg" || ext === ".gif" || ext === ".webp" || ext === ".svg"
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
      id: recorded?.id ?? ulid(Math.floor(stats.mtimeMs)),
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

async function deleteSourceResource(project: string, relativePath: string) {
  const { directory, resolved, projectRelativePath, sourceRelativePath } = resolveSourcePath(project, relativePath)
  await ensureExistingProject(directory)
  if (!sourceRelativePath) badRequest("Source file path is required")
  const stats = await fs.stat(resolved).catch(() => undefined)
  if (!stats || !stats.isFile()) badRequest("Source file not found")
  await fs.unlink(resolved)
  const registry = await readSourceRegistry(directory)
  await writeSourceRegistry(directory, {
    resources: registry.resources.filter((resource) => resource.path !== projectRelativePath),
  })
  return { ok: true, path: projectRelativePath }
}

function contentTypeForPath(filePath: string) {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === ".json") return "application/json"
  if (ext === ".md" || ext === ".markdown") return "text/markdown"
  if (ext === ".txt" || ext === ".log") return "text/plain"
  if (ext === ".html" || ext === ".htm") return "text/html"
  if (ext === ".png") return "image/png"
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg"
  if (ext === ".gif") return "image/gif"
  if (ext === ".webp") return "image/webp"
  if (ext === ".svg") return "image/svg+xml"
  if (ext === ".yaml" || ext === ".yml") return "application/yaml"
  return "text/plain"
}

type PreviewResourceInfo = {
  name: string
  path: string
  size: number
  mimeType: string
  previewable: boolean
}

function sourceRawUrl(project: string, relativePath: string) {
  return `/project/source/raw?project=${encodeURIComponent(project)}&path=${encodeURIComponent(relativePath)}`
}

function noteRawUrl(project: string, relativePath: string) {
  return `/project/notes/raw?project=${encodeURIComponent(project)}&path=${encodeURIComponent(relativePath)}`
}

async function previewResolvedResource(
  resource: PreviewResourceInfo,
  resolved: string,
  stats: Stats,
  unsupportedMessage: string,
  options: { imageUrl?: string } = {},
) {
  if (!resource.previewable) {
    return {
      ...resource,
      type: "unsupported" as const,
      content: "",
      message: unsupportedMessage,
    }
  }
  if (isImagePreviewPath(resolved)) {
    return {
      ...resource,
      type: "image" as const,
      content: "",
      imageUrl: options.imageUrl,
    }
  }
  const maxTextPreviewBytes = 512 * 1024
  if (stats.size > maxTextPreviewBytes) {
    return {
      ...resource,
      type: "too_large" as const,
      content: "",
      message: "文件超过 512KB，当前版本暂不预览大文本或 HTML 文件。",
    }
  }
  const content = await fs.readFile(resolved, "utf8")
  return {
    ...resource,
    type: isHtmlPreviewPath(resolved) ? "html" as const : "text" as const,
    content,
  }
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
  return previewResolvedResource(
    resource,
    resolved,
    stats,
    "当前只支持预览文本、Markdown、HTML 和常见图片文件；该文件已保存，可作为附件引用。",
    { imageUrl: sourceRawUrl(project, projectRelativePath) },
  )
}

async function readImageFileResponse(input: { resolved: string; resourcePath: string; request: Request }) {
  if (!isImagePreviewPath(input.resolved)) badRequest("Only image resources can be read as binary preview")
  const stats = await fs.stat(input.resolved).catch(() => undefined)
  if (!stats || !stats.isFile()) badRequest("Image file not found")

  const etag = `"image-${Buffer.from(input.resourcePath).toString("base64url")}-${stats.size}-${Math.floor(stats.mtimeMs)}"`
  if (input.request.headers.get("if-none-match") === etag) {
    return new Response(null, {
      status: 304,
      headers: {
        ETag: etag,
        "Cache-Control": "private, max-age=300",
      },
    })
  }

  return new Response(Bun.file(input.resolved), {
    headers: {
      "Content-Type": contentTypeForPath(input.resolved),
      "Content-Length": String(stats.size),
      "Cache-Control": "private, max-age=300",
      ETag: etag,
      "Last-Modified": stats.mtime.toUTCString(),
      "X-Content-Type-Options": "nosniff",
    },
  })
}

async function readSourceImageResource(project: string, relativePath: string, request: Request) {
  const { directory, resolved, projectRelativePath, sourceRelativePath } = resolveSourcePath(project, relativePath)
  await ensureExistingProject(directory)
  if (!sourceRelativePath) badRequest("Source file path is required")
  return readImageFileResponse({ resolved, resourcePath: projectRelativePath, request })
}

function resolveNotePath(project: string, relativePath = "") {
  const directory = projectDirectoryForName(project)
  const notesRoot = path.resolve(directory, "notes")
  const clean = relativePath.replace(/^\/+/, "").replace(/^notes\/+/, "")
  const resolved = path.resolve(notesRoot, clean)
  if (resolved !== notesRoot && !resolved.startsWith(notesRoot + path.sep)) {
    badRequest("Path escapes project notes directory")
  }
  return {
    directory,
    notesRoot,
    noteRelativePath: clean,
    projectRelativePath: clean ? `notes/${clean}` : "notes",
    resolved,
  }
}

function normalizeArchivedNotePath(notePath: string | undefined) {
  if (!notePath) return undefined
  const normalized = path.posix.normalize(notePath.replaceAll("\\", "/").replace(/^\.\//u, ""))
  if (!normalized.startsWith("notes/") || normalized.includes("../")) return undefined
  return normalized
}

async function readArchivedJson<T extends z.ZodTypeAny>(filePath: string, schema: T): Promise<z.infer<T> | undefined> {
  try {
    return schema.parse(JSON.parse(await fs.readFile(filePath, "utf8")))
  } catch {
    return undefined
  }
}

async function archivedNoteProgress(directory: string, visibleNotePaths: Set<string>) {
  const appliedRoot = path.join(directory, "workflows", "applied")
  const entries = await fs.readdir(appliedRoot, { withFileTypes: true }).catch(() => [] as Dirent[])
  const records = (await Promise.all(entries.map(async (entry) => {
    if (!entry.isDirectory()) return undefined
    const archiveDirectory = path.join(appliedRoot, entry.name)
    const applyResult = await readArchivedJson(path.join(archiveDirectory, "apply_result.json"), ArchivedWorkflowApplyResult)
    if (!applyResult?.success) return undefined
    const operations = await readArchivedJson(path.join(archiveDirectory, "operations.json"), ArchivedWorkflowOperations)
    return {
      archiveName: entry.name,
      appliedAt: applyResult.appliedAt,
      changeId: applyResult.change_id,
      notePath: normalizeArchivedNotePath(applyResult.notePath),
      workTimestamp: operations?.timestamp,
    }
  }))).filter((record): record is NonNullable<typeof record> => !!record)

  records.sort((a, b) => a.appliedAt.localeCompare(b.appliedAt) || a.archiveName.localeCompare(b.archiveName))
  const latestByNotePath = new Map<string, {
    firstAppliedAt: string
    firstArchiveName: string
    changeId: string
    workTimestamp?: string
    appliedAt: string
  }>()
  records.forEach((record) => {
    if (!record.notePath || !visibleNotePaths.has(record.notePath)) return
    const previous = latestByNotePath.get(record.notePath)
    latestByNotePath.set(record.notePath, {
      firstAppliedAt: previous?.firstAppliedAt ?? record.appliedAt,
      firstArchiveName: previous?.firstArchiveName ?? record.archiveName,
      changeId: record.changeId,
      workTimestamp: record.workTimestamp,
      appliedAt: record.appliedAt,
    })
  })
  const byNotePath = new Map<string, {
    changeId: string
    progressIndex: number
    workTimestamp?: string
    appliedAt: string
  }>()
  Array.from(latestByNotePath.entries())
    .sort(([, a], [, b]) => a.firstAppliedAt.localeCompare(b.firstAppliedAt) || a.firstArchiveName.localeCompare(b.firstArchiveName))
    .forEach(([notePath, record], index) => {
      byNotePath.set(notePath, {
        changeId: record.changeId,
        progressIndex: index + 1,
        workTimestamp: record.workTimestamp,
        appliedAt: record.appliedAt,
      })
    })
  return byNotePath
}

async function listProjectNotes(project: string) {
  const { directory, notesRoot } = resolveNotePath(project)
  await ensureExistingProject(directory)
  const entries = await fs.readdir(notesRoot, { withFileTypes: true }).catch(() => [] as Dirent[])
  const noteEntries = entries.filter((entry) => entry.isFile() && entry.name !== ".DS_Store")
  const visibleNotePaths = new Set(noteEntries.map((entry) => `notes/${entry.name}`))
  const progressByPath = noteEntries.length ? await archivedNoteProgress(directory, visibleNotePaths) : new Map()
  const notes: z.infer<typeof SourceResource>[] = []
  for (const entry of noteEntries) {
    const full = path.join(notesRoot, entry.name)
    const stats = await fs.stat(full)
    const notePath = `notes/${entry.name}`
    const progress = progressByPath.get(notePath)
    notes.push(SourceResource.parse({
      id: `note:${entry.name}`,
      name: entry.name,
      originalName: entry.name,
      path: notePath,
      size: stats.size,
      mimeType: contentTypeForPath(full),
      uploadedAt: stats.mtime.toISOString(),
      previewable: isPreviewableSourcePath(full),
      ...progress,
    }))
  }
  notes.sort((a, b) => {
    if (a.progressIndex && b.progressIndex) return b.progressIndex - a.progressIndex || a.name.localeCompare(b.name)
    if (a.progressIndex) return -1
    if (b.progressIndex) return 1
    return (b.uploadedAt || "").localeCompare(a.uploadedAt || "") || a.name.localeCompare(b.name)
  })
  return notes
}

async function previewProjectNote(project: string, relativePath: string) {
  const { directory, resolved, projectRelativePath, noteRelativePath } = resolveNotePath(project, relativePath)
  await ensureExistingProject(directory)
  if (!noteRelativePath) badRequest("Note path is required")
  const stats = await fs.stat(resolved).catch(() => undefined)
  if (!stats || !stats.isFile()) badRequest("Note file not found")
  const previewable = isPreviewableSourcePath(resolved)
  const resource = {
    name: path.basename(resolved),
    path: projectRelativePath,
    size: stats.size,
    mimeType: contentTypeForPath(resolved),
    previewable,
  }
  return previewResolvedResource(
    resource,
    resolved,
    stats,
    "当前只支持预览文本、Markdown、HTML 和常见图片文件。",
    { imageUrl: noteRawUrl(project, projectRelativePath) },
  )
}

async function readNoteImageResource(project: string, relativePath: string, request: Request) {
  const { directory, resolved, projectRelativePath, noteRelativePath } = resolveNotePath(project, relativePath)
  await ensureExistingProject(directory)
  if (!noteRelativePath) badRequest("Note path is required")
  return readImageFileResponse({ resolved, resourcePath: projectRelativePath, request })
}

async function readWorkflowNote(project: string) {
  const directory = projectDirectoryForName(project)
  await ensureExistingProject(directory)
  const workflow = await ProjectWorkflowExecution.getActive({ project, directory })
  const artifacts = await ProjectWorkflow.readActiveArtifacts({ project, directory })
  return WorkflowNote.parse({
    exists: !!artifacts.note,
    content: artifacts.note ?? "",
    path: artifacts.note ? "workflows/active/note.md" : undefined,
    workflow,
  })
}

async function readWorkflowOperationArtifacts(project: string) {
  const directory = projectDirectoryForName(project)
  await ensureExistingProject(directory)
  return ProjectWorkflowExecution.readOperationArtifacts({ project, directory })
}

async function notifyWorkflowChatOfManualNoteUpdate(
  directory: string,
  workflow: ProjectWorkflow.ActionResult,
) {
  const sessionID = workflow.state?.sessionID
  if (!sessionID) return { appended: false as const, reason: "no_session" as const }
  const invalidatedArtifacts = Array.isArray(workflow.data?.invalidatedArtifacts)
    ? workflow.data.invalidatedArtifacts.filter((item): item is string => typeof item === "string")
    : []
  const invalidationSummary = typeof workflow.data?.invalidationSummary === "string"
    ? workflow.data.invalidationSummary
    : undefined
  const operationReviewRequired = workflow.data?.operationReviewRequired === true
  const text = operationReviewRequired
    ? [
        "<workflow-context-event>",
        "用户已在页面中更新工作笔记。现有图操作、校验和预览已保留，但提交资格已撤销。",
        "立即调用 project_workflow_graph_operation_reviewer subagent，只读检查最新 workflows/active/note.md 与现有 operation_notes.md、operations.draft.json 是否一致。",
        "禁止直接修改图操作。reviewer 返回后，调用 workflow_action action=\"登记图操作复核\" 记录精简结论，向用户说明问题，并询问是沿用当前图操作还是按新笔记调整。",
        "只有用户随后在聊天中明确同意沿用，才可调用 action=\"确认沿用现有图操作\"；该动作只开放页面提交按钮，不会直接提交。",
        "</workflow-context-event>",
      ].join("\n")
    : invalidationSummary
    ? [
        "<workflow-context-event>",
        `用户已在页面中更新工作笔记。执行层${invalidationSummary}`,
        `已清理：${invalidatedArtifacts.join(", ")}。`,
        "后续不要继续引用上述已失效产物；仅在用户明确要求后，基于最新 workflows/active/note.md 重新生成图操作和预览。",
        "</workflow-context-event>",
      ].join("\n")
    : [
        "<workflow-context-event>",
        "用户已在页面中更新工作笔记。后续以最新 workflows/active/note.md 为准。",
        "</workflow-context-event>",
      ].join("\n")
  return Instance.provide({
    directory,
    fn: () => Session.appendSyntheticContext({
      sessionID: sessionID as SessionID,
      text,
      metadata: { workflowContextEvent: "manual_note_updated" },
    }),
  })
}

async function readWorkflowGraph(project: string, view: z.infer<typeof GraphView>) {
  const directory = projectDirectoryForName(project)
  await ensureExistingProject(directory)
  await GraphVersionStore.ensure(directory)
  const active = await ProjectWorkflow.getActive({ project, directory })
  const graphDirectory = active.state
    ? await GraphVersionStore.resolveActiveBase(directory)
    : await GraphVersionStore.resolve(directory, "latest")
  return view === "expanded"
    ? loadExpandedGraph(graphDirectory)
    : loadGraph(graphDirectory)
}

async function importWorkflowNote(input: {
  project: string
  content: string
  source?: "manual_import" | "manual_edit"
  summary?: string
}) {
  const directory = projectDirectoryForName(input.project)
  await ensureExistingProject(directory)
  const workflow = await ProjectWorkflowExecution.runAction({
    project: input.project,
    directory,
    action: "更新工作笔记",
    payload: {
      content: input.content,
      summary: input.summary ?? "人工修改工作笔记。",
      source: input.source ?? "manual_edit",
    },
  })
  if (workflow.data?.recoveredPublishedApply) {
    throw new HTTPException(409, { message: "上一轮图操作已经发布并完成归档，本次工作笔记修改未执行。" })
  }
  const notification = await notifyWorkflowChatOfManualNoteUpdate(directory, workflow).catch((error) => {
    log.warn("failed to append workflow note update context", {
      project: input.project,
      workflowID: workflow.workflowID,
      sessionID: workflow.state?.sessionID,
      error,
    })
    return undefined
  })
  if (workflow.data?.operationReviewRequired === true && notification?.appended && workflow.state?.sessionID) {
    void Instance.provide({
      directory,
      fn: () => SessionPrompt.loop({ sessionID: workflow.state!.sessionID as SessionID }),
    }).catch((error) => {
      log.warn("failed to start workflow operation review after manual note update", {
        project: input.project,
        workflowID: workflow.workflowID,
        sessionID: workflow.state?.sessionID,
        error,
      })
    })
  }
  return WorkflowNote.parse({
    exists: true,
    content: input.content.trimEnd() + "\n",
    path: "workflows/active/note.md",
    workflow,
  })
}

async function importWorkflowNoteFromFile(project: string, file: File) {
  if (!isTextPreviewPath(file.name)) badRequest("工作笔记导入只支持 .txt、.md、.markdown 文件")
  const maxBytes = 1024 * 1024
  const buffer = Buffer.from(await file.arrayBuffer())
  if (buffer.byteLength > maxBytes) badRequest("工作笔记文件不能超过 1MB")
  const content = buffer.toString("utf8")
  if (!content.trim()) badRequest("工作笔记内容不能为空")
  return importWorkflowNote({
    project,
    content,
    source: "manual_import",
    summary: `人工导入工作笔记：${file.name}`,
  })
}

function visibleMessageText(message: MessageV2.WithParts) {
  return message.parts.reduce((result, part) => {
    if (part.type !== "text" || part.synthetic || part.ignored) return result
    return result + part.text
  }, "").trim()
}

async function latestAssistantText(sessionID: SessionID) {
  const messages = await Session.messages({ sessionID })
  const assistant = [...messages].reverse().find((message) => message.info.role === "assistant")
  return assistant ? visibleMessageText(assistant) : ""
}

export function requireWarmupContext(context: string) {
  const result = context.trim()
  if (!result) throw new Error("项目上下文预热未生成有效内容，请重新预热。")
  return result
}

function warmupPrompt(project: string) {
  return [
    "请执行工作推进项目上下文预热。",
    "",
    `项目名：${project}`,
    "",
    "要求：",
    "- 使用 project-workflow-context-warmup Skill。",
    "- 图数据基线固定在 workflows/active/base_graph/；从这里读取 nodes、edges、changes、descriptions_output 和 snapshots。",
    "- 只建立项目主干上下文，供后续 workflow chat session fork 使用。",
    "- 只读取项目资料，不要创建、修改或删除任何文件。",
    "- 不要调用 workflow_action。",
    "- 不要生成正式项目总结报告，不要写 report_output。",
    "- 输出紧凑 Markdown，覆盖项目主线、当前目标状态、主要问题、主要工作块、最近变化的粗略线索、后续查找入口和需要确认的上下文缺口。",
  ].join("\n")
}

function correctionWarmupPrompt(project: string, expectedChangeId?: string) {
  return [
    "请执行项目图谱更正上下文预热。",
    "",
    `项目名：${project}`,
    expectedChangeId ? `后端指定本轮 change_id 约束：${expectedChangeId}` : "",
    "",
    "要求：",
    "- 只建立更正上下文，供后续 correction chat session fork 使用。",
    "- 不读取 workflows/active/state.json；更正语义和 change_id 约束由后端在本请求中提供。",
    "- 轻量读取 workflows/active/base_graph 中的图谱、最近 changelog 和相关 description_summary / nodes / edges 索引。",
    "- 不创建、修改或删除任何文件。",
    "- 不调用 workflow_action。",
    "- 输出紧凑 Markdown，覆盖当前图谱主线、最近提交线索、可能需要更正的入口、软更正规则和后续需要核实的证据。",
  ].filter(Boolean).join("\n")
}

async function createWorkflowChatSession(directory: string, warmupSessionID?: SessionID) {
  return Instance.provide({
    directory,
    fn: async () => {
      if (warmupSessionID) {
        const forked = await Session.fork({ sessionID: warmupSessionID })
        await Session.setTitle({ sessionID: forked.id, title: "工作推进" })
        return forked
      }
      return Session.create({ title: "工作推进" })
    },
  })
}

export function workflowAgentProfile(state: ProjectWorkflow.State | undefined) {
  return ProjectWorkflow.usesCorrectionWorkflowSemantics(state)
    ? {
        primary: "project_workflow_correction" as const,
        warmup: "project_workflow_correction_warmup" as const,
      }
    : {
        primary: "project_workflow" as const,
        warmup: "project_workflow_warmup" as const,
      }
}

export function workflowChatAgent(state: ProjectWorkflow.State | undefined) {
  return workflowAgentProfile(state).primary
}

async function sessionExists(directory: string, sessionID: string | undefined) {
  if (!sessionID) return false
  return Instance.provide({
    directory,
    fn: () => Session.get(sessionID as SessionID).then(() => true).catch(() => false),
  })
}

async function forkExistingSession(directory: string, sessionID: string) {
  return Instance.provide({
    directory,
    fn: async () => {
      const forked = await Session.fork({ sessionID: sessionID as SessionID })
      await Session.setTitle({ sessionID: forked.id, title: "工作推进" })
      return forked
    },
  })
}

async function cleanupWorkflowChatSession(directory: string, sessionID: string | undefined) {
  if (!sessionID) return
  await Instance.provide({
    directory,
    fn: async () => {
      await SessionPrompt.cancel(sessionID as SessionID).catch(() => undefined)
      await Session.remove(sessionID as SessionID).catch(() => undefined)
    },
  }).catch(() => undefined)
}

async function assertWorkflowIdle(project: string, directory: string, actionLabel: string) {
  const active = await ProjectWorkflowExecution.getActive({ project, directory })
  const state = active.state
  if (!state) return
  if (state.warmupStatus === "running") {
    throw new HTTPException(409, { message: `项目上下文仍在预热，完成前不能${actionLabel}。` })
  }
  const sessionIDs = new Set([state.sessionID, state.warmupSessionID].filter((id): id is string => !!id))
  if (!sessionIDs.size) return
  const [statuses, permissions] = await Instance.provide({
    directory,
    fn: () => Promise.all([
      Promise.all([...sessionIDs].map(async (id) => [id, await SessionStatus.get(id as SessionID)] as const)),
      Permission.list(),
    ]),
  })
  if (statuses.some(([, status]) => status.type === "busy" || status.type === "retry")) {
    throw new HTTPException(409, { message: `大模型仍在处理当前工作推进，回复完成前不能${actionLabel}。` })
  }
  if (permissions.some((permission) => sessionIDs.has(permission.sessionID))) {
    throw new HTTPException(409, { message: `当前还有待处理的工具修改审批，批准或拒绝前不能${actionLabel}。` })
  }
}

const activeWarmupRuns = new Map<string, { token: string; sessionID?: SessionID }>()

async function invalidateActiveWarmup(directory: string) {
  const key = path.resolve(directory)
  const run = activeWarmupRuns.get(key)
  activeWarmupRuns.delete(key)
  if (!run?.sessionID) return
  await Instance.provide({
    directory,
    fn: () => SessionPrompt.cancel(run.sessionID!),
  }).catch(() => undefined)
}

async function runWorkflowWarmupSession(input: {
  project: string
  directory: string
  active: ProjectWorkflow.ActionResult
  title: string
  agent: "project_workflow_warmup" | "project_workflow_correction_warmup"
  prompt: string
  contextPath: string
}) {
  const workflowID = input.active.state?.id
  if (!workflowID) throw new Error("当前没有可预热的 active 工作推进草案。")
  const key = path.resolve(input.directory)
  const runToken = ulid()
  activeWarmupRuns.set(key, { token: runToken })
  const previousSessionID = input.active.state?.sessionID
  let warmupSessionID: SessionID | undefined
  let chatSessionID: SessionID | undefined
  try {
    const warmupSession = await Instance.provide({
      directory: input.directory,
      fn: () => Session.create({ title: input.title }),
    })
    warmupSessionID = warmupSession.id
    const currentRun = activeWarmupRuns.get(key)
    if (currentRun?.token !== runToken) return undefined
    currentRun.sessionID = warmupSession.id
    const running = await ProjectWorkflow.bindSessionsIfCurrent({
      project: input.project,
      directory: input.directory,
      expectedWorkflowID: workflowID,
      warmupSessionID: warmupSession.id,
      warmupStatus: "running",
    })
    if (!running) return undefined
    if (activeWarmupRuns.get(key)?.token !== runToken) return undefined

    await Instance.provide({
      directory: input.directory,
      fn: () => SessionPrompt.prompt({
        sessionID: warmupSession.id,
        agent: input.agent,
        noReply: true,
        parts: [{ type: "text", text: input.prompt }],
      }),
    })
    await Instance.provide({
      directory: input.directory,
      fn: () => SessionPrompt.loop({ sessionID: warmupSession.id }),
    })
    if (activeWarmupRuns.get(key)?.token !== runToken) return undefined

    const context = requireWarmupContext(await Instance.provide({
      directory: input.directory,
      fn: () => latestAssistantText(warmupSession.id),
    }))
    const chatSession = await createWorkflowChatSession(input.directory, warmupSession.id)
    chatSessionID = chatSession.id
    const bound = await ProjectWorkflow.bindSessionsIfCurrent({
      project: input.project,
      directory: input.directory,
      expectedWorkflowID: workflowID,
      expectedWarmupSessionID: warmupSession.id,
      sessionID: chatSession.id,
      warmupSessionID: warmupSession.id,
      warmupStatus: "completed",
      reset: true,
    })
    if (!bound) {
      await cleanupWorkflowChatSession(input.directory, chatSession.id)
      return undefined
    }
    const current = await ProjectWorkflow.getActive({ project: input.project, directory: input.directory })
    if (current.state?.id === workflowID && current.state.sessionID === chatSession.id) {
      await fs.writeFile(
        path.join(input.directory, "workflows", "active", input.contextPath),
        context + "\n",
        "utf8",
      )
    }
    if (previousSessionID && previousSessionID !== chatSession.id) {
      await cleanupWorkflowChatSession(input.directory, previousSessionID)
    }
    return bound
  } catch (error) {
    if (activeWarmupRuns.get(key)?.token === runToken) {
      await ProjectWorkflow.bindSessionsIfCurrent({
        project: input.project,
        directory: input.directory,
        expectedWorkflowID: workflowID,
        ...(chatSessionID ? {
          sessionID: undefined,
          warmupSessionID,
          reset: true,
        } : {}),
        warmupStatus: "failed",
      }).catch(() => undefined)
    }
    if (chatSessionID) await cleanupWorkflowChatSession(input.directory, chatSessionID)
    throw error
  } finally {
    if (activeWarmupRuns.get(key)?.token === runToken) activeWarmupRuns.delete(key)
  }
}

const RestoredWorkflowSession = z.object({
  sessionID: z.string().optional(),
  sessionStartedAt: z.number().optional(),
  warmupSessionID: z.string().optional(),
  warmupStatus: ProjectWorkflow.BaselineStatus.optional(),
})
type RestoredWorkflowSession = z.infer<typeof RestoredWorkflowSession>

async function prepareHardCorrectionWorkflowChat(project: string, directory: string, state: ProjectWorkflow.State, restored?: RestoredWorkflowSession) {
  if (!state.hardCorrection) throw new Error("当前 active 不是硬更正现场。")
  if (state.sessionID && await sessionExists(directory, state.sessionID)) return state.sessionID as SessionID
  const restoredSessionID = restored?.sessionID
  const restoredWarmupSessionID = restored?.warmupSessionID
  if (restoredSessionID && await sessionExists(directory, restoredSessionID)) {
    const chatSession = await forkExistingSession(directory, restoredSessionID)
    const bound = await ProjectWorkflow.bindRestoredWorkflowChat({
      project,
      directory,
      sessionID: chatSession.id,
      sessionStartedAt: restored?.sessionStartedAt,
      warmupSessionID: restoredWarmupSessionID,
      warmupStatus: restored?.warmupStatus,
    })
    if (!bound.state?.sessionID) throw new Error("硬更正工作推进会话绑定失败。")
    return bound.state.sessionID as SessionID
  }
  if (restoredWarmupSessionID && await sessionExists(directory, restoredWarmupSessionID)) {
    const chatSession = await createWorkflowChatSession(directory, restoredWarmupSessionID as SessionID)
    const bound = await ProjectWorkflow.bindRestoredWorkflowChat({
      project,
      directory,
      sessionID: chatSession.id,
      warmupSessionID: restoredWarmupSessionID,
      warmupStatus: "completed",
    })
    if (!bound.state?.sessionID) throw new Error("硬更正工作推进会话绑定失败。")
    return bound.state.sessionID as SessionID
  }

  const base = await GraphVersionStore.resolveActiveBase(directory)
  if (await GraphVersionStore.isEmpty(base)) {
    const chatSession = await createWorkflowChatSession(directory)
    const bound = await ProjectWorkflow.bindSessions({
      project,
      directory,
      sessionID: chatSession.id,
      warmupStatus: "completed",
      reset: true,
    })
    if (!bound.state?.sessionID) throw new Error("硬更正工作推进会话绑定失败。")
    return bound.state.sessionID as SessionID
  }

  const active = await ProjectWorkflowExecution.getActive({ project, directory })
  const warmed = await runWorkflowWarmupForActive(project, directory, active)
  if (!warmed?.state?.sessionID) throw new Error("硬更正工作推进会话绑定失败。")
  return warmed.state.sessionID as SessionID
}

async function ensureWorkflowChatSession(project: string, directory: string) {
  let active: ProjectWorkflow.ActionResult = await ProjectWorkflowExecution.getActive({ project, directory })
  let state = active.state
  let createdActive = false
  if (!state) {
    active = await ProjectWorkflowExecution.runAction({ project, directory, action: "开始或恢复", payload: {} })
    state = active.state
    createdActive = true
  }
  if (!state) throw new Error("无法创建工作推进草案。")
  const base = await GraphVersionStore.resolveActiveBase(directory)
  const baseIsEmpty = await GraphVersionStore.isEmpty(base)
  if (!baseIsEmpty && state.warmupStatus !== "completed") {
    throw new HTTPException(409, { message: "项目上下文预热尚未完成，暂不能开始工作推进对话。" })
  }
  if (state.sessionID) {
    const sessionID = state.sessionID as SessionID
    if (await sessionExists(directory, sessionID)) return sessionID
  }
  if (!createdActive) {
    throw new HTTPException(409, {
      message: baseIsEmpty
        ? "推进会话尚未就位，请使用恢复推进会话入口后再继续。"
        : "推进会话尚未就位，请重新预热并恢复会话后再继续。",
    })
  }
  const session = await createWorkflowChatSession(directory, state.warmupSessionID as SessionID | undefined)
  const bound = await ProjectWorkflow.bindSessions({
    project,
    directory,
    sessionID: session.id,
    warmupSessionID: state.warmupSessionID,
    warmupStatus: state.warmupStatus,
  })
  if (!bound.state?.sessionID) throw new Error("工作推进会话绑定失败。")
  return bound.state.sessionID as SessionID
}

async function runCorrectionWarmup(project: string, directory: string, active: ProjectWorkflow.ActionResult) {
  const expectedChangeId = ProjectWorkflow.expectedChangeId(active.state)
  return runWorkflowWarmupSession({
    project,
    directory,
    active,
    title: "图谱软更正上下文预热",
    agent: "project_workflow_correction_warmup",
    prompt: correctionWarmupPrompt(project, expectedChangeId),
    contextPath: "correction_warmup.md",
  })
}

async function runWorkflowWarmup(project: string, directory: string, active: ProjectWorkflow.ActionResult) {
  return runWorkflowWarmupSession({
    project,
    directory,
    active,
    title: "工作推进上下文预热",
    agent: "project_workflow_warmup",
    prompt: warmupPrompt(project),
    contextPath: "context_warmup.md",
  })
}

async function runWorkflowWarmupForActive(project: string, directory: string, active: ProjectWorkflow.ActionResult) {
  return workflowAgentProfile(active.state).warmup === "project_workflow_correction_warmup"
    ? runCorrectionWarmup(project, directory, active)
    : runWorkflowWarmup(project, directory, active)
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
      async (c) => {
        const { project } = c.req.valid("query")
        return c.json(await ProjectWorkflowExecution.getActive({ project, directory: projectDirectoryForName(project) }))
      },
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
        const input = c.req.valid("json")
        if (input.action === "登记图操作复核" || input.action === "确认沿用现有图操作") {
          throw new HTTPException(400, { message: "该动作只能由工作推进聊天执行。" })
        }
        const directory = projectDirectoryForName(query.project)
        const correctionConfirmed = input.payload?.confirm === true
        const correctionAction = input.action === "开始软更正" || input.action === "重做最近提交"
        if (input.action === "应用图操作") await assertWorkflowIdle(query.project, directory, "提交图操作")
        if (correctionConfirmed && correctionAction) await assertWorkflowIdle(query.project, directory, "切换更正模式")
        const result = await ProjectWorkflowExecution.runAction({ project: query.project, ...input })
        if (input.action === "放弃草案" || (correctionConfirmed && (input.action === "开始软更正" || input.action === "重做最近提交"))) {
          await invalidateActiveWarmup(directory)
        }
        if (input.action === "开始软更正" && result.state?.correction && !result.state.hardCorrection) {
          const base = await GraphVersionStore.resolveActiveBase(directory)
          if (await GraphVersionStore.isEmpty(base)) {
            const chat = await createWorkflowChatSession(directory)
            await ProjectWorkflow.bindSessions({
              project: query.project,
              directory,
              sessionID: chat.id,
              warmupStatus: "completed",
              reset: true,
            })
            return c.json(await ProjectWorkflowExecution.getActive({ project: query.project, directory }))
          }
          await ProjectWorkflow.bindSessions({ project: query.project, directory, warmupStatus: "running" })
          void runCorrectionWarmup(query.project, directory, result).catch(() => undefined)
          return c.json(await ProjectWorkflowExecution.getActive({ project: query.project, directory }))
        }
        if (input.action === "重做最近提交" && result.state?.hardCorrection) {
          const restored = result.data?.restoredSession && typeof result.data.restoredSession === "object"
            ? RestoredWorkflowSession.parse(result.data.restoredSession)
            : undefined
          await prepareHardCorrectionWorkflowChat(query.project, directory, result.state, restored)
          const refreshed = await ProjectWorkflowExecution.getActive({ project: query.project, directory })
          const { restoredSession: _restoredSession, ...data } = result.data ?? {}
          return c.json({
            ...refreshed,
            message: result.message,
            data,
          })
        }
        return c.json(result)
      },
    )
    .post(
      "/workflow/warmup",
      describeRoute({
        summary: "Start project workflow context warmup",
        operationId: "project.workflowWarmup",
        responses: {
          200: { description: "Workflow state", content: { "application/json": { schema: resolver(ProjectWorkflow.ActionResult) } } },
          ...errors(400),
        },
      }),
      validator("query", ProjectOnlyQuery),
      validator("json", WorkflowWarmupInput),
      async (c) => {
        const { project } = c.req.valid("query")
        const input = c.req.valid("json")
        const directory = projectDirectoryForName(project)
        await ensureExistingProject(directory)
        const recovered = await ProjectWorkflowExecution.finishCommittedActiveIfNeeded({ project, directory })
        if (recovered) {
          return c.json({
            ...recovered,
            message: "上一轮图操作已经发布并完成归档，本次预热未执行。",
            data: { ...recovered.data, recoveredPublishedApply: true },
          })
        }
        const current = await ProjectWorkflowExecution.getActive({ project, directory })
        if (current.state?.warmupStatus === "running" && !input.force) return c.json(current)
        if (current.state && !input.force) {
          throw new HTTPException(409, { message: "当前已有 active 工作推进草案；重新预热需要 force=true。" })
        }
        let active: ProjectWorkflow.ActionResult = current
        if (!active.state) active = await ProjectWorkflowExecution.runAction({ project, directory, action: "开始或恢复", payload: {} })
        await invalidateActiveWarmup(directory)
        const base = await GraphVersionStore.resolveActiveBase(directory)
        if (await GraphVersionStore.isEmpty(base)) {
          const previousSessionID = active.state?.sessionID
          const chat = await createWorkflowChatSession(directory)
          await ProjectWorkflow.bindSessions({
            project,
            directory,
            sessionID: chat.id,
            warmupStatus: "completed",
            reset: true,
          })
          if (previousSessionID && previousSessionID !== chat.id) await cleanupWorkflowChatSession(directory, previousSessionID)
          return c.json(await ProjectWorkflowExecution.getActive({ project, directory }))
        }
        await ProjectWorkflow.bindSessions({ project, directory, warmupStatus: "running" })
        void runWorkflowWarmupForActive(project, directory, active).catch(() => undefined)
        return c.json(await ProjectWorkflowExecution.getActive({ project, directory }))
      },
    )
    .post(
      "/workflow/chat",
      describeRoute({
        summary: "Send project workflow chat message",
        operationId: "project.workflowChat",
        responses: {
          200: { description: "Workflow chat state", content: { "application/json": { schema: resolver(z.any()) } } },
          ...errors(400),
        },
      }),
      validator("query", ProjectOnlyQuery),
      validator("json", WorkflowChatInput),
      async (c) => {
        const { project } = c.req.valid("query")
        const input = c.req.valid("json")
        const directory = projectDirectoryForName(project)
        await ensureExistingProject(directory)
        const recovered = await ProjectWorkflowExecution.finishCommittedActiveIfNeeded({ project, directory })
        if (recovered) {
          throw new HTTPException(409, { message: "上一轮图操作已经发布并完成归档，本次消息未发送。" })
        }
        const sessionID = await ensureWorkflowChatSession(project, directory)
        const active = await ProjectWorkflow.getActive({ project, directory })
        const userMessage = await Instance.provide({
          directory,
          fn: () => SessionPrompt.prompt({
            sessionID,
            agent: workflowChatAgent(active.state),
            noReply: true,
            parts: [{ type: "text", text: input.text }],
          }),
        })
        void Instance.provide({
          directory,
          fn: () => SessionPrompt.loop({ sessionID }),
        }).catch(() => undefined)
        return c.json({
          sessionID,
          userMessageID: userMessage.info.id,
          workflow: await ProjectWorkflowExecution.getActive({ project, directory }),
        })
      },
    )
    .get(
      "/workflow/messages",
      describeRoute({
        summary: "List project workflow chat messages",
        operationId: "project.workflowMessages",
        responses: {
          200: { description: "Workflow chat messages", content: { "application/json": { schema: resolver(z.any()) } } },
          ...errors(400),
        },
      }),
      validator("query", ProjectOnlyQuery),
      async (c) => {
        const { project } = c.req.valid("query")
        const directory = projectDirectoryForName(project)
        await ensureExistingProject(directory)
        const active = await ProjectWorkflowExecution.getActive({ project, directory })
        const sessionID = active.state?.sessionID
        if (!sessionID) return c.json({ sessionID: undefined, messages: [], workflow: { ...active, sessionReady: false } })
        if (!await sessionExists(directory, sessionID)) {
          return c.json({ sessionID, messages: [], workflow: { ...active, sessionReady: false } })
        }
        const messages = await Instance.provide({
          directory,
          fn: () => Session.messages({ sessionID: sessionID as SessionID }),
        }).catch(() => [])
        const startedAt = active.state?.sessionStartedAt
        let visibleMessages = messages
        if (typeof startedAt === "number") {
          visibleMessages = messages.filter((message) => (message.info.time.created ?? 0) >= startedAt)
        } else if (active.state?.warmupSessionID) {
          const warmupMessages = await Instance.provide({
            directory,
            fn: () => Session.messages({ sessionID: active.state!.warmupSessionID as SessionID }),
          }).catch(() => [])
          const warmupCutoff = Math.max(0, ...warmupMessages.map((message) => message.info.time.created ?? 0))
          if (warmupCutoff > 0) visibleMessages = messages.filter((message) => (message.info.time.created ?? 0) > warmupCutoff)
        }
        return c.json({ sessionID, messages: visibleMessages, workflow: { ...active, sessionReady: true } })
      },
    )
    .get(
      "/workflow/note",
      describeRoute({
        summary: "Get active workflow note",
        operationId: "project.workflowNote",
        responses: {
          200: { description: "Active workflow note", content: { "application/json": { schema: resolver(WorkflowNote) } } },
          ...errors(400),
        },
      }),
      validator("query", ProjectOnlyQuery),
      async (c) => c.json(await readWorkflowNote(c.req.valid("query").project)),
    )
    .get(
      "/workflow/operations",
      describeRoute({
        summary: "Get active workflow graph operation artifacts",
        operationId: "project.workflowOperations",
        responses: {
          200: { description: "Active workflow graph operation artifacts", content: { "application/json": { schema: resolver(WorkflowOperationArtifacts) } } },
          ...errors(400),
        },
      }),
      validator("query", ProjectOnlyQuery),
      async (c) => c.json(await readWorkflowOperationArtifacts(c.req.valid("query").project)),
    )
    .get(
      "/workflow/graph",
      describeRoute({
        summary: "Get the active workflow base graph payload",
        operationId: "project.workflowGraph",
        responses: {
          200: { description: "Active workflow base graph payload", content: { "application/json": { schema: resolver(z.any()) } } },
          ...errors(400),
        },
      }),
      validator("query", WorkflowGraphQuery),
      async (c) => {
        const query = c.req.valid("query")
        return c.json(await readWorkflowGraph(query.project, query.view || "collapsed"))
      },
    )
    .post(
      "/workflow/note/import",
      describeRoute({
        summary: "Import active workflow note",
        operationId: "project.workflowNoteImport",
        responses: {
          200: { description: "Imported workflow note", content: { "application/json": { schema: resolver(WorkflowNote) } } },
          ...errors(400),
        },
      }),
      validator("query", ProjectOnlyQuery),
      async (c) => {
        const { project } = c.req.valid("query")
        const directory = projectDirectoryForName(project)
        await ensureExistingProject(directory)
        await assertWorkflowIdle(project, directory, "修改工作笔记")
        const contentType = c.req.header("content-type") || ""
        if (contentType.includes("multipart/form-data")) {
          const body = await c.req.parseBody({ all: true })
          const file = Array.isArray(body.file) ? body.file[0] : body.file
          if (!(file instanceof File)) badRequest("Upload field 'file' is required")
          return c.json(await importWorkflowNoteFromFile(project, file))
        }
        const input = WorkflowNoteImportInput.parse(await c.req.json())
        return c.json(await importWorkflowNote({
          project,
          content: input.content,
        }))
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

        await ProjectWorkflowExecution.runAction({
          project,
          directory: target.directory,
          action: "登记资源",
          payload: {
            path: resource.path,
            title: resource.originalName,
            note: resource.previewable ? "上传的资源可在工作推进页预览。" : "上传的附件资源，当前版本不支持内容预览。",
          },
        }).catch(() => undefined)

        return c.json(resource)
      },
    )
    .delete(
      "/source",
      describeRoute({
        summary: "Delete project source resource",
        operationId: "project.sourceDelete",
        responses: {
          200: { description: "Deleted project source resource", content: { "application/json": { schema: resolver(z.object({ ok: z.boolean(), path: z.string() })) } } },
          ...errors(400),
        },
      }),
      validator("query", ProjectSourceQuery),
      async (c) => {
        const query = c.req.valid("query")
        return c.json(await deleteSourceResource(query.project, query.path))
      },
    )
    .get(
      "/notes",
      describeRoute({
        summary: "List archived project notes",
        operationId: "project.notesList",
        responses: {
          200: { description: "Archived project notes", content: { "application/json": { schema: resolver(SourceResource.array()) } } },
          ...errors(400),
        },
      }),
      validator("query", ProjectOnlyQuery),
      async (c) => c.json(await listProjectNotes(c.req.valid("query").project)),
    )
    .get(
      "/notes/preview",
      describeRoute({
        summary: "Preview archived project note",
        operationId: "project.notesPreview",
        responses: {
          200: { description: "Archived project note preview", content: { "application/json": { schema: resolver(z.any()) } } },
          ...errors(400),
        },
      }),
      validator("query", ProjectSourceQuery),
      async (c) => {
        const query = c.req.valid("query")
        return c.json(await previewProjectNote(query.project, query.path))
      },
    )
    .get(
      "/notes/raw",
      describeRoute({
        summary: "Read image archived project note",
        operationId: "project.notesRaw",
        responses: {
          200: { description: "Image archived project note" },
          304: { description: "Image archived project note not modified" },
          ...errors(400),
        },
      }),
      validator("query", ProjectSourceQuery),
      async (c) => {
        const query = c.req.valid("query")
        return readNoteImageResource(query.project, query.path, c.req.raw)
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
      "/source/raw",
      describeRoute({
        summary: "Read image source resource",
        operationId: "project.sourceRaw",
        responses: {
          200: { description: "Image source resource" },
          304: { description: "Image source resource not modified" },
          ...errors(400),
        },
      }),
      validator("query", ProjectSourceQuery),
      async (c) => {
        const query = c.req.valid("query")
        return readSourceImageResource(query.project, query.path, c.req.raw)
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
      validator("query", ProjectSummaryRunQuery),
      async (c) => {
        const query = c.req.valid("query")
        const summary = await ProjectDetail.runSummary({ directory: resolveGraphDirectory(query), source: query.source })
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
