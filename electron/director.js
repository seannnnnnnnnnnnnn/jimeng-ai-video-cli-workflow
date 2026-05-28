/**
 * Director Module — scene-level re-generation with automatic backup
 *
 * Backup strategy:
 *   Before overwriting a file, rename it to:
 *   <scene_dir>/backups/<original_name>_bak_<timestamp>.<ext>
 *
 * Re-generate:
 *   director:regenerateImage(projectId, sceneId, imagePrompt, mediaParams)
 *   director:regenerateVideo(projectId, sceneId, videoPrompt, mediaParams)
 */

const path = require('path')
const fs = require('fs')
const { EventEmitter } = require('events')

// ── Backup helpers ────────────────────────────────────────────────

function backupDir(sceneDir) {
  const d = path.join(sceneDir, 'backups')
  fs.mkdirSync(d, { recursive: true })
  return d
}

function backupFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null
  const sceneDir = path.dirname(filePath)
  const bDir = backupDir(sceneDir)
  const ext = path.extname(filePath)
  const base = path.basename(filePath, ext)
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const dest = path.join(bDir, `${base}_bak_${ts}${ext}`)
  fs.renameSync(filePath, dest)
  return dest
}

function listBackups(sceneDir) {
  const bDir = path.join(sceneDir, 'backups')
  if (!fs.existsSync(bDir)) return []
  return fs.readdirSync(bDir)
    .filter(f => !f.startsWith('.'))
    .map(f => {
      const full = path.join(bDir, f)
      const stat = fs.statSync(full)
      const ext = path.extname(f).toLowerCase()
      return {
        file: full,
        name: f,
        size: stat.size,
        mtime: stat.mtime.toISOString(),
        type: ['.mp4', '.mov', '.webm'].includes(ext) ? 'video' : 'image',
      }
    })
    .sort((a, b) => new Date(b.mtime) - new Date(a.mtime))
}

// ── File info helper ──────────────────────────────────────────────

const { execSync } = require('child_process')

function getFileInfo(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null
  const stat = fs.statSync(filePath)
  const ext = path.extname(filePath).toLowerCase()
  const info = { size: stat.size, format: ext.replace('.', '') }

  try {
    if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
      // macOS sips — no extra deps needed
      const out = execSync(`sips -g pixelWidth -g pixelHeight "${filePath}" 2>/dev/null`, { timeout: 3000 }).toString()
      const w = out.match(/pixelWidth:\s*(\d+)/)?.[1]
      const h = out.match(/pixelHeight:\s*(\d+)/)?.[1]
      if (w) info.width = parseInt(w)
      if (h) info.height = parseInt(h)
    } else if (['.mp4', '.mov', '.webm'].includes(ext)) {
      // Try ffprobe
      const probe = execSync(
        `ffprobe -v quiet -print_format json -show_streams "${filePath}" 2>/dev/null`,
        { timeout: 5000 }
      ).toString()
      const data = JSON.parse(probe)
      const vs = data.streams?.find(s => s.codec_type === 'video')
      if (vs) {
        info.width = vs.width
        info.height = vs.height
        info.duration = parseFloat(vs.duration || data.format?.duration || 0)
      }
    }
  } catch (_) {
    // ffprobe / sips not available — just return size
  }
  return info
}

// ── Director class ────────────────────────────────────────────────

class Director extends EventEmitter {
  constructor(runner, projectManager) {
    super()
    this.runner = runner
    this.pm = projectManager
  }

  _emit(msg, type = 'info') {
    this.emit('progress', { message: msg, type })
  }

  async regenerateImage(project, sceneId, imagePrompt, mediaParams = {}) {
    const scene = project.scenes.find(s => s.id === sceneId)
    if (!scene) throw new Error(`Scene ${sceneId} not found`)
    if (!imagePrompt || !String(imagePrompt).trim()) throw new Error('图片提示词不能为空')

    const sceneDir = path.join(project.outputDir, 'scenes', `scene_${sceneId}`)
    fs.mkdirSync(sceneDir, { recursive: true })
    const oldVideoPath = scene.videoPath

    // Backup old image
    let backup = null
    if (scene.imagePath && fs.existsSync(scene.imagePath)) {
      backup = backupFile(scene.imagePath)
      this._emit(`📦 旧图片已备份: ${path.basename(backup)}`)
    }

    this._emit(`🎨 开始重新生成分镜 ${sceneId} 的图片...`)

    const imagePath = await this.runner.generateImage(
      imagePrompt,
      {
        ratio: mediaParams.imageRatio || '16:9',
        resolutionType: mediaParams.imageResolutionType || '2k',
        modelVersion: mediaParams.imageModelVersion || null,
        downloadDir: sceneDir,
        pollSeconds: 120,
      },
      (log) => this._emit(log)
    )

    // Update scene
    scene.imagePath = imagePath
    scene.image_prompt = imagePrompt
    scene.status = 'image_done'
    if (oldVideoPath) scene.videoPath = null

    const saved = this.pm.saveProject({ ...project, scenes: project.scenes })
    this._emit(`✓ 分镜 ${sceneId} 图片重新生成完成`, 'done')
    return { imagePath, backup, project: saved }
  }

  async regenerateVideo(project, sceneId, videoPrompt, mediaParams = {}) {
    const scene = project.scenes.find(s => s.id === sceneId)
    if (!scene) throw new Error(`Scene ${sceneId} not found`)
    if (!scene.imagePath || !fs.existsSync(scene.imagePath)) {
      throw new Error(`Scene ${sceneId} 还没有图片，请先生成图片`)
    }

    const sceneDir = path.join(project.outputDir, 'scenes', `scene_${sceneId}`)
    fs.mkdirSync(sceneDir, { recursive: true })

    // Backup old video
    let backup = null
    if (scene.videoPath && scene.videoPath !== scene.imagePath && fs.existsSync(scene.videoPath)) {
      backup = backupFile(scene.videoPath)
      this._emit(`📦 旧视频已备份: ${path.basename(backup)}`)
    }

    this._emit(`🎬 开始重新生成分镜 ${sceneId} 的视频...`)

    const videoPath = await this.runner.generateVideo(
      scene.imagePath,
      videoPrompt,
      {
        modelVersion: mediaParams.videoModel || 'seedance2.0_vip',
        duration: mediaParams.videoDuration || 5,
        videoResolution: mediaParams.videoResolution || '1080p',
        downloadDir: sceneDir,
        pollSeconds: 300,
      },
      (log) => this._emit(log)
    )

    scene.videoPath = videoPath
    scene.video_prompt = videoPrompt

    const saved = this.pm.saveProject({ ...project, scenes: project.scenes })
    this._emit(`✓ 分镜 ${sceneId} 视频重新生成完成`, 'done')
    return { videoPath, backup, project: saved }
  }
}

module.exports = { Director, listBackups, getFileInfo, backupFile }
