const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  // Settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),

  // LLM
  testLLM: () => ipcRenderer.invoke('llm:test'),
  agentChat: (params) => ipcRenderer.invoke('agent:chat', params),

  // Jimeng CLI
  jimengCheck: () => ipcRenderer.invoke('jimeng:check'),
  jimengCredit: () => ipcRenderer.invoke('jimeng:credit'),
  jimengLoginStatus: () => ipcRenderer.invoke('jimeng:loginStatus'),
  jimengLoginStart: () => ipcRenderer.invoke('jimeng:loginStart'),
  jimengLoginPoll: (params) => ipcRenderer.invoke('jimeng:loginPoll', params),
  onLoginResult: (cb) => {
    const handler = (event, data) => cb(data)
    ipcRenderer.on('jimeng:loginResult', handler)
    return () => ipcRenderer.removeListener('jimeng:loginResult', handler)
  },

  // Workflow
  startWorkflow: (p) => ipcRenderer.invoke('workflow:start', p),
  workflowPause: () => ipcRenderer.send('jimeng:workflow-pause'),
  workflowResume: (params) => ipcRenderer.invoke('jimeng:workflow-resume', params),
  workflowAbort: () => ipcRenderer.send('jimeng:workflow-abort'),
  onWorkflowProgress: (cb) => {
    const handler = (event, data) => cb(data)
    ipcRenderer.on('workflow:progress', handler)
    // Return cleanup function
    return () => ipcRenderer.removeListener('workflow:progress', handler)
  },

  // Utilities
  openFolder: (p) => ipcRenderer.invoke('util:openFolder', p),
  chooseFolder: () => ipcRenderer.invoke('util:chooseFolder'),
  getFileUrl: (p) => ipcRenderer.invoke('util:getFileUrl', p),
  readFile: (p) => ipcRenderer.invoke('util:readFile', p),

  // Project Manager
  projectList: () => ipcRenderer.invoke('project:list'),
  projectLoad: (id) => ipcRenderer.invoke('project:load', id),
  projectCreate: (data) => ipcRenderer.invoke('project:create', data),
  projectSave: (data) => ipcRenderer.invoke('project:save', data),
  projectDelete: (id) => ipcRenderer.invoke('project:delete', id),
  projectImport: () => ipcRenderer.invoke('project:import'),

  // Director
  directorRegenImage: (p) => ipcRenderer.invoke('director:regenerateImage', p),
  directorRegenVideo: (p) => ipcRenderer.invoke('director:regenerateVideo', p),
  directorListBackups: (p) => ipcRenderer.invoke('director:listBackups', p),
  onDirectorProgress: (cb) => {
    const handler = (event, data) => cb(data)
    ipcRenderer.on('director:progress', handler)
    return () => ipcRenderer.removeListener('director:progress', handler)
  },

  // File info
  fileInfo: (p) => ipcRenderer.invoke('util:fileInfo', p),

  // Editor
  editorImport: () => ipcRenderer.invoke('editor:import'),
  editorChooseOutput: () => ipcRenderer.invoke('editor:chooseOutput'),
  editorExport: (p) => ipcRenderer.invoke('editor:export', p),
  editorCancelExport: () => ipcRenderer.invoke('editor:cancelExport'),
  editorFFmpegPath: () => ipcRenderer.invoke('editor:ffmpegPath'),
  onEditorExportProgress: (cb) => {
    const handler = (event, data) => cb(data)
    ipcRenderer.on('editor:exportProgress', handler)
    return () => ipcRenderer.removeListener('editor:exportProgress', handler)
  },

  // Editor Projects (linkage with workflow/director)
  editorProjectCreateFromWorkflow: (id) => ipcRenderer.invoke('editorProject:createFromWorkflow', id),
  editorProjectSave: (p) => ipcRenderer.invoke('editorProject:save', p),
  editorProjectLoad: (id) => ipcRenderer.invoke('editorProject:load', id),
  editorProjectList: () => ipcRenderer.invoke('editorProject:list'),
  editorProjectDelete: (id) => ipcRenderer.invoke('editorProject:delete', id),

  // Accounts Management
  accountList: () => ipcRenderer.invoke('account:list'),
  accountActive: () => ipcRenderer.invoke('account:active'),
  accountSwitch: (id) => ipcRenderer.invoke('account:switch', id),
  accountRename: (p) => ipcRenderer.invoke('account:rename', p),
  accountDelete: (id) => ipcRenderer.invoke('account:delete', id),
  accountLoginStart: (name) => ipcRenderer.invoke('account:login-start', name),
  accountLoginPoll: (p) => ipcRenderer.invoke('account:login-poll', p),
  accountCheckCredit: (id) => ipcRenderer.invoke('account:check-credit', id),
  accountCheckAll: () => ipcRenderer.invoke('account:check-all'),
  accountAutoSelect: (minCredits) => ipcRenderer.invoke('account:auto-select', minCredits),
})
