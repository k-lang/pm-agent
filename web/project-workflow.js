import {
  allWorkflowDiffRecords as collectWorkflowDiffRecords,
  canShowWorkflowGraphPreview,
  esc,
  markWorkflowPermissionRecord as markWorkflowPermissionRecords,
  mergeWorkflowPermissionRecords as mergeWorkflowPermissionRecordList,
  permissionListUrl,
  permissionReplyUrl,
  renderResourceItem,
  renderWorkflowReviewBody,
  renderWorkflowToolPart,
  resetWorkflowViewState,
  upsertWorkflowPermissionRecord as upsertWorkflowPermissionRecordList,
  workflowMaximizeBodyClass,
  workflowMaximizeButtonState,
  workflowPermissionDiff,
  workflowPermissionFile,
  workflowPermissionStatusText,
  workflowPermissionTitle,
} from './project-workflow-view.js'
import { ProjectGraphRenderer } from './project-graph-renderer.js'

const API = ''
const params = new URLSearchParams(location.search)
let projectName = params.get('project') || ''
let projects = []

const layout = document.getElementById('layout')
const layoutResizer = document.getElementById('layout-resizer')
const projectSelect = document.getElementById('project-select')
const btnNewProject = document.getElementById('btn-new-project')
const btnDetail = document.getElementById('btn-detail')
const btnGraph = document.getElementById('btn-graph')
const btnDebug = document.getElementById('btn-debug')
const workspaceSubtitle = document.getElementById('workspace-subtitle')
const projectStatus = document.getElementById('project-status')
const graphPreview = document.getElementById('graph-preview')
const graphPreviewStatus = document.getElementById('graph-preview-status')
const btnGraphModeMap = document.getElementById('btn-graph-mode-map')
const btnGraphModeDraft = document.getElementById('btn-graph-mode-draft')
const btnGraphRefresh = document.getElementById('btn-graph-refresh')
const btnGraphFit = document.getElementById('btn-graph-fit')
const btnGraphZoomOut = document.getElementById('btn-graph-zoom-out')
const btnGraphZoomIn = document.getElementById('btn-graph-zoom-in')
const btnWorkspaceMaximize = document.getElementById('btn-workspace-maximize')
const notePreview = document.getElementById('note-preview')
const resourcePreview = document.getElementById('resource-preview')
const chatLog = document.getElementById('chat-log')
const chatHint = document.getElementById('chat-hint')
const chatInput = document.getElementById('chat-input')
const btnChatSend = document.getElementById('btn-chat-send')
const btnChatMaximize = document.getElementById('btn-chat-maximize')
const btnWarmup = document.getElementById('btn-warmup')
const warmupStatus = document.getElementById('warmup-status')
const operationList = document.getElementById('operation-list')
const operationSideTitle = document.getElementById('operation-side-title')
const noteList = document.getElementById('note-list')
const resourceList = document.getElementById('resource-list')
const btnUploadResource = document.getElementById('btn-upload-resource')
const resourceFile = document.getElementById('resource-file')
const btnImportNoteFile = document.getElementById('btn-import-note-file')
const btnPasteNote = document.getElementById('btn-paste-note')
const noteFile = document.getElementById('note-file')
const btnApply = document.getElementById('btn-apply')
const btnDiscardWorkflow = document.getElementById('btn-discard-workflow')
const tabButtons = Array.from(document.querySelectorAll('.tab-button'))
const tabPanels = Array.from(document.querySelectorAll('[data-tab-panel]'))
const modal = document.getElementById('new-project-modal')
const projectNameInput = document.getElementById('project-name')
const modalError = document.getElementById('modal-error')
const btnCancelProject = document.getElementById('btn-cancel-project')
const btnCreateProject = document.getElementById('btn-create-project')
const noteImportModal = document.getElementById('note-import-modal')
const noteImportContent = document.getElementById('note-import-content')
const noteImportError = document.getElementById('note-import-error')
const btnCancelNoteImport = document.getElementById('btn-cancel-note-import')
const btnConfirmNoteImport = document.getElementById('btn-confirm-note-import')
const permissionReviewModal = document.getElementById('permission-review-modal')
const permissionReviewTitle = document.getElementById('permission-review-title')
const permissionReviewFile = document.getElementById('permission-review-file')
const permissionReviewStatus = document.getElementById('permission-review-status')
const permissionReviewDiff = document.getElementById('permission-review-diff')
const permissionReviewError = document.getElementById('permission-review-error')
const btnClosePermissionReview = document.getElementById('btn-close-permission-review')
const btnRejectPermissionReview = document.getElementById('btn-reject-permission-review')
const btnApprovePermissionReview = document.getElementById('btn-approve-permission-review')
let activeTab = 'notes'
let resources = []
let workflowNote = null
let selectedResourcePath = ''
let resourceLoading = false
let noteLoading = false
let graphRenderer = null
let graphLoading = false
let graphLoadedProject = ''
let graphLoadedPreviewKey = ''
let graphError = ''
let graphLoadSeq = 0
let graphPreviewMode = 'map'
let workflowOperations = null
let selectedOperationArtifactKey = 'operationNotes'
let selectedOperationKey = ''
let operationHighlight = { nodeIds: [], edgeIds: [], focusNodeId: '', focusEdgeId: '' }
let expandedOperationGroups = new Set()
let workflowOperationsLoading = false
let noteImporting = false
let workflow = null
let workflowMessages = []
let workflowPermissions = []
let workflowPermissionRecords = []
let workflowLoading = false
let chatSending = false
let warmupStarting = false
let workflowPollTimer = null
let currentSSE = null
let refreshWorkflowTimer = null
let restorePromptProject = ''
let suppressRestorePrompt = false
let workflowAwaitingReply = false
let pendingUserText = ''
let activePermissionReviewID = ''
let permissionReplying = false
let maximizedPanel = ''
const workflowStatusById = new Map()
const shownPermissionModalIds = new Set()
const previewRenderKeys = new WeakMap()

const TERMINAL_STAGES = new Set(['已应用', '已取消'])
const CHAT_HEIGHT_KEY = 'pm-agent.workflow.chatHeight.v2'

async function fetchJson(url, options) {
  const res = await fetch(url, options)
  if (!res.ok) throw new Error(await res.text())
  if (res.status === 204 || res.headers.get('content-length') === '0') return null
  return res.json()
}

function selectedProject() {
  return projects.find((project) => project.name === projectName) || projects[0] || null
}

function setPreviewHtml(element, key, html) {
  if (!element) return false
  if (previewRenderKeys.get(element) === key) return false
  element.innerHTML = html
  previewRenderKeys.set(element, key)
  return true
}

function resetPreviewRenderKey(element) {
  if (element) previewRenderKeys.delete(element)
}

function clearWorkflowView() {
  const reset = resetWorkflowViewState()
  workflow = reset.workflow
  workflowNote = reset.workflowNote
  workflowOperations = null
  workflowMessages = reset.workflowMessages
  workflowPermissions = reset.workflowPermissions
  workflowPermissionRecords = reset.workflowPermissionRecords
  pendingUserText = reset.pendingUserText
  activePermissionReviewID = reset.activePermissionReviewID
  selectedOperationKey = ''
  operationHighlight = { nodeIds: [], edgeIds: [], focusNodeId: '', focusEdgeId: '' }
  expandedOperationGroups = new Set()
  shownPermissionModalIds.clear()
  workflowAwaitingReply = reset.workflowAwaitingReply
  workflowStatusById.clear()
  resetPreviewRenderKey(notePreview)
  resetPreviewRenderKey(graphPreview)
  resetGraphPreview()
}

function replaceUrl() {
  const url = new URL(location.href)
  if (projectName) url.searchParams.set('project', projectName)
  else url.searchParams.delete('project')
  history.replaceState(null, '', url.toString())
}

function projectDetailUrl(project) {
  return `/web/project.html?project=${encodeURIComponent(project.name)}`
}

function projectGraphUrl(project) {
  return `/web/project-graph.html?project=${encodeURIComponent(project.name)}&view=expanded`
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function applyChatHeight(height) {
  if (!layout) return
  if (maximizedPanel) return
  const total = layout.clientHeight
  if (!total) return
  const resizerHeight = layoutResizer?.offsetHeight || 10
  const minChat = 280
  const minWorkspace = 420
  const maxChat = Math.max(minChat, total - resizerHeight - minWorkspace)
  const next = clamp(height, minChat, maxChat)
  layout.style.gridTemplateRows = `minmax(${minWorkspace}px, 1fr) ${resizerHeight}px ${next}px`
}

function restoreChatHeight() {
  if (maximizedPanel) return
  if (window.matchMedia('(max-width: 760px)').matches) {
    layout.style.gridTemplateRows = ''
    return
  }
  const saved = Number(localStorage.getItem(CHAT_HEIGHT_KEY))
  applyChatHeight(Number.isFinite(saved) && saved > 0 ? saved : 320)
}

function setupLayoutResizer() {
  if (!layout || !layoutResizer) return
  restoreChatHeight()
  window.addEventListener('resize', restoreChatHeight)
  let dragging = false
  const onMove = (event) => {
    if (!dragging) return
    const rect = layout.getBoundingClientRect()
    const next = rect.bottom - event.clientY
    applyChatHeight(next)
  }
  const onUp = () => {
    if (!dragging) return
    dragging = false
    layout.classList.remove('resizing')
    const rows = getComputedStyle(layout).gridTemplateRows.split(' ')
    const chatHeight = parseFloat(rows[2])
    if (Number.isFinite(chatHeight)) localStorage.setItem(CHAT_HEIGHT_KEY, String(Math.round(chatHeight)))
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
  }
  layoutResizer.addEventListener('pointerdown', (event) => {
    if (maximizedPanel) return
    event.preventDefault()
    dragging = true
    layout.classList.add('resizing')
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  })
}

function updateMaximizeButton(button, panel) {
  if (!button) return
  const state = workflowMaximizeButtonState(maximizedPanel, panel)
  button.textContent = state.label
  button.title = state.title
  button.setAttribute('aria-pressed', state.expanded ? 'true' : 'false')
}

function updateMaximizedLayout() {
  document.body.classList.remove('workflow-maximized-workspace', 'workflow-maximized-chat')
  const bodyClass = workflowMaximizeBodyClass(maximizedPanel)
  if (bodyClass) document.body.classList.add(bodyClass)
  if (!maximizedPanel) restoreChatHeight()
  updateMaximizeButton(btnWorkspaceMaximize, 'workspace')
  updateMaximizeButton(btnChatMaximize, 'chat')
}

function setMaximizedPanel(panel) {
  const next = maximizedPanel === panel ? '' : panel
  maximizedPanel = next
  updateMaximizedLayout()
  if (panel === 'chat' || next === 'chat') chatLog.scrollTop = chatLog.scrollHeight
}

function toggleWorkspaceMaximize() {
  setMaximizedPanel('workspace')
}

function toggleChatMaximize() {
  setMaximizedPanel('chat')
}

async function loadProjects() {
  projects = await fetchJson(API + '/project/directories') || []
  if (projectName && !projects.some((project) => project.name === projectName)) projectName = ''
  if (!projectName && projects.length) projectName = projects[0].name
  render()
  connectWorkflowSSE()
  await Promise.all([loadWorkflow({ askRestore: true }), loadResources(), loadWorkflowNote(), loadWorkflowOperations()])
}

async function loadWorkflowNote() {
  const project = selectedProject()
  workflowNote = null
  if (!project) {
    renderNotes()
    return
  }
  noteLoading = true
  renderNotes()
  try {
    const result = await fetchJson(API + `/project/workflow/note?project=${encodeURIComponent(project.name)}`)
    workflowNote = result || null
    if (result?.workflow) workflow = result.workflow
  } catch (error) {
    workflowNote = { exists: false, content: '', error: error.message || '工作笔记加载失败' }
  } finally {
    noteLoading = false
    renderWorkspace()
  }
}

async function loadWorkflowOperations() {
  const project = selectedProject()
  if (!project) {
    workflowOperations = null
    renderOperationPreview()
    return
  }
  workflowOperationsLoading = true
  if (!workflowOperations) renderOperationPreview()
  try {
    const result = await fetchJson(API + `/project/workflow/operations?project=${encodeURIComponent(project.name)}`)
    workflowOperations = result || null
    if (result?.workflow) workflow = result.workflow
    if (activeTab === 'graph' && graphPreviewMode === 'map') {
      await ensureGraphPreviewLoaded().catch(() => {})
    }
  } catch (error) {
    workflowOperations = { files: [], error: error.message || '图操作草稿加载失败' }
  } finally {
    workflowOperationsLoading = false
    renderWorkspace()
  }
}

async function loadResources() {
  const project = selectedProject()
  const previousResourcePath = selectedResourcePath
  resources = []
  selectedResourcePath = ''
  if (!project) {
    renderResources()
    return
  }
  resourceLoading = true
  renderResources()
  try {
    resources = await fetchJson(API + `/project/source?project=${encodeURIComponent(project.name)}`) || []
    if (previousResourcePath && resources.some((resource) => resource.path === previousResourcePath)) {
      selectedResourcePath = previousResourcePath
    }
  } catch (error) {
    resourcePreview.innerHTML = `<div class="placeholder">${esc(error.message || '资源加载失败')}</div>`
  } finally {
    resourceLoading = false
    renderResources()
  }
}

async function loadWorkflow(options = {}) {
  const project = selectedProject()
  if (!project) {
    workflow = null
    workflowMessages = []
    renderChat()
    return
  }
  workflowLoading = true
  renderChat()
  try {
    const [result, statuses] = await Promise.all([
      fetchJson(API + `/project/workflow/messages?project=${encodeURIComponent(project.name)}`),
      fetchJson(API + `/session/status?directory=${encodeURIComponent(project.directory)}`).catch(() => ({})),
    ])
    workflow = result?.workflow || null
    workflowMessages = result?.messages || []
    syncWorkflowStatuses(statuses || {})
    await loadPendingWorkflowPermissions()
    if (pendingUserText && workflowMessages.some((message) => visibleUserText(message) === pendingUserText)) {
      pendingUserText = ''
    }
    if (!workflowHasUnansweredUser()) workflowAwaitingReply = false
  } catch (error) {
    workflow = { ok: false, message: error.message || '工作推进状态加载失败' }
    workflowMessages = []
  } finally {
    workflowLoading = false
    renderWorkspace()
    maybePollWorkflow()
    if (options.askRestore) await maybeAskRestoreWorkflow()
  }
}

async function loadPendingWorkflowPermissions() {
  const ids = workflowSessionIDs()
  if (!ids.size) {
    workflowPermissions = []
    workflowPermissionRecords = workflowPermissionRecords.filter((record) => record.status !== 'pending')
    return
  }
  const project = selectedProject()
  const permissions = await fetchJson(API + permissionListUrl(project)).catch(() => [])
  workflowPermissions = (permissions || []).filter((permission) => ids.has(permission.sessionID))
  mergeWorkflowPermissionRecords(workflowPermissions)
  openFirstPendingPermissionReview()
}

function mergeWorkflowPermissionRecords(pending) {
  workflowPermissionRecords = mergeWorkflowPermissionRecordList(workflowPermissionRecords, pending)
}

function upsertWorkflowPermissionRecord(req, status = 'pending') {
  workflowPermissionRecords = upsertWorkflowPermissionRecordList(workflowPermissionRecords, req, status)
  workflowPermissions = workflowPermissionRecords.filter((item) => item.status === 'pending')
  return workflowPermissionRecords[0]
}

function markWorkflowPermissionRecord(id, reply) {
  workflowPermissionRecords = markWorkflowPermissionRecords(workflowPermissionRecords, id, reply)
  workflowPermissions = workflowPermissions.filter((item) => item.id !== id)
  if (activePermissionReviewID === id) renderPermissionReviewModal()
}

function openFirstPendingPermissionReview() {
  const pending = workflowPermissionRecords.find((item) => item.status === 'pending' && !shownPermissionModalIds.has(item.id))
  if (!pending) return
  openPermissionReviewModal(pending.id)
}

function allWorkflowDiffRecords() {
  return collectWorkflowDiffRecords(workflowPermissionRecords, workflowMessages)
}

function scheduleWorkflowRefresh() {
  if (refreshWorkflowTimer) return
  refreshWorkflowTimer = setTimeout(async () => {
    refreshWorkflowTimer = null
    await loadWorkflow({ askRestore: false })
  }, 250)
}

function connectWorkflowSSE() {
  if (currentSSE) {
    currentSSE.close()
    currentSSE = null
  }
  const project = selectedProject()
  if (!project) return
  const es = new EventSource(API + '/event?directory=' + encodeURIComponent(project.directory))
  es.onmessage = (event) => {
    try {
      handleWorkflowBusEvent(JSON.parse(event.data))
    } catch {}
  }
  es.onerror = () => {
    es.close()
    currentSSE = null
    setTimeout(() => {
      if (selectedProject()?.name === project.name) connectWorkflowSSE()
    }, 3000)
  }
  currentSSE = es
}

function workflowSessionIDs() {
  const state = currentWorkflowState()
  return new Set([state?.sessionID, state?.warmupSessionID].filter(Boolean))
}

function syncWorkflowStatuses(statuses) {
  const ids = workflowSessionIDs()
  for (const id of Array.from(workflowStatusById.keys())) {
    if (!ids.has(id)) workflowStatusById.delete(id)
  }
  for (const id of ids) {
    const status = statuses[id]
    if (status && status.type !== 'idle') workflowStatusById.set(id, status)
    else workflowStatusById.delete(id)
  }
}

function updateWorkflowStatus(sessionID, status) {
  if (!sessionID) return
  if (status?.type === 'busy' || status?.type === 'retry') workflowStatusById.set(sessionID, status)
  else workflowStatusById.delete(sessionID)
}

function handleWorkflowBusEvent(event) {
  if (!event?.type) return
  const ids = workflowSessionIDs()
  if (!ids.size) {
    if (currentWorkflowState()?.warmupStatus === 'running') scheduleWorkflowRefresh()
    return
  }
  if (event.type === 'session.updated') {
    const sessionID = event.properties?.info?.id
    if (sessionID && ids.has(sessionID)) scheduleWorkflowRefresh()
  }
  if (event.type === 'session.status') {
    const sessionID = event.properties?.sessionID
    if (sessionID && ids.has(sessionID)) {
      updateWorkflowStatus(sessionID, event.properties?.status || { type: 'idle' })
      renderChat()
      scheduleWorkflowRefresh()
    }
  }
  if (event.type === 'message.updated') {
    const sessionID = event.properties?.info?.sessionID
    if (sessionID && ids.has(sessionID)) scheduleWorkflowRefresh()
  }
  if (event.type === 'message.part.updated' || event.type === 'message.part.delta') {
    const sessionID = event.properties?.part?.sessionID || event.properties?.sessionID
    if (sessionID && ids.has(sessionID)) scheduleWorkflowRefresh()
  }
  if (event.type === 'permission.asked') {
    const sessionID = event.properties?.sessionID
    if (sessionID && ids.has(sessionID)) {
      upsertWorkflowPermissionRecord(event.properties, 'pending')
      openPermissionReviewModal(event.properties.id)
      renderChat()
    }
  }
  if (event.type === 'permission.replied') {
    const requestID = event.properties?.requestID
    if (requestID) {
      markWorkflowPermissionRecord(requestID, event.properties?.reply)
      renderChat()
      scheduleWorkflowRefresh()
      loadWorkflowNote().catch(() => {})
    }
  }
}

function renderProjectSelect() {
  projectSelect.innerHTML = ''
  if (!projects.length) {
    const opt = document.createElement('option')
    opt.value = ''
    opt.textContent = '暂无项目'
    projectSelect.append(opt)
    projectSelect.disabled = true
    return
  }
  projectSelect.disabled = false
  for (const project of projects) {
    const opt = document.createElement('option')
    opt.value = project.name
    opt.textContent = project.name
    projectSelect.append(opt)
  }
  projectSelect.value = projectName
}

function setActiveTab(tab) {
  activeTab = tab
  for (const button of tabButtons) {
    button.classList.toggle('active', button.dataset.tab === tab)
  }
  for (const panel of tabPanels) {
    panel.classList.toggle('active', panel.dataset.tabPanel === tab)
  }
  if (tab === 'graph') {
    if (graphPreviewMode === 'map') ensureGraphPreviewLoaded().catch(() => {})
    else loadWorkflowOperations().catch(() => {})
  }
}

function setGraphPreviewPlaceholder(message) {
  if (graphRenderer) {
    graphRenderer.destroy()
    resetPreviewRenderKey(graphPreview)
  }
  graphRenderer = null
  graphLoadedProject = ''
  graphLoadedPreviewKey = ''
  setPreviewHtml(graphPreview, `placeholder:${message}`, `<div class="placeholder">${esc(message)}</div>`)
}

function resetGraphPreview() {
  graphLoadSeq += 1
  graphLoading = false
  graphLoadedProject = ''
  graphLoadedPreviewKey = ''
  graphError = ''
  setGraphPreviewPlaceholder('等待图谱草案。')
}

function graphPreviewApi(project) {
  return API + `/project/graph?project=${encodeURIComponent(project.name)}&view=expanded`
}

function operationArtifactJson(key) {
  const file = operationArtifactByKey(key)
  if (!file?.content) return null
  try {
    return JSON.parse(file.content)
  } catch {
    return null
  }
}

function workflowPreviewArtifact() {
  return operationArtifactJson('preview')
}

function workflowPreviewChange() {
  return workflowPreviewArtifact()?.change || null
}

function workflowPreviewGraph() {
  return workflowPreviewArtifact()?.graph || null
}

function graphPreviewKey(project) {
  if (!project) return ''
  const preview = workflowPreviewArtifact()
  if (!preview?.graph) return `${project.name}:current`
  return `${project.name}:preview:${preview.change_id || ''}:${preview.generatedAt || ''}:${preview.operationCount || ''}`
}

function graphPreviewOptions() {
  const change = workflowPreviewChange()
  const directNodeIds = [
    ...(change?.createdNodeIds || []),
    ...(change?.updatedNodeIds || []),
  ]
  const directEdgeIds = [
    ...(change?.createdEdgeIds || []),
    ...(change?.updatedEdgeIds || []),
  ]
  return {
    mode: workflowPreviewGraph() ? 'draft-preview' : 'current',
    draftNodeIds: directNodeIds,
    draftEdgeIds: directEdgeIds,
    highlightNodeIds: operationHighlight.nodeIds,
    highlightEdgeIds: operationHighlight.edgeIds,
    focusNodeId: operationHighlight.focusNodeId,
    focusEdgeId: operationHighlight.focusEdgeId,
  }
}

function renderGraphPreviewStatus(project, ready) {
  const hasDraftPreviewGraph = !!workflowPreviewGraph()
  const canLoad = !!project && canShowWorkflowGraphPreview(ready, hasDraftPreviewGraph)
  btnGraphRefresh.disabled = !canLoad || graphLoading
  btnGraphFit.disabled = !graphRenderer
  btnGraphZoomOut.disabled = !graphRenderer
  btnGraphZoomIn.disabled = !graphRenderer

  if (!project) {
    graphPreviewStatus.textContent = '未选择项目'
    return
  }
  if (!canLoad) {
    graphPreviewStatus.textContent = '等待第一次图提交'
    return
  }
  if (graphLoading) {
    graphPreviewStatus.textContent = hasDraftPreviewGraph ? '草案图谱加载中' : '当前图谱加载中'
    return
  }
  if (graphError) {
    graphPreviewStatus.textContent = hasDraftPreviewGraph ? '草案图谱加载失败' : '当前图谱加载失败'
    return
  }
  if (graphRenderer && graphLoadedProject === project.name && graphLoadedPreviewKey === graphPreviewKey(project)) {
    graphPreviewStatus.textContent = workflowPreviewGraph() ? '草案预览，未提交' : '当前图谱'
    return
  }
  graphPreviewStatus.textContent = '当前图谱未加载'
}

function renderGraphPreview(project, ready) {
  if (graphPreviewMode === 'draft') {
    renderOperationDraftPreview()
    return
  }
  const hasDraftPreviewGraph = !!workflowPreviewGraph()
  const canLoad = !!project && canShowWorkflowGraphPreview(ready, hasDraftPreviewGraph)
  renderGraphPreviewStatus(project, ready)
  if (!project) {
    setGraphPreviewPlaceholder('点击“新建项目”创建项目目录和基础结构。')
    return
  }
  if (!canLoad) {
    setGraphPreviewPlaceholder('项目目录已创建。第一次图数据提交前，这里将展示项目初始化 Skill 生成的初始图草案。')
    return
  }
  if (graphLoading) {
    setGraphPreviewPlaceholder(hasDraftPreviewGraph ? '草案图谱加载中...' : '当前图谱加载中...')
    return
  }
  if (graphError) {
    setGraphPreviewPlaceholder(graphError)
    return
  }
  if (graphRenderer && graphLoadedProject === project.name && graphLoadedPreviewKey === graphPreviewKey(project)) return
  setGraphPreviewPlaceholder('切换到“图操作预览”页签后加载当前完整图谱。')
  if (activeTab === 'graph') ensureGraphPreviewLoaded().catch(() => {})
}

async function ensureGraphPreviewLoaded({ force = false } = {}) {
  const project = selectedProject()
  const hasDraftPreviewGraph = !!workflowPreviewGraph()
  if (!project || !canShowWorkflowGraphPreview(project.graphInitialized, hasDraftPreviewGraph)) return
  const key = graphPreviewKey(project)
  if (!force && graphRenderer && graphLoadedProject === project.name && graphLoadedPreviewKey === key) return

  const loadSeq = ++graphLoadSeq
  graphLoading = true
  graphError = ''
  renderGraphPreview(project, project.graphInitialized)
  try {
    const payload = workflowPreviewGraph() || await fetchJson(graphPreviewApi(project))
    if (loadSeq !== graphLoadSeq || selectedProject()?.name !== project.name) return
    graphRenderer?.destroy()
    resetPreviewRenderKey(graphPreview)
    graphRenderer = new ProjectGraphRenderer({
      root: graphPreview,
      view: 'expanded',
      showLegend: false,
      showControls: false,
      readonly: true,
    })
    graphRenderer.setPayload(payload, graphPreviewOptions())
    graphLoadedProject = project.name
    graphLoadedPreviewKey = key
  } catch (error) {
    if (loadSeq !== graphLoadSeq || selectedProject()?.name !== project.name) return
    graphError = error.message || '图谱预览加载失败'
    graphLoadedProject = ''
    graphLoadedPreviewKey = ''
  } finally {
    if (loadSeq !== graphLoadSeq || selectedProject()?.name !== project.name) return
    graphLoading = false
    renderGraphPreviewStatus(project, project.graphInitialized)
    if (graphError) renderGraphPreview(project, project.graphInitialized)
  }
}

function operationArtifactFiles() {
  return workflowOperations?.files || []
}

function operationArtifactByKey(key) {
  return operationArtifactFiles().find((file) => file.key === key)
}

function operationIndexItems() {
  const parsed = operationArtifactJson('operationIndex')
  if (Array.isArray(parsed)) return parsed
  if (Array.isArray(parsed?.items)) return parsed.items
  return []
}

function normalizeOperationGroup(group) {
  const sourceNodeId = group.sourceNodeId || group.nodeIds?.[0] || ''
  const targetNodeId = group.targetNodeId || group.nodeIds?.[1] || ''
  const edgeId = group.edgeId || group.edgeIds?.[0] || ''
  const allowedNodes = new Set([sourceNodeId, targetNodeId].filter(Boolean))
  const children = Array.isArray(group.children)
    ? group.children.filter((child) => {
      const childEdges = child.edgeIds || []
      if (childEdges.length) return edgeId ? childEdges.includes(edgeId) : childEdges.length === 1
      const childNodes = child.nodeIds || []
      return childNodes.length > 0 && childNodes.every((nodeId) => allowedNodes.has(nodeId))
    })
    : []
  return {
    ...group,
    sourceNodeId,
    targetNodeId,
    edgeId,
    nodeIds: [sourceNodeId, targetNodeId].filter(Boolean),
    edgeIds: edgeId ? [edgeId] : (group.edgeIds || []).slice(0, 1),
    children,
  }
}

function operationIndexGroups() {
  const parsed = operationArtifactJson('operationIndex')
  if (Array.isArray(parsed?.groups) && parsed.groups.length) return parsed.groups.map(normalizeOperationGroup)
  return operationIndexItems().map((item, index) => ({
    index,
    kind: item.kind || item.type || '图操作',
    title: item.title || item.summary || item.review_text || `图操作 ${index + 1}`,
    description: item.description || item.history_entry || item.detail || '',
    nodeIds: item.nodeIds || (item.targetIds || []).filter((id) => !String(id).includes('|')),
    edgeIds: item.edgeIds || (item.targetIds || []).filter((id) => String(id).includes('|')),
    children: [],
  }))
}

function setOperationHighlight(input = {}) {
  operationHighlight = {
    nodeIds: input.nodeIds || [],
    edgeIds: input.edgeIds || [],
    focusNodeId: input.focusNodeId || input.nodeIds?.[0] || '',
    focusEdgeId: input.focusEdgeId || input.edgeIds?.[0] || '',
  }
  if (graphRenderer) {
    graphRenderer.setHighlights(graphPreviewOptions())
    if (operationHighlight.focusNodeId) graphRenderer.focusNode(operationHighlight.focusNodeId)
    else if (operationHighlight.focusEdgeId) graphRenderer.focusEdge(operationHighlight.focusEdgeId)
  }
}

function renderOperationIndexList() {
  operationSideTitle.innerHTML = '图操作索引 <span>自然语言展示图操作</span>'
  const groups = operationIndexGroups()
  if (!groups.length) {
    operationList.innerHTML = '<div class="placeholder">后续这里显示本次推进生成的图操作索引，点击后图谱预览会定位到对应节点或边。</div>'
    return
  }
  operationList.innerHTML = groups.map((group, index) => {
    const title = group.title || group.summary || `关系组 ${index + 1}`
    const kind = group.kind || '关系组'
    const detail = group.description || group.history_entry || ''
    const key = `group:${index}`
    const children = Array.isArray(group.children) ? group.children : []
    const expanded = expandedOperationGroups.has(key)
    const groupActive = selectedOperationKey === key
    return `
      <div class="operation-group ${groupActive ? 'active' : ''}">
      <div class="operation-group-row">
        <button type="button" class="operation-toggle" data-operation-toggle="${esc(key)}" aria-label="${expanded ? '折叠图操作组' : '展开图操作组'}">${expanded ? 'v' : '>'}</button>
        <button type="button" class="operation-item operation-group-title" data-operation-key="${esc(key)}" data-node-ids="${esc((group.nodeIds || []).join(','))}" data-edge-ids="${esc((group.edgeIds || []).join(','))}" data-focus-node="${esc(group.sourceNodeId || group.focusNodeId || group.nodeIds?.[0] || '')}" data-focus-edge="${esc(group.edgeId || group.focusEdgeId || group.edgeIds?.[0] || '')}">
          <div class="operation-kind">${esc(kind)}</div>
          <div class="operation-title">${esc(title)}</div>
          ${detail ? `<div class="operation-history">${esc(detail)}</div>` : ''}
        </button>
      </div>
      ${children.length && expanded ? `<div class="operation-children">
        ${children.map((child, childIndex) => {
          const childKey = `${key}:child:${childIndex}`
          const childEdgeIds = child.edgeIds || []
          const childNodeIds = childEdgeIds.length ? [] : (child.nodeIds || [])
          return `
            <button type="button" class="operation-child ${selectedOperationKey === childKey ? 'active' : ''}" data-operation-key="${esc(childKey)}" data-node-ids="${esc(childNodeIds.join(','))}" data-edge-ids="${esc(childEdgeIds.join(','))}" data-focus-node="${esc(childNodeIds[0] || '')}" data-focus-edge="${esc(childEdgeIds[0] || '')}">
              <span>${esc(child.kind || '子项')}</span>
              <strong>${esc(child.title || `子项 ${childIndex + 1}`)}</strong>
              ${child.history_entry ? `<em>${esc(child.history_entry)}</em>` : ''}
            </button>
          `
        }).join('')}
      </div>` : ''}
      </div>
    `
  }).join('')
  for (const toggle of operationList.querySelectorAll('[data-operation-toggle]')) {
    toggle.onclick = () => {
      const key = toggle.dataset.operationToggle || ''
      if (!key) return
      if (expandedOperationGroups.has(key)) expandedOperationGroups.delete(key)
      else expandedOperationGroups.add(key)
      renderOperationIndexList()
    }
  }
  for (const item of operationList.querySelectorAll('[data-operation-key]')) {
    item.onclick = async () => {
      selectedOperationKey = item.dataset.operationKey || ''
      const nodeIds = (item.dataset.nodeIds || '').split(',').filter(Boolean)
      const edgeIds = (item.dataset.edgeIds || '').split(',').filter(Boolean)
      setOperationHighlight({
        nodeIds,
        edgeIds,
        focusNodeId: item.dataset.focusNode || nodeIds[0] || '',
        focusEdgeId: item.dataset.focusEdge || edgeIds[0] || '',
      })
      renderOperationIndexList()
      if (!graphRenderer && graphPreviewMode === 'map') await ensureGraphPreviewLoaded()
    }
  }
}

function renderOperationDraftPreview() {
  operationSideTitle.innerHTML = '图操作文件 <span>说明与校验</span>'
  btnGraphRefresh.disabled = true
  btnGraphFit.disabled = true
  btnGraphZoomOut.disabled = true
  btnGraphZoomIn.disabled = true
  graphPreviewStatus.textContent = workflowOperationsLoading ? '说明加载中' : '说明只读'
  if (graphRenderer) {
    graphRenderer.destroy()
    resetPreviewRenderKey(graphPreview)
  }
  graphRenderer = null
  graphLoadedProject = ''
  graphLoadedPreviewKey = ''

  const files = operationArtifactFiles()
  const visibleFiles = files.filter((file) => ['operationNotes', 'changelogEntry', 'operationsDraft', 'operations', 'operationIndex', 'validation', 'preview'].includes(file.key))
  if (!visibleFiles.some((file) => file.key === selectedOperationArtifactKey && file.exists)) {
    selectedOperationArtifactKey = visibleFiles.find((file) => file.exists)?.key || 'operationNotes'
  }
  const selected = operationArtifactByKey(selectedOperationArtifactKey)
  if (workflowOperationsLoading && !visibleFiles.some((file) => file.exists)) {
    setPreviewHtml(graphPreview, 'operation-draft:loading', '<div class="placeholder">图操作说明加载中...</div>')
  } else if (workflowOperations?.error) {
    setPreviewHtml(graphPreview, `operation-draft:error:${workflowOperations.error}`, `<div class="placeholder">${esc(workflowOperations.error)}</div>`)
  } else if (!selected?.exists) {
    setPreviewHtml(graphPreview, 'operation-draft:empty', '<div class="placeholder">生成图操作草案后，这里会展示自然语言说明、operations.draft.json、代码生成的 operations.json 和校验结果。需要修改时请在下方聊天框提出意见。</div>')
  } else if (selected.type === 'json') {
    let content = selected.content || ''
    try {
      content = JSON.stringify(JSON.parse(content), null, 2)
    } catch {}
    setPreviewHtml(graphPreview, `operation-draft:${selected.key}:${content}`, `<pre class="operation-draft-content">${esc(content)}</pre>`)
  } else {
    const content = selected.content || ''
    setPreviewHtml(graphPreview, `operation-draft:${selected.key}:${content}`, `<pre class="operation-draft-content">${esc(content)}</pre>`)
  }

  operationList.innerHTML = visibleFiles.map((file) => `
    <button type="button" class="resource-item ${file.key === selectedOperationArtifactKey ? 'active' : ''}" data-operation-file="${esc(file.key)}" ${file.exists ? '' : 'disabled'}>
      <div class="resource-name">${esc(file.label)}</div>
      <div class="resource-meta">${esc(file.exists ? file.path : '未生成')}</div>
    </button>
  `).join('') || '<div class="placeholder">还没有图操作说明。</div>'
  for (const item of operationList.querySelectorAll('[data-operation-file]')) {
    item.onclick = () => {
      selectedOperationArtifactKey = item.dataset.operationFile
      renderOperationDraftPreview()
    }
  }
}

function renderOperationPreview() {
  btnGraphModeMap.classList.toggle('active', graphPreviewMode === 'map')
  btnGraphModeDraft.classList.toggle('active', graphPreviewMode === 'draft')
  const draftMode = graphPreviewMode === 'draft'
  graphPreview.classList.toggle('draft-mode', draftMode)
  if (draftMode) {
    renderOperationDraftPreview()
  } else {
    renderOperationIndexList()
    if (graphRenderer) graphRenderer.setHighlights(graphPreviewOptions())
  }
}

function emptyMaterialState(message) {
  resetGraphPreview()
  graphPreview.innerHTML = `<div class="placeholder">${message}</div>`
  operationList.innerHTML = '<div class="placeholder">还没有图操作草案。</div>'
  notePreview.innerHTML = '<div class="placeholder">还没有工作笔记。可以人工导入，也可以在下方对话中让 AI 帮你整理生成。</div>'
  noteList.innerHTML = '<div class="placeholder">还没有项目。</div>'
  resourcePreview.innerHTML = '<div class="placeholder">还没有可预览的项目资源。</div>'
  resourceList.innerHTML = '<div class="placeholder">还没有登记项目资源文档。</div>'
}

function currentWorkflowState() {
  return workflow?.state || null
}

function hasUnfinishedActiveWorkflow(state) {
  return !!state && !TERMINAL_STAGES.has(state.stage)
}

function workflowActionEntry(action) {
  const available = workflow?.availableActions || []
  const blocked = workflow?.blockedActions || []
  return {
    available: available.find((item) => item.action === action),
    blocked: blocked.find((item) => item.action === action),
  }
}

function workflowActionBlockedReason(action) {
  const project = selectedProject()
  const state = currentWorkflowState()
  if (!project) return '请先选择项目。'
  if (workflowLoading) return '工作推进状态仍在加载，请稍后再试。'
  if (!state) return '当前项目还没有 active 工作推进草案。'
  if (TERMINAL_STAGES.has(state.stage)) return `当前草案已处于终态「${state.stage}」，不能执行「${action}」。`
  const entry = workflowActionEntry(action)
  if (entry.blocked?.reason) return entry.blocked.reason
  if (!entry.available) return `当前阶段「${state.stage}」不支持「${action}」。`
  return ''
}

function updateTerminalActionButtons() {
  const project = selectedProject()
  const state = currentWorkflowState()
  const hasProject = !!project && !workflowLoading
  if (btnDiscardWorkflow) {
    btnDiscardWorkflow.disabled = !hasProject
    btnDiscardWorkflow.title = state ? `当前阶段：${state.stage}` : '当前没有 active 工作推进草案'
  }
  if (btnApply) {
    btnApply.disabled = !hasProject
    btnApply.classList.toggle('pending-action', !!workflowActionEntry('应用图操作').available)
    btnApply.title = state ? `当前阶段：${state.stage}` : '当前没有 active 工作推进草案'
  }
}

async function refreshWorkflowStateOnly(project) {
  if (!project) return
  workflowLoading = true
  updateTerminalActionButtons()
  try {
    workflow = await fetchJson(API + `/project/workflow/state?project=${encodeURIComponent(project.name)}`)
  } finally {
    workflowLoading = false
    renderWorkspace()
  }
}

async function maybeAskRestoreWorkflow() {
  const project = selectedProject()
  const state = currentWorkflowState()
  if (!project || !hasUnfinishedActiveWorkflow(state)) return
  if (suppressRestorePrompt) return
  if (restorePromptProject === project.name) return
  restorePromptProject = project.name

  const ok = confirm(`检测到项目「${project.name}」有未完成的工作推进草案，当前阶段：${state.stage}。是否恢复上次操作？\n\n选择“确定”会恢复本轮 active workflow。\n选择“取消”会结束并删除本轮 active workflow，包括 state、图操作草案、校验、预览和聊天会话；如果已有工作笔记，会只保留 workflows/active/note.md 供下一轮重新开始使用。已写入的正式图数据不会删除。`)
  if (ok) return

  suppressRestorePrompt = true
  try {
    await fetchJson(API + `/project/workflow/action?project=${encodeURIComponent(project.name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: '放弃草案', payload: {} }),
    })
    clearWorkflowView()
    await loadWorkflow({ askRestore: false })
    await loadWorkflowNote()
    await loadWorkflowOperations()
  } catch (error) {
    chatLog.innerHTML = `<div class="placeholder">${esc(error.message || '放弃草案失败')}</div>`
  } finally {
    suppressRestorePrompt = false
  }
}

function warmupStatusText(status) {
  if (status === 'completed') return '项目上下文预热已完成'
  if (status === 'running') return '项目上下文预热中'
  if (status === 'failed') return '项目上下文预热失败'
  if (status === 'stale') return '项目上下文需要重新预热'
  return '项目上下文尚未预热'
}

function visibleMessageText(message) {
  return (message.parts || []).reduce((result, part) => {
    if (part.type !== 'text' || part.synthetic || part.ignored) return result
    return result + (part.text || '')
  }, '').trim()
}

function visibleUserText(message) {
  if ((message.info?.role || message.role) !== 'user') return ''
  return visibleMessageText(message)
}

function assistantReplies(userMessageID) {
  return workflowMessages.filter((message) =>
    (message.info?.role || message.role) === 'assistant' && message.info?.parentID === userMessageID)
}

function workflowHasUnansweredUser() {
  const users = workflowMessages.filter((message) => visibleUserText(message))
  const latestUser = users[users.length - 1]
  if (!latestUser?.info?.id) return false
  const assistants = assistantReplies(latestUser.info.id)
  if (!assistants.length) return true
  return assistants.some((assistant) => !assistant.info?.time?.completed)
}

function renderMessagePart(part, message) {
  if (part.type === 'text' && !part.synthetic && !part.ignored) {
    return `<div class="message-text">${esc(part.text || '')}</div>`
  }
  if (part.type === 'tool') {
    return renderWorkflowToolPart(part, message)
  }
  return ''
}

function renderWorkflowMessage(message) {
  const role = message.info?.role || message.role || 'assistant'
  if (role !== 'user' && role !== 'assistant') return ''
  const parts = (message.parts || []).map((part) => renderMessagePart(part, message)).filter(Boolean).join('')
  const fallback = visibleMessageText(message)
  if (!parts && !fallback) return ''
  const label = role === 'user' ? '你' : '大模型'
  return `
    <div class="workflow-message ${role === 'user' ? 'user' : 'assistant'}">
      <div class="message-role">${label}</div>
      <div class="message-body">${parts || `<div class="message-text">${esc(fallback)}</div>`}</div>
    </div>
  `
}

function currentPermissionReviewRecord() {
  return allWorkflowDiffRecords().find((item) => item.id === activePermissionReviewID)
}

function openPermissionReviewModal(id) {
  const record = allWorkflowDiffRecords().find((item) => item.id === id)
  if (!record) return
  activePermissionReviewID = id
  if (record.status === 'pending') shownPermissionModalIds.add(id)
  hidePermissionReviewError()
  renderPermissionReviewModal()
  permissionReviewModal.classList.remove('hidden')
}

function closePermissionReviewModal() {
  permissionReviewModal.classList.add('hidden')
  activePermissionReviewID = ''
  hidePermissionReviewError()
}

function closePermissionReviewModalFromBackdrop() {
  const record = currentPermissionReviewRecord()
  if (record?.status === 'pending') {
    showPermissionReviewError('请先批准或拒绝本次修改请求。')
    return
  }
  closePermissionReviewModal()
}

function showPermissionReviewError(message) {
  permissionReviewError.textContent = message
  permissionReviewError.classList.remove('hidden')
}

function hidePermissionReviewError() {
  permissionReviewError.textContent = ''
  permissionReviewError.classList.add('hidden')
}

function renderPermissionReviewModal() {
  const record = currentPermissionReviewRecord()
  if (!record) return
  const pending = record.status === 'pending'
  permissionReviewTitle.textContent = record.title || workflowPermissionTitle(record)
  permissionReviewFile.textContent = record.file || workflowPermissionFile(record)
  permissionReviewStatus.textContent = workflowPermissionStatusText(record.status)
  permissionReviewStatus.className = `permission-status ${record.status || 'pending'}`
  permissionReviewDiff.innerHTML = renderWorkflowReviewBody(record)
  btnClosePermissionReview.classList.toggle('hidden', pending)
  btnApprovePermissionReview.classList.toggle('hidden', !pending)
  btnRejectPermissionReview.classList.toggle('hidden', !pending)
  btnApprovePermissionReview.disabled = permissionReplying
  btnRejectPermissionReview.disabled = permissionReplying
  btnClosePermissionReview.disabled = false
}

async function replyWorkflowPermission(id, reply) {
  const project = selectedProject()
  await fetchJson(API + permissionReplyUrl(id, project), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reply }),
  })
  markWorkflowPermissionRecord(id, reply)
  renderChat()
  await Promise.all([
    loadWorkflow({ askRestore: false }),
    loadWorkflowNote(),
  ]).catch(() => {})
}

async function replyActivePermissionReview(reply) {
  const id = activePermissionReviewID
  if (!id || permissionReplying) return
  permissionReplying = true
  renderPermissionReviewModal()
  try {
    await replyWorkflowPermission(id, reply)
    closePermissionReviewModal()
  } catch (error) {
    showPermissionReviewError(error.message || '权限处理失败')
  } finally {
    permissionReplying = false
    renderPermissionReviewModal()
  }
}

function workflowIsRunning() {
  const state = currentWorkflowState()
  if (state?.warmupStatus === 'running') return true
  if ([...workflowStatusById.values()].some((status) => status.type === 'busy' || status.type === 'retry')) return true
  if (chatSending || workflowAwaitingReply || workflowHasUnansweredUser()) return true
  return workflowMessages.some((message) =>
    (message.parts || []).some((part) => {
      const status = part.state?.status
      return status === 'pending' || status === 'running'
    }))
}

function chatLockReason(project, state) {
  if (!project) return '选择或新建项目后可以开始工作推进。'
  if (!project.graphInitialized) return ''
  if (workflowLoading) return '正在加载工作推进状态。'
  if (!state) return '已有图数据的项目需要先完成项目上下文预热。'
  if (state.warmupStatus === 'running') return '项目上下文预热中，完成后会自动开放推进对话。'
  if (state.warmupStatus === 'failed') return '项目上下文预热失败，请重新预热后再继续。'
  if (state.warmupStatus !== 'completed') return '请先预热项目上下文，让大模型掌握当前项目主线。'
  return ''
}

function renderChat() {
  const project = selectedProject()
  const state = currentWorkflowState()
  const lockReason = chatLockReason(project, state)
  const running = workflowIsRunning()
  const canChat = !!project && !running && !lockReason
  const canWarmup = !!project?.graphInitialized && !warmupStarting && state?.warmupStatus !== 'running'
  const hasNote = !!workflowNote?.exists
  const readyHint = !project
    ? '选择或新建项目后可以开始工作推进。'
    : project.graphInitialized
      ? hasNote
        ? '基于当前工作笔记继续补充、修改，或要求生成图操作草案。'
        : '描述本次推进、补充材料，或在工作笔记页签导入/人工修改笔记。'
      : '描述项目背景、目标、现状或已有笔记；也可以在工作笔记页签导入/人工修改。'

  btnChatSend.disabled = !canChat || !chatInput.value.trim()
  chatInput.disabled = !canChat
  chatInput.placeholder = lockReason || readyHint
  chatHint.textContent = lockReason
    ? lockReason
    : running
      ? '大模型正在处理，本轮回复完成后可以继续输入。'
      : ''

  btnWarmup.classList.toggle('hidden', !project?.graphInitialized)
  btnWarmup.disabled = !canWarmup
  btnWarmup.textContent = state?.warmupStatus === 'completed' ? '重新预热项目上下文' : '开始项目上下文预热'
  const showWarmupStatus = !!project?.graphInitialized
  const warmupDisplayStatus = warmupStarting ? 'running' : (state?.warmupStatus || '')
  warmupStatus.classList.toggle('hidden', !showWarmupStatus)
  warmupStatus.textContent = showWarmupStatus ? warmupStatusText(warmupDisplayStatus) : ''
  warmupStatus.dataset.status = warmupDisplayStatus || 'none'

  if (workflowLoading && !workflowMessages.length) {
    chatLog.innerHTML = ''
    chatHint.textContent = '正在加载工作推进会话...'
    return
  }

  if (!project) {
    chatLog.innerHTML = ''
    return
  }

  const messages = workflowMessages.map(renderWorkflowMessage).filter(Boolean)
  if (pendingUserText) {
    messages.push(`
      <div class="workflow-message user local-pending">
        <div class="message-role">你</div>
        <div class="message-body"><div class="message-text">${esc(pendingUserText)}</div></div>
      </div>
    `)
  }
  if (running) messages.push('<div class="output-cursor">运行中</div>')
  const messagesHtml = messages.join('')

  chatLog.innerHTML = messagesHtml
  for (const button of Array.from(chatLog.querySelectorAll('[data-tool-diff-open]'))) {
    button.onclick = () => {
      const id = button.dataset.toolDiffOpen
      if (id) openPermissionReviewModal(id)
    }
  }
  chatLog.scrollTop = chatLog.scrollHeight
}

function formatBytes(size) {
  if (!Number.isFinite(size)) return ''
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

function renderResources() {
  const project = selectedProject()
  if (btnUploadResource) btnUploadResource.disabled = !project || resourceLoading
  if (!project) {
    resourcePreview.innerHTML = '<div class="placeholder">选择项目后可以上传和预览资源。</div>'
    resourceList.innerHTML = '<div class="placeholder">还没有项目。</div>'
    return
  }
  if (resourceLoading) {
    resourceList.innerHTML = '<div class="placeholder">正在加载资源...</div>'
    return
  }
  if (!resources.length) {
    resourcePreview.innerHTML = '<div class="placeholder">可以上传 txt、md 或其他附件；当前只支持预览 txt 和 markdown。</div>'
    resourceList.innerHTML = '<div class="placeholder">还没有项目资源。</div>'
    return
  }
  resourceList.innerHTML = resources.map((resource) => `
    ${renderResourceItem(resource, selectedResourcePath, `${formatBytes(resource.size)}${resource.previewable ? ' / 可预览' : ' / 附件'}`)}
  `).join('')
  for (const item of Array.from(resourceList.querySelectorAll('.resource-item'))) {
    item.onclick = () => previewResource(item.dataset.path)
    item.onkeydown = (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      previewResource(item.dataset.path)
    }
  }
  for (const item of Array.from(resourceList.querySelectorAll('.resource-delete'))) {
    item.onclick = (event) => {
      event.stopPropagation()
      deleteResource(item.dataset.path).catch((error) => {
        resourcePreview.innerHTML = `<div class="placeholder">${esc(error.message || '删除失败')}</div>`
      })
    }
    item.onkeydown = (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      event.stopPropagation()
      item.click()
    }
  }
}

function renderNotes() {
  const project = selectedProject()
  if (btnImportNoteFile) btnImportNoteFile.disabled = !project || noteLoading || noteImporting
  if (btnPasteNote) btnPasteNote.disabled = !project || noteLoading || noteImporting
  if (!project) {
    setPreviewHtml(notePreview, 'note:no-project', '<div class="placeholder">选择项目后可以导入、粘贴或生成工作笔记。</div>')
    noteList.innerHTML = '<div class="placeholder">还没有项目。</div>'
    return
  }
  if (noteLoading) {
    setPreviewHtml(notePreview, 'note:loading', '<div class="placeholder">正在加载工作笔记...</div>')
    noteList.innerHTML = '<div class="placeholder">正在加载...</div>'
    return
  }
  if (workflowNote?.error) {
    setPreviewHtml(notePreview, `note:error:${workflowNote.error}`, `<div class="placeholder">${esc(workflowNote.error)}</div>`)
    noteList.innerHTML = '<div class="placeholder">加载失败。</div>'
    return
  }
  if (!workflowNote?.exists) {
    setPreviewHtml(notePreview, 'note:empty', `
      <div class="note-empty">
        <h4>还没有工作笔记</h4>
        <p>工作笔记可以人工导入，也可以让 AI 根据对话整理生成；导入后仍可继续让 AI 辅助修改。</p>
      </div>
    `)
    noteList.innerHTML = `
      <div class="note-info">
        <strong>可选方式</strong>
        <span>导入已有 markdown/txt 笔记</span>
        <span>手工粘贴或编辑一段工作记录</span>
        <span>在下方对话中描述背景，让 AI 生成</span>
      </div>
    `
    return
  }
  setPreviewHtml(notePreview, `note:content:${workflowNote.content || ''}`, `<pre class="note-content">${esc(workflowNote.content || '')}</pre>`)
  const state = currentWorkflowState()
  noteList.innerHTML = `
    <div class="note-info">
      <strong>当前工作笔记</strong>
      <span>${esc(workflowNote.path || 'workflows/active/note.md')}</span>
      <span>当前阶段：${esc(state?.stage || '未知')}</span>
      <span>可人工替换，也可在对话中让 AI 基于这份笔记继续修改。</span>
      <span>更新笔记会清空旧图操作、校验和预览。</span>
    </div>
  `
}

function renderWorkspace() {
  const project = selectedProject()
  if (!project) {
    workspaceSubtitle.textContent = '还没有项目'
    projectStatus.textContent = ''
    emptyMaterialState('点击“新建项目”创建项目目录和基础结构。')
    btnDetail.disabled = true
    btnGraph.disabled = true
    updateTerminalActionButtons()
    renderResources()
    renderNotes()
    renderChat()
    return
  }
  const ready = !!project.graphInitialized
  const hasDraftPreviewGraph = !!workflowPreviewGraph()
  const state = currentWorkflowState()
  workspaceSubtitle.textContent = `${project.name} / ${project.directory}`
  projectStatus.innerHTML = `
    <span class="badge ${ready ? 'ready' : 'pending'}">${ready ? '图数据已初始化' : '等待第一次图提交'}</span>
    ${state ? `<span class="badge workflow-stage">${esc(state.stage)}</span>` : ''}
  `
  btnDetail.disabled = !ready
  btnGraph.disabled = !ready
  updateTerminalActionButtons()
  if (!canShowWorkflowGraphPreview(ready, hasDraftPreviewGraph) || graphLoadedProject !== project.name || graphLoadedPreviewKey !== graphPreviewKey(project)) {
    graphRenderer?.destroy()
    graphRenderer = null
    graphLoadedProject = ''
    graphLoadedPreviewKey = ''
  }
  renderGraphPreview(project, ready)
  if (ready || hasDraftPreviewGraph || graphPreviewMode === 'draft') renderOperationPreview()
  else operationList.innerHTML = '<div class="placeholder">等待项目初始化 Skill 生成第一批图操作：初始事件/目标/工作块/工作项等。</div>'
  renderResources()
  renderNotes()
  renderChat()
}

function render() {
  renderProjectSelect()
  renderWorkspace()
  replaceUrl()
}

function openModal() {
  projectNameInput.value = ''
  hideError()
  modal.classList.remove('hidden')
  projectNameInput.focus()
}

function closeModal() {
  modal.classList.add('hidden')
}

function showError(message) {
  modalError.textContent = message
  modalError.classList.remove('hidden')
}

function hideError() {
  modalError.textContent = ''
  modalError.classList.add('hidden')
}

function openNoteImportModal() {
  noteImportContent.value = workflowNote?.content || ''
  hideNoteImportError()
  noteImportModal.classList.remove('hidden')
  noteImportContent.focus()
}

function closeNoteImportModal() {
  noteImportModal.classList.add('hidden')
}

function showNoteImportError(message) {
  noteImportError.textContent = message
  noteImportError.classList.remove('hidden')
}

function hideNoteImportError() {
  noteImportError.textContent = ''
  noteImportError.classList.add('hidden')
}

async function createProject() {
  hideError()
  const name = projectNameInput.value.trim()
  if (!name) {
    showError('请输入项目名')
    return
  }
  btnCreateProject.disabled = true
  try {
    const created = await fetchJson(API + '/project/directories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    projectName = created.name
    restorePromptProject = created.name
    clearWorkflowView()
    closeModal()
    await loadProjects()
  } catch (error) {
    showError(error.message || '创建失败')
  } finally {
    btnCreateProject.disabled = false
  }
}

async function refreshAfterNoteImport() {
  await Promise.all([
    loadWorkflow({ askRestore: false }),
    loadWorkflowNote(),
    loadResources(),
    loadWorkflowOperations(),
  ])
  setActiveTab('notes')
}

function confirmNoteReplacement() {
  return confirm('保存后会替换当前工作笔记，并清空旧图操作、校验和预览。之后仍可让 AI 继续修改这份笔记。是否继续？')
}

async function importNoteFile(file) {
  const project = selectedProject()
  if (!project || !file) return
  if (!confirmNoteReplacement()) return
  const form = new FormData()
  form.append('file', file)
  noteImporting = true
  renderNotes()
  try {
    const result = await fetchJson(API + `/project/workflow/note/import?project=${encodeURIComponent(project.name)}`, {
      method: 'POST',
      body: form,
    })
    workflowNote = result
    if (result?.workflow) workflow = result.workflow
    await refreshAfterNoteImport()
  } catch (error) {
    notePreview.innerHTML = `<div class="placeholder">${esc(error.message || '导入失败')}</div>`
  } finally {
    noteImporting = false
    if (noteFile) noteFile.value = ''
    renderNotes()
  }
}

async function importPastedNote() {
  hideNoteImportError()
  const project = selectedProject()
  const content = noteImportContent.value.trim()
  if (!project) {
    showNoteImportError('请先选择项目')
    return
  }
  if (!content) {
    showNoteImportError('请输入工作笔记内容')
    return
  }
  if (!confirmNoteReplacement()) return
  btnConfirmNoteImport.disabled = true
  noteImporting = true
  renderNotes()
  try {
    const result = await fetchJson(API + `/project/workflow/note/import?project=${encodeURIComponent(project.name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    })
    workflowNote = result
    if (result?.workflow) workflow = result.workflow
    closeNoteImportModal()
    await refreshAfterNoteImport()
  } catch (error) {
    showNoteImportError(error.message || '保存失败')
  } finally {
    noteImporting = false
    btnConfirmNoteImport.disabled = false
    renderNotes()
  }
}

projectSelect.onchange = () => {
  projectName = projectSelect.value
  restorePromptProject = ''
  clearWorkflowView()
  resetGraphPreview()
  render()
  connectWorkflowSSE()
  Promise.all([loadWorkflow({ askRestore: true }), loadResources(), loadWorkflowNote(), loadWorkflowOperations()]).catch((error) => {
    chatLog.innerHTML = `<div class="placeholder">${esc(error.message || '加载失败')}</div>`
  })
}
for (const button of tabButtons) {
  button.onclick = () => setActiveTab(button.dataset.tab)
}
btnWorkspaceMaximize.onclick = toggleWorkspaceMaximize
btnChatMaximize.onclick = toggleChatMaximize
btnNewProject.onclick = openModal
btnDetail.onclick = () => {
  const project = selectedProject()
  if (project?.graphInitialized) location.href = projectDetailUrl(project)
}
btnGraph.onclick = () => {
  const project = selectedProject()
  if (project?.graphInitialized) location.href = projectGraphUrl(project)
}
btnGraphRefresh.onclick = () => {
  ensureGraphPreviewLoaded({ force: true }).catch((error) => {
    graphError = error.message || '图谱预览加载失败'
    renderGraphPreview(selectedProject(), !!selectedProject()?.graphInitialized)
  })
}
btnGraphModeMap.onclick = () => {
  graphPreviewMode = 'map'
  renderWorkspace()
  if (activeTab === 'graph') ensureGraphPreviewLoaded().catch(() => {})
}
btnGraphModeDraft.onclick = () => {
  graphPreviewMode = 'draft'
  renderWorkspace()
  if (activeTab === 'graph') loadWorkflowOperations().catch(() => {})
}
btnGraphFit.onclick = () => graphRenderer?.fit()
btnGraphZoomOut.onclick = () => graphRenderer?.zoomBy(1 / 1.2)
btnGraphZoomIn.onclick = () => graphRenderer?.zoomBy(1.2)
btnDebug.onclick = () => { location.href = '/web' }
btnCancelProject.onclick = closeModal
btnCreateProject.onclick = createProject
btnPasteNote.onclick = openNoteImportModal
btnImportNoteFile.onclick = () => {
  const project = selectedProject()
  if (!project) return
  noteFile.click()
}
btnCancelNoteImport.onclick = closeNoteImportModal
btnConfirmNoteImport.onclick = () => importPastedNote().catch((error) => {
  showNoteImportError(error.message || '保存失败')
})
btnClosePermissionReview.onclick = closePermissionReviewModal
btnApprovePermissionReview.onclick = () => replyActivePermissionReview('once')
btnRejectPermissionReview.onclick = () => replyActivePermissionReview('reject')
chatInput.oninput = renderChat
chatInput.onkeydown = (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault()
    sendChat().catch((error) => {
      chatLog.innerHTML = `<div class="placeholder">${esc(error.message || '发送失败')}</div>`
    })
  }
}
btnChatSend.onclick = () => sendChat().catch((error) => {
  chatLog.innerHTML = `<div class="placeholder">${esc(error.message || '发送失败')}</div>`
})
btnWarmup.onclick = () => startWarmup().catch((error) => {
  chatLog.innerHTML = `<div class="placeholder">${esc(error.message || '预热失败')}</div>`
})
btnUploadResource.onclick = () => {
  const project = selectedProject()
  if (!project) return
  resourceFile.click()
}

async function discardWorkflowFromButton() {
  const project = selectedProject()
  await refreshWorkflowStateOnly(project)
  const reason = workflowActionBlockedReason('放弃草案')
  if (reason) {
    alert(reason)
    return
  }
  const state = currentWorkflowState()
  const ok = confirm(`确认放弃项目「${project.name}」的本轮工作推进草案吗？\n\n当前阶段：${state.stage}\n\n这会结束并删除本轮 active workflow，包括 state、图操作草案、校验、预览和聊天会话；如果已有工作笔记，会只保留 workflows/active/note.md 供下一轮重新开始使用。已写入的正式图数据不会删除。`)
  if (!ok) return
  btnDiscardWorkflow.disabled = true
  try {
    await fetchJson(API + `/project/workflow/action?project=${encodeURIComponent(project.name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: '放弃草案', payload: {} }),
    })
    clearWorkflowView()
    restorePromptProject = project.name
    await loadWorkflow({ askRestore: false })
    await loadWorkflowNote()
    await loadWorkflowOperations()
  } catch (error) {
    alert(error.message || '放弃草案失败')
  } finally {
    updateTerminalActionButtons()
  }
}

async function applyWorkflowFromButton() {
  const project = selectedProject()
  try {
    await refreshWorkflowStateOnly(project)
  } catch (error) {
    alert(error.message || '读取工作推进状态失败')
    return
  }
  const reason = workflowActionBlockedReason('应用图操作')
  if (reason) {
    alert(reason)
    return
  }
  const state = currentWorkflowState()
  const ok = confirm(`确认提交项目「${project.name}」的本轮图操作吗？\n\n当前阶段：${state.stage}\n\n提交后将进入正式图数据写入流程。`)
  if (!ok) return
  btnApply.disabled = true
  try {
    const result = await fetchJson(API + `/project/workflow/action?project=${encodeURIComponent(project.name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: '应用图操作', payload: { confirm: true } }),
    })
    alert(result.message || '图操作已应用。')
    clearWorkflowView()
    await loadWorkflow({ askRestore: false })
    await loadWorkflowNote()
    await loadWorkflowOperations()
  } catch (error) {
    alert(error.message || '应用图操作失败')
    await loadWorkflow({ askRestore: false }).catch(() => {})
    await loadWorkflowOperations().catch(() => {})
  } finally {
    updateTerminalActionButtons()
  }
}

btnDiscardWorkflow.onclick = () => discardWorkflowFromButton()
btnApply.onclick = () => applyWorkflowFromButton()

resourceFile.onchange = async () => {
  const project = selectedProject()
  const file = resourceFile.files?.[0]
  if (!project || !file) return
  const form = new FormData()
  form.append('file', file)
  btnUploadResource.disabled = true
  resourcePreview.innerHTML = '<div class="placeholder">正在上传资源...</div>'
  try {
    const uploaded = await fetchJson(API + `/project/source?project=${encodeURIComponent(project.name)}`, {
      method: 'POST',
      body: form,
    })
    selectedResourcePath = uploaded.path
    await loadResources()
    await previewResource(uploaded.path)
    setActiveTab('resources')
  } catch (error) {
    resourcePreview.innerHTML = `<div class="placeholder">${esc(error.message || '上传失败')}</div>`
  } finally {
    resourceFile.value = ''
    btnUploadResource.disabled = false
  }
}
modal.onclick = (event) => {
  if (event.target === modal) closeModal()
}
permissionReviewModal.onclick = (event) => {
  if (event.target === permissionReviewModal) closePermissionReviewModalFromBackdrop()
}

noteFile.onchange = async () => {
  const file = noteFile.files?.[0]
  if (!file) return
  await importNoteFile(file)
}

async function deleteResource(resourcePath) {
  const project = selectedProject()
  if (!project || !resourcePath) return
  const resource = resources.find((item) => item.path === resourcePath)
  const name = resource?.originalName || resource?.name || resourcePath
  const ok = confirm(`确认删除资源「${name}」吗？\n\n这会删除 source 目录下的文件；如果工作笔记已引用该资源，需要手动调整引用。`)
  if (!ok) return
  await fetchJson(API + `/project/source?project=${encodeURIComponent(project.name)}&path=${encodeURIComponent(resourcePath)}`, {
    method: 'DELETE',
  })
  if (selectedResourcePath === resourcePath) {
    selectedResourcePath = ''
    resourcePreview.innerHTML = '<div class="placeholder">资源已删除。</div>'
  }
  await loadResources()
}

async function previewResource(resourcePath) {
  const project = selectedProject()
  if (!project || !resourcePath) return
  selectedResourcePath = resourcePath
  renderResources()
  resourcePreview.innerHTML = '<div class="placeholder">正在读取预览...</div>'
  try {
    const preview = await fetchJson(API + `/project/source/preview?project=${encodeURIComponent(project.name)}&path=${encodeURIComponent(resourcePath)}`)
    if (preview.type === 'text') {
      resourcePreview.innerHTML = `<pre class="resource-preview-text">${esc(preview.content)}</pre>`
      return
    }
    resourcePreview.innerHTML = `
      <div class="resource-preview-message">
        <div class="operation-kind">${esc(preview.name || resourcePath)}</div>
        <div class="operation-title">${esc(preview.message || '当前文件不可预览。')}</div>
        <div class="operation-history">${esc(preview.path || resourcePath)}${preview.size ? ` / ${esc(formatBytes(preview.size))}` : ''}</div>
      </div>
    `
  } catch (error) {
    resourcePreview.innerHTML = `<div class="placeholder">${esc(error.message || '预览失败')}</div>`
  }
}

async function sendChat() {
  const project = selectedProject()
  const text = chatInput.value.trim()
  if (!project || !text || chatSending) return
  chatSending = true
  workflowAwaitingReply = true
  pendingUserText = text
  renderChat()
  try {
    await fetchJson(API + `/project/workflow/chat?project=${encodeURIComponent(project.name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    })
    chatInput.value = ''
    await loadWorkflow({ askRestore: false })
    await loadWorkflowOperations()
    startWorkflowPolling()
  } catch (error) {
    workflowAwaitingReply = false
    pendingUserText = ''
    throw error
  } finally {
    chatSending = false
    renderChat()
  }
}

async function startWarmup() {
  const project = selectedProject()
  if (!project?.graphInitialized || warmupStarting) return
  const state = currentWorkflowState()
  const force = !!state
  if (force) {
    const ok = confirm('重新预热会创建新的 active workflow 和新的聊天会话；会保留当前工作笔记和资源登记，但清空图操作草案、校验和预览。是否继续？')
    if (!ok) return
  }
  warmupStarting = true
  renderChat()
  try {
    await fetchJson(API + `/project/workflow/warmup?project=${encodeURIComponent(project.name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force }),
    })
    await loadWorkflow({ askRestore: false })
    startWorkflowPolling()
  } finally {
    warmupStarting = false
    renderChat()
  }
}

function startWorkflowPolling() {
  if (workflowPollTimer) clearTimeout(workflowPollTimer)
  workflowPollTimer = setTimeout(async () => {
    workflowPollTimer = null
    await loadWorkflow({ askRestore: false })
    await loadWorkflowOperations()
  }, 1600)
}

function maybePollWorkflow() {
  if (workflowIsRunning()) startWorkflowPolling()
}

setupLayoutResizer()
loadProjects().catch((error) => {
  graphPreview.innerHTML = `<div class="placeholder">${esc(error.message || '加载失败')}</div>`
})
setActiveTab(activeTab)
