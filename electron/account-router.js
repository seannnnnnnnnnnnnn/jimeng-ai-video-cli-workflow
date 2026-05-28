const { spawn, execFileSync } = require('child_process')
const { EventEmitter } = require('events')
const path = require('path')
const fs = require('fs')
const os = require('os')

const HOME = os.homedir()
const DEFAULT_BASE_DIR = path.join(HOME, '.jimeng-accounts')
const DREAMINA_CLI = path.join(HOME, '.local/bin/dreamina')
const ORIGINAL_DREAMINA_DIR = path.join(HOME, '.dreamina_cli')

const EXTRA_PATHS = [
  `${HOME}/.local/bin`,
  '/usr/local/bin',
  `${HOME}/bin`,
  '/opt/homebrew/bin',
]

/**
 * AccountRouter — multi-account session manager for the dreamina CLI.
 *
 * Key insight: dreamina stores local state in `$HOME/.dreamina_cli/` and auth
 * secrets in the macOS keychain. Existing CLI login state cannot be migrated by
 * copying files alone, so the default account uses the real HOME. Additional
 * accounts use isolated HOME directories with their own keychain database and
 * are logged in once through OAuth.
 *
 * Storage layout:
 *   ~/.jimeng-accounts/
 *   ├── accounts.json
 *   ├── active             (plain text — active account ID)
 *   ├── account_<timestamp>/
 *   │   └── .dreamina_cli/
 *   └── ...
 */
class AccountRouter extends EventEmitter {
  /**
   * @param {string} [baseDir] — root directory for all account data
   */
  constructor(baseDir = DEFAULT_BASE_DIR) {
    super()
    this.baseDir = baseDir
    this.accountsFile = path.join(baseDir, 'accounts.json')
    this.activeFile = path.join(baseDir, 'active')
    /** @type {Array<Object>} */
    this._accounts = []
  }

  // ─── Initialisation ─────────────────────────────────────────────

  /**
   * Call once at startup.
   * Creates the base directory, migrates the existing ~/.dreamina_cli/ as
   * the default account when no accounts exist yet.
   */
  async init() {
    fs.mkdirSync(this.baseDir, { recursive: true })
    this._accounts = this._loadAccounts()

    if (this._accounts.length === 0) {
      this._createDefaultAccountRecord()
    } else {
      this._normalizeAccounts()
    }
    if (!this._readActiveId() && this._accounts.length > 0) {
      this.switchAccount(this._accounts[0].id)
    }
  }

  // ─── Account CRUD ───────────────────────────────────────────────

  /**
   * List all registered accounts.
   * @returns {Array<{id:string, name:string, credits:number|null, vipLevel:string|null, lastChecked:string|null}>}
   */
  listAccounts() {
    return this._accounts.map(a => ({
      id: a.id,
      name: a.name,
      credits: a.credits ?? null,
      vipLevel: a.vipLevel ?? null,
      lastChecked: a.lastChecked ?? null,
      sessionType: a.sessionType || (a.homeDir === HOME ? 'system' : 'isolated'),
    }))
  }

  /**
   * Get the currently active account object, or null.
   * @returns {Object|null}
   */
  getActiveAccount() {
    const activeId = this._readActiveId()
    if (!activeId) return null
    return this._accounts.find(a => a.id === activeId) || null
  }

  /**
   * Switch to a different account.
   * @param {string} accountId
   * @returns {Object} the account that was activated
   */
  switchAccount(accountId) {
    const account = this._accounts.find(a => a.id === accountId)
    if (!account) throw new Error(`账户不存在: ${accountId}`)
    fs.writeFileSync(this.activeFile, accountId, 'utf-8')
    this.emit('switch', account)
    return account
  }

  /**
   * Rename an account.
   * @param {string} accountId
   * @param {string} newName
   * @returns {Object} updated account
   */
  renameAccount(accountId, newName) {
    const account = this._accounts.find(a => a.id === accountId)
    if (!account) throw new Error(`账户不存在: ${accountId}`)
    account.name = newName
    this._saveAccounts()
    return account
  }

  /**
   * Delete an account. Cannot delete the currently active account.
   * @param {string} accountId
   */
  deleteAccount(accountId) {
    const activeId = this._readActiveId()
    if (accountId === activeId) {
      throw new Error('不能删除当前活跃账户，请先切换到其他账户')
    }
    const idx = this._accounts.findIndex(a => a.id === accountId)
    if (idx === -1) throw new Error(`账户不存在: ${accountId}`)

    const dir = this._getAccountDir(accountId)
    if (dir.startsWith(this.baseDir + path.sep) && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }

    this._accounts.splice(idx, 1)
    this._saveAccounts()
    this.emit('delete', accountId)
  }

  // ─── Login Flow ─────────────────────────────────────────────────

  /**
   * Begin headless OAuth login for a new account.
   * Creates the account directory, runs `dreamina login --headless`,
   * and returns the device/user codes for the caller to display.
   *
   * @param {string} [accountName] — human-readable label
   * @returns {Promise<{accountId:string, deviceCode:string|null, userCode:string|null, verificationUri:string|null, raw:string}>}
   */
  async startLogin(accountName) {
    const accountId = `account_${Date.now()}`
    const accountDir = this._getAccountDir(accountId)
    fs.mkdirSync(path.join(accountDir, '.dreamina_cli'), { recursive: true })
    this._seedCliVersionFile(accountDir)

    const out = await this._runCliCommand(accountId, ['login', '--headless'])

    const uriMatch = out.match(/verification_uri[:\s]+([^\s\n]+)/i)
      || out.match(/https:\/\/[^\s\n]+/)
    const codeMatch = out.match(/user_code[:\s]+([A-Z0-9\-]+)/i)
    const deviceMatch = out.match(/device_code[:\s]+([a-zA-Z0-9_\-]+)/i)

    // Pre-register the account so pollLogin can find it
    this._accounts.push({
      id: accountId,
      name: accountName || `账户 ${this._accounts.length + 1}`,
      credits: null,
      vipLevel: null,
      lastChecked: null,
      homeDir: accountDir,
      sessionType: 'isolated',
      createdAt: new Date().toISOString(),
    })
    this._saveAccounts()

    return {
      accountId,
      deviceCode: deviceMatch ? deviceMatch[1] : null,
      userCode: codeMatch ? codeMatch[1] : null,
      verificationUri: uriMatch ? (uriMatch[1] || uriMatch[0]) : null,
      raw: out.trim(),
    }
  }

  /**
   * Poll checklogin until the user authorises in-browser, or timeout.
   *
   * @param {string} accountId
   * @param {string} deviceCode
   * @param {number} [timeout=120] — seconds
   * @returns {Promise<{success:boolean, credits?:number, userId?:string, userName?:string, vipLevel?:string}>}
   */
  async pollLogin(accountId, deviceCode, timeout = 120) {
    const out = await this._runCliCommand(accountId, [
      'login', 'checklogin',
      `--device_code=${deviceCode}`,
      `--poll=${timeout}`,
    ])

    const success = /success|登录成功|授权成功|authorized|logged.?in/i.test(out)

    if (success) {
      // Fetch credit info for the newly-authenticated account
      const creditInfo = await this._fetchCredit(accountId)
      const account = this._accounts.find(a => a.id === accountId)
      if (account) {
        Object.assign(account, creditInfo, { lastChecked: new Date().toISOString() })
        this._saveAccounts()
      }
      // If this is the only account, make it active automatically
      if (!this._readActiveId() || this._accounts.length === 1) {
        this.switchAccount(accountId)
      }
      return { success: true, ...creditInfo }
    }

    // Login failed — clean up the pre-registered account
    const idx = this._accounts.findIndex(a => a.id === accountId)
    if (idx !== -1) this._accounts.splice(idx, 1)
    this._saveAccounts()

    return { success: false, output: out.trim() }
  }

  // ─── Credit Queries ─────────────────────────────────────────────

  /**
   * Check remaining credits for a single account.
   * @param {string} accountId
   * @returns {Promise<{credits:number|null, vipLevel:string|null}>}
   */
  async checkCredit(accountId) {
    const info = await this._fetchCredit(accountId)
    const account = this._accounts.find(a => a.id === accountId)
    if (account) {
      Object.assign(account, info, { lastChecked: new Date().toISOString() })
      this._saveAccounts()
    }
    return info
  }

  /**
   * Check credits for ALL accounts in parallel.
   * @returns {Promise<Array<{id:string, credits:number|null, vipLevel:string|null}>>}
   */
  async checkAllCredits() {
    const results = await Promise.allSettled(
      this._accounts.map(async (a) => {
        const info = await this._fetchCredit(a.id)
        Object.assign(a, info, { lastChecked: new Date().toISOString() })
        return { id: a.id, ...info }
      })
    )
    this._saveAccounts()
    return results.map((r, i) =>
      r.status === 'fulfilled'
        ? r.value
        : { id: this._accounts[i].id, credits: null, vipLevel: null, error: r.reason?.message }
    )
  }

  // ─── CLI Environment (THE KEY METHOD) ───────────────────────────

  /**
   * Build an env object suitable for spawning dreamina CLI commands
   * under a specific account's HOME directory.
   *
   * @param {string|null} [accountId=null] — defaults to active account
   * @returns {{HOME:string, PATH:string, [key:string]:string}}
   */
  getCliEnv(accountId = null) {
    const id = accountId || this._readActiveId()
    if (!id) throw new Error('没有活跃账户，请先登录或切换账户')

    const account = this._accounts.find(a => a.id === id)
    if (!account) throw new Error(`账户不存在: ${id}`)

    const accountDir = this._getAccountHome(id)
    if (accountDir !== HOME) this.ensureAccountKeychain(id)
    const extendedPath = [process.env.PATH || '', ...EXTRA_PATHS].join(':')

    return { ...process.env, HOME: accountDir, PATH: extendedPath }
  }

  // ─── Auto-scheduling (stub) ─────────────────────────────────────

  /**
   * Find the first account with at least `minCredits`.
   * @param {number} minCredits
   * @returns {Object|null}
   */
  findAccountWithCredits(minCredits) {
    return this._accounts.find(a => a.credits != null && a.credits >= minCredits) || null
  }

  async selectAvailableAccount(minCredits = 1) {
    await this.checkAllCredits()
    const active = this.getActiveAccount()
    if (active && active.credits != null && active.credits >= minCredits) return active

    const candidate = this.findAccountWithCredits(minCredits)
    if (candidate) {
      this.switchAccount(candidate.id)
      return candidate
    }
    return active
  }

  // ─── Private Helpers ────────────────────────────────────────────

  /** @returns {Array<Object>} */
  _loadAccounts() {
    try {
      if (fs.existsSync(this.accountsFile)) {
        return JSON.parse(fs.readFileSync(this.accountsFile, 'utf-8'))
      }
    } catch (e) {
      console.error('Failed to load accounts.json:', e)
    }
    return []
  }

  _saveAccounts() {
    fs.writeFileSync(this.accountsFile, JSON.stringify(this._accounts, null, 2), 'utf-8')
  }

  _createDefaultAccountRecord() {
    this._accounts = [{
      id: 'account_default',
      name: '默认 CLI 账号',
      credits: null,
      vipLevel: null,
      userId: null,
      userName: null,
      lastChecked: null,
      homeDir: HOME,
      sessionType: 'system',
      createdAt: new Date().toISOString(),
    }]
    this._saveAccounts()
    this.switchAccount('account_default')
  }

  _normalizeAccounts() {
    let changed = false
    for (const account of this._accounts) {
      if (account.id === 'account_default') {
        if (account.homeDir !== HOME || account.sessionType !== 'system') {
          account.homeDir = HOME
          account.sessionType = 'system'
          account.name = account.name || '默认 CLI 账号'
          changed = true
        }
      } else if (!account.homeDir) {
        account.homeDir = this._getAccountDir(account.id)
        account.sessionType = 'isolated'
        changed = true
      }
    }
    if (changed) this._saveAccounts()
  }

  /**
   * @param {string} accountId
   * @returns {string} absolute path to account directory
   */
  _getAccountDir(accountId) {
    return path.join(this.baseDir, accountId)
  }

  _getAccountHome(accountId) {
    const account = this._accounts.find(a => a.id === accountId)
    return account?.homeDir || this._getAccountDir(accountId)
  }

  /** @returns {string|null} */
  _readActiveId() {
    try {
      if (fs.existsSync(this.activeFile)) {
        return fs.readFileSync(this.activeFile, 'utf-8').trim() || null
      }
    } catch (_) {}
    return null
  }

  /**
   * Ensure a macOS keychain exists for sandboxed HOME directories.
   * Symlinking to the real login keychain makes all accounts share one OAuth
   * secret, so isolated accounts get their own empty login.keychain-db.
   * @param {string} accountId
   */
  ensureAccountKeychain(accountId) {
    if (process.platform !== 'darwin') return
    const accountDir = this._getAccountHome(accountId)
    if (accountDir === HOME) return
    const libraryDir = path.join(accountDir, 'Library')
    const keychainsDir = path.join(libraryDir, 'Keychains')
    const loginKeychain = path.join(keychainsDir, 'login.keychain-db')

    if (!fs.existsSync(libraryDir)) {
      fs.mkdirSync(libraryDir, { recursive: true })
    }

    let keychainsStat = null
    try {
      keychainsStat = fs.lstatSync(keychainsDir)
    } catch (_) {}

    if (keychainsStat && !keychainsStat.isDirectory()) {
      const backup = path.join(libraryDir, `Keychains.legacy-${Date.now()}`)
      try {
        fs.renameSync(keychainsDir, backup)
        console.log(`[AccountRouter] Moved legacy keychain link for ${accountId} to ${path.basename(backup)}`)
      } catch (err) {
        console.error(`[AccountRouter] Failed to move legacy keychain link for ${accountId}:`, err.message)
      }
    }

    fs.mkdirSync(keychainsDir, { recursive: true })

    if (!fs.existsSync(loginKeychain)) {
      try {
        execFileSync('security', ['create-keychain', '-p', '', loginKeychain], { stdio: 'ignore' })
        execFileSync('security', ['set-keychain-settings', '-lut', '21600', loginKeychain], { stdio: 'ignore' })
        console.log(`[AccountRouter] Created isolated keychain for ${accountId}`)
      } catch (err) {
        console.error(`[AccountRouter] Failed to create isolated keychain for ${accountId}:`, err.message)
      }
    }

    try {
      execFileSync('security', ['unlock-keychain', '-p', '', loginKeychain], { stdio: 'ignore' })
    } catch (err) {
      console.error(`[AccountRouter] Failed to unlock isolated keychain for ${accountId}:`, err.message)
    }
  }

  /**
   * Spawn a dreamina CLI command with HOME override for the given account.
   * @param {string} accountId
   * @param {string[]} args
   * @returns {Promise<string>} combined stdout+stderr
   */
  _runCliCommand(accountId, args) {
    this.ensureAccountKeychain(accountId)

    return new Promise((resolve, reject) => {
      const accountDir = this._getAccountHome(accountId)
      const extendedPath = [process.env.PATH || '', ...EXTRA_PATHS].join(':')
      const env = { ...process.env, HOME: accountDir, PATH: extendedPath }

      const proc = spawn(DREAMINA_CLI, args, { env, shell: false })


      let stdout = ''
      let stderr = ''

      proc.stdout.on('data', (chunk) => { stdout += chunk.toString() })
      proc.stderr.on('data', (chunk) => { stderr += chunk.toString() })

      proc.on('close', (code) => {
        if (code === 0) {
          resolve(stdout + stderr)
        } else {
          const combined = (stdout + stderr).slice(0, 1000)
          reject(new Error(`dreamina ${args[0]} 失败 (code ${code})\n${combined}`))
        }
      })
      proc.on('error', (err) => {
        reject(new Error(`无法启动 dreamina "${DREAMINA_CLI}": ${err.message}`))
      })
    })
  }

  /**
   * Parse credit/vip info from `dreamina user_credit` output.
   * @param {string} accountId
   * @returns {Promise<{credits:number|null, vipLevel:string|null, userId:string|null, userName:string|null}>}
   */
  async _fetchCredit(accountId) {
    try {
      const out = await this._runCliCommand(accountId, ['user_credit'])
      return this._parseCreditOutput(out)
    } catch (e) {
      console.error(`Failed to fetch credit for ${accountId}:`, e.message)
      return { credits: null, vipLevel: null, userId: null, userName: null }
    }
  }

  _parseCreditOutput(text) {
    try {
      const json = JSON.parse(text)
      return {
        credits: Number.isFinite(Number(json.total_credit ?? json.credits ?? json.credit))
          ? Number(json.total_credit ?? json.credits ?? json.credit)
          : null,
        vipLevel: json.vip_level ?? json.vipLevel ?? null,
        userId: json.user_id != null ? String(json.user_id) : (json.userId != null ? String(json.userId) : null),
        userName: json.user_name ?? json.userName ?? null,
      }
    } catch (_) {
      const credits = this._parseNumber(text, /(?:total[_\s-]?)?credit[s]?["']?\s*[:=]\s*"?(\d+)/i)
      const vipLevel = this._parseField(text, /vip[_\s]?level["']?\s*[:=]\s*"?([^",\s\n}]+)/i)
      const userId = this._parseField(text, /user[_\s]?id["']?\s*[:=]\s*"?([^",\s\n}]+)/i)
      const userName = this._parseField(text, /user[_\s]?name["']?\s*[:=]\s*"?(.*?)["',\n}]/i)
      return { credits, vipLevel, userId, userName }
    }
  }

  /** Parse a number from CLI output using a regex */
  _parseNumber(text, re) {
    const m = text.match(re)
    return m ? parseInt(m[1], 10) : null
  }

  /** Parse a string field from CLI output using a regex */
  _parseField(text, re) {
    const m = text.match(re)
    return m ? m[1] : null
  }

  _seedCliVersionFile(accountDir) {
    const src = path.join(ORIGINAL_DREAMINA_DIR, 'version.json')
    const destDir = path.join(accountDir, '.dreamina_cli')
    const dest = path.join(destDir, 'version.json')
    if (!fs.existsSync(src) || fs.existsSync(dest)) return
    try {
      fs.mkdirSync(destDir, { recursive: true })
      fs.copyFileSync(src, dest)
    } catch (_) {}
  }
}

module.exports = AccountRouter
