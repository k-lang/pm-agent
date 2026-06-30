import fs from "fs/promises"
import path from "path"
import { GraphEdge, GraphNode, GraphSnapshot, NODE_TYPES, type NodeType } from "./schema"

export class GraphStorage {
  constructor(readonly root: string) {}

  async ensureDirectories() {
    await Promise.all([
      ...NODE_TYPES.map((type) => fs.mkdir(path.join(this.root, "nodes", type), { recursive: true })),
      fs.mkdir(path.join(this.root, "edges"), { recursive: true }),
      fs.mkdir(path.join(this.root, "changes"), { recursive: true }),
      fs.mkdir(path.join(this.root, "snapshots"), { recursive: true }),
      fs.mkdir(path.join(this.root, "metadata"), { recursive: true }),
    ])
  }

  nodePath(type: NodeType, id: string) {
    return path.join(this.root, "nodes", type, `${id}.json`)
  }

  edgePath(id: string) {
    return path.join(this.root, "edges", `${id}.json`)
  }

  snapshotPath(id: string) {
    return path.join(this.root, "snapshots", `${id}.json`)
  }

  async saveNode(node: GraphNode) {
    await this.ensureDirectories()
    await fs.writeFile(this.nodePath(node.type, node.id), JSON.stringify(GraphNode.parse(node), null, 2) + "\n", "utf8")
  }

  async loadNode(id: string, type: NodeType): Promise<GraphNode | undefined> {
    const raw = await fs.readFile(this.nodePath(type, id), "utf8").catch(() => undefined)
    return raw ? GraphNode.parse(JSON.parse(raw)) : undefined
  }

  async getNodeById(id: string): Promise<GraphNode | undefined> {
    for (const type of NODE_TYPES) {
      const node = await this.loadNode(id, type)
      if (node) return node
    }
    return undefined
  }

  async saveEdge(edge: GraphEdge) {
    await this.ensureDirectories()
    await fs.writeFile(this.edgePath(edge.id), JSON.stringify(GraphEdge.parse(edge), null, 2) + "\n", "utf8")
  }

  async loadEdge(id: string): Promise<GraphEdge | undefined> {
    const raw = await fs.readFile(this.edgePath(id), "utf8").catch(() => undefined)
    return raw ? GraphEdge.parse(JSON.parse(raw)) : undefined
  }

  async listNodeIdsByType(type: NodeType): Promise<string[]> {
    const dir = path.join(this.root, "nodes", type)
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => path.basename(entry.name, ".json")).sort()
  }

  async getAllNodes(): Promise<GraphNode[]> {
    const nested = await Promise.all(NODE_TYPES.map(async (type) => {
      const ids = await this.listNodeIdsByType(type)
      return Promise.all(ids.map((id) => this.loadNode(id, type)))
    }))
    return nested.flat().filter((node): node is GraphNode => !!node)
  }

  async listEdgeIds(): Promise<string[]> {
    const entries = await fs.readdir(path.join(this.root, "edges"), { withFileTypes: true }).catch(() => [])
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => path.basename(entry.name, ".json")).sort()
  }

  async getAllEdges(): Promise<GraphEdge[]> {
    const ids = await this.listEdgeIds()
    const edges = await Promise.all(ids.map((id) => this.loadEdge(id)))
    return edges.filter((edge): edge is GraphEdge => !!edge)
  }

  async saveSnapshot(snapshot: GraphSnapshot) {
    await this.ensureDirectories()
    await fs.writeFile(this.snapshotPath(snapshot.id), JSON.stringify(GraphSnapshot.parse(snapshot), null, 2) + "\n", "utf8")
  }
}

