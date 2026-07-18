import fs from "fs/promises"
import path from "path"
import { randomUUID } from "crypto"
import { NODE_TYPES } from "./schema"

export namespace GraphVersionStore {
  export const GRAPH_DIRECTORIES = [
    "nodes",
    "edges",
    "changes",
    "snapshots",
    "descriptions_output",
    "notes",
  ] as const

  const LAYOUT_FILES = ["layout.json", "layout.expanded.json"] as const
  const pendingEnsures = new Map<string, Promise<{ latest: string; previous: string }>>()
  type GraphAlias = "latest_graph" | "previous_graph"

  function workflowsRoot(projectDirectory: string) {
    return path.join(projectDirectory, "workflows")
  }

  function versionsRoot(projectDirectory: string) {
    return path.join(workflowsRoot(projectDirectory), "graph_versions")
  }

  function commitsRoot(projectDirectory: string) {
    return path.join(workflowsRoot(projectDirectory), "graph_commits")
  }

  function headPath(projectDirectory: string) {
    return path.join(workflowsRoot(projectDirectory), "HEAD")
  }

  function aliasPath(projectDirectory: string, alias: GraphAlias) {
    return path.join(workflowsRoot(projectDirectory), alias)
  }

  function activeBasePath(projectDirectory: string) {
    return path.join(workflowsRoot(projectDirectory), "active", "base_graph")
  }

  async function exists(file: string) {
    return !!(await fs.lstat(file).catch(() => undefined))
  }

  async function ensureGraphDirectories(directory: string) {
    await Promise.all([
      ...NODE_TYPES.map((type) => fs.mkdir(path.join(directory, "nodes", type), { recursive: true })),
      fs.mkdir(path.join(directory, "edges"), { recursive: true }),
      fs.mkdir(path.join(directory, "changes"), { recursive: true }),
      fs.mkdir(path.join(directory, "snapshots"), { recursive: true }),
      fs.mkdir(path.join(directory, "metadata"), { recursive: true }),
      fs.mkdir(path.join(directory, "descriptions_output", "description_summary"), { recursive: true }),
      fs.mkdir(path.join(directory, "descriptions_output", "history"), { recursive: true }),
      fs.mkdir(path.join(directory, "notes"), { recursive: true }),
    ])
  }

  async function copyGraphData(source: string, target: string) {
    await fs.mkdir(target, { recursive: true })
    for (const entry of GRAPH_DIRECTORIES) {
      const from = path.join(source, entry)
      if (await exists(from)) await fs.cp(from, path.join(target, entry), { recursive: true })
    }
    for (const filename of LAYOUT_FILES) {
      const from = path.join(source, "metadata", filename)
      if (!await exists(from)) continue
      await fs.mkdir(path.join(target, "metadata"), { recursive: true })
      await fs.copyFile(from, path.join(target, "metadata", filename))
    }
    await ensureGraphDirectories(target)
  }

  async function listFiles(directory: string, prefix = ""): Promise<string[]> {
    const root = path.join(directory, prefix)
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
    const files = await Promise.all(entries.map(async (entry) => {
      const relative = path.join(prefix, entry.name)
      if (entry.isDirectory()) return listFiles(directory, relative)
      if (entry.isFile() || entry.isSymbolicLink()) return [relative]
      return []
    }))
    return files.flat().sort()
  }

  async function graphOwnedFiles(directory: string) {
    const files = (await Promise.all(GRAPH_DIRECTORIES.map((entry) => listFiles(directory, entry)))).flat()
    for (const filename of LAYOUT_FILES) {
      const relative = path.join("metadata", filename)
      if (await exists(path.join(directory, relative))) files.push(relative)
    }
    return files.sort()
  }

  async function verifyCopy(source: string, target: string) {
    const sourceFiles = await graphOwnedFiles(source)
    const targetFiles = await graphOwnedFiles(target)
    if (JSON.stringify(sourceFiles) !== JSON.stringify(targetFiles)) {
      throw new Error("图版本复制后的文件清单与基线不一致。")
    }
    for (const relative of sourceFiles) {
      const [before, after] = await Promise.all([
        fs.readFile(path.join(source, relative)),
        fs.readFile(path.join(target, relative)),
      ])
      if (!before.equals(after)) throw new Error(`图版本复制后的文件内容不一致：${relative}`)
    }
  }

  function versionName(prefix: string) {
    return `${prefix}-${Date.now()}-${randomUUID().slice(0, 8)}`
  }

  async function createVersionFrom(projectDirectory: string, source: string, prefix: string) {
    const directory = path.join(versionsRoot(projectDirectory), versionName(prefix))
    try {
      await copyGraphData(source, directory)
      await verifyCopy(source, directory)
      return directory
    } catch (error) {
      await fs.rm(directory, { recursive: true, force: true })
      throw error
    }
  }

  async function replaceSymlink(link: string, target: string) {
    const temporary = `${link}.switching`
    await fs.rm(temporary, { recursive: true, force: true })
    await fs.symlink(path.relative(path.dirname(link), target), temporary, "dir")
    await fs.rename(temporary, link)
  }

  async function syncDirectory(directory: string) {
    const handle = await fs.open(directory, "r")
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  async function resolveVersionLinkIfValid(projectDirectory: string, link: string) {
    const stat = await fs.lstat(link).catch(() => undefined)
    if (!stat?.isSymbolicLink()) return undefined
    const target = await fs.realpath(link).catch(() => undefined)
    const root = await fs.realpath(versionsRoot(projectDirectory)).catch(() => undefined)
    return target && root && path.dirname(target) === root ? target : undefined
  }

  async function resolveAliasIfValid(projectDirectory: string, alias: GraphAlias) {
    const link = aliasPath(projectDirectory, alias)
    return resolveVersionLinkIfValid(projectDirectory, link)
  }

  async function resolveCommitIfValid(projectDirectory: string, link = headPath(projectDirectory)) {
    const stat = await fs.lstat(link).catch(() => undefined)
    if (!stat?.isSymbolicLink()) return undefined
    const [commit, root] = await Promise.all([
      fs.realpath(link).catch(() => undefined),
      fs.realpath(commitsRoot(projectDirectory)).catch(() => undefined),
    ])
    if (!commit || !root || path.dirname(commit) !== root) return undefined
    const [latest, previous] = await Promise.all([
      resolveVersionLinkIfValid(projectDirectory, path.join(commit, "latest_graph")),
      resolveVersionLinkIfValid(projectDirectory, path.join(commit, "previous_graph")),
    ])
    return latest && previous ? { commit, latest, previous } : undefined
  }

  async function createCommit(projectDirectory: string, latest: string, previous: string) {
    const root = commitsRoot(projectDirectory)
    const name = versionName("commit")
    const staging = path.join(root, `.${name}.preparing`)
    const commit = path.join(root, name)
    await fs.mkdir(staging, { recursive: true })
    try {
      await Promise.all([
        fs.symlink(path.relative(staging, latest), path.join(staging, "latest_graph"), "dir"),
        fs.symlink(path.relative(staging, previous), path.join(staging, "previous_graph"), "dir"),
      ])
      await syncDirectory(staging)
      await fs.rename(staging, commit)
      await syncDirectory(root)
      return commit
    } catch (error) {
      await fs.rm(staging, { recursive: true, force: true })
      throw error
    }
  }

  async function switchHead(projectDirectory: string, commit: string) {
    const head = headPath(projectDirectory)
    const temporary = `${head}.switching`
    await fs.rm(temporary, { recursive: true, force: true })
    await fs.symlink(path.relative(path.dirname(head), commit), temporary, "dir")
    await syncDirectory(path.dirname(head))
    await fs.rename(temporary, head)
    // HEAD is already the visible commit point; never report a publish failure after it changed.
    await syncDirectory(path.dirname(head)).catch(() => undefined)
  }

  async function ensureCompatibilityAliases(projectDirectory: string) {
    for (const alias of ["latest_graph", "previous_graph"] as const) {
      const link = aliasPath(projectDirectory, alias)
      const target = path.join(headPath(projectDirectory), alias)
      const expected = path.relative(path.dirname(link), target)
      const stat = await fs.lstat(link).catch(() => undefined)
      if (stat?.isSymbolicLink() && await fs.readlink(link).catch(() => undefined) === expected) continue
      await fs.rm(link, { recursive: true, force: true })
      await replaceSymlink(link, target)
    }
  }

  async function migrateLegacyProject(projectDirectory: string) {
    const stagedLatestLink = `${aliasPath(projectDirectory, "latest_graph")}.migrating`
    const stagedPreviousLink = `${aliasPath(projectDirectory, "previous_graph")}.migrating`
    const versionRoot = await fs.realpath(versionsRoot(projectDirectory))
    const stagedLatestTarget = await fs.realpath(stagedLatestLink).catch(() => undefined)
    const stagedLatest = stagedLatestTarget && path.dirname(stagedLatestTarget) === versionRoot ? stagedLatestTarget : undefined
    if (stagedLatest) {
      const stagedPreviousTarget = await fs.realpath(stagedPreviousLink).catch(() => undefined)
      const stagedPrevious = stagedPreviousTarget && path.dirname(stagedPreviousTarget) === versionRoot ? stagedPreviousTarget : undefined
      if (stagedPrevious) {
        await fs.rm(aliasPath(projectDirectory, "previous_graph"), { recursive: true, force: true })
        await fs.rename(stagedPreviousLink, aliasPath(projectDirectory, "previous_graph"))
      } else if (!await resolveAliasIfValid(projectDirectory, "previous_graph")) {
        const legacyPrevious = aliasPath(projectDirectory, "previous_graph")
        const previousStat = await fs.lstat(legacyPrevious).catch(() => undefined)
        const previousVersion = previousStat?.isDirectory()
          ? await createVersionFrom(projectDirectory, legacyPrevious, "version")
          : stagedLatest
        await fs.rm(legacyPrevious, { recursive: true, force: true })
        await replaceSymlink(legacyPrevious, previousVersion)
      }
      await fs.rm(stagedPreviousLink, { force: true })
      await fs.rm(aliasPath(projectDirectory, "latest_graph"), { recursive: true, force: true })
      await fs.rename(stagedLatestLink, aliasPath(projectDirectory, "latest_graph"))
      return
    }

    const legacyPrevious = aliasPath(projectDirectory, "previous_graph")
    const previousStat = await fs.lstat(legacyPrevious).catch(() => undefined)
    const latestVersion = await createVersionFrom(projectDirectory, projectDirectory, "version")
    const previousVersion = previousStat?.isDirectory()
      ? await createVersionFrom(projectDirectory, legacyPrevious, "version")
      : latestVersion

    await Promise.all([
      fs.rm(stagedLatestLink, { force: true }),
      fs.rm(stagedPreviousLink, { force: true }),
    ])
    await Promise.all([
      fs.symlink(path.relative(path.dirname(stagedLatestLink), latestVersion), stagedLatestLink, "dir"),
      fs.symlink(path.relative(path.dirname(stagedPreviousLink), previousVersion), stagedPreviousLink, "dir"),
    ])
    await fs.rm(legacyPrevious, { recursive: true, force: true })
    await fs.rename(stagedPreviousLink, legacyPrevious)
    await fs.rm(aliasPath(projectDirectory, "latest_graph"), { recursive: true, force: true })
    await fs.rename(stagedLatestLink, aliasPath(projectDirectory, "latest_graph"))
  }

  async function ensureRootCompatibilityLinks(projectDirectory: string) {
    for (const entry of GRAPH_DIRECTORIES) {
      const link = path.join(projectDirectory, entry)
      const expectedTarget = path.join(workflowsRoot(projectDirectory), "latest_graph", entry)
      const stat = await fs.lstat(link).catch(() => undefined)
      if (stat?.isSymbolicLink()) {
        const current = await fs.readlink(link).catch(() => undefined)
        if (current === path.relative(path.dirname(link), expectedTarget)) continue
      }
      await fs.rm(link, { recursive: true, force: true })
      await fs.symlink(path.relative(path.dirname(link), expectedTarget), link, "dir")
    }

    const metadata = path.join(projectDirectory, "metadata")
    await fs.mkdir(metadata, { recursive: true })
    for (const filename of LAYOUT_FILES) {
      const link = path.join(metadata, filename)
      const expectedTarget = path.join(workflowsRoot(projectDirectory), "latest_graph", "metadata", filename)
      const stat = await fs.lstat(link).catch(() => undefined)
      if (stat?.isSymbolicLink()) {
        const current = await fs.readlink(link).catch(() => undefined)
        if (current === path.relative(path.dirname(link), expectedTarget)) continue
      }
      await fs.rm(link, { force: true })
      await fs.symlink(path.relative(path.dirname(link), expectedTarget), link)
    }
  }

  async function ensureInternal(projectDirectory: string) {
    const project = await fs.stat(projectDirectory).catch(() => undefined)
    if (!project?.isDirectory()) throw new Error(`项目目录不存在：${projectDirectory}`)
    await Promise.all([
      fs.mkdir(versionsRoot(projectDirectory), { recursive: true }),
      fs.mkdir(commitsRoot(projectDirectory), { recursive: true }),
    ])
    let head = await resolveCommitIfValid(projectDirectory)
    if (!head) {
      const stagedHead = await resolveCommitIfValid(projectDirectory, `${headPath(projectDirectory)}.switching`)
      if (stagedHead) {
        await fs.rm(headPath(projectDirectory), { recursive: true, force: true })
        await fs.rename(`${headPath(projectDirectory)}.switching`, headPath(projectDirectory))
        head = await resolveCommitIfValid(projectDirectory)
      }
    }
    if (!head) {
      let latest = await resolveAliasIfValid(projectDirectory, "latest_graph")
      if (!latest) {
        await migrateLegacyProject(projectDirectory)
        latest = await resolveAliasIfValid(projectDirectory, "latest_graph")
      }
      if (!latest) throw new Error("无法初始化 latest_graph 图版本。")
      let previous = await resolveAliasIfValid(projectDirectory, "previous_graph")
      if (!previous) {
        const previousLink = aliasPath(projectDirectory, "previous_graph")
        await fs.rm(previousLink, { recursive: true, force: true })
        await replaceSymlink(previousLink, latest)
        previous = latest
      }
      const commit = await createCommit(projectDirectory, latest, previous)
      await switchHead(projectDirectory, commit)
      head = await resolveCommitIfValid(projectDirectory)
    }
    if (!head) throw new Error("无法初始化原子图版本 HEAD。")
    await ensureCompatibilityAliases(projectDirectory)
    await Promise.all([
      fs.rm(`${aliasPath(projectDirectory, "latest_graph")}.migrating`, { force: true }),
      fs.rm(`${aliasPath(projectDirectory, "previous_graph")}.migrating`, { force: true }),
    ])
    await ensureRootCompatibilityLinks(projectDirectory)
    return { latest: head.latest, previous: head.previous }
  }

  export async function ensure(projectDirectory: string) {
    const key = path.resolve(projectDirectory)
    const pending = pendingEnsures.get(key)
    if (pending) return pending
    const operation = ensureInternal(key).finally(() => pendingEnsures.delete(key))
    pendingEnsures.set(key, operation)
    return operation
  }

  export async function resolve(projectDirectory: string, which: "latest" | "previous") {
    const head = await resolveCommitIfValid(projectDirectory)
    if (!head) throw new Error("图版本 HEAD 无效或尚未初始化。")
    return which === "latest" ? head.latest : head.previous
  }

  export async function resolveManagedVersion(projectDirectory: string, versionPath: string) {
    const target = await fs.realpath(path.resolve(projectDirectory, versionPath))
    const root = await fs.realpath(versionsRoot(projectDirectory))
    if (path.dirname(target) !== root) throw new Error("图版本路径未指向 graph_versions 中的受管理版本。")
    return target
  }

  export async function bindActiveBase(projectDirectory: string, which: "latest" | "previous", force = false) {
    await ensure(projectDirectory)
    const target = await resolve(projectDirectory, which)
    const link = activeBasePath(projectDirectory)
    const existing = await resolveActiveBase(projectDirectory).catch(() => undefined)
    if (!force && existing) return existing
    await fs.mkdir(path.dirname(link), { recursive: true })
    await fs.rm(link, { recursive: true, force: true })
    await fs.symlink(path.relative(path.dirname(link), target), link, "dir")
    return target
  }

  export async function resolveActiveBase(projectDirectory: string) {
    const target = await fs.realpath(activeBasePath(projectDirectory))
    const root = await fs.realpath(versionsRoot(projectDirectory))
    if (path.dirname(target) !== root) throw new Error("active/base_graph 未指向受管理的真实图版本。")
    return target
  }

  export async function isEmpty(directory: string) {
    for (const type of NODE_TYPES) {
      const entries = await fs.readdir(path.join(directory, "nodes", type)).catch(() => [])
      if (entries.some((name) => name.endsWith(".json"))) return false
    }
    const edges = await fs.readdir(path.join(directory, "edges")).catch(() => [])
    return !edges.some((name) => name.endsWith(".json"))
  }

  export async function copyTo(source: string, target: string) {
    await fs.rm(target, { recursive: true, force: true })
    await copyGraphData(source, target)
    return target
  }

  export async function createCandidate(projectDirectory: string, baseDirectory: string) {
    await ensure(projectDirectory)
    const candidate = path.join(versionsRoot(projectDirectory), versionName("candidate"))
    try {
      await copyGraphData(baseDirectory, candidate)
      await verifyCopy(baseDirectory, candidate)
      return candidate
    } catch (error) {
      await fs.rm(candidate, { recursive: true, force: true })
      throw error
    }
  }

  export async function discardCandidate(candidate: string) {
    await fs.rm(candidate, { recursive: true, force: true })
  }

  export async function publish(projectDirectory: string, baseDirectory: string, candidate: string) {
    const versionRoot = await fs.realpath(versionsRoot(projectDirectory))
    const base = await fs.realpath(baseDirectory)
    const next = await fs.realpath(candidate)
    if (path.dirname(base) !== versionRoot || path.dirname(next) !== versionRoot) {
      throw new Error("只能发布 graph_versions 中的基线和候选版本。")
    }
    const commit = await createCommit(projectDirectory, next, base)
    await switchHead(projectDirectory, commit)
    return { previous: base, latest: next }
  }

  export async function removeActiveBase(projectDirectory: string) {
    await fs.rm(activeBasePath(projectDirectory), { force: true })
  }

  async function resolvePreparedActiveVersion(projectDirectory: string) {
    const file = path.join(workflowsRoot(projectDirectory), "active", "apply_result.json")
    const raw = await fs.readFile(file, "utf8").catch(() => undefined)
    if (!raw) return undefined
    try {
      const result = JSON.parse(raw) as { success?: unknown; graphVersion?: unknown }
      if (result.success !== true || typeof result.graphVersion !== "string") return undefined
      return await resolveManagedVersion(projectDirectory, result.graphVersion)
    } catch {
      return undefined
    }
  }

  async function cleanupCommits(projectDirectory: string) {
    const root = commitsRoot(projectDirectory)
    const [head, switching] = await Promise.all([
      resolveCommitIfValid(projectDirectory),
      resolveCommitIfValid(projectDirectory, `${headPath(projectDirectory)}.switching`),
    ])
    const keep = new Set([head?.commit, switching?.commit]
      .filter((item): item is string => !!item)
      .map((item) => path.basename(item)))
    for (const entry of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue
      if (!keep.has(entry.name)) await fs.rm(path.join(root, entry.name), { recursive: true, force: true })
    }
    if (!switching) await fs.rm(`${headPath(projectDirectory)}.switching`, { force: true })
  }

  export async function cleanup(projectDirectory: string) {
    const keep = new Set<string>()
    const [latest, previous, activeBase, prepared] = await Promise.all([
      resolve(projectDirectory, "latest"),
      resolve(projectDirectory, "previous"),
      resolveActiveBase(projectDirectory).catch(() => undefined),
      resolvePreparedActiveVersion(projectDirectory),
    ])
    keep.add(latest)
    keep.add(previous)
    if (activeBase) keep.add(activeBase)
    if (prepared) keep.add(prepared)
    const root = versionsRoot(projectDirectory)
    for (const entry of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue
      const directory = path.join(root, entry.name)
      if (!keep.has(directory)) await fs.rm(directory, { recursive: true, force: true })
    }
    await cleanupCommits(projectDirectory)
  }
}
