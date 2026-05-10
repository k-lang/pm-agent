const API = ''
const params = new URLSearchParams(location.search)
const projectDir = params.get('directory') || ''

const projectDirEl = document.getElementById('project-dir')
const summaryStatusEl = document.getElementById('summary-status')
const summaryEditor = document.getElementById('summary-editor')
const summaryPreview = document.getElementById('summary-preview')
const qaMeta = document.getElementById('qa-meta')
const questionListMetaEl = document.getElementById('question-list-meta')
const questionListEl = document.getElementById('question-list')
const messagesEl = document.getElementById('messages')
const questionInput = document.getElementById('question-input')
const btnAsk = document.getElementById('btn-ask')
const btnFollowup = document.getElementById('btn-followup')
const btnCollapseProcess = document.getElementById('btn-collapse-process')
const btnExpandProcess = document.getElementById('btn-expand-process')
const btnRerun = document.getElementById('btn-rerun')
const btnEditSummary = document.getElementById('btn-edit-summary')
const btnSaveSummary = document.getElementById('btn-save-summary')
const btnCancelSummary = document.getElementById('btn-cancel-summary')
const btnBack = document.getElementById('btn-back')
const sourceViewerModal = document.getElementById('source-viewer-modal')
const sourceViewerPath = document.getElementById('source-viewer-path')
const sourceViewerContent = document.getElementById('source-viewer-content')
const btnCloseSourceViewer = document.getElementById('btn-close-source-viewer')

let detail = null
let currentSummarySessionId = null
let currentQuestionSessionId = null
let currentSSE = null
let selectedQuestionId = null
let currentQuestionUserMessageId = null
let showAllProcessDetails = false
let isEditingSummary = false
const SOURCE_ROOTS = ['notes/', 'nodes/', 'descriptions_output/', 'changes/']

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function escHtml(s) {
  return esc(s)
}

function formatDuration(ms) {
  if (ms < 1000) return ms + 'ms'
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's'
  return Math.floor(ms / 60000) + 'm ' + Math.floor((ms % 60000) / 1000) + 's'
}

function isSourcePath(value) {
  if (!value || value.includes('..')) return false
  return SOURCE_ROOTS.some((prefix) => value.startsWith(prefix))
}

function wrapSourcePath(pathText) {
  return `<a href="#" class="source-path-link" data-source-path="${escHtml(pathText)}"><code>${escHtml(pathText)}</code></a>`
}

function linkifySummaryFootnotes(markdown) {
  const placeholders = []
  const withEntries = markdown.replace(/^\[\^(E\d+)\]:\s*(?:`[^`]+`｜)?(.*)$/gm, (line, id, rest) => {
    const linked = rest.replace(/`([^`]+)`/g, (match, value) => {
      return isSourcePath(value) ? wrapSourcePath(value) : match
    })
    const token = `@@FOOTNOTE_${placeholders.length}@@`
    placeholders.push(`<span id="summary-footnote-${id}" class="summary-footnote-entry">[^${id}]: ${linked}</span>  `)
    return token
  })
  const withRefs = withEntries.replace(/\[\^(E\d+)\]/g, (match, id) => {
    return `<a href="#summary-footnote-${id}" class="summary-footnote-ref" data-footnote-ref="${id}">[^${id}]</a>`
  })
  return withRefs.replace(/@@FOOTNOTE_(\d+)@@/g, (match, index) => placeholders[Number(index)] || match)
}

function linkifyAnswerSources(markdown) {
  const placeholders = []
  const withCodePlaceholders = markdown.replace(/`([^`]+)`/g, (match, value) => {
    if (!isSourcePath(value)) return match
    const token = `@@SOURCE_${placeholders.length}@@`
    placeholders.push(wrapSourcePath(value))
    return token
  })
  const withPlainPlaceholders = withCodePlaceholders.replace(/(^|[^\w/>@])((?:notes|nodes|descriptions_output|changes)\/[^\s\]）；;，,`<]+)/g, (match, prefix, value) => {
    if (!isSourcePath(value)) return match
    const token = `@@SOURCE_${placeholders.length}@@`
    placeholders.push(wrapSourcePath(value))
    return prefix + token
  })
  return withPlainPlaceholders.replace(/@@SOURCE_(\d+)@@/g, (match, index) => placeholders[Number(index)] || match)
}

function renderAssistantMarkdown(markdown, mode) {
  if (!markdown) return ''
  const linked = mode === 'summary'
    ? linkifySummaryFootnotes(markdown)
    : linkifyAnswerSources(markdown)
  return marked.parse(linked)
}

async function openSourceViewer(sourcePath) {
  if (!isSourcePath(sourcePath)) return
  sourceViewerModal.classList.remove('hidden')
  sourceViewerPath.textContent = sourcePath
  sourceViewerContent.textContent = '加载中...'
  try {
    const result = await fetchJson(API + '/file/content?directory=' + encodeURIComponent(projectDir) + '&path=' + encodeURIComponent(sourcePath))
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

async function fetchJson(url, options) {
  const res = await fetch(url, options)
  if (!res.ok) throw new Error(await res.text())
  if (res.status === 204) return null
  return res.json()
}

function hasVisibleUserText(message) {
  return message.parts.some((part) => part.type === 'text' && !part.synthetic && !part.ignored && part.text.trim())
}

function visibleUserText(message) {
  return message.parts
    .filter((part) => part.type === 'text' && !part.synthetic && !part.ignored)
    .map((part) => part.text)
    .join('')
    .trim()
}

function isHiddenAssistantPart(part) {
  return part.type === 'step-start' || part.type === 'step-finish' || part.type === 'compaction' || part.type === 'retry' || part.type === 'subtask'
}

function assistantReplies(messages, userMessageId) {
  return messages.filter((item) => item.info.role === 'assistant' && item.info.parentID === userMessageId)
}

function isQuestionRunning(messages, userMessageId) {
  const assistants = assistantReplies(messages, userMessageId)
  if (!assistants.length) return true
  return assistants.some((assistant) => !assistant.info.time?.completed)
}

function questionThreads() {
  const questions = detail?.questions || []
  const threads = []
  const seenSessions = new Set()
  for (const question of questions) {
    if (seenSessions.has(question.sessionID)) continue
    seenSessions.add(question.sessionID)
    threads.push(question)
  }
  return threads
}

function selectedQuestion() {
  return questionThreads().find((question) => question.id === selectedQuestionId) || null
}

async function refreshProjectView() {
  detail = await fetchJson(API + '/project/detail?directory=' + encodeURIComponent(projectDir))
  const threads = questionThreads()
  if (!threads.some((question) => question.id === selectedQuestionId)) {
    selectedQuestionId = threads[0]?.id || null
  }
  renderSummary()
  await renderQuestions()
}

function connectSSE() {
  if (currentSSE) {
    currentSSE.close()
    currentSSE = null
  }
  const es = new EventSource(API + '/event?directory=' + encodeURIComponent(projectDir))
  es.onmessage = (event) => {
    try {
      handleBusEvent(JSON.parse(event.data))
    } catch {}
  }
  es.onerror = () => {
    es.close()
    currentSSE = null
    setTimeout(connectSSE, 3000)
  }
  currentSSE = es
}

function handleBusEvent(event) {
  if (!event?.type) return
  if (event.type === 'session.updated') {
    const sessionID = event.properties?.info?.id
    if (sessionID && (sessionID === currentSummarySessionId || sessionID === currentQuestionSessionId)) {
      refreshProjectView().catch(() => {})
    }
  }
  if (event.type === 'session.status') {
    const sessionID = event.properties?.sessionID
    if (sessionID && (sessionID === currentSummarySessionId || sessionID === currentQuestionSessionId)) {
      refreshProjectView().catch(() => {})
    }
  }
  if (event.type === 'message.updated') {
    const sessionID = event.properties?.info?.sessionID
    if (sessionID && (sessionID === currentSummarySessionId || sessionID === currentQuestionSessionId)) {
      refreshProjectView().catch(() => {})
    }
  }
  if (event.type === 'message.part.updated' || event.type === 'message.part.delta') {
    const sessionID = event.properties?.part?.sessionID || event.properties?.sessionID
    if (sessionID && (sessionID === currentSummarySessionId || sessionID === currentQuestionSessionId)) {
      refreshProjectView().catch(() => {})
    }
  }
}

async function loadDetail() {
  detail = await fetchJson(API + '/project/detail?directory=' + encodeURIComponent(projectDir))
  projectDirEl.textContent = projectDir
  const threads = questionThreads()
  if (!selectedQuestionId) {
    selectedQuestionId = threads[0]?.id || null
  }
  renderSummary()
  await renderQuestions()
  if (!detail.currentSummary) {
    await runSummary(true)
  }
}

function renderSummary() {
  const current = detail?.currentSummary
  currentSummarySessionId = current?.sessionID || null
  summaryStatusEl.textContent = current ? `${current.status} · ${current.sessionID}` : '未生成'
  summaryEditor.value = current?.summaryText || ''
  summaryPreview.innerHTML = current?.summaryText ? renderAssistantMarkdown(current.summaryText, 'summary') : ''
  summaryPreview.classList.toggle('hidden', isEditingSummary)
  summaryEditor.classList.toggle('hidden', !isEditingSummary)
  btnEditSummary.classList.toggle('hidden', isEditingSummary)
  btnSaveSummary.classList.toggle('hidden', !isEditingSummary)
  btnCancelSummary.classList.toggle('hidden', !isEditingSummary)
}

async function loadMessages(sessionId) {
  return fetchJson(API + '/session/' + sessionId + '/message?directory=' + encodeURIComponent(projectDir)) || []
}

function buildTurns(messages, runningQuestionId) {
  const turns = []
  for (const message of messages) {
    if (message.info.role !== 'user') continue
    const questionText = visibleUserText(message)
    if (!questionText) continue

    const assistants = assistantReplies(messages, message.info.id)
    const answerParts = assistants.flatMap((assistant) => assistant.parts || [])
    const answerText = answerParts
      .filter((part) => part.type === 'text' && !part.synthetic && !part.ignored)
      .map((part) => part.text)
      .join('')
      .trim()
    const details = answerParts.filter((part) => part.type !== 'text' && !isHiddenAssistantPart(part))
    const running = runningQuestionId === message.info.id && isQuestionRunning(messages, message.info.id)

    if (!answerText && !details.length && !running) continue

    turns.push({
      userMessageId: message.info.id,
      questionText,
      answerText,
      details,
      running,
    })
  }
  return turns
}

async function renderQuestionList() {
  const questions = questionThreads()
  questionListMetaEl.textContent = `${questions.length} 条`
  questionListEl.innerHTML = ''

  if (!questions.length) {
    questionListEl.innerHTML = '<div class="empty">还没有历史问题</div>'
    return
  }

  for (const question of questions) {
    const item = document.createElement('button')
    item.type = 'button'
    item.className = 'question-item' + (question.id === selectedQuestionId ? ' active' : '')
    const title = question.previewText || '未命名问题'
    item.innerHTML = `
      <div class="question-title">${esc(title)}</div>
      <div class="question-submeta">
        <span>${esc(question.sessionID)}</span>
        <span>${new Date(question.time.created).toLocaleString()}</span>
      </div>
    `
    item.onclick = async () => {
      selectedQuestionId = question.id
      await renderQuestions()
    }
    questionListEl.appendChild(item)
  }
}

function updateQuestionSelectionUI() {
  const question = selectedQuestion()
  btnFollowup.disabled = !question?.id || !question?.sessionID
}

function renderPartNode(part) {
  const el = document.createElement('div')
  if (part.type === 'reasoning') {
    const text = part.text || ''
    if (!text || text.includes('[REDACTED]')) return null
    el.className = 'part-reasoning'
    el.innerHTML = `<div class="reasoning-label">Thinking</div><pre>${escHtml(text)}</pre>`
    return el
  }

  if (part.type === 'tool') {
    renderToolPart(el, part)
    return el
  }

  if (part.type === 'patch') {
    el.className = 'part-patch'
    el.textContent = (part.files || []).join('  ')
    return el
  }

  if (part.type === 'step-finish') {
    el.className = 'part-step-finish'
    const t = part.tokens || {}
    el.textContent = `tokens: ${(t.input || 0) + (t.output || 0)}  cost: $${(part.cost || 0).toFixed(4)}`
    return el
  }

  return null
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
      el.innerHTML = `<div class="task-done">└ Subagent completed${dur ? ' · ' + dur : ''}${sessionId ? ` <span class="task-link">${escHtml(sessionId)}</span>` : ''}</div>`
    } else {
      el.innerHTML = `<div class="task-error">✗ Subagent failed: ${escHtml(state.error || 'error')}</div>`
    }
    return
  }

  if (toolName === 'todowrite' && status === 'completed') {
    const todos = state.metadata?.todos || part.metadata?.todos || []
    if (todos.length) {
      el.className = 'part-tool todo-list completed'
      const items = todos.map((todo) => {
        const mark = todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '•' : ' '
        const cls = todo.status === 'in_progress' ? 'todo-inprogress' : 'todo-other'
        return `<div class="todo-item ${cls}"><span class="todo-mark">[${mark}]</span> ${escHtml(todo.content)}</div>`
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

async function renderQuestions() {
  await renderQuestionList()
  updateQuestionSelectionUI()

  const question = selectedQuestion()
  if (!question) {
    currentQuestionSessionId = null
    currentQuestionUserMessageId = null
    messagesEl.innerHTML = '<div class="empty">请选择一个历史问题</div>'
    qaMeta.textContent = '0 条提问'
    return
  }

  currentQuestionSessionId = question.sessionID
  currentQuestionUserMessageId = question.userMessageID || null
  qaMeta.textContent = `${questionThreads().length} 条会话线程 · 当前会话 ${question.sessionID}`

  const messages = await loadMessages(question.sessionID)
  const baselineMessages = question.baselineSessionID
    ? await loadMessages(question.baselineSessionID)
    : []
  const inheritedCount = baselineMessages.length
  const inheritedPrefix = inheritedCount > 0 ? messages.slice(0, inheritedCount) : []
  const samePrefixShape = inheritedPrefix.length === inheritedCount
    && inheritedPrefix.every((message, index) => message.info.role === baselineMessages[index]?.info.role)
  const visibleMessages = samePrefixShape ? messages.slice(inheritedCount) : messages
  const filtered = visibleMessages.filter((message) => {
    if (message.info.role === 'user' && !hasVisibleUserText(message)) return false
    return true
  })
  const turns = buildTurns(filtered, currentQuestionUserMessageId)

  messagesEl.innerHTML = ''
  if (!turns.length) {
    messagesEl.innerHTML = '<div class="empty">当前问题还没有可展示的会话内容</div>'
    return
  }

  for (const turn of turns) {
    const el = document.createElement('div')
    el.className = 'turn'

    const questionNode = document.createElement('div')
    questionNode.className = 'turn-user'
    questionNode.textContent = turn.questionText
    el.appendChild(questionNode)

    const answerNode = document.createElement('div')
    answerNode.className = 'turn-answer'
    answerNode.innerHTML = turn.answerText ? renderAssistantMarkdown(turn.answerText, 'answer') : '<div class="loading">生成中...</div>'
    el.appendChild(answerNode)

    if (turn.details.length) {
      const details = document.createElement('details')
      details.className = 'turn-details'
      details.open = turn.running || showAllProcessDetails

      const summary = document.createElement('summary')
      summary.textContent = turn.running ? '处理中...' : '查看中间过程'
      details.appendChild(summary)

      const body = document.createElement('div')
      body.className = 'turn-detail-body'
      for (const part of turn.details) {
        const node = renderPartNode(part)
        if (node) body.appendChild(node)
      }
      details.appendChild(body)
      el.appendChild(details)
    }

    messagesEl.appendChild(el)
  }
}

async function runSummary(auto = false) {
  const summary = await fetchJson(API + '/project/summary/run?directory=' + encodeURIComponent(projectDir), { method: 'POST' })
  detail.currentSummary = summary
  detail.summaries = [summary, ...(detail.summaries || [])]
  renderSummary()
  summaryStatusEl.textContent = auto ? '生成中...' : `running · ${summary.sessionID}`
}

function startSummaryEdit() {
  if (!detail?.currentSummary) return
  isEditingSummary = true
  renderSummary()
}

function cancelSummaryEdit() {
  isEditingSummary = false
  renderSummary()
}

async function saveSummary() {
  if (!detail?.currentSummary) return
  const summary = await fetchJson(API + '/project/summary/' + detail.currentSummary.id, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ summaryText: summaryEditor.value }),
  })
  detail.currentSummary = summary
  isEditingSummary = false
  renderSummary()
}

async function ask(mode) {
  const text = questionInput.value.trim()
  if (!text) return
  const body = { text, mode }
  const question = selectedQuestion()
  if (mode === 'followup') {
    if (!question?.id || !question?.sessionID) return
    body.questionID = question.id
    body.questionSessionID = question.sessionID
  }
  const created = await fetchJson(API + '/project/question?directory=' + encodeURIComponent(projectDir), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (mode === 'question' && created?.id) {
    selectedQuestionId = created.id
  }
  questionInput.value = ''
  await refreshProjectView()
}

summaryPreview.onclick = async (event) => {
  const link = event.target.closest('[data-source-path]')
  if (!link) return
  event.preventDefault()
  await openSourceViewer(link.dataset.sourcePath || '')
}

messagesEl.onclick = async (event) => {
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

btnAsk.onclick = () => ask('question')
btnFollowup.onclick = () => ask('followup')
btnCollapseProcess.onclick = async () => {
  showAllProcessDetails = false
  await renderQuestions()
}
btnExpandProcess.onclick = async () => {
  showAllProcessDetails = true
  await renderQuestions()
}
btnRerun.onclick = () => runSummary(false)
btnEditSummary.onclick = startSummaryEdit
btnSaveSummary.onclick = saveSummary
btnCancelSummary.onclick = cancelSummaryEdit
btnBack.onclick = () => { location.href = '/web' }

connectSSE()
loadDetail().catch((error) => {
  messagesEl.innerHTML = `<div class="empty">${esc(error.message || '加载失败')}</div>`
})
