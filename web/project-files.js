const API = ''
const params = new URLSearchParams(location.search)
const legacyDirectory = params.get('directory') || ''
const projectName = params.get('project') || projectNameFromDirectory(legacyDirectory)
const initialPath = params.get('path') || ''

const GROUPS = [
  { id: 'nodes', label: 'Nodes', root: 'nodes' },
  { id: 'edges', label: 'Edges', root: 'edges' },
  { id: 'descriptions', label: 'Description Output', root: 'descriptions_output' },
  { id: 'changelog', label: 'Changelog', root: 'changes' },
  { id: 'snapshots', label: 'Snapshot', root: 'snapshots' },
  { id: 'notes', label: 'Notes', root: 'notes' },
  { id: 'reports', label: 'Reports', root: 'report_output' },
  { id: 'metadata', label: 'Metadata', root: 'metadata' },
]

const TEXT_EXTENSIONS = new Set(['json', 'jsonc', 'md', 'txt', 'log', 'yaml', 'yml', 'csv'])
const SOURCE_ROOTS = ['notes/', 'nodes/', 'descriptions_output/', 'changes/', 'snapshots/', 'edges/', 'metadata/', 'report_output/']

const projectDirEl = document.getElementById('project-dir')
const statusEl = document.getElementById('status')
const groupsEl = document.getElementById('groups')
const fileSearchEl = document.getElementById('file-search')
const fileListEl = document.getElementById('file-list')
const previewTitleEl = document.getElementById('preview-title')
const previewPathEl = document.getElementById('preview-path')
const previewContentEl = document.getElementById('preview-content')
const relatedLinksEl = document.getElementById('related-links')
const btnDetail = document.getElementById('btn-detail')
const btnGraph = document.getElementById('btn-graph')
const btnRefresh = document.getElementById('btn-refresh')
const btnCopyPath = document.getElementById('btn-copy-path')
const btnCopyContent = document.getElementById('btn-copy-content')
const btnViewRendered = document.getElementById('btn-view-rendered')
const btnViewSource = document.getElementById('btn-view-source')

const state = {
  filesByGroup: {},
  activeGroup: GROUPS[0].id,
  selectedPath: initialPath,
  selectedContent: '',
  selectedResult: null,
  previewMode: 'rendered',
  loading: false,
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function basename(filePath) {
  return filePath.split('/').filter(Boolean).pop() || filePath
}

function projectNameFromDirectory(directory) {
  return directory.split('/').filter(Boolean).pop() || ''
}

function extension(filePath) {
  const name = basename(filePath)
  const idx = name.lastIndexOf('.')
  return idx === -1 ? '' : name.slice(idx + 1).toLowerCase()
}

function isSourcePath(value) {
  if (!value || value.includes('..')) return false
  return SOURCE_ROOTS.some((prefix) => value.startsWith(prefix))
}

function groupForPath(filePath) {
  return GROUPS.find((group) => filePath === group.root || filePath.startsWith(group.root + '/')) || GROUPS[0]
}

async function fetchJson(url, options) {
  const res = await fetch(url, options)
  if (!res.ok) throw new Error(await res.text())
  if (res.status === 204) return null
  return res.json()
}

async function listDirectory(root) {
  return fetchJson(API + '/project/file?project=' + encodeURIComponent(projectName) + '&path=' + encodeURIComponent(root))
}

async function listRecursive(root) {
  const output = []
  async function visit(dir) {
    const nodes = await listDirectory(dir).catch(() => [])
    for (const node of nodes || []) {
      if (node.type === 'directory') await visit(node.path)
      else output.push(node)
    }
  }
  await visit(root)
  return output.sort((a, b) => a.path.localeCompare(b.path))
}

async function loadGroups() {
  state.loading = true
  statusEl.textContent = '加载中...'
  renderGroups()
  try {
    const entries = await Promise.all(GROUPS.map(async (group) => {
      const files = await listRecursive(group.root)
      if (group.id === 'changelog') {
        files.sort((a, b) => {
          if (a.path === 'changes/changelog.txt') return -1
          if (b.path === 'changes/changelog.txt') return 1
          return a.path.localeCompare(b.path)
        })
      }
      return [group.id, files]
    }))
    state.filesByGroup = Object.fromEntries(entries)
    if (state.selectedPath) state.activeGroup = groupForPath(state.selectedPath).id
    statusEl.textContent = `${GROUPS.reduce((sum, group) => sum + (state.filesByGroup[group.id]?.length || 0), 0)} 个文件`
  } finally {
    state.loading = false
    renderGroups()
    renderFiles()
  }
}

function renderGroups() {
  groupsEl.innerHTML = ''
  for (const group of GROUPS) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'group-button' + (state.activeGroup === group.id ? ' active' : '')
    button.innerHTML = `<span>${esc(group.label)}</span><span class="group-count">${state.filesByGroup[group.id]?.length ?? '-'}</span>`
    button.onclick = () => {
      state.activeGroup = group.id
      state.selectedPath = ''
      renderGroups()
      renderFiles()
      clearPreview()
      replaceUrl()
    }
    groupsEl.append(button)
  }
}

function filteredFiles() {
  const query = fileSearchEl.value.trim().toLowerCase()
  const files = state.filesByGroup[state.activeGroup] || []
  if (!query) return files
  return files.filter((file) => file.path.toLowerCase().includes(query) || file.name.toLowerCase().includes(query))
}

function renderFiles() {
  const files = filteredFiles()
  fileListEl.innerHTML = ''
  if (!files.length) {
    fileListEl.innerHTML = `<div class="empty">${state.loading ? '加载中...' : '无文件'}</div>`
    return
  }
  for (const file of files) {
    const item = document.createElement('button')
    item.type = 'button'
    item.className = 'file-item' + (state.selectedPath === file.path ? ' active' : '')
    item.innerHTML = `<span class="file-name">${esc(file.name)}</span><span class="file-path">${esc(file.path)}</span>`
    item.onclick = () => selectFile(file.path)
    fileListEl.append(item)
  }
}

function clearPreview() {
  state.selectedContent = ''
  state.selectedResult = null
  previewTitleEl.textContent = '未选择文件'
  previewPathEl.textContent = ''
  relatedLinksEl.innerHTML = ''
  previewContentEl.innerHTML = '<div class="empty">未选择文件</div>'
  updatePreviewButtons()
}

function replaceUrl() {
  const url = new URL(location.href)
  url.searchParams.delete('directory')
  url.searchParams.set('project', projectName)
  if (state.selectedPath) url.searchParams.set('path', state.selectedPath)
  else url.searchParams.delete('path')
  history.replaceState(null, '', url.toString())
}

async function selectFile(filePath) {
  state.selectedPath = filePath
  state.activeGroup = groupForPath(filePath).id
  state.selectedContent = ''
  state.selectedResult = null
  previewTitleEl.textContent = basename(filePath)
  previewPathEl.textContent = filePath
  previewContentEl.innerHTML = '<div class="empty">加载中...</div>'
  relatedLinksEl.innerHTML = ''
  renderGroups()
  renderFiles()
  replaceUrl()

  try {
    const result = await fetchJson(API + '/project/file/content?project=' + encodeURIComponent(projectName) + '&path=' + encodeURIComponent(filePath))
    state.selectedResult = result
    state.selectedContent = result?.content || ''
    renderPreview()
  } catch (error) {
    previewContentEl.innerHTML = `<div class="error">${esc(error.message || '加载失败')}</div>`
  }
}

function sourcePathLinksFromObject(value) {
  const found = new Set()
  function walk(input) {
    if (typeof input === 'string') {
      if (isSourcePath(input)) found.add(input)
      return
    }
    if (Array.isArray(input)) {
      input.forEach(walk)
      return
    }
    if (input && typeof input === 'object') {
      Object.values(input).forEach(walk)
    }
  }
  walk(value)
  return [...found].sort()
}

function renderRelatedLinks(parsedJson) {
  relatedLinksEl.innerHTML = ''
  const links = parsedJson ? sourcePathLinksFromObject(parsedJson) : []
  for (const linkPath of links) {
    if (linkPath === state.selectedPath) continue
    const link = document.createElement('a')
    link.href = '#'
    link.className = 'related-link'
    link.textContent = linkPath
    link.onclick = (event) => {
      event.preventDefault()
      selectFile(linkPath)
    }
    relatedLinksEl.append(link)
  }
}

function renderPreview() {
  const result = state.selectedResult
  updatePreviewButtons()
  if (!result) {
    previewContentEl.innerHTML = '<div class="empty">无内容</div>'
    return
  }
  if (result.type === 'binary') {
    previewContentEl.innerHTML = '<div class="empty">该文件不可作为文本预览</div>'
    return
  }

  const ext = extension(state.selectedPath)
  const content = state.selectedContent || ''
  let parsedJson = null

  if (result.encoding === 'base64' && result.mimeType?.startsWith('image/')) {
    previewContentEl.innerHTML = `<img class="image-preview" src="data:${esc(result.mimeType)};base64,${esc(content)}" alt="">`
    return
  }

  if (ext === 'json' || ext === 'jsonc') {
    try {
      parsedJson = JSON.parse(content)
      previewContentEl.innerHTML = `<pre>${esc(JSON.stringify(parsedJson, null, 2))}</pre>`
    } catch {
      previewContentEl.innerHTML = `<pre>${esc(content)}</pre>`
    }
    renderRelatedLinks(parsedJson)
    return
  }

  renderRelatedLinks(null)
  if (ext === 'md' && state.previewMode === 'rendered' && window.marked) {
    previewContentEl.innerHTML = marked.parse(content)
    return
  }

  if (!TEXT_EXTENSIONS.has(ext) && content.length === 0) {
    previewContentEl.innerHTML = '<div class="empty">无内容</div>'
    return
  }

  previewContentEl.innerHTML = `<pre>${esc(content)}</pre>`
}

function updatePreviewButtons() {
  const hasFile = Boolean(state.selectedPath)
  const isMarkdown = extension(state.selectedPath) === 'md'
  btnCopyPath.disabled = !hasFile
  btnCopyContent.disabled = !hasFile || !state.selectedResult || state.selectedResult.type === 'binary'
  btnViewRendered.disabled = !isMarkdown
  btnViewSource.disabled = !isMarkdown
  btnViewRendered.classList.toggle('active', isMarkdown && state.previewMode === 'rendered')
  btnViewSource.classList.toggle('active', isMarkdown && state.previewMode === 'source')
}

async function copyText(text, label) {
  if (!text) return
  await navigator.clipboard.writeText(text)
  statusEl.textContent = `${label}已复制`
}

btnDetail.onclick = () => {
  location.href = `/web/project.html?project=${encodeURIComponent(projectName)}`
}

btnGraph.onclick = () => {
  location.href = `/web/project-graph.html?project=${encodeURIComponent(projectName)}&view=expanded`
}

btnRefresh.onclick = () => loadGroups().catch((error) => {
  statusEl.textContent = error.message || '加载失败'
})

btnCopyPath.onclick = () => copyText(state.selectedPath, '路径').catch(() => {
  statusEl.textContent = '复制失败'
})

btnCopyContent.onclick = () => copyText(state.selectedContent, '内容').catch(() => {
  statusEl.textContent = '复制失败'
})

btnViewRendered.onclick = () => {
  state.previewMode = 'rendered'
  renderPreview()
}

btnViewSource.onclick = () => {
  state.previewMode = 'source'
  renderPreview()
}

fileSearchEl.oninput = renderFiles

projectDirEl.textContent = projectName ? `${projectName}/` : '缺少项目'
clearPreview()

if (!projectName) {
  statusEl.textContent = '缺少 project 参数'
} else {
  replaceUrl()
  loadGroups().then(() => {
    if (initialPath) return selectFile(initialPath)
  }).catch((error) => {
    statusEl.textContent = error.message || '加载失败'
  })
}
