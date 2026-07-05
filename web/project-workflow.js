import {
  allWorkflowDiffRecords as collectWorkflowDiffRecords,
  esc,
  markWorkflowPermissionRecord as markWorkflowPermissionRecords,
  mergeWorkflowPermissionRecords as mergeWorkflowPermissionRecordList,
  permissionListUrl,
  permissionReplyUrl,
  renderResourceItem,
  renderWorkflowToolPart,
  resetWorkflowViewState,
  upsertWorkflowPermissionRecord as upsertWorkflowPermissionRecordList,
  workflowPermissionDiff,
  workflowPermissionFile,
  workflowPermissionStatusText,
  workflowPermissionTitle,
} from './project-workflow-view.js'

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
const notePreview = document.getElementById('note-preview')
const resourcePreview = document.getElementById('resource-preview')
const chatLog = document.getElementById('chat-log')
const chatHint = document.getElementById('chat-hint')
const chatInput = document.getElementById('chat-input')
const btnChatSend = document.getElementById('btn-chat-send')
const btnWarmup = document.getElementById('btn-warmup')
const operationList = document.getElementById('operation-list')
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
const noteImportTitle = document.getElementById('note-import-title')
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
let activeTab = 'graph'
let resources = []
let workflowNote = null
let selectedResourcePath = ''
let resourceLoading = false
let noteLoading = false
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
const workflowStatusById = new Map()
const shownPermissionModalIds = new Set()

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

function clearWorkflowView() {
  const reset = resetWorkflowViewState()
  workflow = reset.workflow
  workflowNote = reset.workflowNote
  workflowMessages = reset.workflowMessages
  workflowPermissions = reset.workflowPermissions
  workflowPermissionRecords = reset.workflowPermissionRecords
  pendingUserText = reset.pendingUserText
  activePermissionReviewID = reset.activePermissionReviewID
  shownPermissionModalIds.clear()
  workflowAwaitingReply = reset.workflowAwaitingReply
  workflowStatusById.clear()
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
    event.preventDefault()
    dragging = true
    layout.classList.add('resizing')
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  })
}

async function loadProjects() {
  projects = await fetchJson(API + '/project/directories') || []
  if (projectName && !projects.some((project) => project.name === projectName)) projectName = ''
  if (!projectName && projects.length) projectName = projects[0].name
  render()
  connectWorkflowSSE()
  await Promise.all([loadWorkflow({ askRestore: true }), loadResources(), loadWorkflowNote()])
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
}

function emptyMaterialState(message) {
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
    btnApply.classList.toggle('pending-action', state?.stage === '预览已生成')
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

  const ok = confirm(`检测到项目「${project.name}」有未完成的工作推进草案，当前阶段：${state.stage}。是否恢复上次操作？\n\n选择“确定”会恢复本轮 active workflow。\n选择“取消”会放弃当前图操作草案、校验、预览和聊天会话；如果已有工作笔记，会保留 workflows/active/note.md。已写入的正式图数据不会删除。`)
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
  permissionReviewDiff.textContent = record.diff || workflowPermissionDiff(record)
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
    notePreview.innerHTML = '<div class="placeholder">选择项目后可以导入、粘贴或生成工作笔记。</div>'
    noteList.innerHTML = '<div class="placeholder">还没有项目。</div>'
    return
  }
  if (noteLoading) {
    notePreview.innerHTML = '<div class="placeholder">正在加载工作笔记...</div>'
    noteList.innerHTML = '<div class="placeholder">正在加载...</div>'
    return
  }
  if (workflowNote?.error) {
    notePreview.innerHTML = `<div class="placeholder">${esc(workflowNote.error)}</div>`
    noteList.innerHTML = '<div class="placeholder">加载失败。</div>'
    return
  }
  if (!workflowNote?.exists) {
    notePreview.innerHTML = `
      <div class="note-empty">
        <h4>还没有工作笔记</h4>
        <p>工作笔记可以人工导入，也可以让 AI 根据对话整理生成；导入后仍可继续让 AI 辅助修改。</p>
      </div>
    `
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
  notePreview.innerHTML = `<pre class="note-content">${esc(workflowNote.content || '')}</pre>`
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
  const state = currentWorkflowState()
  workspaceSubtitle.textContent = `${project.name} / ${project.directory}`
  projectStatus.innerHTML = `
    <span class="badge ${ready ? 'ready' : 'pending'}">${ready ? '图数据已初始化' : '等待第一次图提交'}</span>
    ${state ? `<span class="badge workflow-stage">${esc(state.stage)}</span>` : ''}
  `
  btnDetail.disabled = !ready
  btnGraph.disabled = !ready
  updateTerminalActionButtons()
  graphPreview.innerHTML = ready
    ? '<div class="placeholder">后续这里显示当前项目图谱，并叠加本次工作推进草案的新增/更新节点和边。</div>'
    : '<div class="placeholder">项目目录已创建。第一次图数据提交前，这里将展示项目初始化 Skill 生成的初始图草案。</div>'
  operationList.innerHTML = ready
    ? '<div class="placeholder">后续这里显示本次推进生成的图操作索引，点击后图谱预览会定位到对应节点或边。</div>'
    : '<div class="placeholder">等待项目初始化 Skill 生成第一批图操作：初始事件/目标/工作块/工作项等。</div>'
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
  noteImportTitle.value = workflowNote?.exists ? '人工修改工作笔记' : ''
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
  const title = noteImportTitle.value.trim()
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
    body: JSON.stringify({ content, title: title || undefined }),
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
  render()
  connectWorkflowSSE()
  Promise.all([loadWorkflow({ askRestore: true }), loadResources(), loadWorkflowNote()]).catch((error) => {
    chatLog.innerHTML = `<div class="placeholder">${esc(error.message || '加载失败')}</div>`
  })
}
for (const button of tabButtons) {
  button.onclick = () => setActiveTab(button.dataset.tab)
}
btnNewProject.onclick = openModal
btnDetail.onclick = () => {
  const project = selectedProject()
  if (project?.graphInitialized) location.href = projectDetailUrl(project)
}
btnGraph.onclick = () => {
  const project = selectedProject()
  if (project?.graphInitialized) location.href = projectGraphUrl(project)
}
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
  const ok = confirm(`确认放弃项目「${project.name}」的本轮工作推进草案吗？\n\n当前阶段：${state.stage}\n\n这会清空当前图操作草案、校验、预览和聊天会话；如果已有工作笔记，会保留 workflows/active/note.md。已写入的正式图数据不会删除。`)
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
  alert('确认提交入口已预留。当前版本尚未实现正式写入图数据，请先继续审核图操作草案。')
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
