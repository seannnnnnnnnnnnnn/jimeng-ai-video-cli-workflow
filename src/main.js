// ─── State ─────────────────────────────────────────────────────────
const state = {
  activeTab: 'workflow',
  sceneCount: 4,
  outputDir: '',
  workflowRunning: false,
  isPaused: false,
  inReviewMode: false,
  lastOutputDir: '',
  currentProject: null,    // last completed/loaded project
  directorProject: null,   // project loaded in director mode
  directorBusy: false,
  removeProgressListener: null,
  removeDirectorListener: null,
  chatHistory: [],
}

// ─── DOM Helpers ───────────────────────────────────────────────────
const $ = (id) => document.getElementById(id)
const mk = (tag, cls, html) => {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (html !== undefined) e.innerHTML = html
  return e
}
const escHtml = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

// ─── Tab Navigation ────────────────────────────────────────────────
function switchTab(tabName) {
  document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'))
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'))
  document.querySelector(`[data-tab="${tabName}"]`)?.classList.add('active')
  $(`tab-${tabName}`)?.classList.add('active')
  state.activeTab = tabName
  if (tabName === 'gallery') renderProjects()
  if (tabName === 'director') renderDirectorIfReady()
}
document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab))
})


// ─── Scene Count Buttons ───────────────────────────────────────────
$('scene-count-btns').addEventListener('click', (e) => {
  const btn = e.target.closest('.count-btn')
  if (!btn) return
  document.querySelectorAll('.count-btn').forEach(b => b.classList.remove('active'))
  btn.classList.add('active')
  state.sceneCount = parseInt(btn.dataset.count)
})

// ─── Output Dir ────────────────────────────────────────────────────
$('choose-output-dir').addEventListener('click', async () => {
  const dir = await window.electronAPI.chooseFolder()
  if (dir) {
    state.outputDir = dir
    $('output-dir-input').value = dir
  }
})

// ─── Params Panel Toggle ───────────────────────────────────────────
function getMediaParams() {
  return {
    imageRatio: $('p-image-ratio').value,
    imageResolutionType: $('p-image-resolution').value,
    videoModel: $('p-video-model').value,
    videoDuration: parseInt($('p-video-duration').value) || 5,
    videoResolution: $('p-video-resolution').value,
  }
}

function setMediaParams(mp) {
  if (!mp) return
  if (mp.imageRatio) $('p-image-ratio').value = mp.imageRatio
  if (mp.imageResolutionType) $('p-image-resolution').value = mp.imageResolutionType
  if (mp.videoModel) $('p-video-model').value = mp.videoModel
  if (mp.videoDuration) $('p-video-duration').value = mp.videoDuration
  if (mp.videoResolution) $('p-video-resolution').value = mp.videoResolution
  updateParamsSummary()
}

function updateParamsSummary() {
  const mp = getMediaParams()
  $('params-summary').textContent =
    `${mp.imageRatio} · ${mp.imageResolutionType.toUpperCase()} · ${mp.videoDuration}s`
}

$('params-toggle').addEventListener('click', () => {
  const panel = $('params-panel')
  const icon = $('params-toggle-icon')
  const open = panel.style.display === 'none'
  panel.style.display = open ? 'block' : 'none'
  icon.classList.toggle('open', open)
  updateParamsSummary()
})

// Update summary on any param change
;['p-image-ratio','p-image-resolution','p-video-model','p-video-duration','p-video-resolution']
  .forEach(id => $(`${id}`)?.addEventListener('change', updateParamsSummary))

updateParamsSummary()

// ─── CLI Status Check + Login ─────────────────────────────────────────────
// Check both CLI installed and login status
async function checkCLI() {
  const dot = $('status-dot')
  const txt = $('status-text')
  const loginBtn = $('login-btn')
  dot.className = 'status-dot checking'
  txt.textContent = '检测中...'
  if (loginBtn) loginBtn.style.display = 'none'

  try {
    const res = await window.electronAPI.jimengCheck()
    if (!res.installed) {
      dot.className = 'status-dot error'
      txt.textContent = '未安装 CLI'
      const hint = $('install-hint')
      if (hint) hint.style.display = 'block'
      return
    }

    // CLI found, now check login
    const loginStatus = await window.electronAPI.jimengLoginStatus()
    if (loginStatus.loggedIn) {
      dot.className = 'status-dot ok'
      txt.textContent = 'CLI 已就绪 ✓'
    } else {
      dot.className = 'status-dot error'
      txt.textContent = '未登录即梦'
      if (loginBtn) loginBtn.style.display = 'flex'
    }
  } catch (e) {
    dot.className = 'status-dot error'
    txt.textContent = 'CLI 检测失败'
  }
}

// ─── Login Modal ────────────────────────────────────────────────
function showLoginModal() {
  $('login-modal').style.display = 'grid'
  $('login-step-init').style.display = 'block'
  $('login-step-code').style.display = 'none'
  $('login-step-done').style.display = 'none'
  $('login-step-error').style.display = 'none'
}

function hideLoginModal() {
  $('login-modal').style.display = 'none'
}

if ($('login-btn')) $('login-btn').addEventListener('click', showLoginModal)
$('login-modal-close').addEventListener('click', hideLoginModal)
$('login-modal').addEventListener('click', (e) => {
  if (e.target === $('login-modal')) hideLoginModal()
})

$('do-login-btn').addEventListener('click', async () => {
  $('do-login-btn').textContent = '正在获取授权信息...'
  $('do-login-btn').disabled = true

  const res = await window.electronAPI.jimengLoginStart()

  if (!res.success) {
    $('login-step-init').style.display = 'none'
    $('login-step-error').style.display = 'block'
    $('login-error-msg').textContent = '获取登录信息失败: ' + (res.error || '')
    return
  }

  // Show code to user
  $('login-step-init').style.display = 'none'
  $('login-step-code').style.display = 'block'
  $('auth-user-code').textContent = res.user_code || '---'
  $('auth-uri').textContent = res.verification_uri || ''

  // Start polling in background (opens browser automatically)
  window.electronAPI.jimengLoginPoll({
    deviceCode: res.device_code,
    verificationUri: res.verification_uri,
  })
})

$('login-retry-btn').addEventListener('click', () => {
  $('do-login-btn').textContent = '开始登录授权'
  $('do-login-btn').disabled = false
  $('login-step-error').style.display = 'none'
  $('login-step-init').style.display = 'block'
})

// Listen for login result from main process
window.electronAPI.onLoginResult((result) => {
  if (result.success) {
    $('login-step-code').style.display = 'none'
    $('login-step-done').style.display = 'block'
    // Update sidebar status
    setTimeout(() => {
      hideLoginModal()
      checkCLI()
    }, 2000)
  } else {
    $('login-step-code').style.display = 'none'
    $('login-step-error').style.display = 'block'
    $('login-error-msg').textContent = '登录超时或失败，请重试。' + (result.error || '')
  }
})

// ─── Credit ────────────────────────────────────────────────────────
$('credit-badge').addEventListener('click', async () => {
  $('credit-text').textContent = '查询中...'
  try {
    const res = await window.electronAPI.jimengCredit()
    if (res.success) {
      const match = res.output.match(/[\d,]+/)
      $('credit-text').textContent = match ? `💎 ${match[0]}` : '已查询'
    } else {
      $('credit-text').textContent = '需先登录'
    }
  } catch (e) {
    $('credit-text').textContent = '查询失败'
  }
})

// ─── Logging ───────────────────────────────────────────────────────
function addLog(msg, type = '') {
  if (!msg || !msg.trim()) return
  const body = $('log-body')
  const placeholder = body.querySelector('.log-placeholder')
  if (placeholder) placeholder.remove()
  const line = mk('div', `log-line ${type}`, escHtml(msg))
  body.appendChild(line)
  body.scrollTop = body.scrollHeight
}
$('clear-log').addEventListener('click', () => {
  $('log-body').innerHTML = '<div class="log-placeholder">日志将在这里实时显示...</div>'
})

function showSceneOverlay(sceneId, html) {
  const overlay = $(`scene-overlay-${sceneId}`)
  if (!overlay) return
  overlay.style.display = 'grid'
  overlay.innerHTML = html
}

function hideSceneOverlay(sceneId) {
  const overlay = $(`scene-overlay-${sceneId}`)
  if (!overlay) return
  overlay.style.display = 'none'
}

// ─── Phase Indicators ──────────────────────────────────────────────
function setPhase(phase, status) {
  const elem = $(`phase-${phase}`)
  if (!elem) return
  elem.querySelector('.phase-dot').className = `phase-dot ${status}`
  const labels = { running: '进行中', done: '完成 ✓', error: '失败 ✗', '': '等待中' }
  elem.querySelector('.phase-status').textContent = labels[status] ?? '等待中'
}
function resetPhases() {
  ['llm', 'image', 'video'].forEach(p => setPhase(p, ''))
}

// ─── Scene Cards ───────────────────────────────────────────────────
function initSceneCard(scene) {
  const card = mk('div', 'scene-card')
  card.id = `scene-card-${scene.id}`
  card.innerHTML = `
    <div class="scene-media" id="scene-media-${scene.id}">
      <div class="scene-loading-overlay" id="scene-overlay-${scene.id}">
        <div style="text-align:center">
          <div class="scene-spinner"></div>
          <div>图片生成中...</div>
        </div>
      </div>
      <div class="scene-badge">场景 ${scene.id}</div>
    </div>
    <div class="scene-body">
      <div class="scene-num">SCENE ${scene.id}</div>
      <div class="scene-desc">${escHtml(scene.description)}</div>
      <div class="scene-prompts">
        <div class="scene-prompt-tag">
          <span class="prompt-label">IMG</span>
          <textarea class="prompt-edit" id="prompt-edit-${scene.id}" rows="2" disabled>${escHtml(scene.image_prompt)}</textarea>
        </div>
        <div class="scene-prompt-tag">
          <span class="prompt-label">VID</span>
          <span class="prompt-text">${escHtml(scene.video_prompt)}</span>
        </div>
      </div>
      <div class="scene-actions" id="scene-actions-${scene.id}" style="display:none">
        <button class="outline-btn scene-regen-btn" data-scene-id="${scene.id}">🔄 重新生成图片</button>
      </div>
    </div>`
  // Click image to open lightbox
  const mediaEl = card.querySelector('.scene-media')
  mediaEl.addEventListener('click', () => {
    const img = mediaEl.querySelector('img')
    if (img && img.src) openLightbox(img.src)
  })
  // Regen button
  card.querySelector('.scene-regen-btn').addEventListener('click', (e) => {
    e.stopPropagation()
    handleRegenImage(scene.id)
  })
  $('scenes-grid').appendChild(card)
}

async function updateSceneImage(sceneId, imagePath) {
  const media = $(`scene-media-${sceneId}`)
  if (!media) return
  try {
    const res = await window.electronAPI.getFileUrl(imagePath)
    if (!res.success) return
    const existing = media.querySelector('img')
    if (existing) existing.remove()
    const img = document.createElement('img')
    img.src = res.url
    img.onerror = () => { img.src = '' }
    if (state.inReviewMode) {
      hideSceneOverlay(sceneId)
    } else {
      showSceneOverlay(sceneId, '<div style="text-align:center"><div class="scene-spinner"></div><div>等待视频生成...</div></div>')
    }
    media.insertBefore(img, media.firstChild)
  } catch (e) {
    console.error('Failed to load image', e)
  }
}

async function updateSceneVideo(sceneId, videoPath) {
  const media = $(`scene-media-${sceneId}`)
  if (!media) return
  try {
    const res = await window.electronAPI.getFileUrl(videoPath)
    if (!res.success) return
    const video = document.createElement('video')
    video.controls = true
    video.autoplay = false
    video.loop = true
    video.muted = true
    video.src = res.url
    const overlay = $(`scene-overlay-${sceneId}`)
    if (overlay) overlay.remove()
    const existing = media.querySelector('img')
    if (existing) existing.replaceWith(video)
    else media.insertBefore(video, media.firstChild)
  } catch (e) {
    console.error('Failed to load video', e)
  }
}

// ─── Workflow Progress ─────────────────────────────────────────────
function handleProgress(data) {
  const { phase, status, message, sceneId, imagePath, videoPath, data: storyboard, manifest } = data

  // Always log (skip empty log lines)
  const logType = status === 'done' ? 'done' : status === 'error' ? 'error' : status === 'running' || status === 'info' ? 'info' : ''
  if (message) addLog(message, logType)

  switch (phase) {
    case 'llm':
      setPhase('llm', status === 'done' ? 'done' : status === 'error' ? 'error' : 'running')
      if (status === 'done' && storyboard) {
        $('storyboard-title').textContent = `《${storyboard.title}》分镜预览`
        $('scenes-section').style.display = 'block'
        $('scenes-grid').innerHTML = ''
        storyboard.scenes.forEach(s => initSceneCard(s))
        setPhase('image', 'running')
      }
      break

    case 'image':
      if (status === 'running' && sceneId != null) {
        showSceneOverlay(sceneId, '<div style="text-align:center"><div class="scene-spinner"></div><div>图片生成中...</div></div>')
      }
      if (status === 'done' && imagePath && sceneId != null) {
        updateSceneImage(sceneId, imagePath)
      }
      if (status === 'error') {
        setPhase('image', 'error')
        if (sceneId != null) showSceneOverlay(sceneId, '<div style="text-align:center;color:var(--red)">图片生成失败</div>')
      }
      if (status === 'all_done') {
        setPhase('image', 'done')
        $('continue-video-banner').style.display = 'block'
        $('pause-workflow-btn').style.display = 'none'
        $('start-workflow-btn').disabled = false
        $('start-btn-text').textContent = '开始新的工作流'
        state.workflowRunning = false
        state.isPaused = false
        if (manifest) {
          state.currentProject = manifest
          state.lastOutputDir = manifest.outputDir || state.lastOutputDir
        }
        enterReviewMode()
      }
      break

    case 'video':
      if (status === 'running' && sceneId != null) {
        showSceneOverlay(sceneId, '<div style="text-align:center"><div class="scene-spinner"></div><div>视频生成中...</div></div>')
      }
      if (status === 'done' && videoPath && sceneId != null) {
        updateSceneVideo(sceneId, videoPath)
      }
      if (status === 'error') {
        setPhase('video', 'error')
        if (sceneId != null) showSceneOverlay(sceneId, '<div style="text-align:center;color:var(--red)">视频生成失败</div>')
      }
      break

    case 'complete':
      setPhase('video', 'done')
      if (manifest) state.currentProject = manifest
      onWorkflowFinished()
      if (manifest) state.lastOutputDir = manifest.outputDir
      break

    case 'sys':
      if (status === 'paused') {
        $('pause-workflow-btn').style.display = 'none'
        $('start-workflow-btn').disabled = false
        $('start-btn-text').textContent = '重新开始 / 继续'
        state.workflowRunning = false
        state.isPaused = true
      }
      break
  }
}

function onWorkflowFinished() {
  state.workflowRunning = false
  state.isPaused = false
  state.inReviewMode = false
  $('start-workflow-btn').disabled = false
  $('start-btn-text').textContent = '开始生成工作流'
  $('pause-workflow-btn').style.display = 'none'
  $('continue-video-banner').style.display = 'none'
  // Show action buttons if we have a project
  if (state.currentProject) {
    $('open-director-btn').style.display = 'inline-flex'
    $('import-to-editor-btn').style.display = 'inline-flex'
  }
}

// ─── Review Mode ─────────────────────────────────────────────────
function enterReviewMode() {
  state.inReviewMode = true
  // Enable prompt editing and show regen buttons for all scenes
  document.querySelectorAll('.prompt-edit').forEach(el => el.disabled = false)
  document.querySelectorAll('.scene-actions').forEach(el => el.style.display = 'flex')
  document.querySelectorAll('.scene-loading-overlay').forEach(overlay => { overlay.style.display = 'none' })
}

function exitReviewMode() {
  state.inReviewMode = false
  document.querySelectorAll('.prompt-edit').forEach(el => el.disabled = true)
  document.querySelectorAll('.scene-actions').forEach(el => el.style.display = 'none')
}

async function handleRegenImage(sceneId) {
  if (!state.currentProject) return
  const promptEl = $(`prompt-edit-${sceneId}`)
  if (!promptEl) return
  const newPrompt = promptEl.value.trim()
  if (!newPrompt) { promptEl.focus(); return }

  const btn = document.querySelector(`[data-scene-id="${sceneId}"]`)
  if (btn) { btn.disabled = true; btn.textContent = '生成中...' }

  showSceneOverlay(sceneId, '<div style="text-align:center"><div class="scene-spinner"></div><div>重新生成中...</div></div>')

  const mediaParams = getMediaParams()
  const result = await window.electronAPI.directorRegenImage({
    projectId: state.currentProject.id,
    sceneId,
    imagePrompt: newPrompt,
    mediaParams,
  })

  if (btn) { btn.disabled = false; btn.textContent = '🔄 重新生成图片' }

  if (result.success && result.imagePath) {
    addLog(`[分镜 ${sceneId}] ✓ 图片已重新生成`, 'done')
    updateSceneImage(sceneId, result.imagePath)
    hideSceneOverlay(sceneId)
  } else {
    addLog(`[分镜 ${sceneId}] ✗ 重新生成失败: ${result.error || ''}`, 'error')
    showSceneOverlay(sceneId, '<div style="text-align:center;color:var(--red)">❌</div>')
  }
}

// ─── Lightbox ────────────────────────────────────────────────────
function openLightbox(src) {
  const modal = $('lightbox-modal')
  if (!modal) return
  $('lightbox-img').src = src
  modal.style.display = 'flex'
}
function closeLightbox() {
  const modal = $('lightbox-modal')
  if (modal) { modal.style.display = 'none'; $('lightbox-img').src = '' }
}
document.addEventListener('click', (e) => {
  if (e.target.classList.contains('lightbox-backdrop') || e.target.classList.contains('lightbox-close')) closeLightbox()
})
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLightbox() })

// ─── New Project button (in workflow header) ──────────────────────
function resetWorkflowUI() {
  // Abort any running/paused backend workflow
  window.electronAPI.workflowAbort()
  // Clear all form inputs
  $('story-prompt').value = ''
  $('output-dir-input').value = ''
  $('project-name-input').value = ''
  // Clear scenes
  $('scenes-section').style.display = 'none'
  $('scenes-grid').innerHTML = ''
  // Clear logs
  $('log-body').innerHTML = '<div class="log-placeholder">日志将在这里实时显示...</div>'
  // Hide all action buttons
  $('open-director-btn').style.display = 'none'
  $('import-to-editor-btn').style.display = 'none'
  $('continue-video-banner').style.display = 'none'
  $('pause-workflow-btn').style.display = 'none'
  // Reset button text
  $('start-workflow-btn').disabled = false
  $('start-btn-text').textContent = '开始生成工作流'
  // Reset state
  state.outputDir = ''
  state.currentProject = null
  state.workflowRunning = false
  state.isPaused = false
  state.inReviewMode = false
  resetPhases()
}

$('new-project-header-btn').addEventListener('click', resetWorkflowUI)

$('open-director-btn').addEventListener('click', () => {
  if (state.currentProject) {
    state.directorProject = state.currentProject
    switchTab('director')
  }
})

$('import-to-editor-btn').addEventListener('click', async () => {
  if (!state.currentProject) return
  await importProjectToEditor(state.currentProject.id)
})

// ─── Start Workflow ────────────────────────────────────────────────
$('start-workflow-btn').addEventListener('click', async () => {
  const prompt = $('story-prompt').value.trim()
  if (!prompt) {
    $('story-prompt').focus()
    return
  }
  if (state.workflowRunning) return

  const settings = await window.electronAPI.getSettings()
  if (!settings.llmApiKey) {
    addLog('⚠️  请先在「设置」页配置 LLM API Key，然后重试', 'error')
    switchTab('settings')
    return
  }

  const mediaParams = getMediaParams()

  // Resume logic — use state flag instead of button text
  if (state.isPaused && state.currentProject) {
    state.workflowRunning = true
    $('start-workflow-btn').disabled = true
    $('start-btn-text').textContent = '生成中...'
    $('pause-workflow-btn').style.display = 'inline-flex'
    $('pause-workflow-btn').disabled = false
    $('pause-workflow-btn').textContent = '⏸️ 暂停'
    $('continue-video-banner').style.display = 'none'

    const result = await window.electronAPI.workflowResume(mediaParams)
    if (!result.success) {
      if (result.error !== 'Workflow returned null') {
        addLog(`❌ 恢复执行失败: ${result.error || ''}`, 'error')
      }
      onWorkflowFinished()
    } else if (result.manifest || result.project) {
      state.currentProject = result.manifest || result.project
    }
    return
  }

  state.workflowRunning = true
  $('start-workflow-btn').disabled = true
  $('start-btn-text').textContent = '生成中...'
  $('pause-workflow-btn').style.display = 'inline-flex'
  $('continue-video-banner').style.display = 'none'
  $('scenes-section').style.display = 'none'
  $('scenes-grid').innerHTML = ''
  $('log-body').innerHTML = ''
  $('open-director-btn').style.display = 'none'
  resetPhases()
  setPhase('llm', 'running')

  if (state.removeProgressListener) {
    state.removeProgressListener()
    state.removeProgressListener = null
  }
  state.removeProgressListener = window.electronAPI.onWorkflowProgress(handleProgress)

  const projectName = $('project-name-input').value.trim() || null

  const result = await window.electronAPI.startWorkflow({
    prompt,
    sceneCount: state.sceneCount,
    outputDir: state.outputDir || null,
    projectName,
    mediaParams,
  })

  if (!result.success) {
    if (result.error !== 'Workflow returned null') {
      addLog(`❌ 工作流中止或失败: ${result.error || ''}`, 'error')
    }
    onWorkflowFinished()
  } else if (result.manifest || result.project) {
    state.currentProject = result.manifest || result.project
  }
})

$('open-output-folder').addEventListener('click', () => {
  if (state.lastOutputDir) window.electronAPI.openFolder(state.lastOutputDir)
})

// ─── Settings ──────────────────────────────────────────────────────
async function loadSettings() {
  const s = await window.electronAPI.getSettings()
  $('llm-base-url').value = s.llmBaseUrl || ''
  $('llm-api-key').value = s.llmApiKey || ''
  $('llm-model').value = s.llmModel || 'gpt-4o'
  $('jimeng-cli-path').value = s.jimengCliPath || '/Users/huihui/.local/bin/dreamina'
  $('image-resolution').value = s.imageResolutionType || '2k'
  $('image-ratio').value = s.imageRatio || '16:9'
  $('video-model').value = s.videoModel || 'seedance2.0_vip'
  $('video-duration').value = s.videoDuration || 5
  $('video-resolution').value = s.videoResolution || '1080p'
}

$('save-settings-btn').addEventListener('click', async () => {
  await window.electronAPI.saveSettings({
    llmBaseUrl: $('llm-base-url').value.trim(),
    llmApiKey: $('llm-api-key').value.trim(),
    llmModel: $('llm-model').value.trim() || 'gpt-4o',
    jimengCliPath: $('jimeng-cli-path').value.trim() || 'dreamina',
    imageResolutionType: $('image-resolution').value,
    imageRatio: $('image-ratio').value,
    videoModel: $('video-model').value,
    videoDuration: parseInt($('video-duration').value) || 5,
    videoResolution: $('video-resolution').value,
  })
  const s = $('save-status')
  s.textContent = '✓ 设置已保存'
  setTimeout(() => (s.textContent = ''), 2500)
})

// Real LLM connection test
$('test-llm-btn').addEventListener('click', async () => {
  // Save current values first
  await window.electronAPI.saveSettings({
    llmBaseUrl: $('llm-base-url').value.trim(),
    llmApiKey: $('llm-api-key').value.trim(),
    llmModel: $('llm-model').value.trim() || 'gpt-4o',
  })
  $('test-llm-btn').textContent = '测试中...'
  $('test-llm-btn').disabled = true
  const res = await window.electronAPI.testLLM()
  $('test-llm-btn').disabled = false
  if (res.success) {
    $('test-llm-btn').textContent = '✓ 连接成功'
    setTimeout(() => ($('test-llm-btn').textContent = '测试连接'), 3000)
  } else {
    $('test-llm-btn').textContent = '✗ 连接失败'
    $('save-status').textContent = `错误: ${res.error}`
    setTimeout(() => {
      $('test-llm-btn').textContent = '测试连接'
      $('save-status').textContent = ''
    }, 5000)
  }
})

$('test-cli-btn').addEventListener('click', async () => {
  $('test-cli-btn').textContent = '检测中...'
  $('test-cli-btn').disabled = true
  await window.electronAPI.saveSettings({
    jimengCliPath: $('jimeng-cli-path').value.trim() || 'dreamina',
  })
  await checkCLI()
  $('test-cli-btn').textContent = '检测 CLI'
  $('test-cli-btn').disabled = false
})

// ─── Agent Chat ────────────────────────────────────────────────────
function addChatMessage(role, html) {
  const wrap = mk('div', `chat-message ${role}`)
  const avatar = mk('div', 'msg-avatar', role === 'assistant' ? '✦' : '👤')
  const bubble = mk('div', 'msg-bubble', html)
  wrap.appendChild(avatar)
  wrap.appendChild(bubble)
  $('chat-messages').appendChild(wrap)
  $('chat-messages').scrollTop = $('chat-messages').scrollHeight
  return bubble
}

async function sendChat() {
  const input = $('chat-input')
  const text = input.value.trim()
  if (!text || input.disabled) return

  input.value = ''
  input.disabled = true
  $('send-chat-btn').disabled = true

  addChatMessage('user', `<p>${escHtml(text)}</p>`)

  // Show thinking animation
  const bubble = addChatMessage('assistant', '<span class="thinking">思考中<span class="dots">...</span></span>')

  // Add to history before call
  state.chatHistory.push({ role: 'user', content: text })

  try {
    const res = await window.electronAPI.agentChat({
      history: state.chatHistory.slice(-10),
      userMessage: text,
    })

    if (!res.success) {
      bubble.innerHTML = `<p>⚠️ ${escHtml(res.error)}</p><p style="font-size:12px;color:var(--text-muted)">请先到「设置」页配置 LLM API Key</p>`
      state.chatHistory.pop()
    } else {
      const reply = res.reply || ''

      // Parse optional ACTION directive inserted by LLM
      const actionMatch = reply.match(/\[ACTION:START_WORKFLOW:([^\]]+)\]/)
      const displayReply = reply.replace(/\[ACTION:START_WORKFLOW:[^\]]+\]/g, '').trim()

      // Render: blank lines → paragraphs, single newlines → <br>
      const htmlReply = displayReply
        .split(/\n{2,}/)
        .filter(p => p.trim())
        .map(p => `<p>${escHtml(p.trim()).replace(/\n/g, '<br>')}</p>`)
        .join('')
      bubble.innerHTML = htmlReply || '<p>（无回复）</p>'

      state.chatHistory.push({ role: 'assistant', content: displayReply })

      // If LLM decided to start workflow automatically
      if (actionMatch) {
        const storyPrompt = actionMatch[1].trim()
        const autoRun = $('auto-run-toggle')?.checked !== false
        if (autoRun) {
          setTimeout(() => {
            addChatMessage('assistant', '<p>🚀 正在切换到工作流页面，自动开始生成...</p>')
            document.querySelector('[data-tab="workflow"]').click()
            $('story-prompt').value = storyPrompt
            setTimeout(() => $('start-workflow-btn').click(), 400)
          }, 800)
        }
      }
    }
  } catch (e) {
    bubble.innerHTML = `<p>❌ 请求失败: ${escHtml(e.message)}</p>`
    state.chatHistory.pop()
  }

  input.disabled = false
  $('send-chat-btn').disabled = false
  input.focus()
}

$('send-chat-btn').addEventListener('click', sendChat)
$('chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat() }
})

// ─── Project Manager ───────────────────────────────────────────────
const STATUS_LABELS = { done: '✅ 完成', partial: '⚠️ 部分完成', generating: '⏳ 生成中', draft: '草稿' }

async function renderProjects() {
  const grid = $('projects-grid')
  const empty = $('projects-empty')
  const res = await window.electronAPI.projectList()
  if (!res.success || !res.projects.length) {
    grid.innerHTML = ''
    grid.appendChild(empty)
    empty.style.display = 'flex'
    return
  }
  empty.style.display = 'none'
  grid.innerHTML = ''

  for (const proj of res.projects) {
    const card = mk('div', 'project-card')

    // Thumbnail mosaic (up to 4 images)
    const thumb = mk('div', 'project-card-thumb')
    const imgScenes = (proj.scenes || []).filter(s => s.imagePath)
    if (imgScenes.length === 0) {
      thumb.innerHTML = '<div class="project-card-thumb-empty">🎬</div>'
    } else {
      for (const s of imgScenes.slice(0, 4)) {
        const img = document.createElement('img')
        img.src = 'file://' + s.imagePath
        img.onerror = () => { img.style.display = 'none' }
        thumb.appendChild(img)
      }
    }

    const statusBadge = `<span class="project-status-badge ${proj.status || 'draft'}">${STATUS_LABELS[proj.status] || proj.status}</span>`
    const sceneCount = (proj.scenes || []).length
    const videoCount = (proj.scenes || []).filter(s => s.videoPath && s.videoPath !== s.imagePath).length
    const date = new Date(proj.updatedAt).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

    card.innerHTML = `
      <div class="project-card-thumb"></div>
      <div class="project-card-name" title="${escHtml(proj.name)}">${escHtml(proj.name)}</div>
      <div class="project-card-meta">
        ${statusBadge}
        <span>${sceneCount} 个分镜，${videoCount} 个视频</span>
        <span>${date}</span>
      </div>
      <div class="project-card-actions">
        <button class="project-action-btn" data-action="open" data-id="${proj.id}">📂 打开目录</button>
        <button class="project-action-btn" data-action="load" data-id="${proj.id}">▶ 加载分镜</button>
        <button class="project-action-btn" data-action="director" data-id="${proj.id}">🎬 导演</button>
        <button class="project-action-btn danger" data-action="delete" data-id="${proj.id}">🗑</button>
      </div>`

    // Insert real thumbnail
    card.querySelector('.project-card-thumb').replaceWith(thumb)

    card.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-action]')
      if (!btn) return
      const id = btn.dataset.id
      const action = btn.dataset.action
      if (action === 'open') {
        const p = await window.electronAPI.projectLoad(id)
        if (p.success && p.project.outputDir) window.electronAPI.openFolder(p.project.outputDir)
      } else if (action === 'load') {
        await loadProjectIntoWorkflow(id)
      } else if (action === 'director') {
        const p = await window.electronAPI.projectLoad(id)
        if (p.success) {
          state.directorProject = p.project
          switchTab('director')
        }
      } else if (action === 'delete') {
        if (!confirm(`确定删除项目「${proj.name}」吗？\n（仅删除项目记录，不删除输出文件）`)) return
        await window.electronAPI.projectDelete(id)
        renderProjects()
      }
    })

    grid.appendChild(card)
  }
}

async function loadProjectIntoWorkflow(id) {
  const res = await window.electronAPI.projectLoad(id)
  if (!res.success) { alert('加载失败: ' + res.error); return }
  const proj = res.project

  switchTab('workflow')
  $('story-prompt').value = proj.prompt || ''
  $('project-name-input').value = proj.name || ''
  state.outputDir = proj.outputDir
  $('output-dir-input').value = proj.outputDir || ''
  state.currentProject = proj

  // Restore media params
  if (proj.mediaParams) setMediaParams(proj.mediaParams)

  // Show existing scenes
  if (proj.scenes && proj.scenes.length) {
    $('storyboard-title').textContent = `《${proj.name}》分镜预览`
    $('scenes-section').style.display = 'block'
    $('open-director-btn').style.display = 'inline-flex'
    $('scenes-grid').innerHTML = ''
    proj.scenes.forEach(s => {
      initSceneCard(s)
      if (s.imagePath) updateSceneImage(s.id, s.imagePath)
      if (s.videoPath && s.videoPath !== s.imagePath) updateSceneVideo(s.id, s.videoPath)
    })
  }
}

// New project button → switch to workflow with cleared state
$('new-project-btn').addEventListener('click', () => {
  switchTab('workflow')
  resetWorkflowUI()
})

// Import project from manifest.json
$('import-project-btn').addEventListener('click', async () => {
  const res = await window.electronAPI.projectImport()
  if (res.canceled) return
  if (!res.success) { alert('导入失败: ' + res.error); return }
  renderProjects()
})

// ─── Pause Workflow ────────────────────────────────────────────────
$('pause-workflow-btn').addEventListener('click', () => {
  $('pause-workflow-btn').disabled = true
  $('pause-workflow-btn').textContent = '正在暂停...'
  window.electronAPI.workflowPause()
})

// ─── Continue Video Generation ─────────────────────────────────────
$('continue-video-btn').addEventListener('click', async () => {
  $('continue-video-banner').style.display = 'none'
  $('pause-workflow-btn').style.display = 'inline-flex'
  $('pause-workflow-btn').disabled = false
  $('pause-workflow-btn').textContent = '⏸️ 暂停'
  $('start-workflow-btn').disabled = true
  $('start-btn-text').textContent = '生成中...'
  state.workflowRunning = true
  state.isPaused = false
  exitReviewMode()
  setPhase('video', 'running')
  
  const mediaParams = getMediaParams()
  const result = await window.electronAPI.workflowResume(mediaParams)
  if (!result.success) {
    if (result.error !== 'Workflow returned null') {
      addLog(`❌ 视频生成中止或失败: ${result.error || ''}`, 'error')
    }
    onWorkflowFinished()
  } else if (result.manifest || result.project) {
    state.currentProject = result.manifest || result.project
  }
})

// ─── Save & Load Settings ──────────────────────────────────────────
// ─── Import Project → Editor (shared by workflow + director) ─────
async function importProjectToEditor(workflowProjectId) {
  const res = await window.electronAPI.editorProjectCreateFromWorkflow(workflowProjectId)
  if (!res.success) { alert('创建剪辑项目失败: ' + res.error); return }
  const edp = res.project
  // Switch to editor tab and load the project
  state.editorCurrentProject = edp
  switchTab('editor')
  // editor.js will pick it up via window.EDITOR_LOAD_PROJECT
  window.__pendingEditorProject = edp
  // Trigger load if editor already initialized
  if (window.__editorLoadProject) window.__editorLoadProject(edp)
}

$('director-goto-gallery').addEventListener('click', () => switchTab('gallery'))
$('director-import-to-editor-btn').addEventListener('click', async () => {
  if (state.directorProject) await importProjectToEditor(state.directorProject.id)
})

$('director-pick-project').addEventListener('click', () => switchTab('gallery'))
$('clear-director-log').addEventListener('click', () => {
  $('director-log-body').innerHTML = '<div class="log-placeholder">操作日志将在这里显示...</div>'
})

function addDirectorLog(msg, type = '') {
  const body = $('director-log-body')
  const ph = body.querySelector('.log-placeholder')
  if (ph) ph.remove()
  const line = mk('div', `log-line ${type}`, escHtml(msg))
  body.appendChild(line)
  body.scrollTop = body.scrollHeight
}

function renderDirectorIfReady() {
  const proj = state.directorProject
  if (!proj) {
    $('director-no-project').style.display = 'flex'
    $('director-scenes').style.display = 'none'
    $('director-subtitle').textContent = '选择一个项目开始二次调整'
    $('director-project-badge').style.display = 'none'
    $('director-import-to-editor-btn').style.display = 'none'
    return
  }
  $('director-no-project').style.display = 'none'
  $('director-scenes').style.display = 'block'
  $('director-subtitle').textContent = `共 ${proj.scenes?.length || 0} 个分镜可二次调整`
  $('director-project-badge').textContent = proj.name
  $('director-project-badge').style.display = 'inline-block'
  $('director-import-to-editor-btn').style.display = 'inline-flex'
  renderDirectorScenes(proj)

  // Subscribe to director progress
  if (state.removeDirectorListener) state.removeDirectorListener()
  state.removeDirectorListener = window.electronAPI.onDirectorProgress((data) => {
    addDirectorLog(data.message, data.type === 'done' ? 'done' : data.type === 'error' ? 'error' : 'info')
  })
}

async function renderDirectorScenes(proj) {
  const list = $('director-scene-list')
  list.innerHTML = ''

  for (const scene of (proj.scenes || [])) {
    const mp = proj.mediaParams || {}
    const card = mk('div', 'director-scene-card')
    card.id = `dcard-${scene.id}`

    const backupRes = await window.electronAPI.directorListBackups({ projectId: proj.id, sceneId: scene.id })
    const backupCount = backupRes.success ? backupRes.backups.length : 0

    card.innerHTML = `
      <div class="director-scene-header">
        <span class="director-scene-num">SCENE ${scene.id}</span>
        <div style="display:flex;gap:8px;align-items:center">
          ${backupCount > 0 ? `<button class="director-backup-count" data-scene="${scene.id}">🗃 ${backupCount} 个备份</button>` : ''}
        </div>
      </div>

      <div class="director-media-row">
        <div class="director-media-slot">
          <div class="director-media-label">🖼 图片</div>
          <div class="director-preview" id="dpreview-img-${scene.id}">
            ${scene.imagePath ? `<img src="file://${scene.imagePath}" />` : '<div class="director-preview-empty">🖼</div>'}
          </div>
          <textarea class="director-prompt-area" id="dprompt-img-${scene.id}">${escHtml(scene.image_prompt || '')}</textarea>
          <div class="director-params-row">
            <select class="param-select" id="dp-img-ratio-${scene.id}" style="flex:1">
              <option value="16:9" ${(mp.imageRatio||'16:9')==='16:9'?'selected':''}>16:9</option>
              <option value="9:16" ${mp.imageRatio==='9:16'?'selected':''}>9:16</option>
              <option value="1:1" ${mp.imageRatio==='1:1'?'selected':''}>1:1</option>
            </select>
            <select class="param-select" id="dp-img-res-${scene.id}" style="flex:1">
              <option value="2k" ${(mp.imageResolutionType||'2k')==='2k'?'selected':''}>2K</option>
              <option value="4k" ${mp.imageResolutionType==='4k'?'selected':''}>4K</option>
              <option value="1k" ${mp.imageResolutionType==='1k'?'selected':''}>1K</option>
            </select>
            <button class="director-regen-btn" id="dregen-img-${scene.id}">🔄 重新生成图片</button>
          </div>
        </div>

        <div class="director-media-slot">
          <div class="director-media-label">🎬 视频</div>
          <div class="director-preview" id="dpreview-vid-${scene.id}">
            ${scene.videoPath && scene.videoPath !== scene.imagePath
              ? `<video src="file://${scene.videoPath}" controls muted loop></video>`
              : '<div class="director-preview-empty">🎬</div>'}
          </div>
          <textarea class="director-prompt-area" id="dprompt-vid-${scene.id}">${escHtml(scene.video_prompt || '')}</textarea>
          <div class="director-params-row">
            <select class="param-select" id="dp-vid-model-${scene.id}" style="flex:1">
              <option value="seedance2.0_vip" ${(!mp.videoModel||mp.videoModel==='seedance2.0_vip')?'selected':''}>VIP</option>
              <option value="seedance2.0" ${mp.videoModel==='seedance2.0'?'selected':''}>2.0</option>
              <option value="seedance2.0fast_vip" ${mp.videoModel==='seedance2.0fast_vip'?'selected':''}>Fast VIP</option>
            </select>
            <input type="number" class="param-select" id="dp-vid-dur-${scene.id}" value="${mp.videoDuration||5}" min="3" max="15" style="width:56px" />
            <select class="param-select" id="dp-vid-res-${scene.id}" style="flex:1">
              <option value="1080p" ${(!mp.videoResolution||mp.videoResolution==='1080p')?'selected':''}>1080p</option>
              <option value="720p" ${mp.videoResolution==='720p'?'selected':''}>720p</option>
            </select>
            <button class="director-regen-btn video-btn" id="dregen-vid-${scene.id}">🔄 重新生成视频</button>
          </div>
        </div>
      </div>`

    // Backup drawer toggle
    card.querySelector('.director-backup-count')?.addEventListener('click', async (e) => {
      e.stopPropagation()
      const existing = card.querySelector('.backup-drawer')
      if (existing) { existing.remove(); return }
      const r = await window.electronAPI.directorListBackups({ projectId: proj.id, sceneId: scene.id })
      if (!r.success || !r.backups.length) return
      const drawer = mk('div', 'backup-drawer')
      drawer.innerHTML = `<div class="backup-drawer-title">🗃 历史备份（重新生成前自动保存）</div>` +
        r.backups.map(b => `
          <div class="backup-item">
            <span class="backup-item-name">${escHtml(b.name)}</span>
            <span class="backup-item-meta">${(b.size/1024/1024).toFixed(1)} MB · ${b.type}</span>
            <button class="backup-open-btn" data-file="${b.file}">📂</button>
          </div>`).join('')
      drawer.querySelectorAll('.backup-open-btn').forEach(btn => {
        btn.addEventListener('click', () => window.electronAPI.openFolder(btn.dataset.file.replace(/\/[^/]+$/, '')))
      })
      card.appendChild(drawer)
    })

    // Regen image
    card.querySelector(`#dregen-img-${scene.id}`).addEventListener('click', async () => {
      if (state.directorBusy) { addDirectorLog('上一个任务还未完成，请等待...', 'error'); return }
      state.directorBusy = true
      const btn = card.querySelector(`#dregen-img-${scene.id}`)
      btn.disabled = true; btn.textContent = '生成中...'
      const imgPrompt = card.querySelector(`#dprompt-img-${scene.id}`).value.trim()
      const sceneMP = { ...proj.mediaParams,
        imageRatio: card.querySelector(`#dp-img-ratio-${scene.id}`).value,
        imageResolutionType: card.querySelector(`#dp-img-res-${scene.id}`).value,
      }
      const res = await window.electronAPI.directorRegenImage({
        projectId: proj.id, sceneId: scene.id, imagePrompt: imgPrompt, mediaParams: sceneMP
      })
      if (res.success) {
        card.querySelector(`#dpreview-img-${scene.id}`).innerHTML = `<img src="file://${res.imagePath}?t=${Date.now()}" />`
        state.directorProject = res.project
        addDirectorLog(`✓ 分镜 ${scene.id} 图片重新生成完成`, 'done')
      } else { addDirectorLog(`✗ 失败: ${res.error}`, 'error') }
      btn.disabled = false; btn.textContent = '🔄 重新生成图片'
      state.directorBusy = false
    })

    // Regen video
    card.querySelector(`#dregen-vid-${scene.id}`).addEventListener('click', async () => {
      if (state.directorBusy) { addDirectorLog('上一个任务还未完成，请等待...', 'error'); return }
      state.directorBusy = true
      const btn = card.querySelector(`#dregen-vid-${scene.id}`)
      btn.disabled = true; btn.textContent = '生成中...'
      const vidPrompt = card.querySelector(`#dprompt-vid-${scene.id}`).value.trim()
      const sceneMP = { ...proj.mediaParams,
        videoModel: card.querySelector(`#dp-vid-model-${scene.id}`).value,
        videoDuration: parseInt(card.querySelector(`#dp-vid-dur-${scene.id}`).value) || 5,
        videoResolution: card.querySelector(`#dp-vid-res-${scene.id}`).value,
      }
      const res = await window.electronAPI.directorRegenVideo({
        projectId: proj.id, sceneId: scene.id, videoPrompt: vidPrompt, mediaParams: sceneMP
      })
      if (res.success) {
        card.querySelector(`#dpreview-vid-${scene.id}`).innerHTML = `<video src="file://${res.videoPath}?t=${Date.now()}" controls muted loop></video>`
        state.directorProject = res.project
        addDirectorLog(`✓ 分镜 ${scene.id} 视频重新生成完成`, 'done')
      } else { addDirectorLog(`✗ 失败: ${res.error}`, 'error') }
      btn.disabled = false; btn.textContent = '🔄 重新生成视频'
      state.directorBusy = false
    })

    list.appendChild(card)
  }
}

// ─── Accounts Routing & Management ───────────────────────────────────
let isPollingAccountLogin = false
let currentPollingAccountId = null

async function initAccountSelector() {
  const select = $('account-select')
  if (!select) return
  select.innerHTML = '<option value="">载入中...</option>'

  try {
    const list = await window.electronAPI.accountList()
    const active = await window.electronAPI.accountActive()

    select.innerHTML = ''
    if (list.length === 0) {
      select.innerHTML = '<option value="">(无账号，请添加)</option>'
      $('credit-text').textContent = '需先登录'
      return
    }

    list.forEach(acc => {
      const opt = document.createElement('option')
      opt.value = acc.id
      opt.textContent = `${acc.name} (${acc.credits !== null ? acc.credits + ' 💎' : '未知积分'})`
      if (active && acc.id === active.id) {
        opt.selected = true
        // Update sidebar credit display
        $('credit-text').textContent = acc.credits !== null ? `💎 ${acc.credits}` : '已登录'
      }
      select.appendChild(opt)
    })
  } catch (e) {
    console.error('Failed to load accounts in selector', e)
    select.innerHTML = '<option value="">加载失败</option>'
  }
}

// Open Account Manager Modal
async function showAccountManager() {
  $('account-manager-modal').style.display = 'grid'
  $('new-account-name-input').value = ''
  $('router-login-polling-box').style.display = 'none'
  await renderAccountsList()
}

function hideAccountManager() {
  $('account-manager-modal').style.display = 'none'
  initAccountSelector()
  checkCLI()
}

// Render Accounts List inside Modal Table
async function renderAccountsList() {
  const tbody = $('accounts-table-body')
  if (!tbody) return
  tbody.innerHTML = '<tr><td colspan="5" style="text-align:center">加载中...</td></tr>'

  try {
    const list = await window.electronAPI.accountList()
    const active = await window.electronAPI.accountActive()

    tbody.innerHTML = ''
    if (list.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-muted)">暂无账号，请在下方登录添加新账号</td></tr>'
      return
    }

    list.forEach(acc => {
      const isActive = active && acc.id === active.id
      const tr = document.createElement('tr')
      
      // Status column
      const statusTd = document.createElement('td')
      if (isActive) {
        statusTd.innerHTML = '<span class="active-account-badge">活跃</span>'
      } else {
        const switchBadge = document.createElement('span')
        switchBadge.className = 'inactive-account-badge'
        switchBadge.textContent = '切换'
        switchBadge.addEventListener('click', async () => {
          await window.electronAPI.accountSwitch(acc.id)
          renderAccountsList()
        })
        statusTd.appendChild(switchBadge)
      }
      tr.appendChild(statusTd)

      // Name column (editable via rename button)
      const nameTd = document.createElement('td')
      nameTd.style.fontWeight = '500'
      nameTd.textContent = acc.name
      tr.appendChild(nameTd)

      // Credits column
      const creditsTd = document.createElement('td')
      creditsTd.textContent = acc.credits !== null ? `${acc.credits} 💎` : '未知'
      tr.appendChild(creditsTd)

      // VIP Level column
      const vipTd = document.createElement('td')
      vipTd.textContent = acc.vipLevel || '普通'
      tr.appendChild(vipTd)

      // Actions column
      const actionsTd = document.createElement('td')
      const btnGrp = document.createElement('div')
      btnGrp.className = 'account-action-buttons'

      // Refresh credit button
      const refreshBtn = document.createElement('button')
      refreshBtn.className = 'account-action-btn'
      refreshBtn.textContent = '🔄 刷新'
      refreshBtn.addEventListener('click', async () => {
        refreshBtn.disabled = true
        refreshBtn.textContent = '刷新中...'
        await window.electronAPI.accountCheckCredit(acc.id)
        renderAccountsList()
      })
      btnGrp.appendChild(refreshBtn)

      // Rename button
      const renameBtn = document.createElement('button')
      renameBtn.className = 'account-action-btn'
      renameBtn.textContent = '📝 备注'
      renameBtn.addEventListener('click', async () => {
        const newName = prompt('输入该账号新的备注名称:', acc.name)
        if (newName && newName.trim()) {
          await window.electronAPI.accountRename({ accountId: acc.id, newName: newName.trim() })
          renderAccountsList()
        }
      })
      btnGrp.appendChild(renameBtn)

      // Delete button
      if (!isActive) {
        const deleteBtn = document.createElement('button')
        deleteBtn.className = 'account-action-btn delete'
        deleteBtn.textContent = '🗑️ 删除'
        deleteBtn.addEventListener('click', async () => {
          if (confirm(`确定要删除账号 "${acc.name}" 的本地Session吗？这将断开该账号关联。`)) {
            await window.electronAPI.accountDelete(acc.id)
            renderAccountsList()
          }
        })
        btnGrp.appendChild(deleteBtn)
      }

      actionsTd.appendChild(btnGrp)
      tr.appendChild(actionsTd)
      tbody.appendChild(tr)
    })
  } catch (e) {
    console.error('Failed to render accounts list', e)
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--red)">加载失败</td></tr>'
  }
}

// Start head-less OAuth login flow inside router manager
async function handleRouterAddAccount() {
  const nameInput = $('new-account-name-input')
  const remarkName = nameInput.value.trim()
  if (!remarkName) {
    nameInput.focus()
    return
  }

  const addBtn = $('add-account-btn')
  addBtn.disabled = true
  addBtn.textContent = '请求中...'

  try {
    const res = await window.electronAPI.accountLoginStart(remarkName)
    if (!res.accountId) {
      alert('无法开启登录授权，请检查即梦 CLI 安装状态。')
      addBtn.disabled = false
      addBtn.textContent = '🔑 扫码/授权登录'
      return
    }

    // Show verification URI & code in modal
    $('router-login-polling-box').style.display = 'block'
    $('router-auth-user-code').textContent = res.userCode || '---'
    $('router-auth-uri').textContent = res.verificationUri || ''

    isPollingAccountLogin = true
    currentPollingAccountId = res.accountId

    $('router-polling-status-text').textContent = '等待浏览器授权中...（120秒有效）'

    // Start polling in background
    const pollRes = await window.electronAPI.accountLoginPoll({
      accountId: res.accountId,
      deviceCode: res.deviceCode,
      timeout: 120
    })

    isPollingAccountLogin = false
    $('router-login-polling-box').style.display = 'none'
    addBtn.disabled = false
    addBtn.textContent = '🔑 扫码/授权登录'
    nameInput.value = ''

    if (pollRes.success) {
      alert(`账号 "${remarkName}" 登录并绑定成功！`)
      renderAccountsList()
    } else {
      alert('账号登录授权失败或超时: ' + (pollRes.error || pollRes.output || ''))
    }
  } catch (e) {
    console.error('Failed to start login inside account manager', e)
    alert('启动登录授权失败: ' + e.message)
    addBtn.disabled = false
    addBtn.textContent = '🔑 扫码/授权登录'
  }
}

// Bind accounts UI listeners
if ($('account-select')) {
  $('account-select').addEventListener('change', async (e) => {
    const val = e.target.value
    if (val) {
      await window.electronAPI.accountSwitch(val)
      initAccountSelector()
      checkCLI()
    }
  })
}

if ($('account-manage-btn')) $('account-manage-btn').addEventListener('click', showAccountManager)
if ($('account-manager-close')) $('account-manager-close').addEventListener('click', hideAccountManager)
if ($('account-manager-modal')) {
  $('account-manager-modal').addEventListener('click', (e) => {
    if (e.target === $('account-manager-modal')) hideAccountManager()
  })
}
if ($('add-account-btn')) $('add-account-btn').addEventListener('click', handleRouterAddAccount)
if ($('refresh-all-accounts-btn')) {
  $('refresh-all-accounts-btn').addEventListener('click', async () => {
    $('refresh-all-accounts-btn').disabled = true
    $('refresh-all-accounts-btn').textContent = '刷新中...'
    await window.electronAPI.accountCheckAll()
    await renderAccountsList()
    await initAccountSelector()
    $('refresh-all-accounts-btn').disabled = false
    $('refresh-all-accounts-btn').textContent = '刷新全部积分'
  })
}
if ($('auto-select-account-btn')) {
  $('auto-select-account-btn').addEventListener('click', async () => {
    $('auto-select-account-btn').disabled = true
    $('auto-select-account-btn').textContent = '选择中...'
    await window.electronAPI.accountAutoSelect(1)
    await renderAccountsList()
    await initAccountSelector()
    await checkCLI()
    $('auto-select-account-btn').disabled = false
    $('auto-select-account-btn').textContent = '自动选择可用账号'
  })
}

// ─── Init ──────────────────────────────────────────────────────────
loadSettings()
initAccountSelector()
checkCLI()
renderProjects()
updateParamsSummary()
