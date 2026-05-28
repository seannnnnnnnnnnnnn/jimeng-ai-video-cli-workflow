const { app } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')

const STORE_PATH = path.join(app.getPath('userData'), 'settings.json')

const DEFAULTS = {
  // LLM settings
  llmBaseUrl: 'https://api.openai.com/v1',
  llmApiKey: '',
  llmModel: 'gpt-4o',

  // Jimeng CLI settings
  jimengCliPath: `${os.homedir()}/.local/bin/dreamina`, // absolute path
  imageResolutionType: '2k',          // 2k or 4k (for model 4.0+)
  imageRatio: '16:9',
  imageModelVersion: '',               // empty = CLI default
  videoModel: 'seedance2.0_vip',      // supports 1080p
  videoDuration: 5,
  videoResolution: '1080p',

  // Workflow settings
  defaultSceneCount: 4,
  outputDir: '',
}

function loadSettings() {
  try {
    if (fs.existsSync(STORE_PATH)) {
      const raw = fs.readFileSync(STORE_PATH, 'utf-8')
      return { ...DEFAULTS, ...JSON.parse(raw) }
    }
  } catch (e) {
    console.error('Failed to load settings:', e)
  }
  return { ...DEFAULTS }
}

function saveSettings(settings) {
  try {
    const merged = { ...loadSettings(), ...settings }
    fs.writeFileSync(STORE_PATH, JSON.stringify(merged, null, 2), 'utf-8')
  } catch (e) {
    console.error('Failed to save settings:', e)
  }
}

module.exports = { loadSettings, saveSettings }
