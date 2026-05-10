import { join } from "path"

export const PROJECT_GRAPH_ROOT_NAME = "project_graph_data"

export function projectGraphRoot() {
  return join(process.cwd(), PROJECT_GRAPH_ROOT_NAME)
}
