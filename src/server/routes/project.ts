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
import { Session } from "@/session"
import { SessionPrompt } from "@/session/prompt"
import { Instance } from "@/project/instance"
import { MessageV2 } from "@/session/message-v2"
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

const WorkflowChatInput = z.object({
  text: z.string().min(1),
})

const WorkflowWarmupInput = z.object({
  force: z.boolean().default(false),
})

const WorkflowNoteImportInput = z.object({
  content: z.string().min(1),
  title: z.string().optional(),
})

const WorkflowNote = z.object({
  exists: z.boolean(),
  content: z.string(),
  path: z.string().optional(),
  workflow: ProjectWorkflow.ActionResult,
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

function projectReadmeTemplatePath() {
  return path.join(import.meta.dirname, "../../project/template/project-readme.md")
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

async function readWorkflowNote(project: string) {
  const directory = projectDirectoryForName(project)
  await ensureExistingProject(directory)
  const workflow = await ProjectWorkflow.getActive({ project, directory })
  const artifacts = await ProjectWorkflow.readActiveArtifacts({ project, directory })
  return WorkflowNote.parse({
    exists: !!artifacts.note,
    content: artifacts.note ?? "",
    path: artifacts.note ? "workflows/active/note.md" : undefined,
    workflow,
  })
}

async function importWorkflowNote(input: {
  project: string
  content: string
  title?: string
  sourcePath?: string
  sourceName?: string
}) {
  const directory = projectDirectoryForName(input.project)
  await ensureExistingProject(directory)
  await ProjectWorkflow.runAction({ project: input.project, directory, action: "开始或恢复", payload: {} })
  if (input.sourcePath) {
    await ProjectWorkflow.runAction({
      project: input.project,
      directory,
      action: "登记资源",
      payload: {
        path: input.sourcePath,
        title: input.sourceName ?? input.title ?? input.sourcePath,
        note: "人工导入工作笔记时保留的原始文件。",
      },
    })
  }
  const workflow = await ProjectWorkflow.runAction({
    project: input.project,
    directory,
    action: "更新工作笔记",
    payload: {
      content: input.content,
      summary: input.sourcePath ? `人工导入工作笔记：${input.sourceName ?? input.sourcePath}` : "人工修改工作笔记。",
      source: input.sourcePath ? "manual_import" : "manual_edit",
      sourcePath: input.sourcePath,
    },
  })
  return WorkflowNote.parse({
    exists: true,
    content: input.content.trimEnd() + "\n",
    path: "workflows/active/note.md",
    workflow,
  })
}

async function importWorkflowNoteFromFile(project: string, file: File) {
  if (!isPreviewableSourcePath(file.name)) badRequest("工作笔记导入只支持 .txt、.md、.markdown 文件")
  const maxBytes = 1024 * 1024
  const buffer = Buffer.from(await file.arrayBuffer())
  if (buffer.byteLength > maxBytes) badRequest("工作笔记文件不能超过 1MB")
  const content = buffer.toString("utf8")
  if (!content.trim()) badRequest("工作笔记内容不能为空")

  const target = await uniqueSourceFilePath(project, file.name)
  await fs.mkdir(target.sourceRoot, { recursive: true })
  await fs.writeFile(target.resolved, buffer)

  const now = new Date().toISOString()
  const resource = SourceResource.parse({
    id: ulid(),
    name: path.basename(target.resolved),
    originalName: file.name,
    path: target.projectRelativePath,
    size: buffer.byteLength,
    mimeType: file.type || contentTypeForPath(target.resolved),
    uploadedAt: now,
    previewable: true,
  })
  const registry = await readSourceRegistry(target.directory)
  await writeSourceRegistry(target.directory, {
    resources: [
      resource,
      ...registry.resources.filter((item) => item.path !== resource.path),
    ],
  })

  return importWorkflowNote({
    project,
    content,
    title: file.name,
    sourcePath: resource.path,
    sourceName: resource.originalName,
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

function warmupPrompt(project: string) {
  return [
    "请执行工作推进项目上下文预热。",
    "",
    `项目名：${project}`,
    "",
    "要求：",
    "- 使用 project-workflow-context-warmup Skill。",
    "- 只建立项目主干上下文，供后续 workflow chat session fork 使用。",
    "- 只读取项目资料，不要创建、修改或删除任何文件。",
    "- 不要调用 workflow_action。",
    "- 不要生成正式项目总结报告，不要写 report_output。",
    "- 输出紧凑 Markdown，覆盖项目主线、当前目标状态、主要问题、主要工作块、最近变化的粗略线索、后续查找入口和需要确认的上下文缺口。",
  ].join("\n")
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

async function ensureWorkflowChatSession(project: string, directory: string, graphInitialized: boolean) {
  let active = await ProjectWorkflow.getActive({ project, directory })
  let state = active.state
  if (!state) {
    active = await ProjectWorkflow.runAction({ project, directory, action: "开始或恢复", payload: {} })
    state = active.state
  }
  if (!state) throw new Error("无法创建工作推进草案。")
  if (graphInitialized && state.warmupStatus !== "completed") {
    throw new HTTPException(409, { message: "项目上下文预热尚未完成，暂不能开始工作推进对话。" })
  }
  if (state.sessionID) return state.sessionID as SessionID
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

async function runWorkflowWarmup(project: string, directory: string, carry: ProjectWorkflow.ActiveArtifactSnapshot) {
  let warmupSessionID: SessionID | undefined
  try {
    const warmupSession = await Instance.provide({
      directory,
      fn: () => Session.create({ title: "工作推进上下文预热" }),
    })
    warmupSessionID = warmupSession.id
    await ProjectWorkflow.bindSessions({
      project,
      directory,
      warmupSessionID,
      warmupStatus: "running",
    })
    await Instance.provide({
      directory,
      fn: () => SessionPrompt.prompt({
        sessionID: warmupSession.id,
        agent: "project_workflow_warmup",
        noReply: true,
        parts: [{ type: "text", text: warmupPrompt(project) }],
      }),
    })
    await Instance.provide({
      directory,
      fn: () => SessionPrompt.loop({ sessionID: warmupSession.id }),
    })
    const context = await Instance.provide({
      directory,
      fn: () => latestAssistantText(warmupSession.id),
    })
    const chatSession = await createWorkflowChatSession(directory, warmupSession.id)
    const replaced = await ProjectWorkflow.replaceActiveForWarmup({
      project,
      directory,
      sessionID: chatSession.id,
      warmupSessionID: warmupSession.id,
      warmupStatus: "completed",
      carry,
    })
    if (context.trim()) {
      await fs.writeFile(
        path.join(directory, "workflows", "active", "context_warmup.md"),
        context.trimEnd() + "\n",
        "utf8",
      )
    }
    return replaced
  } catch (error) {
    await ProjectWorkflow.bindSessions({
      project,
      directory,
      ...(warmupSessionID ? { warmupSessionID } : {}),
      warmupStatus: "failed",
    }).catch(() => undefined)
    throw error
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
        const projectState = await readProjectState(directory)
        if (!projectState.graphInitialized) badRequest("未初始化项目不需要项目上下文预热。")
        const current = await ProjectWorkflow.getActive({ project, directory })
        if (current.state?.warmupStatus === "running") return c.json(current)
        if (current.state && !input.force) {
          throw new HTTPException(409, { message: "当前已有 active 工作推进草案；重新预热需要 force=true。" })
        }
        const carry = await ProjectWorkflow.readActiveArtifacts({ project, directory })
        let active = current
        if (!active.state) active = await ProjectWorkflow.runAction({ project, directory, action: "开始或恢复", payload: {} })
        await ProjectWorkflow.bindSessions({ project, directory, warmupStatus: "running" })
        void runWorkflowWarmup(project, directory, carry).catch(() => undefined)
        return c.json(await ProjectWorkflow.getActive({ project, directory }))
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
        const projectState = await readProjectState(directory)
        const sessionID = await ensureWorkflowChatSession(project, directory, !!projectState.graphInitialized)
        const userMessage = await Instance.provide({
          directory,
          fn: () => SessionPrompt.prompt({
            sessionID,
            agent: "project_workflow",
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
          workflow: await ProjectWorkflow.getActive({ project, directory }),
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
        const active = await ProjectWorkflow.getActive({ project, directory })
        const sessionID = active.state?.sessionID
        if (!sessionID) return c.json({ sessionID: undefined, messages: [], workflow: active })
        const messages = await Instance.provide({
          directory,
          fn: () => Session.messages({ sessionID: sessionID as SessionID }),
        })
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
        return c.json({ sessionID, messages: visibleMessages, workflow: active })
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
          title: input.title,
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
