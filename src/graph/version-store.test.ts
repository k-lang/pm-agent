import fs from "fs/promises"
import os from "os"
import path from "path"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { GraphVersionStore } from "./version-store"

describe("GraphVersionStore", () => {
  let project: string

  beforeEach(async () => {
    project = await fs.mkdtemp(path.join(os.tmpdir(), "pm-agent-graph-version-"))
    await fs.mkdir(path.join(project, "metadata"), { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(project, { recursive: true, force: true })
  })

  test("initializes an empty immutable graph version and root compatibility links", async () => {
    const versions = await GraphVersionStore.ensure(project)

    expect(versions.latest).toBe(versions.previous)
    expect(await GraphVersionStore.isEmpty(versions.latest)).toBe(true)
    expect((await fs.lstat(path.join(project, "nodes"))).isSymbolicLink()).toBe(true)
    expect((await fs.lstat(path.join(project, "notes"))).isSymbolicLink()).toBe(true)
    expect((await fs.lstat(path.join(project, "metadata"))).isDirectory()).toBe(true)
    expect((await fs.lstat(path.join(project, "metadata", "layout.json"))).isSymbolicLink()).toBe(true)
    await expect(fs.readlink(path.join(project, "workflows", "latest_graph"))).resolves.toBe("HEAD/latest_graph")
    await expect(fs.readlink(path.join(project, "workflows", "previous_graph"))).resolves.toBe("HEAD/previous_graph")
  })

  test("migrates legacy graph data while keeping project metadata outside graph versions", async () => {
    await fs.mkdir(path.join(project, "nodes", "goal"), { recursive: true })
    await fs.writeFile(path.join(project, "nodes", "goal", "goal_demo.json"), "{}\n")
    await fs.writeFile(path.join(project, "metadata", "layout.json"), "{\"nodes\":{}}\n")
    await fs.writeFile(path.join(project, "metadata", "project_state.json"), "{\"graphInitialized\":true}\n")

    const { latest } = await GraphVersionStore.ensure(project)

    await expect(fs.readFile(path.join(latest, "nodes", "goal", "goal_demo.json"), "utf8")).resolves.toBe("{}\n")
    await expect(fs.readFile(path.join(latest, "metadata", "layout.json"), "utf8")).resolves.toContain("nodes")
    await expect(fs.stat(path.join(latest, "metadata", "project_state.json"))).rejects.toThrow()
    await expect(fs.readFile(path.join(project, "metadata", "project_state.json"), "utf8")).resolves.toContain("graphInitialized")
  })

  test("upgrades direct latest and previous version links to one atomic HEAD without changing versions", async () => {
    const initial = await GraphVersionStore.ensure(project)
    const workflows = path.join(project, "workflows")
    await fs.rm(path.join(workflows, "HEAD"), { force: true })
    for (const [alias, target] of [["latest_graph", initial.latest], ["previous_graph", initial.previous]] as const) {
      const link = path.join(workflows, alias)
      await fs.rm(link, { force: true })
      await fs.symlink(path.relative(workflows, target), link, "dir")
    }

    const upgraded = await GraphVersionStore.ensure(project)

    expect(upgraded).toEqual(initial)
    expect((await fs.lstat(path.join(workflows, "HEAD"))).isSymbolicLink()).toBe(true)
    await expect(fs.readlink(path.join(workflows, "latest_graph"))).resolves.toBe("HEAD/latest_graph")
    await expect(fs.readlink(path.join(workflows, "previous_graph"))).resolves.toBe("HEAD/previous_graph")
  })

  test("keeps active base fixed and publishes candidate through latest and previous aliases", async () => {
    const initial = await GraphVersionStore.ensure(project)
    const initialHead = await fs.readlink(path.join(project, "workflows", "HEAD"))
    const latestAlias = await fs.readlink(path.join(project, "workflows", "latest_graph"))
    const previousAlias = await fs.readlink(path.join(project, "workflows", "previous_graph"))
    const base = await GraphVersionStore.bindActiveBase(project, "latest")
    const candidate = await GraphVersionStore.createCandidate(project, base)
    await fs.writeFile(path.join(candidate, "changes", "marker.txt"), "candidate\n")

    const published = await GraphVersionStore.publish(project, base, candidate)

    expect(published.previous).toBe(initial.latest)
    expect(await GraphVersionStore.resolve(project, "previous")).toBe(base)
    expect(await GraphVersionStore.resolve(project, "latest")).toBe(candidate)
    expect(await GraphVersionStore.resolveActiveBase(project)).toBe(base)
    await expect(fs.readFile(path.join(project, "changes", "marker.txt"), "utf8")).resolves.toBe("candidate\n")
    expect(await fs.readlink(path.join(project, "workflows", "HEAD"))).not.toBe(initialHead)
    expect(await fs.readlink(path.join(project, "workflows", "latest_graph"))).toBe(latestAlias)
    expect(await fs.readlink(path.join(project, "workflows", "previous_graph"))).toBe(previousAlias)
  })

  test("a failure before the HEAD switch leaves both formal graph references unchanged", async () => {
    const initial = await GraphVersionStore.ensure(project)
    const initialHead = await fs.readlink(path.join(project, "workflows", "HEAD"))
    const unmanaged = await fs.mkdtemp(path.join(os.tmpdir(), "pm-agent-unmanaged-graph-"))
    try {
      await GraphVersionStore.copyTo(initial.latest, unmanaged)

      await expect(GraphVersionStore.publish(project, initial.latest, unmanaged)).rejects.toThrow("graph_versions")

      expect(await fs.readlink(path.join(project, "workflows", "HEAD"))).toBe(initialHead)
      expect(await GraphVersionStore.resolve(project, "latest")).toBe(initial.latest)
      expect(await GraphVersionStore.resolve(project, "previous")).toBe(initial.previous)
    } finally {
      await fs.rm(unmanaged, { recursive: true, force: true })
    }
  })

  test("deleting active base never deletes the immutable graph version", async () => {
    await GraphVersionStore.ensure(project)
    const base = await GraphVersionStore.bindActiveBase(project, "latest")

    await GraphVersionStore.removeActiveBase(project)

    await expect(fs.stat(base)).resolves.toBeTruthy()
    await expect(fs.lstat(path.join(project, "workflows", "active", "base_graph"))).rejects.toThrow()
  })

  test("cleanup retains only latest and previous published versions", async () => {
    await GraphVersionStore.ensure(project)
    const first = await GraphVersionStore.resolve(project, "latest")
    const second = await GraphVersionStore.createCandidate(project, first)
    await GraphVersionStore.publish(project, first, second)
    const third = await GraphVersionStore.createCandidate(project, second)
    await GraphVersionStore.publish(project, second, third)
    const commits = path.join(project, "workflows", "graph_commits")
    await fs.mkdir(path.join(commits, ".interrupted.preparing"), { recursive: true })
    expect((await fs.readdir(commits)).length).toBeGreaterThan(1)

    await GraphVersionStore.cleanup(project)

    await expect(fs.stat(first)).rejects.toThrow()
    await expect(fs.stat(second)).resolves.toBeTruthy()
    await expect(fs.stat(third)).resolves.toBeTruthy()
    const currentCommit = path.basename(await fs.realpath(path.join(project, "workflows", "HEAD")))
    expect(await fs.readdir(commits)).toEqual([currentCommit])
  })

  test("cleanup preserves an older active base while a published candidate awaits finalization", async () => {
    const initial = await GraphVersionStore.ensure(project)
    const activeBase = await GraphVersionStore.bindActiveBase(project, "latest")
    const second = await GraphVersionStore.createCandidate(project, activeBase)
    await GraphVersionStore.publish(project, activeBase, second)
    const candidate = await GraphVersionStore.createCandidate(project, second)
    await GraphVersionStore.publish(project, second, candidate)

    await GraphVersionStore.cleanup(project)

    expect(activeBase).toBe(initial.latest)
    await expect(fs.stat(activeBase)).resolves.toBeTruthy()
    await expect(fs.stat(second)).resolves.toBeTruthy()
    await expect(fs.stat(candidate)).resolves.toBeTruthy()
  })

  test("cleanup preserves a prepared active candidate before the atomic HEAD switch", async () => {
    const initial = await GraphVersionStore.ensure(project)
    await GraphVersionStore.bindActiveBase(project, "latest")
    const candidate = await GraphVersionStore.createCandidate(project, initial.latest)
    await fs.writeFile(path.join(project, "workflows", "active", "apply_result.json"), JSON.stringify({
      success: true,
      graphVersion: path.relative(project, candidate),
    }, null, 2) + "\n", "utf8")

    await GraphVersionStore.cleanup(project)

    await expect(fs.stat(candidate)).resolves.toBeTruthy()
    expect(await GraphVersionStore.resolve(project, "latest")).toBe(initial.latest)
    expect(await GraphVersionStore.resolve(project, "previous")).toBe(initial.previous)
  })

  test("an interrupted HEAD switch keeps the old commit visible and can be retried", async () => {
    const initial = await GraphVersionStore.ensure(project)
    const base = await GraphVersionStore.bindActiveBase(project, "latest")
    const candidate = await GraphVersionStore.createCandidate(project, base)
    const workflows = path.join(project, "workflows")
    const interruptedCommit = path.join(workflows, "graph_commits", "commit-interrupted")
    await fs.mkdir(interruptedCommit, { recursive: true })
    await Promise.all([
      fs.symlink(path.relative(interruptedCommit, candidate), path.join(interruptedCommit, "latest_graph"), "dir"),
      fs.symlink(path.relative(interruptedCommit, base), path.join(interruptedCommit, "previous_graph"), "dir"),
      fs.writeFile(path.join(workflows, "active", "apply_result.json"), JSON.stringify({
        success: true,
        graphVersion: path.relative(project, candidate),
      }, null, 2) + "\n", "utf8"),
    ])
    await fs.symlink("graph_commits/commit-interrupted", path.join(workflows, "HEAD.switching"), "dir")

    const beforeRetry = await GraphVersionStore.ensure(project)
    await GraphVersionStore.cleanup(project)

    expect(beforeRetry).toEqual(initial)
    await expect(fs.stat(candidate)).resolves.toBeTruthy()
    await expect(fs.stat(interruptedCommit)).resolves.toBeTruthy()

    await GraphVersionStore.publish(project, base, candidate)

    expect(await GraphVersionStore.resolve(project, "latest")).toBe(candidate)
    expect(await GraphVersionStore.resolve(project, "previous")).toBe(base)
  })

  test("normal, soft-correction, and hard-correction publication all set previous to their active base", async () => {
    const initial = await GraphVersionStore.ensure(project)

    const normalCandidate = await GraphVersionStore.createCandidate(project, initial.latest)
    await GraphVersionStore.publish(project, initial.latest, normalCandidate)
    expect(await GraphVersionStore.resolve(project, "previous")).toBe(initial.latest)

    const softCandidate = await GraphVersionStore.createCandidate(project, normalCandidate)
    await GraphVersionStore.publish(project, normalCandidate, softCandidate)
    expect(await GraphVersionStore.resolve(project, "previous")).toBe(normalCandidate)

    const hardBase = await GraphVersionStore.resolve(project, "previous")
    const hardCandidate = await GraphVersionStore.createCandidate(project, hardBase)
    await GraphVersionStore.publish(project, hardBase, hardCandidate)
    expect(await GraphVersionStore.resolve(project, "previous")).toBe(hardBase)
    expect(await GraphVersionStore.resolve(project, "latest")).toBe(hardCandidate)
  })

  test("resumes an interrupted legacy migration from its staged latest link", async () => {
    const initialized = await GraphVersionStore.ensure(project)
    const workflows = path.join(project, "workflows")
    await fs.rm(path.join(workflows, "latest_graph"), { force: true })
    await fs.symlink(
      path.relative(workflows, initialized.latest),
      path.join(workflows, "latest_graph.migrating"),
      "dir",
    )

    const recovered = await GraphVersionStore.ensure(project)

    expect(recovered.latest).toBe(initialized.latest)
    await expect(fs.lstat(path.join(workflows, "latest_graph.migrating"))).rejects.toThrow()
    await expect(fs.stat(path.join(project, "nodes"))).resolves.toBeTruthy()
  })

  test("interrupted migration preserves a legacy previous graph when only staged latest exists", async () => {
    await fs.mkdir(path.join(project, "nodes", "goal"), { recursive: true })
    await fs.writeFile(path.join(project, "nodes", "goal", "goal_current.json"), "current\n")
    const workflows = path.join(project, "workflows")
    const stagedLatest = path.join(workflows, "graph_versions", "version-staged")
    await GraphVersionStore.copyTo(project, stagedLatest)
    const legacyPrevious = path.join(workflows, "previous_graph")
    await fs.mkdir(path.join(legacyPrevious, "nodes", "goal"), { recursive: true })
    await fs.writeFile(path.join(legacyPrevious, "nodes", "goal", "goal_previous.json"), "previous\n")
    await fs.symlink(
      path.relative(workflows, stagedLatest),
      path.join(workflows, "latest_graph.migrating"),
      "dir",
    )

    const recovered = await GraphVersionStore.ensure(project)

    expect(recovered.latest).toBe(stagedLatest)
    expect(recovered.previous).not.toBe(recovered.latest)
    await expect(fs.readFile(path.join(recovered.previous, "nodes", "goal", "goal_previous.json"), "utf8"))
      .resolves.toBe("previous\n")
    await expect(fs.readFile(path.join(recovered.latest, "nodes", "goal", "goal_current.json"), "utf8"))
      .resolves.toBe("current\n")
  })
})
