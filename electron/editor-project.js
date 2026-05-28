/**
 * editor-project.js
 * 管理剪辑项目的持久化
 *
 * 每个剪辑项目保存两份：
 *  1. 注册表：~/.local/share/jimeng-studio/editor-projects/<id>.json
 *  2. 本地联动：<workflowOutputDir>/editor_project.json（与素材同目录）
 */

const fs = require('fs')
const path = require('path')
const os = require('os')

const REGISTRY_DIR = path.join(os.homedir(), '.local', 'share', 'jimeng-studio', 'editor-projects')
fs.mkdirSync(REGISTRY_DIR, { recursive: true })

function registryPath(id) {
  return path.join(REGISTRY_DIR, `${id}.json`)
}

function save(project) {
  project.updatedAt = new Date().toISOString()
  const data = JSON.stringify(project, null, 2)

  // 1. 写注册表
  fs.writeFileSync(registryPath(project.id), data, 'utf8')

  // 2. 联动写到素材目录（如果有 sourceOutputDir）
  if (project.sourceOutputDir && fs.existsSync(project.sourceOutputDir)) {
    const localPath = path.join(project.sourceOutputDir, 'editor_project.json')
    fs.writeFileSync(localPath, data, 'utf8')
    project.localProjectFile = localPath
  }

  return project
}

function load(id) {
  const p = registryPath(id)
  if (!fs.existsSync(p)) return null
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}

function list() {
  if (!fs.existsSync(REGISTRY_DIR)) return []
  return fs.readdirSync(REGISTRY_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(REGISTRY_DIR, f), 'utf8')) }
      catch { return null }
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
}

function remove(id) {
  const p = registryPath(id)
  if (fs.existsSync(p)) fs.unlinkSync(p)
}

/**
 * 从工作流项目创建剪辑项目
 * 扫描 outputDir/scenes/scene_N/ 目录下的 .mp4 文件，按场景顺序排列
 */
function createFromWorkflowProject(wfProject) {
  const id = 'edp_' + Date.now().toString(36)
  const clips = []

  // 优先用 project.scenes 里的 videoPath
  const scenes = (wfProject.scenes || []).filter(s => s.videoPath && fs.existsSync(s.videoPath))

  if (scenes.length > 0) {
    let t = 0
    for (const scene of scenes) {
      const duration = getVideoDuration(scene.videoPath) || 5
      clips.push({
        id: 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2),
        src: scene.videoPath,
        name: `场景 ${scene.id}`,
        type: 'video',
        mediaDuration: duration,
        startTime: t,
        duration,
        trimIn: 0,
        trimOut: duration,
        transitionToNext: null,
      })
      t += duration
    }
  } else {
    // fallback: 扫目录
    const scenesDir = path.join(wfProject.outputDir, 'scenes')
    if (fs.existsSync(scenesDir)) {
      const dirs = fs.readdirSync(scenesDir)
        .filter(d => d.startsWith('scene_'))
        .sort((a, b) => {
          const na = parseInt(a.split('_')[1]), nb = parseInt(b.split('_')[1])
          return na - nb
        })
      let t = 0
      for (const dir of dirs) {
        const dirPath = path.join(scenesDir, dir)
        const mp4s = fs.readdirSync(dirPath).filter(f => f.endsWith('.mp4') && !f.includes('_bak_'))
        for (const mp4 of mp4s) {
          const fullPath = path.join(dirPath, mp4)
          const duration = getVideoDuration(fullPath) || 5
          clips.push({
            id: 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2),
            src: fullPath, name: mp4, type: 'video',
            mediaDuration: duration, startTime: t,
            duration, trimIn: 0, trimOut: duration, transitionToNext: null,
          })
          t += duration
        }
      }
    }
  }

  const project = {
    id,
    name: `${wfProject.name || '未命名项目'} · 剪辑版`,
    sourceProjectId: wfProject.id,
    sourceOutputDir: wfProject.outputDir,
    localProjectFile: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    clips,
  }

  return save(project)
}

// 用 ffprobe 获取视频时长，失败返回 null
function getVideoDuration(filePath) {
  try {
    const { execSync } = require('child_process')
    const out = execSync(
      `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${filePath}" 2>/dev/null`,
      { timeout: 4000 }
    ).toString().trim()
    const d = parseFloat(out)
    return isNaN(d) ? null : d
  } catch { return null }
}

module.exports = { save, load, list, remove, createFromWorkflowProject }
