// ─── Editor Module ──────────────────────────────────────────────
const E = id => document.getElementById(id)
const api = window.electronAPI

// ─── State ──────────────────────────────────────────────────────
const es = {
  mediaItems: [],      // bin items
  clips: [],           // timeline clips: {id,src,name,type,mediaDuration,startTime,duration,trimIn,trimOut,transitionToNext}
  selected: null,      // selected clip id
  pxPerSec: 80,
  snap: true,
  playing: false,
  currentTime: 0,      // global timeline time
  inPoint: null,
  outPoint: null,
  previewItem: null,   // item currently in preview (bin item or null)
  exportPath: null,
  exportUnlisten: null,
  dragData: null,
}

// ─── Helpers ────────────────────────────────────────────────────
const fmtTime = s => {
  if (!isFinite(s)) s = 0
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = (s % 60).toFixed(3)
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${sec.padStart(6,'0')}`
}
const fmtShort = s => {
  if (s == null || !isFinite(s)) return '--:--'
  const m = Math.floor(s / 60), sec = Math.floor(s % 60)
  return `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`
}
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2)
const totalDuration = () => es.clips.reduce((s,c)=>s+c.duration,0)
const trackWidth = () => Math.max(800, totalDuration() * es.pxPerSec + 200)

// ─── Init (only when tab is active) ─────────────────────────────
let editorInited = false
function initEditor() {
  if (editorInited) return
  editorInited = true
  bindTransport()
  bindToolbar()
  bindBin()
  bindExport()
  bindProjectUI()
  bindResizers()
  bindKeys()
  renderRuler()
  E('timeline-track-area').addEventListener('click', onTrackClick)
}

// Watch for tab activation
const tabBtn = document.querySelector('[data-tab="editor"]')
if (tabBtn) tabBtn.addEventListener('click', () => { initEditor(); setTimeout(renderTimeline, 50) })


// ─── Preview Player ──────────────────────────────────────────────
const vid = E('editor-video')

function loadPreview(item, seekTo = 0) {
  es.previewItem = item
  E('editor-placeholder').style.display = 'none'
  vid.style.display = 'block'
  vid.src = 'file://' + item.src
  vid.load()
  vid.currentTime = seekTo
  updateInOutBar()
  // Adjust aspect ratio
  const wrap = E('editor-preview-wrap')
  if (item.width && item.height) {
    const ratio = item.width / item.height
    wrap.style.aspectRatio = ratio.toFixed(4)
    wrap.style.maxHeight = '100%'
    wrap.style.maxWidth = '100%'
  } else {
    wrap.style.aspectRatio = '16/9'
  }
}

vid.addEventListener('timeupdate', () => {
  if (!es.playing) return
  // Update timecode based on which clip is playing
  const clip = es.clips.find(c => c.id === es._playingClipId)
  if (clip) {
    const elapsed = vid.currentTime - clip.trimIn
    es.currentTime = clip.startTime + elapsed
    updateTimecode()
    updatePlayhead()
    // Check if clip ended
    if (vid.currentTime >= clip.trimIn + clip.duration || vid.ended) {
      advanceToNextClip(clip)
    }
  } else {
    updateTimecode()
    updateInOutBar()
  }
})

vid.addEventListener('pause', () => { if (es.playing && !es._advancing) stopPlay() })

function playTimeline() {
  if (!es.clips.length) return
  es.playing = true
  E('tp-play').textContent = '⏸'
  playClipAtTime(es.currentTime)
}

function stopPlay() {
  es.playing = false
  es._advancing = false
  E('tp-play').textContent = '▶'
  vid.pause()
}

function playClipAtTime(t) {
  let acc = 0
  for (const clip of es.clips) {
    if (t < acc + clip.duration) {
      es._playingClipId = clip.id
      if (vid.src !== 'file://' + clip.src) {
        loadPreview({ ...clip, width: 1280, height: 720 }, clip.trimIn + (t - acc))
      } else {
        vid.currentTime = clip.trimIn + (t - acc)
      }
      vid.play().catch(()=>{})
      return
    }
    acc += clip.duration
  }
  stopPlay() // past end
}

function advanceToNextClip(clip) {
  es._advancing = true
  const idx = es.clips.findIndex(c => c.id === clip.id)
  if (idx < es.clips.length - 1) {
    const next = es.clips[idx + 1]
    es._playingClipId = next.id
    es.currentTime = next.startTime
    if (vid.src !== 'file://' + next.src) {
      loadPreview({ ...next, width: 1280, height: 720 }, next.trimIn)
    } else {
      vid.currentTime = next.trimIn
    }
    vid.play().catch(()=>{})
    es._advancing = false
  } else {
    stopPlay()
    es.currentTime = totalDuration()
    updateTimecode()
    updatePlayhead()
  }
}

function updateTimecode() {
  const t = es.playing ? es.currentTime : (es.previewItem ? vid.currentTime : es.currentTime)
  E('transport-timecode').textContent = fmtTime(t)
}

function updateInOutBar() {
  const bar = E('preview-inout-bar')
  if (!es.previewItem || (es.inPoint == null && es.outPoint == null)) { bar.style.display = 'none'; return }
  bar.style.display = 'block'
  const dur = es.previewItem.duration || es.previewItem.mediaDuration || 1
  const iP = (es.inPoint ?? 0) / dur * 100
  const oP = (es.outPoint ?? dur) / dur * 100
  E('inout-range').style.left = iP + '%'
  E('inout-range').style.width = (oP - iP) + '%'
}

// ─── Transport Binding ───────────────────────────────────────────
function bindTransport() {
  E('tp-play').onclick = () => {
    if (es.playing) stopPlay()
    else { if (es.clips.length) playTimeline(); else if (es.previewItem) { vid.play().catch(()=>{}) } }
  }
  E('tp-prev').onclick = () => { if (vid.src) vid.currentTime = Math.max(0, vid.currentTime - 1/25) }
  E('tp-next').onclick = () => { if (vid.src) vid.currentTime = Math.min(vid.duration||0, vid.currentTime + 1/25) }
  E('tp-inpoint').onclick = () => {
    es.inPoint = vid.src ? vid.currentTime : null
    E('in-label').textContent = fmtShort(es.inPoint)
    updateInOutBar()
  }
  E('tp-outpoint').onclick = () => {
    es.outPoint = vid.src ? vid.currentTime : null
    E('out-label').textContent = fmtShort(es.outPoint)
    updateInOutBar()
  }
  E('tp-clear-inout').onclick = () => {
    es.inPoint = null; es.outPoint = null
    E('in-label').textContent = '--:--'; E('out-label').textContent = '--:--'
    updateInOutBar()
  }
  E('tp-apply-inout').onclick = applyInOutToSelected
  vid.addEventListener('timeupdate', updateTimecode)
}

function applyInOutToSelected() {
  const clip = es.clips.find(c => c.id === es.selected)
  if (!clip || es.inPoint == null || es.outPoint == null) return
  const i = Math.min(es.inPoint, es.outPoint), o = Math.max(es.inPoint, es.outPoint)
  clip.trimIn = i; clip.trimOut = o; clip.duration = o - i
  reflow(); renderTimeline()
}

// ─── Media Bin ───────────────────────────────────────────────────
function bindBin() {
  E('editor-import-btn').onclick = async () => {
    const res = await api.editorImport()
    if (!res.success || !res.items) return
    for (const item of res.items) {
      item.mediaDuration = item.duration
      es.mediaItems.push(item)
    }
    renderBin()
  }
}

function renderBin() {
  const list = E('bin-list')
  E('bin-empty').style.display = es.mediaItems.length ? 'none' : 'flex'
  // Remove old items
  list.querySelectorAll('.bin-item').forEach(el => el.remove())
  for (const item of es.mediaItems) {
    const el = document.createElement('div')
    el.className = 'bin-item'
    el.dataset.id = item.id
    const icon = item.type === 'image' ? '🖼' : '🎬'
    const durStr = item.type === 'image' ? `${item.duration}s (静帧)` : fmtShort(item.duration)
    el.innerHTML = `
      <div class="bin-item-thumb">${icon}</div>
      <div class="bin-item-info">
        <div class="bin-item-name" title="${item.name}">${item.name}</div>
        <div class="bin-item-meta">${durStr} · ${item.type === 'image' ? '图片' : '视频'}</div>
      </div>
      <button class="bin-item-add" title="添加到时间线">＋</button>`
    el.querySelector('.bin-item-add').onclick = (e) => { e.stopPropagation(); addClipToTimeline(item) }
    el.onclick = () => { loadPreview(item, 0); el.classList.toggle('selected') }
    list.appendChild(el)
    // Load video thumbnail
    if (item.type === 'image') {
      const img = document.createElement('img')
      img.src = 'file://' + item.src
      el.querySelector('.bin-item-thumb').innerHTML = ''
      el.querySelector('.bin-item-thumb').appendChild(img)
    }
  }
}

// ─── Timeline ────────────────────────────────────────────────────
function addClipToTimeline(item) {
  const lastClip = es.clips[es.clips.length - 1]
  const startTime = lastClip ? lastClip.startTime + lastClip.duration : 0
  const defTrans = E('default-transition-type').value
  const defDur = parseFloat(E('default-transition-dur').value) || 0.5
  const clip = {
    id: uid(), src: item.src, name: item.name, type: item.type,
    mediaDuration: item.mediaDuration || item.duration,
    startTime, duration: item.duration, trimIn: 0, trimOut: item.duration,
    transitionToNext: defTrans !== 'none' ? { type: defTrans, duration: defDur } : null,
  }
  es.clips.push(clip)
  reflow(); renderTimeline(); markDirty()
}

function reflow() {
  let t = 0
  for (const c of es.clips) { c.startTime = t; t += c.duration }
}

function renderTimeline() {
  const track = E('timeline-track')
  track.querySelectorAll('.tl-clip,.tl-transition,.snap-line').forEach(e=>e.remove())
  const tw = trackWidth()
  track.style.width = tw + 'px'
  E('timeline-track-area').style.width = tw + 'px'
  renderRuler()
  for (let i = 0; i < es.clips.length; i++) {
    const c = es.clips[i]
    renderClip(c, i)
    if (i < es.clips.length - 1 && c.transitionToNext) renderTransitionMarker(c, i)
  }
  updatePlayhead()
}

function renderClip(clip, idx) {
  const track = E('timeline-track')
  const el = document.createElement('div')
  el.className = `tl-clip ${clip.type}-clip${clip.id === es.selected ? ' selected' : ''}`
  el.id = 'clip-' + clip.id
  el.style.left = (clip.startTime * es.pxPerSec) + 'px'
  el.style.width = Math.max(8, clip.duration * es.pxPerSec) + 'px'
  el.innerHTML = `
    <div class="tl-trim tl-trim-left"></div>
    <div class="tl-clip-label">${clip.name}</div>
    <div class="tl-trim tl-trim-right"></div>`

  el.addEventListener('mousedown', e => {
    if (e.target.classList.contains('tl-trim-left')) { startTrim(e, clip, 'left'); return }
    if (e.target.classList.contains('tl-trim-right')) { startTrim(e, clip, 'right'); return }
    selectClip(clip.id)
    startDrag(e, clip)
  })
  el.addEventListener('click', e => { e.stopPropagation(); selectClip(clip.id) })
  track.appendChild(el)
}

function renderTransitionMarker(clip) {
  const track = E('timeline-track')
  const el = document.createElement('div')
  el.className = 'tl-transition'
  const x = (clip.startTime + clip.duration) * es.pxPerSec
  el.style.left = x + 'px'
  el.title = clip.transitionToNext ? clip.transitionToNext.type : 'none'
  el.textContent = '⟨⟩'
  el.addEventListener('click', e => { e.stopPropagation(); showTransitionPopup(e, clip) })
  track.appendChild(el)
}

function selectClip(id) {
  es.selected = id
  document.querySelectorAll('.tl-clip').forEach(el => el.classList.remove('selected'))
  const el = E('clip-' + id)
  if (el) el.classList.add('selected')
  // Load clip into preview
  const clip = es.clips.find(c => c.id === id)
  if (clip) loadPreview({ ...clip, width:1280, height:720 }, clip.trimIn)
}

function onTrackClick(e) {
  if (e.target === E('timeline-track-area') || e.target === E('timeline-track')) {
    es.selected = null
    document.querySelectorAll('.tl-clip').forEach(el => el.classList.remove('selected'))
    const rect = E('timeline-track').getBoundingClientRect()
    const x = e.clientX - rect.left
    es.currentTime = Math.max(0, x / es.pxPerSec)
    updatePlayhead(); updateTimecode()
  }
}

// ─── Drag ────────────────────────────────────────────────────────
function startDrag(e, clip) {
  const startX = e.clientX, origStart = clip.startTime
  const onMove = mv => {
    const dx = mv.clientX - startX
    let newStart = Math.max(0, origStart + dx / es.pxPerSec)
    if (es.snap) newStart = snapTo(newStart, clip)
    clip.startTime = newStart
    const el = E('clip-' + clip.id)
    if (el) el.style.left = (newStart * es.pxPerSec) + 'px'
  }
  const onUp = () => {
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
    es.clips.sort((a,b)=>a.startTime-b.startTime)
    reflow(); renderTimeline()
  }
  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
}

function snapTo(newStart, clip) {
  const thresh = 8 / es.pxPerSec
  for (const other of es.clips) {
    if (other.id === clip.id) continue
    if (Math.abs(newStart - other.startTime) < thresh) return other.startTime
    if (Math.abs(newStart - (other.startTime + other.duration)) < thresh) return other.startTime + other.duration
    if (Math.abs(newStart + clip.duration - other.startTime) < thresh) return other.startTime - clip.duration
  }
  return newStart
}

// ─── Trim ────────────────────────────────────────────────────────
function startTrim(e, clip, side) {
  e.preventDefault(); e.stopPropagation()
  const startX = e.clientX, origDur = clip.duration, origTrimIn = clip.trimIn, origStart = clip.startTime
  const onMove = mv => {
    const dx = (mv.clientX - startX) / es.pxPerSec
    if (side === 'left') {
      const newTrimIn = Math.max(0, Math.min(origTrimIn + dx, clip.trimOut - 0.1))
      const diff = newTrimIn - origTrimIn
      clip.trimIn = newTrimIn; clip.duration = origDur - diff; clip.startTime = origStart + diff
    } else {
      clip.trimOut = Math.max(clip.trimIn + 0.1, Math.min(clip.mediaDuration, clip.trimIn + origDur + dx))
      clip.duration = clip.trimOut - clip.trimIn
    }
    const el = E('clip-' + clip.id)
    if (el) { el.style.left = (clip.startTime * es.pxPerSec) + 'px'; el.style.width = Math.max(8, clip.duration * es.pxPerSec) + 'px' }
  }
  const onUp = () => {
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
    reflow(); renderTimeline()
  }
  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
}

// ─── Ruler ───────────────────────────────────────────────────────
function renderRuler() {
  const ruler = E('timeline-ruler')
  if (!ruler) return
  ruler.innerHTML = ''
  const tw = trackWidth()
  ruler.style.width = tw + 'px'
  const step = es.pxPerSec >= 60 ? 1 : es.pxPerSec >= 20 ? 5 : 10
  for (let t = 0; t <= tw / es.pxPerSec + step; t += step / 5) {
    const x = t * es.pxPerSec
    if (x > tw) break
    const isMajor = Math.abs(t % step) < 0.01
    const tick = document.createElement('div')
    tick.className = 'ruler-tick'
    tick.style.left = x + 'px'
    tick.innerHTML = `<div style="height:${isMajor?12:6}px;width:1px;background:${isMajor?'rgba(255,255,255,0.25)':'rgba(255,255,255,0.1)'}"></div>`
    if (isMajor) {
      const lbl = document.createElement('span')
      lbl.className = 'ruler-label'
      lbl.style.left = x + 'px'
      lbl.textContent = fmtShort(t)
      ruler.appendChild(lbl)
    }
    ruler.appendChild(tick)
  }
}

// ─── Playhead ────────────────────────────────────────────────────
function updatePlayhead() {
  const ph = E('timeline-playhead')
  if (!ph) return
  ph.style.left = (es.currentTime * es.pxPerSec) + 'px'
  // Also sync scroll to keep playhead visible during playback
  if (es.playing) {
    const scroll = E('timeline-scroll')
    const phLeft = es.currentTime * es.pxPerSec
    const sw = scroll.clientWidth
    const sl = scroll.scrollLeft
    if (phLeft < sl + 30 || phLeft > sl + sw - 60) {
      scroll.scrollLeft = Math.max(0, phLeft - sw / 2)
    }
  }
}

function bindPlayheadDrag() {
  const ph = E('timeline-playhead')
  if (!ph) return
  ph.addEventListener('mousedown', e => {
    e.stopPropagation()
    const scroll = E('timeline-scroll')
    const track = E('timeline-track')
    const onMove = mv => {
      const rect = track.getBoundingClientRect()
      const x = mv.clientX - rect.left + scroll.scrollLeft
      es.currentTime = Math.max(0, x / es.pxPerSec)
      updatePlayhead(); updateTimecode()
      if (es.playing) { stopPlay(); playClipAtTime(es.currentTime) }
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  })
  // Ruler click to seek
  const ruler = E('timeline-ruler')
  if (ruler) ruler.addEventListener('click', e => {
    const scroll = E('timeline-scroll')
    const rect = ruler.getBoundingClientRect()
    const x = e.clientX - rect.left + scroll.scrollLeft
    es.currentTime = Math.max(0, x / es.pxPerSec)
    updatePlayhead(); updateTimecode()
    if (es.playing) { stopPlay(); playClipAtTime(es.currentTime) }
  })
}

// ─── Toolbar ─────────────────────────────────────────────────────
function bindToolbar() {
  E('tl-snap-btn').onclick = () => {
    es.snap = !es.snap
    E('tl-snap-btn').classList.toggle('active', es.snap)
  }
  E('tl-cut-btn').onclick = cutAtPlayhead
  E('tl-delete-btn').onclick = deleteSelected
  E('tl-clear-btn').onclick = () => { if (confirm('确定清空时间线？')) { es.clips = []; es.selected = null; renderTimeline() } }
  E('tl-zoom-in').onclick = () => { es.pxPerSec = Math.min(300, es.pxPerSec + 20); E('tl-zoom-label').textContent = es.pxPerSec+'px/s'; renderTimeline() }
  E('tl-zoom-out').onclick = () => { es.pxPerSec = Math.max(20, es.pxPerSec - 20); E('tl-zoom-label').textContent = es.pxPerSec+'px/s'; renderTimeline() }
  // Timeline track background click to seek
  E('timeline-track').addEventListener('click', e => {
    if (e.target === E('timeline-track')) {
      const scroll = E('timeline-scroll')
      const rect = E('timeline-track').getBoundingClientRect()
      const x = e.clientX - rect.left + scroll.scrollLeft
      es.currentTime = Math.max(0, x / es.pxPerSec)
      updatePlayhead(); updateTimecode()
    }
  })
  bindPlayheadDrag()
}

function cutAtPlayhead() {
  const t = es.currentTime
  const clip = es.clips.find(c => t > c.startTime && t < c.startTime + c.duration)
  if (!clip) return
  const elapsed = t - clip.startTime
  const newClip = {
    id: uid(), src: clip.src, name: clip.name, type: clip.type,
    mediaDuration: clip.mediaDuration,
    startTime: t, duration: clip.duration - elapsed,
    trimIn: clip.trimIn + elapsed, trimOut: clip.trimOut,
    transitionToNext: clip.transitionToNext,
  }
  clip.duration = elapsed; clip.trimOut = clip.trimIn + elapsed; clip.transitionToNext = null
  const idx = es.clips.indexOf(clip)
  es.clips.splice(idx + 1, 0, newClip)
  reflow(); renderTimeline(); markDirty()
}

function deleteSelected() {
  if (!es.selected) return
  es.clips = es.clips.filter(c => c.id !== es.selected)
  es.selected = null; reflow(); renderTimeline(); markDirty()
}

// ─── Transition Popup ────────────────────────────────────────────
let activePopup = null
function showTransitionPopup(e, clip) {
  if (activePopup) { activePopup.remove(); activePopup = null }
  const types = [
    ['none','无转场'],['fade','淡入淡出'],['fadeblack','黑场溶解'],
    ['dissolve','交叉溶解'],['wipeleft','向左擦除'],['wiperight','向右擦除']
  ]
  const pop = document.createElement('div')
  pop.className = 'transition-popup'
  const cur = clip.transitionToNext?.type || 'none'
  const curDur = clip.transitionToNext?.duration || 0.5
  pop.innerHTML = `<div class="transition-popup-title">转场效果</div>` +
    types.map(([v,l])=>`<div class="transition-option${cur===v?' active':''}" data-v="${v}">${l}</div>`).join('') +
    `<div class="transition-dur">时长 <input type="number" id="tr-dur-inp" value="${curDur}" min="0.1" max="3" step="0.1" style="width:44px"> s</div>`
  pop.style.left = e.clientX + 'px'; pop.style.top = e.clientY + 'px'
  pop.querySelectorAll('.transition-option').forEach(opt => {
    opt.onclick = () => {
      const v = opt.dataset.v, dur = parseFloat(pop.querySelector('#tr-dur-inp').value)||0.5
      clip.transitionToNext = v === 'none' ? null : { type: v, duration: dur }
      pop.remove(); activePopup = null; renderTimeline()
    }
  })
  document.body.appendChild(pop); activePopup = pop
  setTimeout(() => document.addEventListener('click', ()=>{pop.remove();activePopup=null}, {once:true}), 50)
}

// ─── Export ──────────────────────────────────────────────────────
function bindExport() {
  E('editor-export-open-btn').onclick = openExportModal
  E('export-cancel-btn').onclick = closeExportModal
  E('export-choose-path-btn').onclick = async () => {
    const res = await api.editorChooseOutput()
    if (res.success) { es.exportPath = res.outputPath; E('export-path-input').value = res.outputPath }
  }
  E('export-start-btn').onclick = startExport
  E('export-modal').addEventListener('click', e => { if (e.target===E('export-modal')) closeExportModal() })
}

function openExportModal() {
  if (!es.clips.length) { alert('时间线为空，请先添加素材'); return }
  E('export-modal').style.display = 'grid'
  E('export-progress-bar').style.display = 'none'
  E('export-progress-label').textContent = ''
  E('export-start-btn').disabled = false
  E('export-start-btn').textContent = '开始导出'
}
function closeExportModal() { E('export-modal').style.display = 'none'; if (es.exportUnlisten) { es.exportUnlisten(); es.exportUnlisten=null } }

async function startExport() {
  if (!es.exportPath) { alert('请先选择导出路径'); return }
  E('export-start-btn').disabled = true
  E('export-start-btn').textContent = '导出中...'
  E('export-progress-bar').style.display = 'block'
  E('export-progress-fill').style.width = '0%'
  E('export-progress-label').textContent = '正在初始化 ffmpeg...'
  es.exportUnlisten = api.onEditorExportProgress(({ progress }) => {
    const pct = Math.round(progress * 100)
    E('export-progress-fill').style.width = pct + '%'
    E('export-progress-label').textContent = `导出进度：${pct}%`
  })
  const clips = es.clips.map(c => ({
    src: c.src, type: c.type, trimIn: c.trimIn, duration: c.duration,
    transitionToNext: c.transitionToNext,
  }))
  const res = await api.editorExport({ clips, outputPath: es.exportPath, resolution: E('export-resolution').value })
  if (es.exportUnlisten) { es.exportUnlisten(); es.exportUnlisten = null }
  if (res.success) {
    E('export-progress-label').textContent = '✅ 导出成功！'
    E('export-start-btn').textContent = '打开文件'
    E('export-start-btn').disabled = false
    E('export-start-btn').onclick = () => { api.openFolder(res.outputPath.replace(/\/[^/]+$/,'')); closeExportModal() }
  } else {
    E('export-progress-label').textContent = '❌ ' + res.error
    E('export-start-btn').disabled = false
    E('export-start-btn').textContent = '重试'
    E('export-start-btn').onclick = startExport
  }
}

// ─── Keyboard ────────────────────────────────────────────────────
function bindKeys() {
  document.addEventListener('keydown', e => {
    if (document.querySelector('#tab-editor.active') === null) return
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return
    if (e.code === 'Space') { e.preventDefault(); E('tp-play').click() }
    if (e.code === 'KeyI') E('tp-inpoint').click()
    if (e.code === 'KeyO') E('tp-outpoint').click()
    if (e.code === 'Delete' || e.code === 'Backspace') deleteSelected()
  })
}

// ─── Editor Project Persistence ──────────────────────────────────
let autoSaveTimer = null

function markDirty() {
  if (!es.currentProject) return
  clearTimeout(autoSaveTimer)
  autoSaveTimer = setTimeout(saveCurrentProject, 2000) // auto-save after 2s idle
  const ind = E('editor-save-indicator')
  if (ind) { ind.textContent = '未保存'; ind.style.color = 'var(--accent)' }
}

async function saveCurrentProject() {
  if (!es.currentProject) return
  es.currentProject.clips = es.clips
  es.currentProject.updatedAt = new Date().toISOString()
  const res = await api.editorProjectSave(es.currentProject)
  if (res.success) {
    es.currentProject = res.project
    showSaveIndicator('✓ 已保存')
  } else {
    showSaveIndicator('❌ 保存失败')
  }
}

function showSaveIndicator(msg) {
  const ind = E('editor-save-indicator')
  if (!ind) return
  ind.style.display = 'inline'
  ind.style.color = msg.startsWith('✓') ? 'var(--accent)' : '#ef4444'
  ind.textContent = msg
  setTimeout(() => { ind.style.color = 'var(--text-muted)' }, 2000)
}

async function loadEditorProject(project) {
  es.currentProject = project
  es.clips = (project.clips || []).map(c => ({
    ...c,
    id: c.id || ('c_' + Date.now().toString(36) + Math.random().toString(36).slice(2))
  }))
  reflow()
  renderTimeline()

  // Load first clip into preview if available
  if (es.clips.length > 0) {
    const first = es.clips[0]
    loadPreview({ src: first.src, name: first.name, type: first.type, width: 1280, height: 720, duration: first.mediaDuration }, first.trimIn)
  }

  // Update select + show save button
  await refreshProjectSelect(project.id)
  const saveBtn = E('editor-save-project-btn')
  const ind = E('editor-save-indicator')
  if (saveBtn) saveBtn.style.display = 'inline-flex'
  if (ind) { ind.style.display = 'inline'; ind.textContent = '已加载' }
}

async function refreshProjectSelect(selectId) {
  const sel = E('editor-project-select')
  if (!sel) return
  const res = await api.editorProjectList()
  const projects = res.success ? res.projects : []
  sel.innerHTML = '<option value="">— 选择剪辑项目 —</option>' +
    projects.map(p => `<option value="${p.id}"${p.id === selectId ? ' selected' : ''}>${escapeHtml(p.name)} (${new Date(p.updatedAt).toLocaleDateString('zh-CN')})</option>`).join('')
}

function escapeHtml(str) {
  return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

// ─── Project UI bindings (called in initEditor) ───────────────────
function bindProjectUI() {
  const sel = E('editor-project-select')
  const saveBtn = E('editor-save-project-btn')
  const newBtn = E('editor-new-project-btn')

  if (sel) sel.onchange = async () => {
    const id = sel.value
    if (!id) return
    const res = await api.editorProjectLoad(id)
    if (res.success) await loadEditorProject(res.project)
  }

  if (saveBtn) saveBtn.onclick = saveCurrentProject

  if (newBtn) newBtn.onclick = () => {
    es.currentProject = null
    es.clips = []
    es.selected = null
    renderTimeline()
    E('editor-placeholder').style.display = 'flex'
    E('editor-video').style.display = 'none'
    const saveBtn2 = E('editor-save-project-btn')
    const ind = E('editor-save-indicator')
    if (saveBtn2) saveBtn2.style.display = 'none'
    if (ind) ind.style.display = 'none'
    if (sel) sel.value = ''
  }

  // Expose load function for cross-module calls from main.js
  window.__editorLoadProject = loadEditorProject

  // If a project was queued by main.js before editor initialized
  if (window.__pendingEditorProject) {
    const pending = window.__pendingEditorProject
    window.__pendingEditorProject = null
    setTimeout(() => loadEditorProject(pending), 100)
  }

  // Initial project list load
  refreshProjectSelect(null)
}

// ─── Resizable Panels ─────────────────────────────────────────────
function bindResizers() {
  bindVerticalResizer()
  bindHorizontalResizer()
}

// Vertical: resize preview ↔ bin width
function bindVerticalResizer() {
  const handle = document.getElementById('resizer-v')
  const top = document.getElementById('editor-top')
  const preview = document.getElementById('editor-preview-panel')
  const bin = document.getElementById('editor-bin')
  if (!handle || !top || !preview || !bin) return

  handle.addEventListener('mousedown', e => {
    e.preventDefault()
    handle.classList.add('dragging')
    document.body.style.cursor = 'ew-resize'
    document.body.style.userSelect = 'none'

    const startX = e.clientX
    const startPreviewW = preview.getBoundingClientRect().width
    const totalW = top.getBoundingClientRect().width - handle.offsetWidth

    const onMove = mv => {
      const dx = mv.clientX - startX
      let newPreviewW = Math.min(Math.max(200, startPreviewW + dx), totalW - 160)
      const newBinW = totalW - newPreviewW - handle.offsetWidth
      // Apply via explicit pixel widths
      preview.style.width = newPreviewW + 'px'
      preview.style.flex = 'none'
      bin.style.width = newBinW + 'px'
      bin.style.flex = 'none'
    }
    const onUp = () => {
      handle.classList.remove('dragging')
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  })
}

// Horizontal: resize top-row ↔ timeline height
function bindHorizontalResizer() {
  const handle = document.getElementById('resizer-h')
  const layout = document.getElementById('editor-layout')
  const top = document.getElementById('editor-top')
  const timeline = document.getElementById('editor-timeline-panel')
  if (!handle || !layout || !top || !timeline) return

  handle.addEventListener('mousedown', e => {
    e.preventDefault()
    handle.classList.add('dragging')
    document.body.style.cursor = 'ns-resize'
    document.body.style.userSelect = 'none'

    const startY = e.clientY
    const startTopH = top.getBoundingClientRect().height
    const totalH = layout.getBoundingClientRect().height
      - handle.offsetHeight

    const onMove = mv => {
      const dy = mv.clientY - startY
      const newTopH = Math.min(Math.max(160, startTopH + dy), totalH - 120)
      // Set top panel height; timeline fills remaining via flex:1
      top.style.height = newTopH + 'px'
    }
    const onUp = () => {
      handle.classList.remove('dragging')
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      // Re-render ruler/timeline after resize
      renderTimeline()
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  })
}

