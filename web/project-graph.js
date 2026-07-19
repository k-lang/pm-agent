import { ProjectGraphRenderer } from './project-graph-renderer.js'

const params = new URLSearchParams(location.search)
const legacyDirectory = params.get('directory') || ''
let projectName = params.get('project') || projectNameFromDirectory(legacyDirectory)
const view = params.get('view') === 'expanded' ? 'expanded' : 'collapsed'

const pageTitleEl = document.getElementById('page-title')
const projectDirEl = document.getElementById('project-dir')
const metaEl = document.getElementById('meta')
const projectSelect = document.getElementById('project-select')
const canvasPanel = document.getElementById('canvas-panel')
const btnBack = document.getElementById('btn-back')
const btnWorkflow = document.getElementById('btn-workflow')
const btnFiles = document.getElementById('btn-files')
const btnCollapsed = document.getElementById('btn-collapsed')
const btnExpanded = document.getElementById('btn-expanded')

let projects = []
let renderer = null

function projectNameFromDirectory(directory) {
  return directory.split('/').filter(Boolean).pop() || ''
}

function graphApi() {
  return `/project/graph?project=${encodeURIComponent(projectName)}&view=${encodeURIComponent(view)}`
}

function layoutApi() {
  return `/project/graph/layout?project=${encodeURIComponent(projectName)}&view=${encodeURIComponent(view)}`
}

async function fetchJson(url, options) {
  const res = await fetch(url, options)
  if (!res.ok) throw new Error(await res.text())
  if (res.status === 204 || res.headers.get('content-length') === '0') return null
  return res.json()
}

function replaceProjectUrl() {
  if (!projectName) return
  const url = new URL(location.href)
  url.searchParams.delete('directory')
  url.searchParams.set('project', projectName)
  url.searchParams.set('view', view)
  history.replaceState(null, '', url.toString())
}

async function loadProjects() {
  projects = await fetchJson('/project/directories') || []
  if (!projectName && projects.length) projectName = projects.find((project) => project.graphInitialized)?.name || projects[0].name
  renderProjectSelect()
}

function renderProjectSelect() {
  projectSelect.innerHTML = ''
  for (const project of projects) {
    const opt = document.createElement('option')
    opt.value = project.name
    opt.textContent = project.name
    opt.disabled = !project.graphInitialized && project.name !== projectName
    projectSelect.append(opt)
  }
  projectSelect.value = projectName
}

function setModeButtons() {
  btnCollapsed.classList.toggle('active', view === 'collapsed')
  btnExpanded.classList.toggle('active', view === 'expanded')
}

function projectDetailHref() {
  return `/web/project.html?project=${encodeURIComponent(projectName)}`
}

function projectFilesHref() {
  return `/web/project-files.html?project=${encodeURIComponent(projectName)}`
}

function projectWorkflowHref() {
  return `/web/project-workflow.html?project=${encodeURIComponent(projectName)}`
}

function graphHref(nextView) {
  return `/web/project-graph.html?project=${encodeURIComponent(projectName)}&view=${encodeURIComponent(nextView)}`
}

async function saveLayout() {
  if (!renderer) return
  await fetchJson(layoutApi(), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(renderer.getLayout()),
  })
}

async function load() {
  if (!projectName) throw new Error('Missing project query parameter')
  replaceProjectUrl()
  pageTitleEl.textContent = view === 'expanded' ? '项目图谱 · Expanded' : '项目图谱 · Collapsed'
  projectDirEl.textContent = `${projectName}/`
  setModeButtons()

  const payload = await fetchJson(graphApi())
  renderer?.destroy()
  renderer = new ProjectGraphRenderer({
    root: canvasPanel,
    projectName,
    view,
    showLegend: true,
    showControls: true,
    readonly: false,
  })
  renderer.setPayload(payload, { mode: 'current' })
  metaEl.textContent = `nodes ${payload.meta.visibleNodeCount}/${payload.meta.rawNodeCount} · edges ${payload.meta.visibleEdgeCount}/${payload.meta.rawEdgeCount}`
}

btnBack.addEventListener('click', () => {
  location.href = projectDetailHref()
})

btnWorkflow.addEventListener('click', () => {
  location.href = projectWorkflowHref()
})

btnFiles.addEventListener('click', () => {
  location.href = projectFilesHref()
})

projectSelect.addEventListener('change', () => {
  const next = projectSelect.value
  if (!next || next === projectName) return
  location.href = `/web/project-graph.html?project=${encodeURIComponent(next)}&view=${encodeURIComponent(view)}`
})

btnCollapsed.addEventListener('click', () => {
  if (view !== 'collapsed') location.href = graphHref('collapsed')
})

btnExpanded.addEventListener('click', () => {
  if (view !== 'expanded') location.href = graphHref('expanded')
})

window.addEventListener('beforeunload', () => {
  if (!renderer) return
  navigator.sendBeacon(layoutApi(), new Blob([JSON.stringify(renderer.getLayout())], { type: 'application/json' }))
})

loadProjects().then(load).catch((error) => {
  metaEl.textContent = error.message || String(error)
})
