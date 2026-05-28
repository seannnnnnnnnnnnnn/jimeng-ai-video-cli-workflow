const { app, BrowserWindow, ipcMain, shell, dialog, protocol } = require('electron')
const path = require('path')
const fs = require('fs')

const { loadSettings, saveSettings } = require('./store')
const JimengRunner = require('./jimeng-runner')
const LLMClient = require('./llm-client')
const WorkflowOrchestrator = require('./workflow')
const PM = require('./project-manager')
const { Director, listBackups, getFileInfo } = require('./director')
const { exportVideo, FFMPEG_BIN } = require('./editor-exporter')
const AccountRouter = require('./account-router')

let mainWindow = null
const isDev = !app.isPackaged

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#0d0f14',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false, // allow local file:// media loading
    },
  })

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173')
    mainWindow.webContents.openDevTools()  // uncomment to debug
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  mainWindow.on('closed', () => { mainWindow = null })
}

app.whenReady().then(async () => {
  // Initialize AccountRouter for multi-account CLI isolation
  const router = new AccountRouter()
  try {
    await router.init()
    global.accountRouter = router
    console.log('[AccountRouter] Initialized successfully')
  } catch (err) {
    console.error('[AccountRouter] Failed to initialize:', err)
  }

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// ─── IPC: Accounts ────────────────────────────────────────────────
ipcMain.handle('account:list', async () => {
  if (!global.accountRouter) return []
  return global.accountRouter.listAccounts()
})

ipcMain.handle('account:active', async () => {
  if (!global.accountRouter) return null
  return global.accountRouter.getActiveAccount()
})

ipcMain.handle('account:switch', async (event, accountId) => {
  if (!global.accountRouter) throw new Error('AccountRouter 未就绪')
  return global.accountRouter.switchAccount(accountId)
})

ipcMain.handle('account:rename', async (event, { accountId, newName }) => {
  if (!global.accountRouter) throw new Error('AccountRouter 未就绪')
  return global.accountRouter.renameAccount(accountId, newName)
})

ipcMain.handle('account:delete', async (event, accountId) => {
  if (!global.accountRouter) throw new Error('AccountRouter 未就绪')
  global.accountRouter.deleteAccount(accountId)
  return { success: true }
})

ipcMain.handle('account:login-start', async (event, accountName) => {
  if (!global.accountRouter) throw new Error('AccountRouter 未就绪')
  const result = await global.accountRouter.startLogin(accountName)
  if (result && result.verificationUri) {
    shell.openExternal(result.verificationUri)
  }
  return result
})

ipcMain.handle('account:login-poll', async (event, { accountId, deviceCode, timeout }) => {
  if (!global.accountRouter) throw new Error('AccountRouter 未就绪')
  return global.accountRouter.pollLogin(accountId, deviceCode, timeout)
})

ipcMain.handle('account:check-credit', async (event, accountId) => {
  if (!global.accountRouter) throw new Error('AccountRouter 未就绪')
  return global.accountRouter.checkCredit(accountId)
})

ipcMain.handle('account:check-all', async () => {
  if (!global.accountRouter) throw new Error('AccountRouter 未就绪')
  return global.accountRouter.checkAllCredits()
})

ipcMain.handle('account:auto-select', async (event, minCredits = 1) => {
  if (!global.accountRouter) throw new Error('AccountRouter 未就绪')
  return global.accountRouter.selectAvailableAccount(minCredits)
})

// ─── IPC: Settings ───────────────────────────────────────────────
ipcMain.handle('settings:get', async () => loadSettings())

ipcMain.handle('settings:save', async (event, settings) => {
  saveSettings(settings)
  return { success: true }
})

// ─── IPC: LLM Test ───────────────────────────────────────────────
ipcMain.handle('llm:test', async () => {
  const s = loadSettings()
  if (!s.llmApiKey) return { success: false, error: 'API Key 未配置，请先在设置页填写' }
  const llm = new LLMClient(s.llmBaseUrl, s.llmApiKey, s.llmModel)
  return llm.testConnection()
})

// ─── IPC: Agent Chat ──────────────────────────────────────────────
ipcMain.handle('agent:chat', async (event, { history, userMessage }) => {
  const s = loadSettings()
  if (!s.llmApiKey) return { success: false, error: 'LLM API Key 未配置，请先在「设置」页填写' }

  const llm = new LLMClient(s.llmBaseUrl, s.llmApiKey, s.llmModel)

  const systemPrompt = `你是即梦工作流 Studio 的 AI 助手，专门帮助用户创作 AI 视频分镜。
你的能力：
1. 理解用户的创意想法，帮助他们完善故事和主题
2. 分析用户需求，给出分镜建议
3. 当用户描述了一个故事/主题时，询问他们是否需要直接生成分镜工作流
4. 如果用户明确说要生成视频/分镜，在回复末尾加上特殊标记：[ACTION:START_WORKFLOW:用户的故事描述]

回复要简洁、专业、友好。用中文回复。`

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.slice(-10), // 保留最近10条对话上下文
    { role: 'user', content: userMessage },
  ]

  try {
    const reply = await llm.chat(messages)
    return { success: true, reply }
  } catch (e) {
    return { success: false, error: e.message }
  }
})

// ─── IPC: Jimeng CLI ─────────────────────────────────────────────
ipcMain.handle('jimeng:check', async () => {
  const s = loadSettings()
  const runner = new JimengRunner(s.jimengCliPath)
  return runner.checkInstalled()
})

ipcMain.handle('jimeng:credit', async () => {
  const s = loadSettings()
  const runner = new JimengRunner(s.jimengCliPath)
  return runner.getCredit()
})

// Check login status by running user_credit (fails if not logged in)
ipcMain.handle('jimeng:loginStatus', async () => {
  const s = loadSettings()
  const runner = new JimengRunner(s.jimengCliPath)
  return runner.checkLoginStatus()
})

// Start headless OAuth login — returns { verification_uri, user_code, device_code }
ipcMain.handle('jimeng:loginStart', async () => {
  const s = loadSettings()
  const runner = new JimengRunner(s.jimengCliPath)
  return runner.startLogin()
})

// Poll checklogin with device_code — opens browser URL, polls until done
ipcMain.handle('jimeng:loginPoll', async (event, { deviceCode, verificationUri }) => {
  // Open browser so user can authorize
  if (verificationUri) shell.openExternal(verificationUri)
  const s = loadSettings()
  const runner = new JimengRunner(s.jimengCliPath)
  // Poll up to 120s
  const result = await runner.pollLogin(deviceCode, 120)
  // Notify renderer when done
  if (mainWindow) mainWindow.webContents.send('jimeng:loginResult', result)
  return result
})

// ─── IPC: Workflow ────────────────────────────────────────────────
ipcMain.handle('workflow:start', async (event, params) => {
  try {
    const s = loadSettings()
    if (!s.llmApiKey || !s.llmBaseUrl) {
      return { success: false, error: 'LLM API 未配置，请先在「设置」页填写 Base URL 和 API Key' }
    }

    const { prompt, sceneCount, outputDir, projectId, projectName, mediaParams } = params
    const llmClient = new LLMClient(s.llmBaseUrl, s.llmApiKey, s.llmModel)
    if (global.accountRouter) {
      await global.accountRouter.selectAvailableAccount(1)
    }
    const jimengRunner = new JimengRunner(s.jimengCliPath)

    const cliCheck = await jimengRunner.checkInstalled()
    if (!cliCheck.installed) {
      return { success: false, error: `dreamina CLI 未就绪：${cliCheck.error}` }
    }

    let project
    if (projectId) {
      project = PM.loadProject(projectId)
      if (!project) return { success: false, error: '项目不存在: ' + projectId }
    } else {
      const outDir = outputDir || path.join(app.getPath('documents'), 'JimengOutput', Date.now().toString())
      fs.mkdirSync(outDir, { recursive: true })
      project = PM.createProject(projectName || null, prompt, outDir)
    }

    // Save initial mediaParams
    PM.saveProject({ ...project, status: 'generating', prompt, mediaParams: mediaParams || {} })

    global.currentWorkflow = new WorkflowOrchestrator(llmClient, jimengRunner, project.outputDir, s, mediaParams || {})
    global.currentWorkflowProjectId = project.id

    global.currentWorkflow.on('progress', (data) => {
      const payload = data?.manifest
        ? {
            ...data,
            manifest: {
              ...data.manifest,
              id: project.id,
              name: data.manifest.title || project.name,
              outputDir: project.outputDir,
              mediaParams: mediaParams || {},
            },
          }
        : data
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('workflow:progress', payload)
    })

    const manifest = await global.currentWorkflow.run(prompt, sceneCount || 4)
    
    if (manifest) {
      const saved = PM.saveProject({
        ...project,
        name: manifest.title || project.name,
        prompt,
        mediaParams: mediaParams || {},
        status: manifest.scenes?.every(s => s.status === 'video_done') ? 'done' : 'partial',
        scenes: manifest.scenes || [],
      })
      return { success: true, manifest: saved, outputDir: project.outputDir, project: saved }
    }
    return { success: false, error: 'Workflow returned null' }
  } catch (err) {
    console.error(err)
    return { success: false, error: err.message }
  }
})

ipcMain.on('jimeng:workflow-pause', () => {
  if (global.currentWorkflow) {
    global.currentWorkflow.pause()
  }
})

ipcMain.handle('jimeng:workflow-resume', async (event, mediaParams) => {
  if (!global.currentWorkflow) return { success: false, error: 'No active workflow' }
  try {
    const manifest = await global.currentWorkflow.resume(mediaParams || {})
    if (manifest) {
      const projectId = global.currentWorkflowProjectId || manifest.id || path.basename(manifest.outputDir)
      const existing = PM.loadProject(projectId)
      const saved = PM.saveProject({
        ...(existing || {}),
        id: projectId,
        name: manifest.title || existing?.name || '未命名项目',
        prompt: manifest.prompt || existing?.prompt || '',
        outputDir: manifest.outputDir || existing?.outputDir || '',
        mediaParams: mediaParams || existing?.mediaParams || {},
        status: manifest.scenes?.every(s => s.status === 'video_done') ? 'done' : 'partial',
        scenes: manifest.scenes || [],
      })
      return { success: true, manifest: saved, project: saved }
    }
    return { success: true, manifest: null, project: null }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.on('jimeng:workflow-abort', () => {
  if (global.currentWorkflow) {
    global.currentWorkflow._isPaused = true // stop any running loop
    global.currentWorkflow.removeAllListeners()
    global.currentWorkflow = null
    global.currentWorkflowProjectId = null
  }
})

// ─── IPC: Utility ─────────────────────────────────────────────────
ipcMain.handle('util:openFolder', async (event, folderPath) => {
  shell.openPath(folderPath)
})

ipcMain.handle('util:chooseFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
  })
  return result.canceled ? null : result.filePaths[0]
})

// Return file:// URL for local media — avoids base64 size limits
ipcMain.handle('util:getFileUrl', async (event, filePath) => {
  if (!filePath || !fs.existsSync(filePath)) {
    return { success: false, error: 'File not found: ' + filePath }
  }
  // Convert to file:// URL
  const fileUrl = 'file://' + filePath.replace(/\\/g, '/')
  return { success: true, url: fileUrl }
})

// Keep readFile for small images (thumbnails etc.)
ipcMain.handle('util:readFile', async (event, filePath) => {
  try {
    const stat = fs.statSync(filePath)
    // Refuse files > 20MB via base64
    if (stat.size > 20 * 1024 * 1024) {
      const url = 'file://' + filePath.replace(/\\/g, '/')
      return { success: true, url, isUrl: true }
    }
    const data = fs.readFileSync(filePath)
    return { success: true, data: data.toString('base64'), isUrl: false }
  } catch (err) {
    return { success: false, error: err.message }
  }
})
// ─── IPC: Project Manager ─────────────────────────────────────────────
ipcMain.handle('project:list', async () => {
  try { return { success: true, projects: PM.listProjects() } }
  catch (e) { return { success: false, error: e.message } }
})

ipcMain.handle('project:load', async (event, id) => {
  try {
    const p = PM.loadProject(id)
    return p ? { success: true, project: p } : { success: false, error: '项目不存在' }
  } catch (e) { return { success: false, error: e.message } }
})

ipcMain.handle('project:create', async (event, { name, prompt, outputDir }) => {
  try {
    const outDir = outputDir || path.join(app.getPath('documents'), 'JimengOutput', Date.now().toString())
    fs.mkdirSync(outDir, { recursive: true })
    return { success: true, project: PM.createProject(name, prompt, outDir) }
  } catch (e) { return { success: false, error: e.message } }
})

ipcMain.handle('project:save', async (event, projectData) => {
  try { return { success: true, project: PM.saveProject(projectData) } }
  catch (e) { return { success: false, error: e.message } }
})

ipcMain.handle('project:delete', async (event, id) => {
  try { return PM.deleteProject(id) }
  catch (e) { return { success: false, error: e.message } }
})

ipcMain.handle('project:import', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择 manifest.json 导入项目',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile'],
  })
  if (result.canceled) return { success: false, canceled: true }
  try {
    const project = PM.importManifest(result.filePaths[0])
    return { success: true, project }
  } catch (e) { return { success: false, error: e.message } }
})

// ─── IPC: Director ─────────────────────────────────────────────────
ipcMain.handle('director:regenerateImage', async (event, { projectId, sceneId, imagePrompt, mediaParams }) => {
  const project = PM.loadProject(projectId)
  if (!project) return { success: false, error: '项目不存在' }
  const s = loadSettings()
  const runner = new JimengRunner(s.jimengCliPath)
  const director = new Director(runner, PM)

  director.on('progress', (data) => {
    if (mainWindow) mainWindow.webContents.send('director:progress', data)
  })
  try {
    const result = await director.regenerateImage(project, sceneId, imagePrompt, mediaParams || {})
    return { success: true, ...result }
  } catch (e) {
    return { success: false, error: e.message }
  }
})

ipcMain.handle('director:regenerateVideo', async (event, { projectId, sceneId, videoPrompt, mediaParams }) => {
  const project = PM.loadProject(projectId)
  if (!project) return { success: false, error: '项目不存在' }
  const s = loadSettings()
  const runner = new JimengRunner(s.jimengCliPath)
  const director = new Director(runner, PM)

  director.on('progress', (data) => {
    if (mainWindow) mainWindow.webContents.send('director:progress', data)
  })
  try {
    const result = await director.regenerateVideo(project, sceneId, videoPrompt, mediaParams || {})
    return { success: true, ...result }
  } catch (e) {
    return { success: false, error: e.message }
  }
})

ipcMain.handle('director:listBackups', async (event, { projectId, sceneId }) => {
  const project = PM.loadProject(projectId)
  if (!project) return { success: false, error: '项目不存在' }
  const sceneDir = path.join(project.outputDir, 'scenes', `scene_${sceneId}`)
  return { success: true, backups: listBackups(sceneDir) }
})

ipcMain.handle('director:onProgress', () => {}) // placeholder for preload

// ─── IPC: util:fileInfo ────────────────────────────────────────────
ipcMain.handle('util:fileInfo', async (event, filePath) => {
  try {
    const info = getFileInfo(filePath)
    return info ? { success: true, info } : { success: false, error: 'File not found' }
  } catch (e) {
    return { success: false, error: e.message }
  }
})


// ─── IPC: Editor ─────────────────────────────────────────────────
let activeExportProc = null

ipcMain.handle('editor:import', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '导入剪辑素材',
    filters: [{ name: '视频和图片', extensions: ['mp4','mov','webm','avi','mkv','png','jpg','jpeg','webp'] }],
    properties: ['openFile', 'multiSelections'],
  })
  if (result.canceled) return { success: false, canceled: true }
  const items = []
  for (const filePath of result.filePaths) {
    const info = getFileInfo(filePath)
    const ext = path.extname(filePath).toLowerCase()
    const type = ['.png','.jpg','.jpeg','.webp'].includes(ext) ? 'image' : 'video'
    items.push({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2),
      src: filePath, name: path.basename(filePath), type,
      width: info?.width || (type==='image'?1920:1280),
      height: info?.height || (type==='image'?1080:720),
      duration: info?.duration || (type==='image'?3:10),
      size: info?.size || 0,
    })
  }
  return { success: true, items }
})

ipcMain.handle('editor:chooseOutput', async () => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '选择导出路径',
    defaultPath: path.join(app.getPath('movies'), `edit_${Date.now()}.mp4`),
    filters: [{ name: 'MP4 Video', extensions: ['mp4'] }],
  })
  return result.canceled ? { success: false } : { success: true, outputPath: result.filePath }
})

ipcMain.handle('editor:export', async (event, { clips, outputPath, resolution }) => {
  if (activeExportProc) return { success: false, error: '已有导出任务运行中' }
  return new Promise((resolve) => {
    activeExportProc = exportVideo(
      { clips, outputPath, resolution },
      (progress) => { if (mainWindow) mainWindow.webContents.send('editor:exportProgress', { progress }) },
      (err, outPath) => {
        activeExportProc = null
        if (err) resolve({ success: false, error: err.message })
        else resolve({ success: true, outputPath: outPath })
      }
    )
    if (!activeExportProc) resolve({ success: false, error: '无法启动 ffmpeg' })
  })
})

ipcMain.handle('editor:cancelExport', async () => {
  if (activeExportProc) { activeExportProc.kill(); activeExportProc = null; return { success: true } }
  return { success: false, error: '无活动导出' }
})

ipcMain.handle('editor:ffmpegPath', async () => ({
  path: FFMPEG_BIN, available: require('fs').existsSync(FFMPEG_BIN),
}))

// ─── IPC: Editor Projects ──────────────────────────────────────
const EP = require('./editor-project')

// 从工作流项目一键创建剪辑项目
ipcMain.handle('editorProject:createFromWorkflow', async (event, projectId) => {
  try {
    const wfProject = PM.loadProject(projectId)
    if (!wfProject) return { success: false, error: '工作流项目不存在: ' + projectId }
    const edp = EP.createFromWorkflowProject(wfProject)
    return { success: true, project: edp }
  } catch (e) { return { success: false, error: e.message } }
})

// 保存剪辑项目（timeline 状态）
ipcMain.handle('editorProject:save', async (event, project) => {
  try { return { success: true, project: EP.save(project) } }
  catch (e) { return { success: false, error: e.message } }
})

// 加载剪辑项目
ipcMain.handle('editorProject:load', async (event, id) => {
  const p = EP.load(id)
  return p ? { success: true, project: p } : { success: false, error: '项目不存在' }
})

// 列出所有剪辑项目
ipcMain.handle('editorProject:list', async () => {
  try { return { success: true, projects: EP.list() } }
  catch (e) { return { success: false, error: e.message } }
})

// 删除剪辑项目（仅删注册表记录）
ipcMain.handle('editorProject:delete', async (event, id) => {
  try { EP.remove(id); return { success: true } }
  catch (e) { return { success: false, error: e.message } }
})
