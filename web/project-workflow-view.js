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
  return tool === 'edit' || tool === 'write' || tool === 'apply_patch'
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
  } else if (part.tool === 'write') {
    diff = unifiedTextPatch(file, '', input.content ?? '')
  } else if (part.tool === 'edit') {
    diff = unifiedTextPatch(file, input.oldString ?? '', input.newString ?? '')
  }
  if (!String(diff).trim()) return null
  const messageID = part.messageID || message?.info?.id || message?.id || ''
  return {
    id: `tool-rejected:${messageID}:${part.callID || part.id || ''}`,
    source: 'tool',
    status: 'rejected',
    title: isWorkflowNotePath(file) ? '已拒绝修改工作笔记' : '已拒绝修改文件',
    file,
    diff,
    callID: part.callID,
    messageID,
  }
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
  return new Set(editToolRecords(workflowMessages).map((record) => record.callID).filter(Boolean))
}

export function rejectedEditToolCallIDs(workflowMessages) {
  return new Set(rejectedEditToolRecords(workflowMessages).map((record) => record.callID).filter(Boolean))
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
    const record = rejected ? rejectedEditToolRecord(part, message) : null
    const button = record ? `<button type="button" class="btn-secondary tool-diff-open" data-tool-diff-open="${esc(record.id)}">查看 diff</button>` : ''
    return `<div class="message-tool tool-error"><span>${esc(title)} · ${esc(label)}</span>${button}</div>`
  }
  return `<div class="message-tool">${esc(title)} · ${esc(status)}</div>`
}

export function renderResourceItem(resource, selectedResourcePath, metaText) {
  return `
    <div class="resource-item ${resource.path === selectedResourcePath ? 'active' : ''}" role="button" tabindex="0" data-path="${esc(resource.path)}">
      <span class="resource-row">
        <span class="resource-name">${esc(resource.originalName || resource.name)}</span>
        <button type="button" class="resource-delete" data-path="${esc(resource.path)}" title="删除资源">删除</button>
      </span>
      <span class="resource-meta">${esc(metaText)}</span>
    </div>
  `
}

export function permissionListUrl(project) {
  const suffix = project?.directory ? `?directory=${encodeURIComponent(project.directory)}` : ''
  return `/permission${suffix}`
}

export function permissionReplyUrl(id, project) {
  const suffix = project?.directory ? `?directory=${encodeURIComponent(project.directory)}` : ''
  return `/permission/${encodeURIComponent(id)}/reply${suffix}`
}
