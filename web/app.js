const API = ''
const ALL_PROJECT = ''
const NEW_PROJECT = '__new__'

let currentSessionId = null
let currentSessionDir = null
let currentSSE = null
let sessionStatusById = {}
let projects = []
let selectedProjectDir = null
const SOURCE_ROOTS = ['notes/', 'nodes/', 'descriptions_output/', 'changes/']

// ── DOM refs ──────────────────────────────────────────────
const sessionList = document.getElementById('session-list')
const messages = document.getElementById('messages')
const chatTitle = document.getElementById('chat-title')
const chatDir = document.getElementById('chat-dir')
const input = document.getElementById('input')
const btnSend = document.getElementById('btn-send')
const btnAbort = document.getElementById('btn-abort')
const btnNew = document.getElementById('btn-new')
const projectSelect = document.getElementById('project-select')
const newSessionModal = document.getElementById('new-session-modal')
const newSessionProject = document.getElementById('new-session-project')
const newProjectNameWrap = document.getElementById('new-project-name-wrap')
const newProjectName = document.getElementById('new-project-name')
const newSessionError = document.getElementById('new-session-error')
const btnNewSessionCancel = document.getElementById('btn-new-session-cancel')
const btnNewSessionCreate = document.getElementById('btn-new-session-create')
const sourceViewerModal = document.getElementById('source-viewer-modal')
const sourceViewerPath = document.getElementById('source-viewer-path')
const sourceViewerContent = document.getElementById('source-viewer-content')
const btnCloseSourceViewer = document.getElementById('btn-close-source-viewer')

// ── API helpers ───────────────────────────────────────────
async function api(method, path, body) {
  const dir = currentSessionDir
  const sep = path.includes('?') ? '&' : '?'
  const url = API + path + (dir ? sep + 'directory=' + encodeURIComponent(dir) : '')
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw new Error(await res.text())
  if (res.status === 204 || res.headers.get('content-length') === '0') return null
  return res.json()
}

async function fetchJson(url, options) {
  const res = await fetch(url, options)
  if (!res.ok) throw new Error(await res.text())
  if (res.status === 204 || res.headers.get('content-length') === '0') return null
  return res.json()
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function isSourcePath(value) {
  if (!value || value.includes('..')) return false
  return SOURCE_ROOTS.some((prefix) => value.startsWith(prefix))
}

function wrapSourcePath(pathText) {
  return `<a href="#" class="source-path-link" data-source-path="${escHtml(pathText)}"><code>${escHtml(pathText)}</code></a>`
}

function renderAssistantMarkdown(markdown) {
  if (!markdown) return ''
  const placeholders = []
  const withCodePlaceholders = markdown.replace(/`([^`]+)`/g, (match, value) => {
    if (!isSourcePath(value)) return match
    const token = `@@SOURCE_${placeholders.length}@@`
    placeholders.push(wrapSourcePath(value))
    return token
  })
  const linked = withCodePlaceholders.replace(/(^|[^\w/>@])((?:notes|nodes|descriptions_output|changes)\/[^\s\]）；;，,`<]+)/g, (match, prefix, value) => {
    if (!isSourcePath(value)) return match
    const token = `@@SOURCE_${placeholders.length}@@`
    placeholders.push(wrapSourcePath(value))
    return prefix + token
  }).replace(/@@SOURCE_(\d+)@@/g, (match, index) => placeholders[Number(index)] || match)
  return marked.parse(linked)
}

async function openSourceViewer(sourcePath) {
  if (!currentSessionDir) throw new Error('当前会话没有项目目录')
  if (!isSourcePath(sourcePath)) return
  sourceViewerModal.classList.remove('hidden')
  sourceViewerPath.textContent = sourcePath
  sourceViewerContent.textContent = '加载中...'
  try {
    const result = await fetchJson(API + '/file/content?directory=' + encodeURIComponent(currentSessionDir) + '&path=' + encodeURIComponent(sourcePath))
    if (!result) {
      sourceViewerContent.textContent = '未返回内容'
      return
    }
    if (result.type === 'binary') {
      sourceViewerContent.textContent = '该文件不可作为文本预览'
      return
    }
    sourceViewerContent.textContent = result.content || ''
  } catch (error) {
    sourceViewerContent.textContent = error.message || '加载失败'
  }
}

function projectRootFromDir(directory) {
  if (!directory) return null
  const marker = '/project_graph_data/'
  const idx = directory.indexOf(marker)
  if (idx === -1) return null
  const rest = directory.slice(idx + marker.length)
  const [name] = rest.split('/').filter(Boolean)
  if (!name) return null
  return directory.slice(0, idx + marker.length + name.length)
}

function getProjectDirForDirectory(directory) {
  if (!directory) return null
  const matched = projects.find((project) =>
    directory === project.directory || directory.startsWith(project.directory + '/'))
  return matched?.directory || projectRootFromDir(directory)
}

function setSelectedProjectDir(directory) {
  selectedProjectDir = directory || null
  projectSelect.value = selectedProjectDir || ALL_PROJECT
}

function resetCurrentSession() {
  currentSessionId = null
  currentSessionDir = null
  messages.innerHTML = ''
  chatTitle.textContent = '选择或新建会话'
  chatDir.textContent = ''
  setStatus({ type: 'idle' })
  if (currentSSE) {
    currentSSE.close()
    currentSSE = null
  }
}

// ── Projects ───────────────────────────────────────────────
async function loadProjects() {
  projects = await fetchJson(API + '/project/directories') || []
  renderProjectSelect()
  renderNewSessionProjectOptions()
}

function renderProjectSelect() {
  projectSelect.innerHTML = ''
  const all = document.createElement('option')
  all.value = ALL_PROJECT
  all.textContent = 'ALL'
  projectSelect.appendChild(all)
  for (const project of projects) {
    const opt = document.createElement('option')
    opt.value = project.directory
    opt.textContent = project.name
    projectSelect.appendChild(opt)
  }
  projectSelect.value = selectedProjectDir || ALL_PROJECT
}

function renderNewSessionProjectOptions() {
  newSessionProject.innerHTML = ''
  for (const project of projects) {
    const opt = document.createElement('option')
    opt.value = project.directory
    opt.textContent = project.name
    newSessionProject.appendChild(opt)
  }
  const newOpt = document.createElement('option')
  newOpt.value = NEW_PROJECT
  newOpt.textContent = '新建项目'
  newSessionProject.appendChild(newOpt)
}

projectSelect.onchange = async () => {
  setSelectedProjectDir(projectSelect.value || null)
  await loadSessions({ keepSelection: false })
}

function syncProjectFilterWithSession(directory) {
  const projectDir = getProjectDirForDirectory(directory)
  setSelectedProjectDir(projectDir)
}

// ── Sessions ──────────────────────────────────────────────
async function loadSessionStatuses() {
  const res = await fetch(API + '/session/status')
  if (!res.ok) throw new Error(await res.text())
  sessionStatusById = await res.json() || {}
}

async function loadSessions(options = {}) {
  const keepSelection = options.keepSelection !== false
  const url = selectedProjectDir
    ? API + '/session?directory=' + encodeURIComponent(selectedProjectDir)
    : API + '/session?global=true'
  const sessions = await fetchJson(url) || []

  if (!keepSelection && currentSessionId) {
    const current = sessions.find((session) => session.id === currentSessionId)
    if (!current) resetCurrentSession()
  }

  sessionList.innerHTML = ''
  const roots = sessions.filter(s => !s.parentID)
  const byParent = {}
  for (const s of sessions) {
    if (s.parentID) (byParent[s.parentID] = byParent[s.parentID] || []).push(s)
  }
  let visibleCurrent = false
  function renderSession(s, indent) {
    if (s.id === currentSessionId) visibleCurrent = true
    const el = document.createElement('div')
    el.className = 'session-item' + (s.id === currentSessionId ? ' active' : '') + (indent ? ' child' : '')
    el.textContent = (indent ? '↳ ' : '') + (s.title || s.id.slice(0, 8))
    el.dataset.id = s.id
    el.onclick = () => selectSession(s.id, s.title || s.id.slice(0, 8), s.directory)
    sessionList.appendChild(el)
    for (const child of byParent[s.id] || []) renderSession(child, true)
  }
  for (const s of roots) renderSession(s, false)
  if (keepSelection && currentSessionId && !visibleCurrent) resetCurrentSession()
}

async function selectSession(id, title, directory) {
  currentSessionId = id
  currentSessionDir = directory || null
  syncProjectFilterWithSession(directory)
  chatTitle.textContent = title
  chatDir.textContent = directory || ''
  await loadSessionStatuses().catch(() => {})
  setStatus(sessionStatusById[id] || { type: 'idle' })
  connectSSE()
  await loadSessions()
  await loadMessages(id)
  await loadPendingInteractions(id).catch(() => {})
}

function openNewSessionModal() {
  renderNewSessionProjectOptions()
  newSessionProject.value = projects[0]?.directory || NEW_PROJECT
  newProjectName.value = ''
  hideNewSessionError()
  updateNewProjectInputVisibility()
  newSessionModal.classList.remove('hidden')
}

function closeNewSessionModal() {
  newSessionModal.classList.add('hidden')
}

function showNewSessionError(message) {
  newSessionError.textContent = message
  newSessionError.classList.remove('hidden')
}

function hideNewSessionError() {
  newSessionError.textContent = ''
  newSessionError.classList.add('hidden')
}

function updateNewProjectInputVisibility() {
  newProjectNameWrap.classList.toggle('hidden', newSessionProject.value !== NEW_PROJECT)
}

async function createProject(name) {
  return fetchJson(API + '/project/directories', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
}

async function createSessionForDirectory(directory) {
  return fetchJson(API + '/session?directory=' + encodeURIComponent(directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
}

btnNew.onclick = openNewSessionModal
btnNewSessionCancel.onclick = closeNewSessionModal
newSessionProject.onchange = updateNewProjectInputVisibility
newSessionModal.onclick = (e) => {
  if (e.target === newSessionModal) closeNewSessionModal()
}

btnNewSessionCreate.onclick = async () => {
  hideNewSessionError()
  try {
    let projectDir = newSessionProject.value
    if (!projectDir) {
      showNewSessionError('请先选择一个项目')
      return
    }
    if (projectDir === NEW_PROJECT) {
      const name = newProjectName.value.trim()
      if (!name) {
        showNewSessionError('请输入项目名')
        return
      }
      const created = await createProject(name)
      await loadProjects()
      projectDir = created.directory
    }
    const session = await createSessionForDirectory(projectDir)
    setSelectedProjectDir(projectDir)
    closeNewSessionModal()
    await loadSessions()
    await selectSession(session.id, session.title || session.id.slice(0, 8), session.directory)
  } catch (error) {
    showNewSessionError(error.message || '创建失败')
  }
}

// ── Messages ──────────────────────────────────────────────
async function loadMessages(sessionId) {
  messages.innerHTML = ''
  const data = await api('GET', `/session/${sessionId}/message`)
  for (const msg of data) {
    const info = msg.info || msg
    const parts = msg.parts || []
    if (!info.role || info.role === 'tool') continue
    ensureMessageContainer(info)
    if (info.role === 'user') {
      const text = parts.filter(p => p.type === 'text').map(p => p.text).join('')
      const el = messages.querySelector(`[data-id="${info.id}"]`)
      if (el) el.textContent = text
    } else {
      for (const part of parts) upsertPart(info.id, part)
      renderMessageError(info)
    }
  }
  scrollBottom()
}

function ensureMessageContainer(info) {
  if (messages.querySelector(`[data-id="${info.id}"]`)) return
  const el = document.createElement('div')
  el.className = `msg ${info.role}`
  el.dataset.id = info.id
  messages.appendChild(el)
}

function errorText(error) {
  if (!error) return ''
  if (typeof error === 'string') return error
  const data = error.data && typeof error.data === 'object' ? error.data : null
  return data?.message || error.message || error.code || error.name || 'error'
}

function renderMessageError(info) {
  if (!info?.error) return
  const el = messages.querySelector(`[data-id="${info.id}"]`)
  if (!el) return
  el.classList.add('error')
  el.textContent = errorText(info.error)
}

function upsertMessage(event) {
  const info = event.info || event
  if (!info.role || info.role === 'tool') return
  ensureMessageContainer(info)
  renderMessageError(info)
}

function renderSessionError(error) {
  if (!error || !currentSessionId) return
  const el = document.createElement('div')
  el.className = 'msg assistant error'
  el.textContent = errorText(error)
  messages.appendChild(el)
  scrollBottom()
}

function isCurrentStreaming() {
  const status = currentSessionId ? sessionStatusById[currentSessionId] : null
  return status?.type === 'busy' || status?.type === 'retry'
}

function upsertTextSnapshot(messageId, part) {
  const container = messages.querySelector(`[data-id="${messageId}"]`)
  if (!container) return
  let el = container.querySelector(`[data-part-id="${part.id}"]`)
  if (!el) {
    el = document.createElement('div')
    el.dataset.partId = part.id
    el.className = 'part-text'
    el.dataset.raw = ''
    container.appendChild(el)
  }

  const next = part.text || ''
  if (isCurrentStreaming()) {
    const raw = el.dataset.raw || ''
    if (next.length < raw.length && raw.startsWith(next)) return
    el.dataset.raw = next
    pendingDeltas.set(part.id, { el, text: next })
    scheduleDeltaFlush()
    return
  }

  el.className = 'part-text'
  el.innerHTML = renderAssistantMarkdown(next)
  el.dataset.raw = next
}

function upsertPart(messageId, part) {
  if (part.type === 'text') {
    upsertTextSnapshot(messageId, part)
    if (isCurrentStreaming()) ensureOutputCursor()
    return
  }
  const container = messages.querySelector(`[data-id="${messageId}"]`)
  if (!container) return
  const existing = container.querySelector(`[data-part-id="${part.id}"]`)
  if (existing) {
    updatePartEl(existing, part)
  } else {
    const el = createPartEl(part)
    if (el) container.appendChild(el)
  }
  if (isCurrentStreaming()) ensureOutputCursor()
}

// ── Delta flush (throttle DOM updates) ───────────────────
const pendingDeltas = new Map()
let flushTimer = null

function scheduleDeltaFlush() {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    for (const [, { el, text }] of pendingDeltas) {
      el.textContent = text
    }
    pendingDeltas.clear()
    scrollBottom()
  }, 50)
}

function applyPartDelta(messageId, partId, field, delta) {
  const container = messages.querySelector(`[data-id="${messageId}"]`)
  if (!container) return
  let el = container.querySelector(`[data-part-id="${partId}"]`)
  if (!el) {
    el = document.createElement('div')
    el.dataset.partId = partId
    el.className = 'part-text'
    el.dataset.raw = ''
    container.appendChild(el)
  }
  if (el.classList.contains('part-text')) {
    el.dataset.raw = (el.dataset.raw || '') + delta
    pendingDeltas.set(partId, { el, text: el.dataset.raw })
    scheduleDeltaFlush()
  } else {
    const target = el.querySelector('[data-delta]')
    if (target) target.textContent += delta
  }
  if (isCurrentStreaming()) ensureOutputCursor()
}

function createPartEl(part) {
  const el = document.createElement('div')
  el.dataset.partId = part.id
  updatePartEl(el, part)
  return el.children.length || el.textContent ? el : null
}

function updatePartEl(el, part) {
  if (part.type === 'text') {
    const text = part.text || ''
    el.className = 'part-text'
    if (isCurrentStreaming()) {
      el.dataset.raw = text
      pendingDeltas.set(part.id, { el, text })
      scheduleDeltaFlush()
    } else {
      el.innerHTML = renderAssistantMarkdown(text)
      el.dataset.raw = text
    }
    el.dataset.delta = ''
  } else if (part.type === 'reasoning') {
    const text = part.text || ''
    if (!text || text.includes('[REDACTED]')) return
    el.className = 'part-reasoning'
    el.innerHTML = `<div class="reasoning-label">Thinking</div><pre data-delta>${escHtml(text)}</pre>`
  } else if (part.type === 'tool') {
    renderToolPart(el, part)
  } else if (part.type === 'patch') {
    el.className = 'part-patch'
    el.textContent = (part.files || []).join('  ')
  } else if (part.type === 'step-finish') {
    el.className = 'part-step-finish'
    const t = part.tokens || {}
    el.textContent = `tokens: ${(t.input || 0) + (t.output || 0)}  cost: $${(part.cost || 0).toFixed(4)}`
  }
}

function renderToolPart(el, part) {
  const state = part.state || {}
  const status = state.status || 'pending'
  const toolName = part.tool || 'tool'

  if (toolName === 'task') {
    el.className = `part-tool task ${status}`
    if (status === 'pending' || status === 'running') {
      const subtitle = state.title ? ` · ${escHtml(state.title)}` : ''
      el.innerHTML = `<div class="task-running">↳ Subagent running${subtitle}<span class="spinner"></span></div>`
    } else if (status === 'completed') {
      const start = state.time?.start || 0
      const end = state.time?.end || 0
      const dur = end && start ? formatDuration(end - start) : ''
      const sessionId = state.metadata?.sessionId || part.metadata?.sessionId
      el.innerHTML = `<div class="task-done">└ Subagent completed${dur ? ' · ' + dur : ''}${sessionId ? ` <a class="task-link" data-session="${escHtml(sessionId)}">view</a>` : ''}</div>`
      const link = el.querySelector('.task-link')
      if (link) link.onclick = async () => {
        const sid = link.dataset.session
        const s = await api('GET', `/session/${sid}`)
        if (s) selectSession(s.id, s.title || s.id.slice(0, 8), s.directory)
      }
    } else {
      el.innerHTML = `<div class="task-error">✗ Subagent failed: ${escHtml(state.error || 'error')}</div>`
    }
    return
  }

  if (toolName === 'todowrite' && status === 'completed') {
    const todos = state.metadata?.todos || part.metadata?.todos || []
    if (todos.length) {
      el.className = 'part-tool todo-list completed'
      const items = todos.map(t => {
        const mark = t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '•' : ' '
        const cls = t.status === 'in_progress' ? 'todo-inprogress' : 'todo-other'
        return `<div class="todo-item ${cls}"><span class="todo-mark">[${mark}]</span> ${escHtml(t.content)}</div>`
      }).join('')
      el.innerHTML = `<div class="todo-title">Todos</div>${items}`
      return
    }
  }

  el.className = `part-tool ${status}`
  const label = state.title || toolName
  if (status === 'pending' || status === 'running') {
    el.innerHTML = `<div>▶ ${escHtml(label)}</div>`
  } else if (status === 'completed') {
    el.innerHTML = `<details><summary>✓ ${escHtml(label)}</summary><pre>${escHtml(String(state.output || ''))}</pre></details>`
  } else {
    el.innerHTML = `<div>✗ ${escHtml(toolName)}: ${escHtml(state.error || 'error')}</div>`
  }
}

function formatDuration(ms) {
  if (ms < 1000) return ms + 'ms'
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's'
  return Math.floor(ms / 60000) + 'm ' + Math.floor((ms % 60000) / 1000) + 's'
}

function renderMessage(msg) {
  const info = msg.info || msg
  const parts = msg.parts || []
  if (!info.role || info.role === 'tool') return
  ensureMessageContainer(info)
  if (info.role === 'user') {
    const text = parts.filter(p => p.type === 'text').map(p => p.text).join('')
    const el = messages.querySelector(`[data-id="${info.id}"]`)
    if (el) el.textContent = text
  } else {
    for (const part of parts) upsertPart(info.id, part)
  }
}

messages.onclick = async (event) => {
  const link = event.target.closest('[data-source-path]')
  if (!link) return
  event.preventDefault()
  await openSourceViewer(link.dataset.sourcePath || '')
}

btnCloseSourceViewer.onclick = () => {
  sourceViewerModal.classList.add('hidden')
}

sourceViewerModal.onclick = (event) => {
  if (event.target === sourceViewerModal) {
    sourceViewerModal.classList.add('hidden')
  }
}

function scrollBottom() { messages.scrollTop = messages.scrollHeight }

function ensureOutputCursor() {
  let el = messages.querySelector('.output-cursor')
  if (!el) {
    el = document.createElement('div')
    el.className = 'output-cursor'
    el.textContent = '运行中'
  }
  messages.appendChild(el)
  return el
}

function removeOutputCursor() {
  messages.querySelector('.output-cursor')?.remove()
}

// ── Send message ───────────────────────────────────────────
async function sendMessage() {
  const text = input.value.trim()
  if (!text || btnSend.disabled) return

  if (!currentSessionId) {
    openNewSessionModal()
    return
  }

  input.value = ''
  const dir = currentSessionDir
  const url = API + `/session/${currentSessionId}/prompt_async` + (dir ? '?directory=' + encodeURIComponent(dir) : '')
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parts: [{ type: 'text', text }] }),
  })
}

btnSend.onclick = sendMessage
btnAbort.onclick = async () => {
  if (currentSessionId) await api('POST', `/session/${currentSessionId}/abort`, {})
}
input.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() }
})

// ── Session status ────────────────────────────────────────
function setStatus(status) {
  const nextStreaming = status.type === 'busy' || status.type === 'retry'

  if (nextStreaming) {
    btnSend.disabled = true
    input.disabled = true
    btnAbort.classList.remove('hidden')
    ensureOutputCursor()
    scrollBottom()
  } else {
    btnSend.disabled = false
    input.disabled = false
    btnAbort.classList.add('hidden')
    removeOutputCursor()
  }
}

// ── SSE events ────────────────────────────────────────────
function connectSSE() {
  if (currentSSE) { currentSSE.close(); currentSSE = null }
  const dir = currentSessionDir
  const url = API + '/event' + (dir ? '?directory=' + encodeURIComponent(dir) : '')
  const es = new EventSource(url)
  es.onmessage = e => { try { handleBusEvent(JSON.parse(e.data)) } catch {} }
  es.onerror = () => { es.close(); currentSSE = null; setTimeout(connectSSE, 3000) }
  currentSSE = es
}

function handleBusEvent(event) {
  if (!event?.type) return
  if (event.type === 'session.updated') loadSessions()
  if (event.type === 'session.status' && event.properties?.sessionID) {
    const sid = event.properties.sessionID
    const status = event.properties.status || { type: 'idle' }
    const wasStreaming = sid === currentSessionId && isCurrentStreaming()
    if (status.type === 'idle') delete sessionStatusById[sid]
    else sessionStatusById[sid] = status
    if (sid === currentSessionId) {
      setStatus(status)
      if (wasStreaming && status.type === 'idle') loadMessages(currentSessionId).catch(() => {})
    }
  }
  if (event.type === 'message.updated' && event.properties?.info?.sessionID === currentSessionId)
    upsertMessage(event.properties)
  if (event.type === 'message.part.updated' && event.properties?.part?.sessionID === currentSessionId)
    upsertPart(event.properties.part.messageID, event.properties.part)
  if (event.type === 'message.part.delta' && event.properties?.sessionID === currentSessionId)
    applyPartDelta(event.properties.messageID, event.properties.partID, event.properties.field, event.properties.delta)
  if (event.type === 'permission.asked' && event.properties?.sessionID === currentSessionId)
    renderPermissionCard(event.properties)
  if (event.type === 'question.asked' && event.properties?.sessionID === currentSessionId)
    renderQuestionCard(event.properties)
  if (event.type === 'session.error' && event.properties?.sessionID === currentSessionId)
    renderSessionError(event.properties.error)
}

// ── Interaction cards ─────────────────────────────────────
async function loadPendingInteractions(sessionId) {
  const [perms, questions] = await Promise.all([
    api('GET', '/permission'),
    api('GET', '/question'),
  ])
  for (const p of perms.filter(p => p.sessionID === sessionId)) renderPermissionCard(p)
  for (const q of questions.filter(q => q.sessionID === sessionId)) renderQuestionCard(q)
}

function renderPermissionCard(req) {
  if (messages.querySelector(`[data-req-id="${req.id}"]`)) return
  const card = document.createElement('div')
  card.className = 'interaction-card'
  card.dataset.reqId = req.id
  const body = req.metadata?.description || JSON.stringify(req.metadata, null, 2)
  card.innerHTML = `<div class="card-title">Permission Request</div>
    <pre class="card-body">${escHtml(body)}</pre>
    <div class="card-actions">
      <button onclick="replyPermission('${req.id}','once')">Allow Once</button>
      <button onclick="replyPermission('${req.id}','always')">Always Allow</button>
      <button class="deny" onclick="replyPermission('${req.id}','reject')">Deny</button>
    </div>`
  messages.appendChild(card)
  scrollBottom()
}

function renderQuestionCard(req) {
  if (messages.querySelector(`[data-req-id="${req.id}"]`)) return
  const card = document.createElement('div')
  card.className = 'interaction-card'
  card.dataset.reqId = req.id
  const inner = req.questions.map((q, i) => {
    const btns = q.options.map(opt => {
      const btn = document.createElement('button')
      btn.textContent = opt.label
      btn.onclick = () => replyQuestion(req.id, i, opt.label, req.questions.length)
      return btn.outerHTML
    }).join('')
    return `<div class="card-title">${escHtml(q.header)}</div>
      <div class="card-body">${escHtml(q.question)}</div>
      <div class="card-actions">${btns}</div>`
  }).join('')
  card.innerHTML = inner
  req.questions.forEach((q, i) => {
    const actions = card.querySelectorAll('.card-actions')[i]
    q.options.forEach((opt, j) => {
      actions.children[j].onclick = () => replyQuestion(req.id, i, opt.label, req.questions.length)
    })
  })
  messages.appendChild(card)
  scrollBottom()
}

async function replyPermission(id, reply) {
  await api('POST', `/permission/${id}/reply`, { reply })
  document.querySelector(`[data-req-id="${id}"]`)?.remove()
}

async function replyQuestion(id, questionIndex, label, totalQuestions) {
  const answers = Array.from({ length: totalQuestions }, (_, i) => i === questionIndex ? [label] : [])
  await api('POST', `/question/${id}/reply`, { answers })
  document.querySelector(`[data-req-id="${id}"]`)?.remove()
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// ── Init ──────────────────────────────────────────────────
Promise.resolve()
  .then(async () => {
    await loadProjects()
    await loadSessionStatuses().catch(() => {})
    await loadSessions()
  })
  .finally(() => connectSSE())
