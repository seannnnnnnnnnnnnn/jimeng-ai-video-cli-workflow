const { EventEmitter } = require('events')
const path = require('path')
const fs = require('fs')

class WorkflowOrchestrator extends EventEmitter {
  constructor(llmClient, jimengRunner, outputDir, settings = {}, mediaParams = {}) {
    super()
    this.llm = llmClient
    this.runner = jimengRunner
    this.outputDir = outputDir
    this.settings = settings
    this.mediaParams = mediaParams
    this._isPaused = false
    this.manifest = null
    this.scenes = []
  }

  pause() {
    this._isPaused = true
    this.emit('progress', { phase: 'sys', status: 'info', message: '⚠️ 收到暂停指令，当前任务执行完毕后将挂起。' })
  }

  _checkPause() {
    if (this._isPaused) {
      throw new Error('Workflow Paused')
    }
  }

  _saveManifest() {
    if (!this.manifest) return
    this.manifest.scenes = this.scenes
    fs.writeFileSync(path.join(this.outputDir, 'manifest.json'), JSON.stringify(this.manifest, null, 2))
  }

  async run(prompt, sceneCount = 4) {
    this._isPaused = false
    this.scenes = []

    // ═══════════════════════════════════════════════
    // Phase 1: LLM Storyboard Generation
    // ═══════════════════════════════════════════════
    this.emit('progress', { phase: 'llm', status: 'running', message: '正在调用 LLM 生成分镜脚本...' })

    let storyboard
    try {
      this._checkPause()
      storyboard = await this.llm.generateStoryboard(prompt, sceneCount)
      this.emit('progress', {
        phase: 'llm', status: 'done',
        message: `分镜脚本生成完成：《${storyboard.title}》，共 ${storyboard.scenes.length} 个分镜`,
        data: storyboard,
      })
    } catch (err) {
      if (err.message === 'Workflow Paused') {
        this.emit('progress', { phase: 'sys', status: 'paused', message: '工作流已在脚本生成阶段暂停' })
        return null
      }
      this.emit('progress', { phase: 'llm', status: 'error', message: `分镜生成失败：${err.message}` })
      throw err
    }

    this.manifest = {
      title: storyboard.title,
      prompt,
      createdAt: new Date().toISOString(),
      outputDir: this.outputDir,
      scenes: []
    }

    // ═══════════════════════════════════════════════
    // Phase 2: Generate All Images First
    // ═══════════════════════════════════════════════
    const sceneBaseDir = path.join(this.outputDir, 'scenes')
    fs.mkdirSync(sceneBaseDir, { recursive: true })

    for (const scene of storyboard.scenes) {
      const sceneDir = path.join(sceneBaseDir, `scene_${scene.id}`)
      fs.mkdirSync(sceneDir, { recursive: true })

      const sceneResult = {
        id: scene.id,
        description: scene.description,
        image_prompt: scene.image_prompt,
        video_prompt: scene.video_prompt,
        imagePath: null,
        videoPath: null,
        status: 'pending',
      }
      this.scenes.push(sceneResult)
    }
    this._saveManifest()

    return this._runImagePhase()
  }

  // ═══════════════════════════════════════════════
  // Phase 2: Generate Images
  // ═══════════════════════════════════════════════
  async _runImagePhase() {
    const sceneBaseDir = path.join(this.outputDir, 'scenes')

    for (const sceneResult of this.scenes) {
      try { this._checkPause() } catch (err) {
        this.emit('progress', { phase: 'sys', status: 'paused', message: '已暂停：在生图阶段挂起' })
        this._saveManifest()
        return this.manifest
      }

      if (sceneResult.status === 'image_done' || sceneResult.status === 'video_done') continue

      const sceneDir = path.join(sceneBaseDir, `scene_${sceneResult.id}`)

      this.emit('progress', {
        phase: 'image', sceneId: sceneResult.id, status: 'running',
        message: `[分镜 ${sceneResult.id}/${this.scenes.length}] 正在生成图片...`,
      })

      const mp = this.mediaParams || {}
      const imgRatio = mp.imageRatio || this.settings.imageRatio || '16:9'
      const imgRes = mp.imageResolutionType || this.settings.imageResolutionType || '2k'
      const imgModel = mp.imageModelVersion || this.settings.imageModelVersion || null

      try {
        const imagePath = await this.runner.generateImage(
          sceneResult.image_prompt,
          {
            ratio: imgRatio,
            resolutionType: imgRes,
            modelVersion: imgModel,
            downloadDir: sceneDir,
            pollSeconds: 120,
          },
          (log) => this.emit('progress', { phase: 'image', sceneId: sceneResult.id, status: 'log', message: log })
        )

        sceneResult.imagePath = imagePath
        sceneResult.status = 'image_done'
        this._saveManifest()

        this.emit('progress', {
          phase: 'image', sceneId: sceneResult.id, status: 'done',
          message: `[分镜 ${sceneResult.id}] ✓ 图片生成完成`,
          imagePath,
        })
      } catch (err) {
        sceneResult.status = 'image_error'
        this._saveManifest()
        this.emit('progress', {
          phase: 'image', sceneId: sceneResult.id, status: 'error',
          message: `[分镜 ${sceneResult.id}] ✗ 图片生成失败：${err.message}`,
        })
      }
    }

    try { this._checkPause() } catch (err) {
      this.emit('progress', { phase: 'sys', status: 'paused', message: '已暂停：所有图片生成结束' })
      return this.manifest
    }

    // Instead of auto video, we pause and wait for user.
    this.emit('progress', {
      phase: 'image', status: 'all_done',
      message: `✨ 全部图片已生成完毕，请确认是否继续生成视频`,
      manifest: this.manifest
    })

    return this.manifest
  }

  // ═══════════════════════════════════════════════
  // Resume from pause or continue
  // ═══════════════════════════════════════════════
  async resume(newMediaParams) {
    if (newMediaParams) {
      this.mediaParams = newMediaParams
    }
    this._isPaused = false

    // Are there missing images?
    const missingImages = this.scenes.some(s => !s.imagePath && s.status !== 'video_done')
    if (missingImages) {
      this.emit('progress', { phase: 'sys', status: 'info', message: '🚀 恢复执行：继续生成剩余图片...' })
      return this._runImagePhase()
    } else {
      this.emit('progress', { phase: 'sys', status: 'info', message: '🚀 恢复执行：继续生成剩余视频...' })
      return this._runVideoPhase()
    }
  }

  // ═══════════════════════════════════════════════
  // Phase 3: Generate Videos
  // ═══════════════════════════════════════════════
  async _runVideoPhase() {
    const sceneBaseDir = path.join(this.outputDir, 'scenes')

    for (const sceneResult of this.scenes) {
      try { this._checkPause() } catch (err) {
        this.emit('progress', { phase: 'sys', status: 'paused', message: '已暂停：在生视频阶段挂起' })
        this._saveManifest()
        return this.manifest
      }

      if (sceneResult.status === 'video_done') continue // skip already done
      if (!sceneResult.imagePath) continue // skip if no image to animate

      const sceneDir = path.join(sceneBaseDir, `scene_${sceneResult.id}`)

      this.emit('progress', {
        phase: 'video', sceneId: sceneResult.id, status: 'running',
        message: `[分镜 ${sceneResult.id}/${this.scenes.length}] 正在基于图片生成视频...`,
      })

      const mp = this.mediaParams || {}
      const vidModel = mp.videoModel || this.settings.videoModel || 'seedance2.0_vip'
      const vidDuration = mp.videoDuration || this.settings.videoDuration || 5
      const vidRes = mp.videoResolution || this.settings.videoResolution || '1080p'

      try {
        const videoPath = await this.runner.generateVideo(
          sceneResult.imagePath,
          sceneResult.video_prompt,
          {
            modelVersion: vidModel,
            duration: vidDuration,
            videoResolution: vidRes,
            downloadDir: sceneDir,
            pollSeconds: 300,
          },
          (log) => this.emit('progress', { phase: 'video', sceneId: sceneResult.id, status: 'log', message: log })
        )

        sceneResult.videoPath = videoPath
        sceneResult.status = 'video_done'
        this._saveManifest()

        this.emit('progress', {
          phase: 'video', sceneId: sceneResult.id, status: 'done',
          message: `[分镜 ${sceneResult.id}] ✓ 视频生成完成`,
          videoPath, scene: sceneResult,
        })
      } catch (err) {
        sceneResult.status = 'video_error'
        this._saveManifest()
        this.emit('progress', {
          phase: 'video', sceneId: sceneResult.id, status: 'error',
          message: `[分镜 ${sceneResult.id}] ✗ 视频生成失败：${err.message}`,
        })
      }
    }

    try { this._checkPause() } catch (err) {
      this.emit('progress', { phase: 'sys', status: 'paused', message: '已暂停：所有视频生成结束' })
      return this.manifest
    }

    const doneCount = this.scenes.filter(s => s.status === 'video_done').length
    this.emit('progress', {
      phase: 'complete', status: 'done',
      message: `✅ 工作流完成！成功生成 ${doneCount}/${this.scenes.length} 个视频`,
      manifest: this.manifest,
    })

    return this.manifest
  }
}

module.exports = WorkflowOrchestrator
