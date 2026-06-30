const API = ''
const params = new URLSearchParams(location.search)
let projectName = params.get('project') || ''
let projects = []

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
const operationList = document.getElementById('operation-list')
const noteList = document.getElementById('note-list')
const resourceList = document.getElementById('resource-list')
const tabButtons = Array.from(document.querySelectorAll('.tab-button'))
const tabPanels = Array.from(document.querySelectorAll('[data-tab-panel]'))
const modal = document.getElementById('new-project-modal')
const projectNameInput = document.getElementById('project-name')
const modalError = document.getElementById('modal-error')
const btnCancelProject = document.getElementById('btn-cancel-project')
const btnCreateProject = document.getElementById('btn-create-project')
let activeTab = 'graph'

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

async function fetchJson(url, options) {
  const res = await fetch(url, options)
  if (!res.ok) throw new Error(await res.text())
  if (res.status === 204 || res.headers.get('content-length') === '0') return null
  return res.json()
}

function selectedProject() {
  return projects.find((project) => project.name === projectName) || projects[0] || null
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

async function loadProjects() {
  projects = await fetchJson(API + '/project/directories') || []
  if (projectName && !projects.some((project) => project.name === projectName)) projectName = ''
  if (!projectName && projects.length) projectName = projects[0].name
  render()
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
  notePreview.innerHTML = '<div class="placeholder">还没有工作笔记草案。</div>'
  noteList.innerHTML = '<div class="placeholder">还没有历史工作笔记。</div>'
  resourcePreview.innerHTML = '<div class="placeholder">还没有可预览的项目资源。</div>'
  resourceList.innerHTML = '<div class="placeholder">还没有登记项目资源文档。</div>'
}

function renderWorkspace() {
  const project = selectedProject()
  if (!project) {
    workspaceSubtitle.textContent = '还没有项目'
    projectStatus.textContent = ''
    emptyMaterialState('点击“新建项目”创建项目目录和基础结构。')
    chatLog.innerHTML = '<div class="placeholder">新建项目后，这里会承载和项目初始化 Skill 的对话。</div>'
    btnDetail.disabled = true
    btnGraph.disabled = true
    return
  }
  const ready = !!project.graphInitialized
  workspaceSubtitle.textContent = `${project.name} / ${project.directory}`
  projectStatus.innerHTML = `<span class="badge ${ready ? 'ready' : 'pending'}">${ready ? '图数据已初始化' : '等待第一次图提交'}</span>`
  btnDetail.disabled = !ready
  btnGraph.disabled = !ready
  graphPreview.innerHTML = ready
    ? '<div class="placeholder">后续这里显示当前项目图谱，并叠加本次工作推进草案的新增/更新节点和边。</div>'
    : '<div class="placeholder">项目目录已创建。第一次图数据提交前，这里将展示项目初始化 Skill 生成的初始图草案。</div>'
  chatLog.innerHTML = `
    <div class="operation-item">
      <div class="operation-kind">当前项目</div>
      <div class="operation-title">${esc(project.name)}</div>
      <div class="operation-history">${ready ? '可以继续工作推进。' : '已创建项目目录结构；下一步在聊天区补充项目背景并生成初始图数据草案。'}</div>
    </div>
    <div class="operation-item">
      <div class="operation-kind">初始化状态</div>
      <div class="operation-title">${esc(project.initialWorkflowID || '等待背景输入')}</div>
      <div class="operation-history">${ready ? '项目已完成第一次图提交。' : '后续聊天区会用于描述背景、修改初始化草案和确认图更新方向。'}</div>
    </div>
  `
  operationList.innerHTML = ready
    ? '<div class="placeholder">后续这里显示本次推进生成的图操作索引，点击后图谱预览会定位到对应节点或边。</div>'
    : '<div class="placeholder">等待项目初始化 Skill 生成第一批图操作：初始事件/目标/工作块/工作项等。</div>'
  notePreview.innerHTML = ready
    ? '<div class="placeholder">后续这里预览 AI 辅助生成或人工修订后的本次工作笔记。</div>'
    : '<div class="placeholder">第一次图数据提交前，工作笔记会先围绕项目背景和初始化草案生成。</div>'
  noteList.innerHTML = '<div class="placeholder">后续这里列出历史工作笔记，点击后在左侧预览。</div>'
  resourcePreview.innerHTML = '<div class="placeholder">后续这里预览架构设计、需求文档、会议纪要等资源文档。</div>'
  resourceList.innerHTML = '<div class="placeholder">后续这里列出已登记或可引用的项目资源文档。</div>'
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
    closeModal()
    await loadProjects()
  } catch (error) {
    showError(error.message || '创建失败')
  } finally {
    btnCreateProject.disabled = false
  }
}

projectSelect.onchange = () => {
  projectName = projectSelect.value
  render()
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
modal.onclick = (event) => {
  if (event.target === modal) closeModal()
}

loadProjects().catch((error) => {
  graphPreview.innerHTML = `<div class="placeholder">${esc(error.message || '加载失败')}</div>`
})
setActiveTab(activeTab)
