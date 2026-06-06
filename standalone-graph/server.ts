import { readFile } from "fs/promises"
import path from "path"
import { loadExpandedGraph, loadGraph, saveLayout } from "./transform"
import type { SavedLayout } from "./types"

const ROOT = path.join(process.cwd(), "standalone-graph")
const PORT = Number(process.env.STANDALONE_GRAPH_PORT || 4310)

function contentType(file: string): string {
  if (file.endsWith(".html")) return "text/html; charset=utf-8"
  if (file.endsWith(".js")) return "application/javascript; charset=utf-8"
  if (file.endsWith(".css")) return "text/css; charset=utf-8"
  return "application/octet-stream"
}

async function serveStatic(file: string): Promise<Response> {
  const full = path.join(ROOT, file)
  const body = await readFile(full)
  return new Response(body, { headers: { "content-type": contentType(file) } })
}

const server = Bun.serve({
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url)

    if (request.method === "GET" && url.pathname === "/") {
      return serveStatic("index.html")
    }

    if (request.method === "GET" && url.pathname === "/expanded") {
      return serveStatic("expanded.html")
    }

    if (request.method === "GET" && (url.pathname === "/graph.css" || url.pathname === "/graph.js")) {
      return serveStatic(url.pathname.slice(1))
    }

    if (request.method === "GET" && url.pathname === "/api/graph") {
      return Response.json(await loadGraph())
    }

    if (request.method === "GET" && url.pathname === "/api/graph-expanded") {
      return Response.json(await loadExpandedGraph())
    }

    if (request.method === "PUT" && url.pathname === "/api/layout") {
      const layout = await request.json() as SavedLayout
      return Response.json(await saveLayout(layout))
    }

    return new Response("Not found", { status: 404 })
  },
})

console.log(`standalone graph demo running at http://localhost:${server.port}`)
