import {
  allWorkflowDiffRecords as collectWorkflowDiffRecords,
  archivedNoteProgressLabel,
  canShowWorkflowGraphPreview,
  effectiveWorkflowWarmupStatus,
  esc,
  markWorkflowPermissionRecord as markWorkflowPermissionRecords,
  mergeWorkflowReadiness,
  mergeWorkflowPermissionRecords as mergeWorkflowPermissionRecordList,
  permissionListUrl,
  permissionReplyUrl,
  renderResourceItem,
  renderWorkflowReviewBody,
  renderWorkflowToolPart,
  resetWorkflowViewState,
  shouldClearWorkflowAwaitingReply,
  shouldDiscardWorkflowFromRestoreChoice,
  upsertWorkflowPermissionRecord as upsertWorkflowPermissionRecordList,
  workflowMaximizeBodyClass,
  workflowMaximizeButtonState,
  workflowChatLockReason,
  workflowCorrectionKind,
  workflowApplyButtonState,
  workflowLoadBlocksInteraction,
  workflowMessageErrorText,
  workflowModePresentation,
  workflowOperationArtifactsChanged,
  workflowRuntimeIsRunning,
  workflowTerminalActionsBlocked,
  workflowViewRequestMatches,
  workflowPermissionDiff,
  workflowPermissionFile,
  workflowPermissionStatusText,
  workflowPermissionTitle,
} from './project-workflow-view.js'
import { graphDetailUrlKey, ProjectGraphRenderer } from './project-graph-renderer.js'
import { sessionAbortControl, sessionAbortUrl, sessionIsRunning } from './session-abort-view.js'

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
const btnChatAbort = document.getElementById('btn-chat-abort')
const btnChatMaximize = document.getElementById('btn-chat-maximize')
const btnWarmup = document.getElementById('btn-warmup')
const warmupStatus = document.getElementById('warmup-status')
const operationList = document.getElementById('operation-list')
const operationSideTitle = document.getElementById('operation-side-title')
const noteList = document.getElementById('note-list')
const resourceList = document.getElementById('resource-list')
const btnUploadResource = document.getElementById('btn-upload-resource')
const btnResourceModeSource = document.getElementById('btn-resource-mode-source')
const btnResourceModeNotes = document.getElementById('btn-resource-mode-notes')
const resourceFile = document.getElementById('resource-file')
const btnImportNoteFile = document.getElementById('btn-import-note-file')
const btnPasteNote = document.getElementById('btn-paste-note')
const noteFile = document.getElementById('note-file')
const btnApply = document.getElementById('btn-apply')
const operationReviewWarning = document.getElementById('operation-review-warning')
const btnHardCorrection = document.getElementById('btn-hard-correction')
const btnSoftCorrection = document.getElementById('btn-soft-correction')
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
const restoreWorkflowModal = document.getElementById('restore-workflow-modal')
const restoreWorkflowSummary = document.getElementById('restore-workflow-summary')
const restoreWorkflowPolicy = document.getElementById('restore-workflow-policy')
const restoreWorkflowError = document.getElementById('restore-workflow-error')
const btnDiscardRestoredWorkflow = document.getElementById('btn-discard-restored-workflow')
const btnContinueRestoredWorkflow = document.getElementById('btn-continue-restored-workflow')
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
let archivedNotes = []
let resourceMode = 'source'
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
let workflowOperationsLoadSeq = 0
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
let workflowLoadPromise = null
let workflowLoadGeneration = -1
let workflowLoadProject = ''
let workflowRefreshQueued = false
let workflowViewGeneration = 0
let terminalActionPending = false
let chatSending = false
let chatAbortPending = false
let warmupStarting = false
let workflowPollTimer = null
let currentSSE = null
let refreshWorkflowTimer = null
let restorePromptProject = ''
let restorePromptResolve = null
let workflowAwaitingReply = false
let pendingUserText = ''
let activePermissionReviewID = ''
let permissionReplying = false
let maximizedPanel = ''
const workflowStatusById = new Map()
let workflowStatusAvailable = false
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

function cancelRestoreWorkflowPrompt() {
  const resolve = restorePromptResolve
  restorePromptResolve = null
  restoreWorkflowModal.classList.add('hidden')
  restoreWorkflowError.textContent = ''
  restoreWorkflowError.classList.add('hidden')
  btnDiscardRestoredWorkflow.disabled = false
  btnContinueRestoredWorkflow.disabled = false
  resolve?.('cancel')
}

function clearWorkflowView() {
  cancelRestoreWorkflowPrompt()
  workflowViewGeneration += 1
  workflowOperationsLoadSeq += 1
  workflowRefreshQueued = false
  if (workflowPollTimer) clearTimeout(workflowPollTimer)
  workflowPollTimer = null
  if (refreshWorkflowTimer) clearTimeout(refreshWorkflowTimer)
  refreshWorkflowTimer = null
  disconnectWorkflowSSE()
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
  workflowStatusAvailable = false
  resources = []
  archivedNotes = []
  selectedResourcePath = ''
  resourceLoading = false
  noteLoading = false
  workflowOperationsLoading = false
  workflowLoading = false
  resetPreviewRenderKey(notePreview)
  resetPreviewRenderKey(graphPreview)
  resetGraphPreview()
}

function workflowViewRequest(project = selectedProject()) {
  return {
    projectName: project?.name || '',
    generation: workflowViewGeneration,
  }
}

function isCurrentWorkflowViewRequest(request) {
  return workflowViewRequestMatches(request, workflowViewRequest())
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
  clearWorkflowView()
  render()
  await loadSelectedProjectView({ askRestore: true })
}

async function refreshProjectDirectories({ renderPage = true, request } = {}) {
  const selectedName = projectName
  const result = await fetchJson(API + '/project/directories') || []
  if (request && !isCurrentWorkflowViewRequest(request)) return
  projects = result
  if (selectedName && projects.some((project) => project.name === selectedName)) projectName = selectedName
  else if (projectName && !projects.some((project) => project.name === projectName)) projectName = ''
  if (!projectName && projects.length) projectName = projects[0].name
  if (renderPage) render()
  connectWorkflowSSE()
}

async function loadSelectedProjectView({ askRestore = false } = {}) {
  const project = selectedProject()
  if (!project) {
    renderWorkspace()
    return
  }

  disconnectWorkflowSSE()
  if (askRestore) {
    const request = workflowViewRequest(project)
    await refreshWorkflowStateOnly(project, request)
    if (!isCurrentWorkflowViewRequest(request)) return
    await maybeAskRestoreWorkflow()
  }

  const request = workflowViewRequest()
  if (!request.projectName) return
  connectWorkflowSSE()
  await Promise.all([
    loadWorkflow({ askRestore: false }),
    loadResources(request),
    loadWorkflowNote(request),
    loadWorkflowOperations(request),
  ])
}

async function loadWorkflowNote(request = workflowViewRequest()) {
  const project = selectedProject()
  if (!isCurrentWorkflowViewRequest(request)) return
  workflowNote = null
  if (!project) {
    renderNotes()
    return
  }
  noteLoading = true
  renderNotes()
  try {
    const result = await fetchJson(API + `/project/workflow/note?project=${encodeURIComponent(project.name)}`)
    if (!isCurrentWorkflowViewRequest(request)) return
    workflowNote = result || null
    if (result?.workflow) workflow = mergeWorkflowReadiness(workflow, result.workflow)
  } catch (error) {
    if (!isCurrentWorkflowViewRequest(request)) return
    workflowNote = { exists: false, content: '', error: error.message || '工作笔记加载失败' }
  } finally {
    if (!isCurrentWorkflowViewRequest(request)) return
    noteLoading = false
    renderWorkspace()
  }
}

async function loadWorkflowOperations(request = workflowViewRequest()) {
  const project = selectedProject()
  if (!isCurrentWorkflowViewRequest(request)) return
  const loadSeq = ++workflowOperationsLoadSeq
  if (!project) {
    workflowOperations = null
    renderOperationPreview()
    return
  }
  workflowOperationsLoading = true
  if (!workflowOperations) renderOperationPreview()
  try {
    const result = await fetchJson(API + `/project/workflow/operations?project=${encodeURIComponent(project.name)}`)
    if (loadSeq !== workflowOperationsLoadSeq || !isCurrentWorkflowViewRequest(request)) return
    workflowOperations = result || null
    if (result?.workflow) workflow = mergeWorkflowReadiness(workflow, result.workflow)
    if (activeTab === 'graph' && graphPreviewMode === 'map') {
      await ensureGraphPreviewLoaded().catch(() => {})
    }
  } catch (error) {
    if (loadSeq !== workflowOperationsLoadSeq || !isCurrentWorkflowViewRequest(request)) return
    workflowOperations = { files: [], error: error.message || '图操作草稿加载失败' }
  } finally {
    if (loadSeq !== workflowOperationsLoadSeq || !isCurrentWorkflowViewRequest(request)) return
    workflowOperationsLoading = false
    renderWorkspace()
  }
}

async function loadResources(request = workflowViewRequest()) {
  const project = selectedProject()
  if (!isCurrentWorkflowViewRequest(request)) return
  const previousResourcePath = selectedResourcePath
  resources = []
  archivedNotes = []
  selectedResourcePath = ''
  if (!project) {
    renderResources()
    return
  }
  resourceLoading = true
  renderResources()
  try {
    const [sourceResources, notes] = await Promise.all([
      fetchJson(API + `/project/source?project=${encodeURIComponent(project.name)}`),
      fetchJson(API + `/project/notes?project=${encodeURIComponent(project.name)}`),
    ])
    if (!isCurrentWorkflowViewRequest(request)) return
    resources = sourceResources || []
    archivedNotes = notes || []
    const visibleResources = resourceMode === 'notes' ? archivedNotes : resources
    if (previousResourcePath && visibleResources.some((resource) => resource.path === previousResourcePath)) {
      selectedResourcePath = previousResourcePath
    }
  } catch (error) {
    if (!isCurrentWorkflowViewRequest(request)) return
    resourcePreview.innerHTML = `<div class="placeholder">${esc(error.message || '资源加载失败')}</div>`
  } finally {
    if (!isCurrentWorkflowViewRequest(request)) return
    resourceLoading = false
    renderResources()
  }
}

async function loadWorkflow() {
  const project = selectedProject()
  const request = workflowViewRequest(project)
  if (!project) {
    workflow = null
    workflowMessages = []
    renderChat()
    return
  }
  if (
    workflowLoadPromise &&
    workflowLoadGeneration === request.generation &&
    workflowLoadProject === request.projectName
  ) {
    workflowRefreshQueued = true
    return workflowLoadPromise
  }

  const showLoading = !workflow
  if (showLoading) {
    workflowLoading = true
    renderChat()
  }

  const load = (async () => {
    try {
      const previousState = currentWorkflowState()
      const previousStage = previousState?.stage || ''
      const previousGraphInitialized = !!project.graphInitialized
      const [result, statusResult] = await Promise.all([
        fetchJson(API + `/project/workflow/messages?project=${encodeURIComponent(project.name)}`),
        fetchJson(API + `/session/status?directory=${encodeURIComponent(project.directory)}`)
          .then((statuses) => ({ available: true, statuses: statuses || {} }))
          .catch(() => ({ available: false, statuses: null })),
      ])
      if (!isCurrentWorkflowViewRequest(request)) return
      workflow = result?.workflow || null
      workflowMessages = result?.messages || []
      workflowStatusAvailable = statusResult.available
      if (statusResult.available) syncWorkflowStatuses(statusResult.statuses)
      await loadPendingWorkflowPermissions(request)
      if (!isCurrentWorkflowViewRequest(request)) return
      if (pendingUserText && workflowMessages.some((message) => visibleUserText(message) === pendingUserText)) {
        pendingUserText = ''
      }
      if (shouldClearWorkflowAwaitingReply({
        chatSending,
        sessionStatuses: [...workflowStatusById.values()],
        statusAvailable: workflowStatusAvailable,
        hasUnansweredUser: workflowHasUnansweredUser(),
      })) workflowAwaitingReply = false
      const nextState = currentWorkflowState()
      const nextStage = nextState?.stage || ''
      if (workflowOperationArtifactsChanged(previousState, nextState)) {
        await loadWorkflowOperations().catch(() => {})
      }
      const appliedOrArchived = (nextStage === '已应用' && previousStage !== '已应用') || (!!previousState && !nextState)
      if (appliedOrArchived) {
        await refreshProjectDirectories({ renderPage: false, request })
        if (!isCurrentWorkflowViewRequest(request)) return
        if (!previousGraphInitialized && selectedProject()?.graphInitialized) resetGraphPreview()
        await loadResources().catch(() => {})
        if (activeTab === 'graph') await ensureGraphPreviewLoaded({ force: true }).catch(() => {})
      }
    } catch (error) {
      if (!isCurrentWorkflowViewRequest(request)) return
      workflow = { ok: false, message: error.message || '工作推进状态加载失败' }
      workflowMessages = []
    } finally {
      if (isCurrentWorkflowViewRequest(request)) {
        if (showLoading) workflowLoading = false
        renderWorkspace()
        maybePollWorkflow()
      }
    }
  })()

  workflowLoadPromise = load
  workflowLoadGeneration = request.generation
  workflowLoadProject = request.projectName
  try {
    return await load
  } finally {
    if (workflowLoadPromise === load) {
      workflowLoadPromise = null
      workflowLoadGeneration = -1
      workflowLoadProject = ''
      if (workflowRefreshQueued && isCurrentWorkflowViewRequest(request)) {
        workflowRefreshQueued = false
        scheduleWorkflowRefresh()
      }
    }
  }
}

async function loadPendingWorkflowPermissions(request = workflowViewRequest()) {
  if (!isCurrentWorkflowViewRequest(request)) return
  const ids = workflowSessionIDs()
  if (!ids.size) {
    workflowPermissions = []
    workflowPermissionRecords = workflowPermissionRecords.filter((record) => record.status !== 'pending')
    return
  }
  const project = selectedProject()
  const permissions = await fetchJson(API + permissionListUrl(project)).catch(() => [])
  if (!isCurrentWorkflowViewRequest(request)) return
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
  const request = workflowViewRequest()
  if (
    workflowLoadPromise &&
    workflowLoadGeneration === request.generation &&
    workflowLoadProject === request.projectName
  ) {
    workflowRefreshQueued = true
    return
  }
  if (refreshWorkflowTimer) return
  refreshWorkflowTimer = setTimeout(async () => {
    refreshWorkflowTimer = null
    await loadWorkflow({ askRestore: false })
  }, 250)
}

function disconnectWorkflowSSE() {
  if (currentSSE) {
    currentSSE.close()
    currentSSE = null
  }
}

function connectWorkflowSSE() {
  disconnectWorkflowSSE()
  const project = selectedProject()
  if (!project) return
  const request = workflowViewRequest(project)
  const es = new EventSource(API + '/event?directory=' + encodeURIComponent(project.directory))
  es.onmessage = (event) => {
    if (currentSSE !== es || !isCurrentWorkflowViewRequest(request)) return
    try {
      handleWorkflowBusEvent(JSON.parse(event.data))
    } catch {}
  }
  es.onerror = () => {
    es.close()
    if (currentSSE === es) currentSSE = null
    setTimeout(() => {
      if (!currentSSE && isCurrentWorkflowViewRequest(request)) connectWorkflowSSE()
    }, 3000)
  }
  currentSSE = es
}

function workflowSessionIDs() {
  const state = currentWorkflowState()
  return new Set([state?.sessionID, state?.warmupSessionID].filter(Boolean))
}

function effectiveWarmupStatus(state = currentWorkflowState()) {
  return effectiveWorkflowWarmupStatus({
    persistedStatus: state?.warmupStatus,
    warmupStarting,
    statusAvailable: workflowStatusAvailable,
    sessionStatus: state?.warmupSessionID ? workflowStatusById.get(state.warmupSessionID) : undefined,
  })
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
  return API + `/project/workflow/graph?project=${encodeURIComponent(project.name)}&view=expanded`
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

function workflowPreviewDraftDetailUrlKeys() {
  const command = operationArtifactJson('operations')
  if (!Array.isArray(command?.operations)) return []
  return command.operations.flatMap((operation) => {
    if (operation?.type === 'create_node' && typeof operation.temp_id === 'string' && typeof operation.data?.detail_url === 'string') {
      return [graphDetailUrlKey(operation.temp_id, operation.data.detail_url)]
    }
    if (operation?.type === 'update_node' && typeof operation.node_id === 'string' && typeof operation.updates?.detail_url === 'string') {
      return [graphDetailUrlKey(operation.node_id, operation.updates.detail_url)]
    }
    return []
  })
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
    draftDetailUrlKeys: workflowPreviewDraftDetailUrlKeys(),
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
      projectName: project.name,
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
  if (terminalActionPending) return '另一个工作推进操作正在处理，请等待完成。'
  if (workflowLoadBlocksInteraction({ loading: workflowLoading, workflow })) return '工作推进状态仍在加载，请稍后再试。'
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
  const hasProject = !!project && !workflowLoadBlocksInteraction({ loading: workflowLoading, workflow }) && !terminalActionPending
  const running = workflowIsRunning()
  const terminalActionsBlocked = workflowTerminalActionsBlocked({
    runtimeRunning: running,
    persistedWarmupStatus: state?.warmupStatus,
  })
  const warmupRecoveryRequired = !running && state?.warmupStatus === 'running'
  if (btnDiscardWorkflow) {
    btnDiscardWorkflow.disabled = !hasProject
    btnDiscardWorkflow.title = state ? `当前阶段：${state.stage}` : '当前没有 active 工作推进草案'
  }
  if (btnApply) {
    const applyEntry = workflowActionEntry('应用图操作')
    const buttonState = workflowApplyButtonState({
      hasProject,
      terminalActionsBlocked,
      warmupRecoveryRequired,
      available: !!applyEntry.available,
      blockedReason: applyEntry.blocked?.reason || '',
      stage: state?.stage || '',
    })
    btnApply.disabled = buttonState.disabled
    btnApply.classList.toggle('pending-action', buttonState.pending)
    btnApply.title = buttonState.title
  }
  if (operationReviewWarning) {
    const reviewPending = state?.stage === '图操作待复核'
    const reviewed = !!workflowActionEntry('确认沿用现有图操作').available
    operationReviewWarning.classList.toggle('hidden', !reviewPending)
    operationReviewWarning.textContent = reviewPending
      ? reviewed
        ? '现有图操作已按最新工作笔记复核。请在聊天中明确选择沿用或调整；确认沿用后才可提交。'
        : '工作笔记已更新，现有图操作和预览已保留，正在等待只读复核；复核完成并经你确认前不能提交。'
      : ''
  }
  const correctionDisabled = !hasProject || terminalActionsBlocked
  if (btnHardCorrection) {
    btnHardCorrection.disabled = correctionDisabled
    btnHardCorrection.title = warmupRecoveryRequired
      ? '项目上下文预热已中断，请先重新预热再重做最近提交。'
      : terminalActionsBlocked
        ? '大模型、预热或工具审批仍在处理，暂不能重做最近提交。'
      : state
      ? '当前已有 active 草案；重做最近提交会先放弃当前草案。'
      : '恢复最近一次提交的草案，用提交前图数据生成更正预览。'
  }
  if (btnSoftCorrection) {
    btnSoftCorrection.disabled = correctionDisabled
    btnSoftCorrection.title = warmupRecoveryRequired
      ? '项目上下文预热已中断，请先重新预热再追加更正记录。'
      : terminalActionsBlocked
        ? '大模型、预热或工具审批仍在处理，暂不能追加更正记录。'
      : state
      ? '当前已有 active 草案；追加更正记录会先放弃当前草案。'
      : '新建一轮只追加更正记录的草案。'
  }
}

function setTerminalActionPending(pending) {
  terminalActionPending = pending
  updateTerminalActionButtons()
  renderNotes()
  renderChat()
}

async function refreshWorkflowStateOnly(project, request = workflowViewRequest(project)) {
  if (!project) return
  if (!isCurrentWorkflowViewRequest(request)) return
  workflowLoading = true
  updateTerminalActionButtons()
  try {
    const result = await fetchJson(API + `/project/workflow/state?project=${encodeURIComponent(project.name)}`)
    if (!isCurrentWorkflowViewRequest(request)) return
    workflow = result
  } finally {
    if (!isCurrentWorkflowViewRequest(request)) return
    workflowLoading = false
    renderWorkspace()
  }
}

async function maybeAskRestoreWorkflow() {
  const project = selectedProject()
  const request = workflowViewRequest(project)
  const state = currentWorkflowState()
  if (!project || !hasUnfinishedActiveWorkflow(state)) return
  if (restorePromptProject === project.name) return
  restorePromptProject = project.name

  const correctionType = workflowCorrectionKind(state)
  const discardNote = correctionType === 'hard'
    ? '这是硬更正草案；点击“放弃当前草案”只会放弃恢复出来的 active 现场，不保留本轮 note.md，正式图数据不会改变。'
    : correctionType === 'soft'
      ? '这是软更正草案；点击“放弃当前草案”会清空本轮更正 note.md 和图操作草案，不保留为普通推进笔记。'
      : '点击“放弃当前草案”会结束并删除本轮 active workflow，包括 state、图操作草案、校验、预览和聊天会话；如果已有工作笔记，会只保留 workflows/active/note.md 供下一轮重新开始使用。已写入的正式图数据不会删除。'
  let discardError = ''
  while (true) {
    restoreWorkflowSummary.textContent = `项目「${project.name}」存在未完成草案，当前阶段：${state.stage}。`
    restoreWorkflowPolicy.textContent = discardNote
    restoreWorkflowError.textContent = discardError
    restoreWorkflowError.classList.toggle('hidden', !discardError)
    btnDiscardRestoredWorkflow.disabled = false
    btnContinueRestoredWorkflow.disabled = false
    restoreWorkflowModal.classList.remove('hidden')
    let decisionResolve
    const decision = await new Promise((resolve) => {
      decisionResolve = resolve
      restorePromptResolve = resolve
      btnContinueRestoredWorkflow.focus()
    })
    if (restorePromptResolve === decisionResolve) restorePromptResolve = null
    if (!isCurrentWorkflowViewRequest(request)) return
    if (!shouldDiscardWorkflowFromRestoreChoice(decision)) {
      restoreWorkflowModal.classList.add('hidden')
      return
    }

    btnDiscardRestoredWorkflow.disabled = true
    btnContinueRestoredWorkflow.disabled = true
    try {
      await fetchJson(API + `/project/workflow/action?project=${encodeURIComponent(project.name)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: '放弃草案', payload: {} }),
      })
      if (!isCurrentWorkflowViewRequest(request)) return
      restoreWorkflowModal.classList.add('hidden')
      clearWorkflowView()
      renderWorkspace()
      return
    } catch (error) {
      if (!isCurrentWorkflowViewRequest(request)) return
      discardError = error.message || '放弃草案失败'
    }
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
    const status = part.state?.status
    const sessionID = part.sessionID || message?.info?.sessionID || message?.sessionID
    const sessionRunning = sessionID
      ? workflowStatusById.has(sessionID)
      : [...workflowStatusById.values()].some((item) => item.type === 'busy' || item.type === 'retry')
    return renderWorkflowToolPart(part, message, {
      interrupted: workflowStatusAvailable && (status === 'pending' || status === 'running') && !sessionRunning,
    })
  }
  return ''
}

function renderWorkflowMessage(message) {
  const role = message.info?.role || message.role || 'assistant'
  if (role !== 'user' && role !== 'assistant') return ''
  const parts = (message.parts || []).map((part) => renderMessagePart(part, message)).filter(Boolean).join('')
  const fallback = visibleMessageText(message)
  const error = role === 'assistant' ? workflowMessageErrorText(message.info?.error || message.error) : ''
  if (!parts && !fallback && !error) return ''
  const label = role === 'user' ? '你' : '大模型'
  const body = parts || (fallback
    ? `<div class="message-text">${esc(fallback)}</div>`
    : `<div class="message-text message-error">模型请求失败：${esc(error)}</div>`)
  return `
    <div class="workflow-message ${role === 'user' ? 'user' : 'assistant'}${error && !parts && !fallback ? ' error' : ''}">
      <div class="message-role">${label}</div>
      <div class="message-body">${body}</div>
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
  return workflowRuntimeIsRunning({
    warmupStatus: effectiveWarmupStatus(state),
    sessionStatuses: [...workflowStatusById.values()],
    statusAvailable: workflowStatusAvailable,
    statusRequired: workflowSessionIDs().size > 0,
    chatSending,
    awaitingReply: workflowAwaitingReply,
  })
}

function chatLockReason(project, state) {
  if (terminalActionPending) return '工作推进操作正在处理，请等待完成。'
  if (!workflowStatusAvailable && workflowSessionIDs().size > 0) return '暂时无法确认工作推进运行状态，正在重试。'
  const effectiveState = state?.warmupStatus === 'running'
    ? { ...state, warmupStatus: effectiveWarmupStatus(state) }
    : state
  return workflowChatLockReason({ project, workflow, state: effectiveState, loading: workflowLoading })
}

function renderChat() {
  const project = selectedProject()
  const state = currentWorkflowState()
  const currentWarmupStatus = effectiveWarmupStatus(state)
  const lockReason = chatLockReason(project, state)
  const running = workflowIsRunning()
  const chatSessionID = state?.sessionID || ''
  const abortControl = sessionAbortControl({
    sessionID: chatSessionID,
    status: chatSessionID ? workflowStatusById.get(chatSessionID) : undefined,
    pending: chatAbortPending,
  })
  updateTerminalActionButtons()
  const canChat = !!project && !running && !lockReason
  const canWarmup = !!project && !terminalActionPending && workflowStatusAvailable && currentWarmupStatus !== 'running'
  const hasNote = !!workflowNote?.exists
  const readyHint = !project
    ? '选择或新建项目后可以开始工作推进。'
    : !workflow?.baseIsEmpty
      ? hasNote
        ? '基于当前工作笔记继续补充、修改，或要求生成图操作草案。'
        : '描述本次推进、补充材料，或在工作笔记页签导入/人工修改笔记。'
      : '描述项目背景、目标、现状或已有笔记；也可以在工作笔记页签导入/人工修改。'

  btnChatSend.disabled = !canChat || !chatInput.value.trim()
  btnChatAbort.classList.toggle('hidden', !abortControl.visible)
  btnChatAbort.disabled = abortControl.disabled
  btnChatAbort.textContent = abortControl.label
  chatInput.disabled = !canChat
  chatInput.placeholder = lockReason || readyHint
  chatHint.textContent = lockReason
    ? lockReason
    : running
      ? '大模型正在处理，本轮回复完成后可以继续输入。'
      : ''

  const showWarmupControl = !!project && (!workflow?.baseIsEmpty || (!!state && !workflow?.sessionReady))
  btnWarmup.classList.toggle('hidden', !showWarmupControl)
  btnWarmup.disabled = !canWarmup
  btnWarmup.textContent = workflow?.baseIsEmpty
    ? '恢复推进会话'
    : state?.warmupStatus === 'completed' ? '重新预热项目上下文' : '开始项目上下文预热'
  const showWarmupStatus = showWarmupControl
  const warmupDisplayStatus = currentWarmupStatus
  warmupStatus.classList.toggle('hidden', !showWarmupStatus)
  const warmupPrefix = state?.correction ? '软更正：' : ''
  warmupStatus.textContent = showWarmupStatus
    ? workflow?.baseIsEmpty
      ? warmupStarting ? '正在恢复推进会话' : '空图无需预热，推进会话待恢复'
      : warmupPrefix + warmupStatusText(warmupDisplayStatus)
    : ''
  warmupStatus.dataset.status = warmupDisplayStatus || 'none'

  if (workflowLoadBlocksInteraction({ loading: workflowLoading, workflow }) && !workflowMessages.length) {
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
  if (btnResourceModeSource) btnResourceModeSource.classList.toggle('active', resourceMode === 'source')
  if (btnResourceModeNotes) btnResourceModeNotes.classList.toggle('active', resourceMode === 'notes')
  if (btnUploadResource) {
    btnUploadResource.disabled = !project || resourceLoading || resourceMode !== 'source'
    btnUploadResource.classList.toggle('hidden', resourceMode !== 'source')
  }
  if (!project) {
    resourcePreview.innerHTML = '<div class="placeholder">选择项目后可以上传和预览资源。</div>'
    resourceList.innerHTML = '<div class="placeholder">还没有项目。</div>'
    return
  }
  if (resourceLoading) {
    resourceList.innerHTML = '<div class="placeholder">正在加载资源...</div>'
    return
  }
  const visibleResources = resourceMode === 'notes' ? archivedNotes : resources
  const emptyPreview = resourceMode === 'notes'
    ? '图操作提交后，active 工作笔记会归档到 notes/，这里会展示过往工作笔记。'
    : '可以上传 txt、md、html、图片或其他附件；当前支持预览文本、Markdown、HTML 和常见图片。'
  const emptyList = resourceMode === 'notes' ? '还没有过往工作笔记。' : '还没有用户上传资料。'
  if (!visibleResources.length) {
    resourcePreview.innerHTML = `<div class="placeholder">${esc(emptyPreview)}</div>`
    resourceList.innerHTML = `<div class="placeholder">${esc(emptyList)}</div>`
    return
  }
  resourceList.innerHTML = visibleResources.map((resource) => {
    const fileMeta = `${formatBytes(resource.size)}${resource.previewable ? ' / 可预览' : ' / 附件'}`
    if (resourceMode === 'notes') {
      const detailText = resource.workTimestamp ? `${resource.workTimestamp} · ${fileMeta}` : fileMeta
      return renderResourceItem(resource, selectedResourcePath, archivedNoteProgressLabel(resource), {
        showDelete: false,
        detailText,
      })
    }
    return renderResourceItem(resource, selectedResourcePath, fileMeta)
  }).join('')
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
  const noteMutationBlocked = terminalActionPending || workflowIsRunning()
  if (btnImportNoteFile) btnImportNoteFile.disabled = !project || noteMutationBlocked || noteLoading || noteImporting
  if (btnPasteNote) btnPasteNote.disabled = !project || noteMutationBlocked || noteLoading || noteImporting
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
      <span>更新笔记后，完整图操作和预览会保留并重新复核，不完整产物会被清理。</span>
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
  const mode = state ? workflowModePresentation(state) : null
  workspaceSubtitle.textContent = `${project.name} / ${project.directory}`
  projectStatus.innerHTML = `
    <span class="badge ${ready ? 'ready' : 'pending'}">${ready ? '图数据已初始化' : '等待第一次图提交'}</span>
    ${mode ? `<span class="badge workflow-mode ${esc(mode.className)}" title="${esc(mode.title)}">${esc(mode.label)}</span>` : ''}
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
  if (terminalActionPending || workflowIsRunning()) {
    alert('大模型、预热或工具审批仍在处理，请等待完成后再修改工作笔记。')
    return
  }
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
  return confirm('保存后会替换当前工作笔记。已有完整图操作和预览将保留并重新复核，不完整产物会被清理。是否继续？')
}

async function importNoteFile(file) {
  const project = selectedProject()
  if (!project || !file) return
  if (terminalActionPending || workflowIsRunning()) {
    if (noteFile) noteFile.value = ''
    alert('大模型、预热或工具审批仍在处理，请等待完成后再修改工作笔记。')
    return
  }
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
    if (result?.workflow) workflow = mergeWorkflowReadiness(workflow, result.workflow)
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
  if (terminalActionPending || workflowIsRunning()) {
    showNoteImportError('大模型、预热或工具审批仍在处理，请等待完成后再修改工作笔记。')
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
    if (result?.workflow) workflow = mergeWorkflowReadiness(workflow, result.workflow)
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
  render()
  loadSelectedProjectView({ askRestore: true }).catch((error) => {
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
btnGraphRefresh.onclick = async () => {
  const project = selectedProject()
  const request = workflowViewRequest(project)
  const previousKey = graphPreviewKey(project)
  try {
    await loadWorkflowOperations(request)
    if (!isCurrentWorkflowViewRequest(request)) return
    if (workflowOperations?.error) throw new Error(workflowOperations.error)
    await ensureGraphPreviewLoaded({ force: previousKey === graphPreviewKey(project) })
  } catch (error) {
    graphError = error.message || '图谱预览加载失败'
    renderGraphPreview(selectedProject(), !!selectedProject()?.graphInitialized)
  }
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
  if (!project || terminalActionPending || workflowIsRunning()) return
  noteFile.click()
}
btnCancelNoteImport.onclick = closeNoteImportModal
btnConfirmNoteImport.onclick = () => importPastedNote().catch((error) => {
  showNoteImportError(error.message || '保存失败')
})
btnContinueRestoredWorkflow.onclick = () => restorePromptResolve?.('continue')
btnDiscardRestoredWorkflow.onclick = () => restorePromptResolve?.('discard')
document.addEventListener('keydown', (event) => {
  if (restoreWorkflowModal.classList.contains('hidden') || event.key !== 'Tab') return
  const buttons = [btnDiscardRestoredWorkflow, btnContinueRestoredWorkflow].filter((button) => !button.disabled)
  if (!buttons.length) {
    event.preventDefault()
    return
  }
  const first = buttons[0]
  const last = buttons[buttons.length - 1]
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
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
btnChatAbort.onclick = () => abortWorkflowChat().catch((error) => {
  alert(error.message || '中止会话失败')
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
  if (terminalActionPending) return
  const project = selectedProject()
  await refreshWorkflowStateOnly(project)
  const reason = workflowActionBlockedReason('放弃草案')
  if (reason) {
    alert(reason)
    return
  }
  const state = currentWorkflowState()
  const correctionType = workflowCorrectionKind(state)
  const notePolicy = correctionType === 'hard'
    ? '这是硬更正草案；放弃后只会删除恢复出来的 active 现场，不保留本轮 note.md，正式图数据不会改变。'
    : correctionType === 'soft'
      ? '这是软更正草案；放弃后会删除本轮更正 note.md、图操作草案、校验、预览和聊天会话，不保留为普通推进笔记。'
      : '这会结束并删除本轮 active workflow，包括 state、图操作草案、校验、预览和聊天会话；如果已有工作笔记，会只保留 workflows/active/note.md 供下一轮重新开始使用。已写入的正式图数据不会删除。'
  const ok = confirm(`确认放弃项目「${project.name}」的本轮工作推进草案吗？\n\n当前阶段：${state.stage}\n\n${notePolicy}`)
  if (!ok) return
  setTerminalActionPending(true)
  try {
    await fetchJson(API + `/project/workflow/action?project=${encodeURIComponent(project.name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: '放弃草案', payload: {} }),
    })
    clearWorkflowView()
    restorePromptProject = project.name
    await loadSelectedProjectView({ askRestore: false })
  } catch (error) {
    alert(error.message || '放弃草案失败')
  } finally {
    setTerminalActionPending(false)
  }
}

async function applyWorkflowFromButton() {
  if (terminalActionPending) return
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
  const mode = workflowModePresentation(state)
  const ok = confirm(`确认提交项目「${project.name}」的本轮图操作吗？\n\n当前模式：${mode.label}\n当前阶段：${state.stage}\n\n提交后将进入正式图数据写入流程。`)
  if (!ok) return
  setTerminalActionPending(true)
  try {
    const result = await fetchJson(API + `/project/workflow/action?project=${encodeURIComponent(project.name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: '应用图操作', payload: { confirm: true } }),
    })
    alert(result.message || '图操作已应用。')
    clearWorkflowView()
    await refreshProjectDirectories({ renderPage: false })
    await loadWorkflow({ askRestore: false })
    await Promise.all([
      loadResources(),
      loadWorkflowNote(),
      loadWorkflowOperations(),
    ])
    if (activeTab === 'graph') await ensureGraphPreviewLoaded({ force: true }).catch(() => {})
    render()
  } catch (error) {
    alert(error.message || '应用图操作失败')
    await loadWorkflow({ askRestore: false }).catch(() => {})
    await loadWorkflowOperations().catch(() => {})
  } finally {
    setTerminalActionPending(false)
  }
}

async function startCorrectionFromButton(kind) {
  if (terminalActionPending) return
  const project = selectedProject()
  if (!project) {
    alert('请先选择项目。')
    return
  }
  try {
    await refreshWorkflowStateOnly(project)
  } catch (error) {
    alert(error.message || '读取工作推进状态失败')
    return
  }
  if (terminalActionPending) return
  if (workflowIsRunning()) {
    alert('大模型、预热或工具审批仍在处理，请等待完成后再切换更正模式。')
    return
  }
  const state = currentWorkflowState()
  const isHard = kind === 'hard'
  const hasUnsubmittedWorkspace = !!state || !!workflowNote?.exists
  const replacementWarning = hasUnsubmittedWorkspace
    ? '当前存在未提交的工作现场；确认后会放弃它，未提交的工作笔记和 active 资源登记不会带入更正。\n\n'
    : ''
  const ok = confirm(isHard
    ? `确认重做项目「${project.name}」最近一次提交吗？\n\n${replacementWarning}这会恢复那次提交的草案现场，并使用提交前图数据生成更正预览；正式图数据现在不会改变，只有最终确认提交时才会替换。`
    : `确认为项目「${project.name}」追加更正记录吗？\n\n${replacementWarning}这会新建一轮 correction 草案，不回滚旧图数据，不修改旧历史；可以新增、更正或逻辑废弃节点和关系，最终会作为新的更正提交追加到图数据。`)
  if (!ok) return
  setTerminalActionPending(true)
  try {
    const result = await fetchJson(API + `/project/workflow/action?project=${encodeURIComponent(project.name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: isHard ? '重做最近提交' : '开始软更正', payload: { confirm: true } }),
    })
    alert(result.message || (isHard ? '已恢复最近提交草案。' : '已开始追加更正记录。'))
    clearWorkflowView()
    await loadSelectedProjectView({ askRestore: false })
  } catch (error) {
    alert(error.message || (isHard ? '重做最近提交失败' : '开始软更正失败'))
    await loadWorkflow({ askRestore: false }).catch(() => {})
    await loadWorkflowOperations().catch(() => {})
  } finally {
    setTerminalActionPending(false)
  }
}

btnDiscardWorkflow.onclick = () => discardWorkflowFromButton()
btnApply.onclick = () => applyWorkflowFromButton()
btnHardCorrection.onclick = () => startCorrectionFromButton('hard')
btnSoftCorrection.onclick = () => startCorrectionFromButton('soft')
btnResourceModeSource.onclick = () => {
  if (resourceMode === 'source') return
  resourceMode = 'source'
  selectedResourcePath = ''
  resourcePreview.innerHTML = '<div class="placeholder">选择用户上传资料进行预览。</div>'
  renderResources()
}
btnResourceModeNotes.onclick = () => {
  if (resourceMode === 'notes') return
  resourceMode = 'notes'
  selectedResourcePath = ''
  resourcePreview.innerHTML = '<div class="placeholder">选择过往工作笔记进行预览。</div>'
  renderResources()
}

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
    const endpoint = resourceMode === 'notes' || resourcePath.startsWith('notes/')
      ? '/project/notes/preview'
      : '/project/source/preview'
    const preview = await fetchJson(API + `${endpoint}?project=${encodeURIComponent(project.name)}&path=${encodeURIComponent(resourcePath)}`)
    if (preview.type === 'text') {
      resourcePreview.innerHTML = `<pre class="resource-preview-text">${esc(preview.content)}</pre>`
      return
    }
    if (preview.type === 'image') {
      const imageUrl = preview.imageUrl || preview.dataUrl || ''
      resourcePreview.innerHTML = `
        <div class="resource-preview-image-wrap">
          <img class="resource-preview-image" src="${esc(imageUrl)}" alt="${esc(preview.name || resourcePath)}">
        </div>
      `
      return
    }
    if (preview.type === 'html') {
      resourcePreview.innerHTML = `<iframe class="resource-preview-frame" sandbox srcdoc="${esc(preview.content || '')}" title="${esc(preview.name || resourcePath)}"></iframe>`
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
  if (!project || !text || terminalActionPending || chatSending) return
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
    await loadWorkflow({ askRestore: false }).catch(() => {})
    await loadWorkflowOperations().catch(() => {})
    throw error
  } finally {
    chatSending = false
    renderChat()
  }
}

async function abortWorkflowChat() {
  const project = selectedProject()
  const sessionID = currentWorkflowState()?.sessionID
  if (!project || !sessionID || chatAbortPending) return
  if (!sessionIsRunning(workflowStatusById.get(sessionID))) return

  chatAbortPending = true
  renderChat()
  try {
    await fetchJson(API + sessionAbortUrl(sessionID, project.directory), { method: 'POST' })
    updateWorkflowStatus(sessionID, { type: 'idle' })
    workflowAwaitingReply = false
    await loadWorkflow({ askRestore: false })
    await loadWorkflowOperations().catch(() => {})
  } finally {
    chatAbortPending = false
    renderChat()
  }
}

async function startWarmup() {
  const project = selectedProject()
  if (!project || terminalActionPending || warmupStarting) return
  const state = currentWorkflowState()
  const force = !!state
  if (force) {
    const message = workflow?.baseIsEmpty
      ? '将重新建立当前工作推进聊天会话；不会改变正式图数据或当前草案。是否继续？'
      : state.correction
        ? '重新预热会基于当前草案的固定图基线建立软更正上下文，并替换当前更正聊天会话；不会改变正式图数据或当前草案。是否继续？'
        : '重新预热会基于当前草案的固定图基线替换聊天会话；不会改变正式图数据，也不会清空工作笔记、资源或图操作草案。是否继续？'
    const ok = confirm(message)
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
