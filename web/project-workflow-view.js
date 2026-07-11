export function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function resetWorkflowViewState() {
  return {
    workflow: null,
    workflowNote: null,
    workflowMessages: [],
    workflowPermissions: [],
    workflowPermissionRecords: [],
    pendingUserText: '',
    activePermissionReviewID: '',
    workflowAwaitingReply: false,
  }
}

export function workflowPermissionTitle(req) {
  if (req.permission === 'edit' && isWorkflowNotePath(workflowPermissionFile(req))) return '修改工作笔记'
  return req.permission === 'edit' ? '修改文件' : '权限请求'
}

export function workflowPermissionFile(req) {
  return req.metadata?.filepath || (req.patterns || []).join(', ') || 'workflow permission'
}

export function workflowPermissionDiff(req) {
  return req.metadata?.diff || req.metadata?.description || ''
}

export function workflowPermissionStatusText(status) {
  if (status === 'executed') return '已执行'
  if (status === 'approved') return '已批准'
  if (status === 'rejected') return '已拒绝'
  return '待审核'
}

function lineChangeSegments(oldText, newText) {
  const oldValue = String(oldText ?? '')
  const newValue = String(newText ?? '')
  let prefix = 0
  const maxPrefix = Math.min(oldValue.length, newValue.length)
  while (prefix < maxPrefix && oldValue[prefix] === newValue[prefix]) prefix++

  let oldSuffix = oldValue.length
  let newSuffix = newValue.length
  while (
    oldSuffix > prefix &&
    newSuffix > prefix &&
    oldValue[oldSuffix - 1] === newValue[newSuffix - 1]
  ) {
    oldSuffix--
    newSuffix--
  }

  return {
    old: {
      before: oldValue.slice(0, prefix),
      changed: oldValue.slice(prefix, oldSuffix),
      after: oldValue.slice(oldSuffix),
    },
    next: {
      before: newValue.slice(0, prefix),
      changed: newValue.slice(prefix, newSuffix),
      after: newValue.slice(newSuffix),
    },
  }
}

function renderChangedContent(text, peerText, mode) {
  if (peerText === undefined) return esc(text)
  const segments = lineChangeSegments(mode === 'delete' ? text : peerText, mode === 'delete' ? peerText : text)
  const target = mode === 'delete' ? segments.old : segments.next
  if (!target.changed) return esc(text)
  return `${esc(target.before)}<span class="diff-word">${esc(target.changed)}</span>${esc(target.after)}`
}

function parseUnifiedDiff(diff) {
  const rows = []
  let oldLine = null
  let newLine = null
  for (const rawLine of String(diff || '').replace(/\r\n/g, '\n').split('\n')) {
    if (!rawLine && rows.length && rows[rows.length - 1].raw === '') continue

    const hunk = rawLine.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@(.*)$/)
    if (hunk) {
      oldLine = Number(hunk[1])
      newLine = Number(hunk[2])
      rows.push({ type: 'hunk', marker: '', oldLine: '', newLine: '', raw: rawLine, text: rawLine })
      continue
    }

    if (rawLine.startsWith('diff --git ') || rawLine.startsWith('index ')) {
      rows.push({ type: 'meta', marker: '', oldLine: '', newLine: '', raw: rawLine, text: rawLine })
      continue
    }
    if (rawLine.startsWith('--- ') || rawLine.startsWith('+++ ')) {
      rows.push({ type: 'file', marker: rawLine.slice(0, 3), oldLine: '', newLine: '', raw: rawLine, text: rawLine.slice(4) })
      continue
    }
    if (rawLine.startsWith('-')) {
      rows.push({ type: 'delete', marker: '-', oldLine: oldLine ?? '', newLine: '', raw: rawLine, text: rawLine.slice(1) })
      if (oldLine !== null) oldLine++
      continue
    }
    if (rawLine.startsWith('+')) {
      rows.push({ type: 'add', marker: '+', oldLine: '', newLine: newLine ?? '', raw: rawLine, text: rawLine.slice(1) })
      if (newLine !== null) newLine++
      continue
    }
    if (rawLine.startsWith(' ')) {
      rows.push({ type: 'context', marker: '', oldLine: oldLine ?? '', newLine: newLine ?? '', raw: rawLine, text: rawLine.slice(1) })
      if (oldLine !== null) oldLine++
      if (newLine !== null) newLine++
      continue
    }
    if (rawLine.startsWith('\\ No newline')) {
      rows.push({ type: 'note', marker: '', oldLine: '', newLine: '', raw: rawLine, text: rawLine })
      continue
    }
    rows.push({ type: 'context', marker: '', oldLine: oldLine ?? '', newLine: newLine ?? '', raw: rawLine, text: rawLine })
    if (oldLine !== null) oldLine++
    if (newLine !== null) newLine++
  }
  return rows
}

export function renderUnifiedDiff(diff) {
  const rows = parseUnifiedDiff(diff)
  if (!rows.length || !String(diff || '').trim()) {
    return '<div class="diff-empty">没有可展示的 diff。</div>'
  }
  const html = rows.map((row, index) => {
    const previous = rows[index - 1]
    const next = rows[index + 1]
    const peerText = row.type === 'delete' && next?.type === 'add'
      ? next.text
      : row.type === 'add' && previous?.type === 'delete'
        ? previous.text
        : undefined
    const content = row.type === 'delete' || row.type === 'add'
      ? renderChangedContent(row.text, peerText, row.type)
      : esc(row.text)
    return `
      <div class="diff-row diff-${esc(row.type)}">
        <span class="diff-line old">${esc(row.oldLine)}</span>
        <span class="diff-line new">${esc(row.newLine)}</span>
        <span class="diff-marker">${esc(row.marker)}</span>
        <span class="diff-content">${content || '&nbsp;'}</span>
      </div>
    `
  }).join('')
  return `<div class="diff-view" role="table" aria-label="文件修改 diff">${html}</div>`
}

export function renderWriteContent(content) {
  const text = String(content ?? '')
  if (!text.trim()) return '<div class="diff-empty">没有可展示的写入内容。</div>'
  return `<div class="write-content-view"><pre>${esc(text)}</pre></div>`
}

export function renderWorkflowReviewBody(record) {
  if (record?.kind === 'content') return renderWriteContent(record.content)
  return renderUnifiedDiff(record?.diff || workflowPermissionDiff(record))
}

export function makeWorkflowPermissionRecord(req, status = 'pending') {
  return {
    ...req,
    status,
    title: workflowPermissionTitle(req),
    file: workflowPermissionFile(req),
    diff: workflowPermissionDiff(req),
  }
}

export function mergeWorkflowPermissionRecords(records, pending) {
  const pendingIDs = new Set(pending.map((item) => item.id))
  const existing = new Map(records.map((item) => [item.id, item]))
  const nextPending = pending.map((item) => ({
    ...(existing.get(item.id) || makeWorkflowPermissionRecord(item, 'pending')),
    ...item,
    status: 'pending',
    title: workflowPermissionTitle(item),
    file: workflowPermissionFile(item),
    diff: workflowPermissionDiff(item),
  }))
  const handled = records.filter((item) => item.status !== 'pending' && !pendingIDs.has(item.id))
  return [...nextPending, ...handled]
}

export function upsertWorkflowPermissionRecord(records, req, status = 'pending') {
  const record = makeWorkflowPermissionRecord(req, status)
  return [
    record,
    ...records.filter((item) => item.id !== req.id),
  ]
}

export function markWorkflowPermissionRecord(records, id, reply) {
  const status = reply === 'reject' ? 'rejected' : 'approved'
  return records.map((item) => item.id === id ? { ...item, status } : item)
}

export function isEditTool(tool) {
  return tool === 'edit' || tool === 'apply_patch'
}

export function isWriteTool(tool) {
  return tool === 'write'
}

function isReviewTool(tool) {
  return isEditTool(tool) || isWriteTool(tool)
}

export function isWorkflowNotePath(file) {
  return String(file || '').replaceAll('\\', '/').endsWith('/workflows/active/note.md') ||
    String(file || '').replaceAll('\\', '/') === 'workflows/active/note.md'
}

function rejectedPermissionError(error) {
  return String(error || '').includes('rejected permission') || String(error || '').includes('rejected')
}

function unifiedTextPatch(file, oldText, newText) {
  const oldLines = String(oldText ?? '').split('\n')
  const newLines = String(newText ?? '').split('\n')
  const lines = [
    `--- ${file}`,
    `+++ ${file}`,
    '@@ rejected proposal @@',
  ]
  for (const line of oldLines) {
    if (line.length || oldLines.length > 1) lines.push(`-${line}`)
  }
  for (const line of newLines) {
    if (line.length || newLines.length > 1) lines.push(`+${line}`)
  }
  return lines.join('\n')
}

export function rejectedEditToolRecord(part, message = null) {
  if (!isEditTool(part.tool)) return null
  if (part.state?.status !== 'error' || !rejectedPermissionError(part.state?.error)) return null
  const input = part.state?.input || {}
  const file = input.filePath || input.filepath || 'workflows/active/note.md'
  let diff = ''
  if (part.tool === 'apply_patch') {
    diff = input.patchText || ''
  } else if (part.tool === 'edit') {
    diff = unifiedTextPatch(file, input.oldString ?? '', input.newString ?? '')
  }
  if (!String(diff).trim()) return null
  const messageID = part.messageID || message?.info?.id || message?.id || ''
  return {
    id: `tool-rejected:${messageID}:${part.callID || part.id || ''}`,
    kind: 'diff',
    source: 'tool',
    status: 'rejected',
    title: isWorkflowNotePath(file) ? '已拒绝修改工作笔记' : '已拒绝修改文件',
    file,
    diff,
    callID: part.callID,
    messageID,
  }
}

export function writeToolRecord(part, message = null) {
  if (!isWriteTool(part.tool)) return null
  const status = part.state?.status || ''
  const rejected = status === 'error' && rejectedPermissionError(part.state?.error)
  if (status !== 'completed' && !rejected) return null
  const input = part.state?.input || {}
  const metadata = part.state?.metadata || {}
  if (input.content === undefined) return null
  const file = input.filePath || metadata.filepath || input.filepath || 'written file'
  const messageID = part.messageID || message?.info?.id || message?.id || ''
  const note = isWorkflowNotePath(file)
  let title = note ? '已写入工作笔记' : '已写入文件'
  if (rejected) title = note ? '已拒绝写入工作笔记' : '已拒绝写入文件'
  else if (metadata.exists === false) title = note ? '已创建工作笔记' : '已创建文件'
  else if (metadata.exists === true) title = note ? '已整体写入工作笔记' : '已整体写入文件'
  return {
    id: `tool-write:${rejected ? 'rejected' : 'executed'}:${messageID}:${part.callID || part.id || ''}`,
    kind: 'content',
    source: 'tool',
    status: rejected ? 'rejected' : 'executed',
    title,
    file,
    content: input.content,
    callID: part.callID,
    messageID,
    buttonLabel: rejected ? '查看模型提交的内容' : '查看写入内容',
  }
}

export function writeToolRecords(workflowMessages) {
  const records = []
  for (const message of workflowMessages) {
    for (const part of message.parts || []) {
      if (part.type !== 'tool') continue
      const record = writeToolRecord(part, message)
      if (record) records.push(record)
    }
  }
  return records
}

export function editToolRecords(workflowMessages) {
  const records = []
  for (const message of workflowMessages) {
    for (const part of message.parts || []) {
      if (part.type !== 'tool' || !isEditTool(part.tool)) continue
      if (part.state?.status !== 'completed') continue
      const metadata = part.state?.metadata || {}
      const diff = metadata.diff || metadata.filediff?.patch || metadata.files?.map((file) => file.diff).filter(Boolean).join('\n') || ''
      if (!diff) continue
      const file = metadata.filepath || metadata.filediff?.file || metadata.files?.map((item) => item.relativePath || item.filePath).filter(Boolean).join(', ') || 'edited file'
      const messageID = part.messageID || message.info?.id || message.id || ''
      records.push({
        id: `tool:${messageID}:${part.callID || part.id || records.length}`,
        kind: 'diff',
        source: 'tool',
        status: 'executed',
        title: isWorkflowNotePath(file) ? '已修改工作笔记' : (part.state?.title || '已修改文件'),
        file,
        diff,
        callID: part.callID,
        messageID,
      })
    }
  }
  return records
}

export function rejectedEditToolRecords(workflowMessages) {
  const records = []
  for (const message of workflowMessages) {
    for (const part of message.parts || []) {
      if (part.type !== 'tool') continue
      const record = rejectedEditToolRecord(part, message)
      if (record) records.push(record)
    }
  }
  return records
}

export function completedEditToolCallIDs(workflowMessages) {
  const ids = []
  for (const message of workflowMessages) {
    for (const part of message.parts || []) {
      if (part.type === 'tool' && isReviewTool(part.tool) && part.state?.status === 'completed' && part.callID) ids.push(part.callID)
    }
  }
  return new Set(ids)
}

export function rejectedEditToolCallIDs(workflowMessages) {
  const ids = []
  for (const message of workflowMessages) {
    for (const part of message.parts || []) {
      if (
        part.type === 'tool' &&
        isReviewTool(part.tool) &&
        part.state?.status === 'error' &&
        rejectedPermissionError(part.state?.error) &&
        part.callID
      ) ids.push(part.callID)
    }
  }
  return new Set(ids)
}

export function visibleWorkflowPermissionRecords(records, workflowMessages) {
  const completedCalls = completedEditToolCallIDs(workflowMessages)
  const rejectedCalls = rejectedEditToolCallIDs(workflowMessages)
  return records.filter((record) => {
    if (record.status === 'rejected') {
      const callID = record.tool?.callID
      if (callID && rejectedCalls.has(callID)) return false
      return !!String(record.diff || '').trim()
    }
    if (record.status !== 'approved') return true
    const callID = record.tool?.callID
    return !callID || !completedCalls.has(callID)
  })
}

export function allWorkflowDiffRecords(records, workflowMessages) {
  return [
    ...editToolRecords(workflowMessages),
    ...writeToolRecords(workflowMessages),
    ...rejectedEditToolRecords(workflowMessages),
    ...visibleWorkflowPermissionRecords(records, workflowMessages),
  ]
}

export function workflowMessageID(message) {
  return message.info?.id || message.id || ''
}

export function renderWorkflowToolPart(part, message = null) {
  const status = part.state?.status || 'pending'
  const title = part.state?.title || part.tool || 'tool'
  const metadata = part.state?.metadata || {}
  if (isWriteTool(part.tool) && status === 'completed') {
    const record = writeToolRecord(part, message)
    const button = record ? `<button type="button" class="btn-secondary tool-diff-open" data-tool-diff-open="${esc(record.id)}">${esc(record.buttonLabel)}</button>` : ''
    return `
        <div class="message-tool tool-diff">
          <span>${esc(record?.title || title)} · 已执行</span>
          ${button}
        </div>
      `
  }
  if (isEditTool(part.tool) && status === 'completed' && (metadata.diff || metadata.filediff?.patch || metadata.files?.some((file) => file.diff))) {
    const messageID = part.messageID || message?.info?.id || message?.id || ''
    const recordID = `tool:${messageID}:${part.callID || part.id || ''}`
    return `
        <div class="message-tool tool-diff">
          <span>${esc(title)} · 已执行</span>
          <button type="button" class="btn-secondary tool-diff-open" data-tool-diff-open="${esc(recordID)}">查看 diff</button>
        </div>
      `
  }
  if (status === 'error') {
    const error = part.state?.error || ''
    const rejected = rejectedPermissionError(error)
    const label = rejected ? '用户已拒绝' : 'error'
    const record = rejected ? (writeToolRecord(part, message) || rejectedEditToolRecord(part, message)) : null
    const button = record ? `<button type="button" class="btn-secondary tool-diff-open" data-tool-diff-open="${esc(record.id)}">${esc(record.buttonLabel || '查看 diff')}</button>` : ''
    return `<div class="message-tool tool-error"><span>${esc(record?.title || title)} · ${esc(label)}</span>${button}</div>`
  }
  return `<div class="message-tool">${esc(title)} · ${esc(status)}</div>`
}

export function renderResourceItem(resource, selectedResourcePath, metaText, options = {}) {
  const showDelete = options.showDelete !== false
  return `
    <div class="resource-item ${resource.path === selectedResourcePath ? 'active' : ''}" role="button" tabindex="0" data-path="${esc(resource.path)}">
      <span class="resource-row">
        <span class="resource-name">${esc(resource.originalName || resource.name)}</span>
        ${showDelete ? `<button type="button" class="resource-delete" data-path="${esc(resource.path)}" title="删除资源">删除</button>` : ''}
      </span>
      <span class="resource-meta">${esc(metaText)}</span>
    </div>
  `
}

export function normalizeWorkflowMaximizedPanel(panel) {
  return panel === 'workspace' || panel === 'chat' ? panel : ''
}

export function workflowMaximizeBodyClass(panel) {
  const normalized = normalizeWorkflowMaximizedPanel(panel)
  return normalized ? `workflow-maximized-${normalized}` : ''
}

export function workflowMaximizeButtonState(activePanel, panel) {
  const normalizedPanel = normalizeWorkflowMaximizedPanel(panel)
  const expanded = normalizeWorkflowMaximizedPanel(activePanel) === normalizedPanel && !!normalizedPanel
  return {
    expanded,
    label: expanded ? '收起' : '展开',
    title: expanded ? '恢复默认布局' : '展开当前区域',
  }
}

export function canShowWorkflowGraphPreview(graphInitialized, hasDraftPreviewGraph) {
  return !!graphInitialized || !!hasDraftPreviewGraph
}

export function permissionListUrl(project) {
  const suffix = project?.directory ? `?directory=${encodeURIComponent(project.directory)}` : ''
  return `/permission${suffix}`
}

export function permissionReplyUrl(id, project) {
  const suffix = project?.directory ? `?directory=${encodeURIComponent(project.directory)}` : ''
  return `/permission/${encodeURIComponent(id)}/reply${suffix}`
}
