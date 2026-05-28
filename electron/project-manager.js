/**
 * Project Manager — stores project metadata in ~/.local/share/jimeng-studio/projects/
 * Each project has:
 *   - id: timestamp string
 *   - name: user-defined title
 *   - prompt: original story prompt
 *   - createdAt / updatedAt
 *   - outputDir: where images/videos are stored
 *   - manifest: full scene data (imported from manifest.json if exists)
 *   - status: 'draft' | 'generating' | 'done' | 'partial'
 */

const path = require('path')
const fs = require('fs')
const os = require('os')

const PROJECTS_DIR = path.join(os.homedir(), '.local', 'share', 'jimeng-studio', 'projects')

function ensureDir() {
  fs.mkdirSync(PROJECTS_DIR, { recursive: true })
}

function projectPath(id) {
  return path.join(PROJECTS_DIR, `${id}.json`)
}

// List all projects sorted by updatedAt desc
function listProjects() {
  ensureDir()
  const files = fs.readdirSync(PROJECTS_DIR).filter(f => f.endsWith('.json'))
  return files
    .map(f => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(PROJECTS_DIR, f), 'utf-8'))
        return data
      } catch (_) { return null }
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
}

// Load a single project
function loadProject(id) {
  ensureDir()
  const p = projectPath(id)
  if (!fs.existsSync(p)) return null
  return JSON.parse(fs.readFileSync(p, 'utf-8'))
}

// Create new project
function createProject(name, prompt, outputDir) {
  ensureDir()
  const id = Date.now().toString()
  const now = new Date().toISOString()
  const project = {
    id,
    name: name || `项目 ${new Date().toLocaleDateString('zh-CN')}`,
    prompt: prompt || '',
    createdAt: now,
    updatedAt: now,
    outputDir: outputDir || '',
    status: 'draft',
    scenes: [],
  }
  fs.writeFileSync(projectPath(id), JSON.stringify(project, null, 2))
  return project
}

// Save/update project data
function saveProject(projectData) {
  ensureDir()
  const updated = {
    ...projectData,
    updatedAt: new Date().toISOString(),
  }
  fs.writeFileSync(projectPath(updated.id), JSON.stringify(updated, null, 2))
  return updated
}

// Delete project (keeps output files, only removes metadata)
function deleteProject(id) {
  const p = projectPath(id)
  if (fs.existsSync(p)) fs.unlinkSync(p)
  return { success: true }
}

// Import from manifest.json (from workflow output)
function importManifest(manifestPath) {
  const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
  const now = new Date().toISOString()
  const id = Date.now().toString()

  const scenesDone = raw.scenes?.filter(s => s.status === 'video_done').length ?? 0
  const scenesStarted = raw.scenes?.filter(s => ['image_done', 'video_done'].includes(s.status)).length ?? 0
  const scenesTotal = raw.scenes?.length ?? 0
  const status = scenesDone === scenesTotal ? 'done' : scenesStarted > 0 ? 'partial' : 'draft'

  const project = {
    id,
    name: raw.title || `未命名项目`,
    prompt: raw.prompt || '',
    createdAt: raw.createdAt || now,
    updatedAt: now,
    outputDir: raw.outputDir || path.dirname(manifestPath),
    status,
    scenes: raw.scenes || [],
  }
  ensureDir()
  fs.writeFileSync(projectPath(id), JSON.stringify(project, null, 2))
  return project
}

module.exports = { listProjects, loadProject, createProject, saveProject, deleteProject, importManifest }
