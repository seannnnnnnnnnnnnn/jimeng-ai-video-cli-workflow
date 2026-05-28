/**
 * editor-exporter.js — FFmpeg-based video export for the editor module
 *
 * Handles:
 *  - Trimmed video clips  (-ss trimIn  -t duration -i src)
 *  - Image clips          (-loop 1 -t duration -i src)
 *  - Concat without transitions  (filter_complex concat)
 *  - xfade transitions  (filter_complex xfade + acrossfade)
 */

const { spawn } = require('child_process')
const fs = require('fs')

// ── Find ffmpeg ───────────────────────────────────────────────────
function findFFmpeg() {
  const candidates = [
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/usr/bin/ffmpeg',
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  return 'ffmpeg'
}
const FFMPEG_BIN = findFFmpeg()

// ── Resolution presets ────────────────────────────────────────────
const RESOLUTIONS = {
  '720p':  { w: 1280, h: 720  },
  '1080p': { w: 1920, h: 1080 },
}

// ── xfade transition map ──────────────────────────────────────────
const XFADE_MAP = {
  fade:       'fade',
  fadeblack:  'fadeblack',
  dissolve:   'dissolve',
  wipeleft:   'wipeleft',
  wiperight:  'wiperight',
}

// ── Build FFmpeg args ─────────────────────────────────────────────
function buildArgs(clips, outputPath, resolution = '720p') {
  const { w, h } = RESOLUTIONS[resolution] || RESOLUTIONS['720p']
  if (!clips.length) throw new Error('No clips to export')

  const args = []

  // 1. Input arguments (one per clip)
  for (const clip of clips) {
    if (clip.type === 'image') {
      args.push('-loop', '1', '-t', String(Math.max(0.1, clip.duration)))
    } else {
      if (clip.trimIn > 0.01) args.push('-ss', String(clip.trimIn))
      args.push('-t', String(Math.max(0.1, clip.duration)))
    }
    args.push('-i', clip.src)
  }

  const n = clips.length
  const filterParts = []

  // 2. Per-clip normalize filters → [nv{i}] [na{i}]
  for (let i = 0; i < n; i++) {
    const clip = clips[i]
    const dur = Math.max(0.1, clip.duration)

    // Video: scale + pad + fps + sar
    filterParts.push(
      `[${i}:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
      `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,fps=25,setsar=1,` +
      `format=yuv420p[nv${i}]`
    )

    // Audio: images get silent audio; videos get resampled audio
    if (clip.type === 'image') {
      filterParts.push(`aevalsrc=0:c=stereo:s=44100:d=${dur}[na${i}]`)
    } else {
      filterParts.push(`[${i}:a]aresample=44100[na${i}]`)
    }
  }

  // 3. Combine clips (with or without xfade transitions)
  const hasXfade = clips.some(
    (c, i) => i < n - 1 && c.transitionToNext &&
    c.transitionToNext.type !== 'none' && XFADE_MAP[c.transitionToNext.type]
  )

  let finalV, finalA

  if (n === 1) {
    // Single clip
    filterParts.push(`[nv0][na0]concat=n=1:v=1:a=1[vout][aout]`)
    finalV = '[vout]'; finalA = '[aout]'
  } else if (!hasXfade) {
    // Simple concat
    const vIn = Array.from({ length: n }, (_, i) => `[nv${i}][na${i}]`).join('')
    filterParts.push(`${vIn}concat=n=${n}:v=1:a=1[vout][aout]`)
    finalV = '[vout]'; finalA = '[aout]'
  } else {
    // Chain xfade / acrossfade
    let curV = 'nv0', curA = 'na0'
    let timeOffset = clips[0].duration

    for (let i = 1; i < n; i++) {
      const prev = clips[i - 1]
      const t = prev.transitionToNext
      const xType = t && XFADE_MAP[t.type]
      const tDur = xType ? Math.min(t.duration || 0.5, prev.duration * 0.8, clips[i].duration * 0.8) : 0
      const isLast = i === n - 1

      const outV = isLast ? 'vfinal' : `vmid${i}`
      const outA = isLast ? 'afinal' : `amid${i}`

      if (xType) {
        const offset = Math.max(0.01, timeOffset - tDur)
        filterParts.push(`[${curV}][nv${i}]xfade=transition=${xType}:duration=${tDur}:offset=${offset.toFixed(3)}[${outV}]`)
        filterParts.push(`[${curA}][na${i}]acrossfade=d=${tDur}[${outA}]`)
        timeOffset += clips[i].duration - tDur
      } else {
        filterParts.push(`[${curV}][${curA}][nv${i}][na${i}]concat=n=2:v=1:a=1[${outV}][${outA}]`)
        timeOffset += clips[i].duration
      }
      curV = outV; curA = outA
    }
    finalV = '[vfinal]'; finalA = '[afinal]'
  }

  args.push(
    '-filter_complex', filterParts.join(';'),
    '-map', finalV,
    '-map', finalA,
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '23',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    '-y',
    outputPath
  )
  return args
}

// ── Spawn export ──────────────────────────────────────────────────
function exportVideo({ clips, outputPath, resolution }, onProgress, onDone) {
  let args
  try {
    args = buildArgs(clips, outputPath, resolution)
  } catch (e) {
    onDone(e); return null
  }

  const totalDuration = clips.reduce((s, c) => s + c.duration, 0)
  const proc = spawn(FFMPEG_BIN, args)
  let stderr = ''

  proc.stderr.on('data', (data) => {
    const chunk = data.toString()
    stderr += chunk
    // Parse "time=HH:MM:SS.ss" for progress
    const m = chunk.match(/time=(\d+):(\d+):(\d+\.\d+)/)
    if (m) {
      const secs = parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3])
      onProgress && onProgress(Math.min(0.99, secs / totalDuration))
    }
  })

  proc.on('close', (code) => {
    if (code === 0) {
      onProgress && onProgress(1)
      onDone(null, outputPath)
    } else {
      onDone(new Error(`ffmpeg 退出码 ${code}\n${stderr.slice(-800)}`))
    }
  })

  proc.on('error', onDone)
  return proc
}

module.exports = { exportVideo, FFMPEG_BIN }
