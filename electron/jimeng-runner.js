const { spawn, execSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')

const HOME = os.homedir()
const EXTRA_PATHS = [
  `${HOME}/.local/bin`,
  '/usr/local/bin',
  `${HOME}/bin`,
  '/opt/homebrew/bin',
]

class JimengRunner {
  constructor(cliPath = 'dreamina') {
    this.cliPath = cliPath
    this._resolvedPath = null
  }

  // ─── Path resolution ──────────────────────────────────────────

  _extendedPath() {
    return [process.env.PATH || '', ...EXTRA_PATHS].join(':')
  }

  _resolvePath() {
    if (this._resolvedPath) return this._resolvedPath

    const env = { ...process.env, PATH: this._extendedPath() }
    const candidates = [
      this.cliPath,
      `${HOME}/.local/bin/dreamina`,
      '/usr/local/bin/dreamina',
      `${HOME}/bin/dreamina`,
      '/opt/homebrew/bin/dreamina',
    ]

    for (const p of candidates) {
      try {
        execSync(`"${p}" --version`, { encoding: 'utf-8', timeout: 4000, env })
        this._resolvedPath = p
        return p
      } catch (_) {}
    }
    throw new Error('找不到 dreamina CLI，请先安装：curl -s https://jimeng.jianying.com/cli | bash')
  }

  // ─── Public API ───────────────────────────────────────────────

  async checkInstalled() {
    try {
      const p = this._resolvePath()
      const out = execSync(`"${p}" --version`, {
        encoding: 'utf-8', timeout: 5000,
        env: { ...process.env, PATH: this._extendedPath() },
      })
      let version = out.trim()
      try { version = JSON.parse(version).version || version } catch (_) {}
      return { installed: true, version, path: p }
    } catch (e) {
      return { installed: false, error: e.message }
    }
  }

  async getCredit(env = null) {
    try {
      const out = await this._spawn(['user_credit'], null, env)
      return { success: true, output: out.trim() }
    } catch (e) {
      return { success: false, error: e.message }
    }
  }

  // Check if user is logged in by running user_credit
  async checkLoginStatus(env = null) {
    try {
      const out = await this._spawn(['user_credit'], null, env)
      const loggedIn = !/未检测|登录态|login/i.test(out) || /credit|\d/i.test(out)
      return { loggedIn, output: out.trim() }
    } catch (e) {
      const msg = e.message || ''
      const notLoggedIn = /未检测|登录|请先执行|login/i.test(msg)
      return { loggedIn: false, error: msg, needsLogin: notLoggedIn }
    }
  }

  // Start headless OAuth login — parse output for verification_uri, user_code, device_code
  async startLogin(env = null) {
    try {
      // --headless prints auth info and exits immediately
      const out = await this._spawn(['login', '--headless'], null, env)
      const uriMatch = out.match(/verification_uri[:\s]+([^\s\n]+)/i)
        || out.match(/https:\/\/[^\s\n]+/)
      const codeMatch = out.match(/user_code[:\s]+([A-Z0-9\-]+)/i)
      const deviceMatch = out.match(/device_code[:\s]+([a-zA-Z0-9_\-]+)/i)

      return {
        success: true,
        verification_uri: uriMatch ? uriMatch[1] || uriMatch[0] : null,
        user_code: codeMatch ? codeMatch[1] : null,
        device_code: deviceMatch ? deviceMatch[1] : null,
        raw: out.trim(),
      }
    } catch (e) {
      return { success: false, error: e.message }
    }
  }

  // Poll checklogin until authorized or timeout
  async pollLogin(deviceCode, maxSeconds = 120, env = null) {
    try {
      const out = await this._spawn([
        'login', 'checklogin',
        `--device_code=${deviceCode}`,
        `--poll=${maxSeconds}`,
      ], null, env)
      const success = /success|登录成功|授权成功|authorized|logged.?in/i.test(out)
      return { success, output: out.trim() }
    } catch (e) {
      return { success: false, error: e.message }
    }
  }

  /**
   * Generate image from text prompt.
   * dreamina text2image is async: submit → poll → query_result --download_dir
   */
  async generateImage(prompt, opts = {}, onLog = null, env = null) {
    const {
      ratio = '16:9',
      resolutionType = '2k',
      modelVersion = null,
      downloadDir = os.tmpdir(),
      pollSeconds = 180,
    } = opts

    fs.mkdirSync(downloadDir, { recursive: true })

    // Build args — pass prompt as separate arg to avoid shell escaping issues
    const args = [
      'text2image',
      '--prompt', prompt,
      '--ratio', ratio,
      '--resolution_type', resolutionType,
      '--poll', String(pollSeconds),
    ]
    if (modelVersion) args.push('--model_version', modelVersion)

    const output = await this._spawn(args, onLog, env)
    return this._resolveGeneratedFile(output, downloadDir, onLog, 'image', env)
  }

  /**
   * Generate video from image (image2video).
   */
  async generateVideo(imagePath, prompt, opts = {}, onLog = null, env = null) {
    let {
      modelVersion = 'seedance2.0_vip',
      duration = 5,
      videoResolution = '1080p',
      downloadDir = os.tmpdir(),
      pollSeconds = 360,
    } = opts

    // Auto-downgrade resolution if a non-VIP model is selected
    if (!modelVersion.includes('_vip') && videoResolution === '1080p') {
      videoResolution = '720p'
    }

    fs.mkdirSync(downloadDir, { recursive: true })

    const args = [
      'image2video',
      '--image', imagePath,
      '--prompt', prompt,
      '--model_version', modelVersion,
      '--duration', String(duration),
      '--video_resolution', videoResolution,
      '--poll', String(pollSeconds),
    ]

    const output = await this._spawn(args, onLog, env)
    return this._resolveGeneratedFile(output, downloadDir, onLog, 'video', env)
  }

  /**
   * Generate video from text only.
   */
  async generateVideoFromText(prompt, opts = {}, onLog = null, env = null) {
    let {
      modelVersion = 'seedance2.0_vip',
      duration = 5,
      videoResolution = '1080p',
      ratio = '16:9',
      downloadDir = os.tmpdir(),
      pollSeconds = 360,
    } = opts

    // Auto-downgrade resolution if a non-VIP model is selected
    if (!modelVersion.includes('_vip') && videoResolution === '1080p') {
      videoResolution = '720p'
    }

    fs.mkdirSync(downloadDir, { recursive: true })

    const args = [
      'text2video',
      '--prompt', prompt,
      '--model_version', modelVersion,
      '--duration', String(duration),
      '--ratio', ratio,
      '--poll', String(pollSeconds),
    ]

    const output = await this._spawn(args, onLog, env)
    return this._resolveGeneratedFile(output, downloadDir, onLog, 'video', env)
  }

  // ─── Private Helpers ──────────────────────────────────────────

  /**
   * Core logic: after running a generation command, locate the output file.
   * IMPORTANT: strictly checks extension matches the expected type to avoid
   * returning an image path as a video path.
   */
  async _resolveGeneratedFile(output, downloadDir, onLog, type, env = null) {
    const imgExts = ['.jpg', '.jpeg', '.png', '.webp']
    const vidExts = ['.mp4', '.mov', '.webm']
    const exts = type === 'image' ? imgExts : vidExts

    const isValidExt = (p) => p && exts.some(e => p.toLowerCase().endsWith(e))

    // 1. Direct path in output — validate extension
    const fromOutput = this._parseDownloadedPath(output)
    if (fromOutput && isValidExt(fromOutput) && fs.existsSync(fromOutput)) return fromOutput

    // 2. Newest file in dir with CORRECT extension
    const inDir = this._findNewestFile(downloadDir, exts)
    if (inDir && isValidExt(inDir)) return inDir

    // 3. Extract submit_id and poll + download
    const submitId = this._parseSubmitId(output)
    if (submitId) {
      if (onLog) onLog(`[轮询] 任务 ${submitId} 生成中，开始等待结果...`)
      return await this._pollAndDownload(submitId, downloadDir, exts, onLog, 600000, env)
    }

    throw new Error(
      `生成命令完成但找不到 ${type} 输出文件。\n` +
      `输出目录: ${downloadDir}\n` +
      `CLI 输出: ${output.slice(0, 600)}`
    )
  }

  async _pollAndDownload(submitId, downloadDir, exts, onLog, maxWaitMs = 600000, env = null) {
    const interval = 10000
    const deadline = Date.now() + maxWaitMs

    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, interval))
      try {
        const out = await this._spawn([
          'query_result',
          '--submit_id', submitId,
          '--download_dir', downloadDir,
        ], onLog, env)
        if (onLog) onLog(out.replace(/\n+$/, ''))

        const fromOut = this._parseDownloadedPath(out)
        if (fromOut && fs.existsSync(fromOut)) return fromOut

        const inDir = this._findNewestFile(downloadDir, exts)
        if (inDir) return inDir

        // If status is still pending/processing, keep waiting
        if (/pending|processing|in.progress|running/i.test(out)) continue

        // If success but no file found yet, give it a moment
        if (/success|done|complete|finish/i.test(out)) {
          await new Promise(r => setTimeout(r, 2000))
          const retry = this._findNewestFile(downloadDir, exts)
          if (retry) return retry
        }
      } catch (e) {
        if (onLog) onLog(`[轮询错误] ${e.message}`)
      }
    }
    throw new Error(`任务 ${submitId} 等待超时（${maxWaitMs / 1000}s）`)
  }

  _parseDownloadedPath(output) {
    // dreamina typically prints something like:
    // "downloaded /path/to/file.jpg" or "saved to /path/to/file.mp4"
    const patterns = [
      /downloaded\s+([^\s\n"']+\.(?:jpg|jpeg|png|webp|mp4|mov|webm))/i,
      /saved(?:\s+to)?\s+([^\s\n"']+\.(?:jpg|jpeg|png|webp|mp4|mov|webm))/i,
      /output[:\s]+([^\s\n"']+\.(?:jpg|jpeg|png|webp|mp4|mov|webm))/i,
      /写入[：:\s]+([^\s\n"']+\.(?:jpg|jpeg|png|webp|mp4|mov|webm))/i,
    ]
    for (const re of patterns) {
      const m = output.match(re)
      if (m) return m[1].replace(/^~/, HOME)
    }
    // Any absolute path in output
    const abs = output.match(/([/][^\s\n"']+\.(?:jpg|jpeg|png|webp|mp4|mov|webm))/i)
    if (abs) return abs[1]
    return null
  }

  _parseSubmitId(output) {
    // dreamina prints: submit_id: <id>  or  --submit_id=<id>
    const patterns = [
      /submit_id[=:\s"']+([a-f0-9]{8,}(?:-[a-f0-9]+)*)/i,
      /task[_\s]?id[=:\s"']+([a-f0-9]{8,}(?:-[a-f0-9]+)*)/i,
    ]
    for (const re of patterns) {
      const m = output.match(re)
      if (m) return m[1]
    }
    return null
  }

  _findNewestFile(dir, extensions) {
    try {
      const entries = fs.readdirSync(dir)
        .filter(f => extensions.some(ext => f.toLowerCase().endsWith(ext)))
        .map(f => {
          const full = path.join(dir, f)
          try {
            return { full, mtime: fs.statSync(full).mtimeMs }
          } catch (_) {
            return null
          }
        })
        .filter(Boolean)
        .sort((a, b) => b.mtime - a.mtime)
      return entries.length > 0 ? entries[0].full : null
    } catch (_) {
      return null
    }
  }

  _spawn(args, onLog = null, customEnv = null) {
    return new Promise((resolve, reject) => {
      const cli = this._resolvePath()
      let baseEnv = customEnv
      if (!baseEnv && global.accountRouter) {
        try {
          baseEnv = global.accountRouter.getCliEnv()
        } catch (_) {
          baseEnv = process.env
        }
      }
      if (!baseEnv) baseEnv = process.env

      const env = { ...baseEnv, PATH: this._extendedPath() }

      // Use shell: false and pass args array to avoid all escaping issues
      const proc = spawn(cli, args, { env, shell: false })

      let stdout = ''
      let stderr = ''

      proc.stdout.on('data', (chunk) => {
        const text = chunk.toString()
        stdout += text
        if (onLog) {
          text.split('\n').filter(l => l.trim()).forEach(l => onLog(l))
        }
      })
      proc.stderr.on('data', (chunk) => {
        const text = chunk.toString()
        stderr += text
        if (onLog) {
          text.split('\n').filter(l => l.trim()).forEach(l => onLog(`[err] ${l}`))
        }
      })
      proc.on('close', (code) => {
        if (code === 0) {
          resolve(stdout + stderr)
        } else {
          const combined = (stdout + stderr).slice(0, 1000)
          reject(new Error(`dreamina ${args[0]} 失败 (code ${code})\n${combined}`))
        }
      })
      proc.on('error', (err) => {
        reject(new Error(`无法启动 dreamina "${cli}": ${err.message}`))
      })
    })
  }
}

module.exports = JimengRunner
