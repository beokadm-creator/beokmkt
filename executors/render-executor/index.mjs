import 'dotenv/config'
import express from 'express'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import { spawn } from 'child_process'
import { randomUUID } from 'crypto'
import { createRequire } from 'module'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const port = Number(process.env.RENDER_EXECUTOR_PORT ?? 8788) || 8788
const publicBaseUrl = (process.env.RENDER_EXECUTOR_PUBLIC_BASE_URL ?? `http://localhost:${port}`).replace(/\/+$/, '')
const artifactsDir = path.resolve(__dirname, 'artifacts')
const ttsEngineDefault = process.platform === 'darwin' ? 'say' : 'none'
const ttsEngine = (process.env.TTS_ENGINE ?? ttsEngineDefault).trim()
const elevenLabsApiKey = (process.env.ELEVENLABS_API_KEY ?? '').trim()
const elevenLabsVoiceId = (process.env.ELEVENLABS_VOICE_ID ?? 'pNInz6obpgDQGcFmaJgB').trim()
const elevenLabsModelId = (process.env.ELEVENLABS_MODEL_ID ?? 'eleven_multilingual_v2').trim()
const require = createRequire(import.meta.url)
let ffmpegCmd = 'ffmpeg'
try {
  const resolved = require('ffmpeg-static')
  if (typeof resolved === 'string' && resolved) ffmpegCmd = resolved
} catch {}

const TARGET_W = 1080
const TARGET_H = 1920
const FPS = 30
const XFADE_DUR = 0.5

async function exists(p) {
  try {
    await fs.stat(p)
    return true
  } catch {
    return false
  }
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'pipe', ...options })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d) => (stdout += d.toString()))
    child.stderr?.on('data', (d) => (stderr += d.toString()))
    child.on('close', (code) => resolve({ code: Number(code ?? 0), stdout, stderr }))
    child.on('error', () => resolve({ code: 127, stdout, stderr }))
  })
}

async function ensureFfmpeg() {
  const r = await run(ffmpegCmd, ['-version'])
  return r.code === 0
}

function toLines(text) {
  if (typeof text !== 'string') return []
  return text
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
}

function formatSrtTime(seconds) {
  const ms = Math.floor((seconds - Math.floor(seconds)) * 1000)
  const total = Math.floor(seconds)
  const s = total % 60
  const m = Math.floor(total / 60) % 60
  const h = Math.floor(total / 3600)
  const pad = (n, w = 2) => String(n).padStart(w, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`
}

/**
 * Write SRT with per-scene subtitle sync.
 * @param {string} filePath
 * @param {Array<{subtitle?: string, duration_sec?: number}>} scenes
 * @param {number} totalDuration
 */
async function writeSrtScenes(filePath, scenes, totalDuration) {
  let out = ''
  let idx = 1
  let elapsed = 0

  for (const scene of scenes) {
    const dur = Math.max(1, Number(scene.duration_sec ?? 0) || 5)
    const subtitle = typeof scene.subtitle === 'string' && scene.subtitle.trim() ? scene.subtitle.trim() : ''
    if (!subtitle) {
      elapsed += dur
      continue
    }

    const start = elapsed
    const end = Math.min(totalDuration, elapsed + dur)
    out += `${idx}\n${formatSrtTime(start)} --> ${formatSrtTime(end)}\n${subtitle}\n\n`
    idx++
    elapsed += dur
  }

  await fs.writeFile(filePath, out, 'utf8')
}

/**
 * Write SRT with line-based sync (legacy mode).
 */
async function writeSrt(filePath, lines, durationSec) {
  const safeDuration = Math.max(1, Number(durationSec ?? 0) || 30)
  const list = lines.length ? lines : ['']
  const step = safeDuration / Math.max(1, list.length)
  let out = ''
  for (let i = 0; i < list.length; i++) {
    const start = i * step
    const end = Math.min(safeDuration, (i + 1) * step)
    out += `${i + 1}\n${formatSrtTime(start)} --> ${formatSrtTime(end)}\n${list[i]}\n\n`
  }
  await fs.writeFile(filePath, out, 'utf8')
}

async function downloadToFile(url, outPath) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`download_failed_${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  await fs.writeFile(outPath, buf)
}

async function generateAudioSay(text, outAiffPath) {
  const r = await run('say', ['-o', outAiffPath, text])
  return r.code === 0
}

async function generateAudioElevenLabs(text, outMp3Path) {
  if (!elevenLabsApiKey) return false
  try {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${elevenLabsVoiceId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': elevenLabsApiKey,
      },
      body: JSON.stringify({
        text,
        model_id: elevenLabsModelId,
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    })
    if (!res.ok) return false
    const buf = Buffer.from(await res.arrayBuffer())
    await fs.writeFile(outMp3Path, buf)
    return buf.length > 0
  } catch {
    return false
  }
}

async function generateSilentAudio(ffmpegOk, durationSec, outWavPath) {
  if (!ffmpegOk) return false
  const d = String(Math.max(1, Number(durationSec ?? 0) || 30))
  const r = await run(ffmpegCmd, ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', d, outWavPath])
  return r.code === 0
}

function buildSuccessResponse(renderJobId, assetUrl, thumbnailUrl, durationSec, executedAt, meta = {}) {
  return {
    status: 'rendered',
    external_job_id: `local-${renderJobId}`,
    qc_status: 'passed',
    output: {
      asset_url: assetUrl,
      thumbnail_url: thumbnailUrl,
      duration_sec: Number(durationSec ?? 0) || 0,
      subtitles_included: true,
      render_provider: 'local-ffmpeg',
      executed_at: executedAt,
      meta,
    },
  }
}

function buildFailureResponse(errorCode, errorMessage) {
  return {
    status: 'failed',
    error_code: errorCode,
    error_message: errorMessage,
    next_retry_at: null,
  }
}

// ---------------------------------------------------------------------------
// Multi-scene renderer with Ken Burns + xfade
// ---------------------------------------------------------------------------

/**
 * Build a zoompan filter for one image, producing exactly `frames` output frames.
 * Each scene alternates zoom direction for visual variety.
 */
function zoompanFilter(sceneIndex, frames) {
  // Alternate: even scenes zoom in, odd scenes zoom out from a slightly different center
  const zoomExpr = sceneIndex % 2 === 0
    ? `min(zoom+0.0015,1.5)`
    : `if(eq(on\\,1)\\,1.5\\,max(zoom-0.0015\\,1.0))`
  const xExpr = sceneIndex % 2 === 0
    ? `iw/2-(iw/zoom/2)`
    : `iw/2-(iw/zoom/2)+50`
  const yExpr = sceneIndex % 2 === 0
    ? `ih/2-(ih/zoom/2)`
    : `ih/2-(ih/zoom/2)+30`
  return `zoompan=z='${zoomExpr}':d=${frames}:x='${xExpr}':y='${yExpr}':s=${TARGET_W}x${TARGET_H}`
}

/**
 * Render a multi-scene video using zoompan + xfade + subtitles.
 *
 * Strategy:
 * 1. For each scene, create a zoompan video segment (scene_N.mp4)
 * 2. Concatenate all segments with xfade transitions
 * 3. Overlay subtitles on the final video
 * 4. Mix in audio
 */
async function renderMultiScene(workDir, scenes, durationSec, audioPath, srtPath, mp4Path) {
  const numScenes = scenes.length

  // --- Step 1: Render each scene as a zoompan segment ---
  const segmentPaths = []
  for (let i = 0; i < numScenes; i++) {
    const scene = scenes[i]
    const sceneDur = Math.max(1, Number(scene.duration_sec ?? 0) || Math.ceil(durationSec / numScenes))
    const frames = Math.ceil(sceneDur * FPS)
    const segPath = path.join(workDir, `scene_${i}.mp4`)

    const imgPath = path.join(workDir, `scene_img_${i}`)
    await downloadToFile(scene.image_url, imgPath)

    const zp = zoompanFilter(i, frames)
    const args = [
      '-y', '-loop', '1', '-i', imgPath,
      '-vf', zp,
      '-t', String(sceneDur),
      '-r', String(FPS),
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-an',
      segPath,
    ]
    const r = await run(ffmpegCmd, args)
    if (r.code !== 0 || !(await exists(segPath))) {
      throw new Error(`zoompan render failed for scene ${i}: ${r.stderr.slice(-300)}`)
    }
    segmentPaths.push({ path: segPath, duration: sceneDur })
  }

  // --- Step 2: xfade concatenate segments ---
  let concatResultPath
  if (numScenes === 1) {
    concatResultPath = segmentPaths[0].path
  } else {
    concatResultPath = path.join(workDir, 'concat_xfade.mp4')

    // Build complex xfade filter graph
    // Input labels: [0:v], [1:v], [2:v], ...
    // xfade between consecutive pairs
    const inputs = []
    for (const seg of segmentPaths) {
      inputs.push('-i', seg.path)
    }

    // Build chain xfade filter graph:
    // First xfade:  [0:v][1:v]xfade...[v0]
    // Second xfade: [v0][2:v]xfade...[v1]
    // Third xfade:  [v1][3:v]xfade...[vout]
    const filterParts = []
    for (let i = 0; i < numScenes - 1; i++) {
      const inLabelA = i === 0 ? '[0:v]' : `[v${i - 1}]`
      const inLabelB = `[${i + 1}:v]`
      // offset = total input duration so far minus accumulated xfade overlaps
      let cumInputDur = 0
      for (let j = 0; j <= i; j++) cumInputDur += segmentPaths[j].duration
      const offset = Math.max(0.1, cumInputDur - i * XFADE_DUR - XFADE_DUR)
      const transition = i % 2 === 0 ? 'fade' : 'fadeblack'
      const outLabel = i === numScenes - 2 ? 'vout' : `v${i}`
      filterParts.push(
        `${inLabelA}${inLabelB}xfade=transition=${transition}:duration=${XFADE_DUR}:offset=${offset.toFixed(3)}[${outLabel}]`
      )
    }

    const args = ['-y', ...inputs, '-filter_complex', filterParts.join(';'), '-map', '[vout]', '-r', String(FPS), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', concatResultPath]
    const r = await run(ffmpegCmd, args)
    if (r.code !== 0 || !(await exists(concatResultPath))) {
      throw new Error(`xfade concat failed: ${r.stderr.slice(-500)}`)
    }
  }

  // --- Step 3: Add subtitles + audio ---
  const style = "Fontsize=36,PrimaryColour=&H00FFFFFF&,OutlineColour=&H00000000&,BorderStyle=1,Outline=3,Shadow=1,Alignment=2,MarginV=80"
  const srtEscaped = srtPath.replaceAll('\\', '\\\\').replaceAll(':', '\\:')
  const vf = `subtitles=${srtEscaped}:force_style='${style}'`

  const args = [
    '-y', '-i', concatResultPath, '-i', audioPath,
    '-vf', vf,
    '-shortest',
    '-r', String(FPS),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k',
    mp4Path,
  ]
  const r = await run(ffmpegCmd, args)
  if (r.code !== 0 || !(await exists(mp4Path))) {
    throw new Error(`subtitle+audio mux failed: ${r.stderr.slice(-500)}`)
  }
}

// ---------------------------------------------------------------------------
// Legacy single-image renderer (original logic)
// ---------------------------------------------------------------------------

async function renderLegacy(workDir, bgUrl, bgPath, durationSec, audioPath, srtPath, mp4Path) {
  const style = "Fontsize=36,PrimaryColour=&H00FFFFFF&,OutlineColour=&H00000000&,BorderStyle=1,Outline=3,Shadow=1,Alignment=2,MarginV=80"
  const vfFromColor = `subtitles=${srtPath.replaceAll('\\', '\\\\').replaceAll(':', '\\:')}:force_style='${style}'`
  const vfFromImage = `scale=${TARGET_W}:${TARGET_H}:force_original_aspect_ratio=increase,crop=${TARGET_W}:${TARGET_H},${vfFromColor}`

  const videoArgs = bgUrl
    ? ['-y', '-loop', '1', '-i', bgPath, '-i', audioPath, '-t', String(durationSec), '-vf', vfFromImage, '-shortest', '-r', String(FPS), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', mp4Path]
    : ['-y', '-f', 'lavfi', '-i', `color=c=black:s=${TARGET_W}x${TARGET_H}:r=${FPS}:d=${durationSec}`, '-i', audioPath, '-vf', vfFromColor, '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', mp4Path]

  const renderResult = await run(ffmpegCmd, videoArgs)
  if (renderResult.code !== 0 || !(await exists(mp4Path))) {
    throw new Error('ffmpeg render failed')
  }
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const app = express()
app.use(express.json({ limit: '10mb' }))
app.use('/artifacts', express.static(artifactsDir))

app.get('/health', async (req, res) => {
  res.json({ ok: true, ffmpeg_cmd: ffmpegCmd, tts_engine: ttsEngine, elevenlabs_configured: !!elevenLabsApiKey })
})

app.post('/', async (req, res) => {
  const startedAt = Date.now()
  try {
    const ffmpegOk = await ensureFfmpeg()
    if (!ffmpegOk) return res.status(200).json(buildFailureResponse('NOT_FOUND', 'ffmpeg not found'))

    const payload = req.body ?? {}
    const renderJobId = typeof payload.render_job_id === 'string' && payload.render_job_id.trim() ? payload.render_job_id.trim() : randomUUID()
    const script = payload.script ?? {}
    const durationSec = Number(script.duration_sec ?? payload.options?.duration_sec ?? 30) || 30
    const subtitleText = typeof script.subtitle_text === 'string' ? script.subtitle_text : typeof script.script_text === 'string' ? script.script_text : ''
    const lines = toLines(subtitleText).slice(0, 12)

    const workDir = path.join(artifactsDir, renderJobId)
    await fs.mkdir(workDir, { recursive: true })

    // --- Detect multi-scene mode ---
    const rawScenes = Array.isArray(payload.options?.scenes) ? payload.options.scenes.filter(
      (s) => s && typeof s.image_url === 'string' && s.image_url.trim()
    ) : []
    const useScenes = rawScenes.length > 0

    // --- Generate SRT ---
    const srtPath = path.join(workDir, 'subtitles.srt')
    if (useScenes) {
      await writeSrtScenes(srtPath, rawScenes, durationSec)
    } else {
      await writeSrt(srtPath, lines, durationSec)
    }

    // --- Download background image (legacy mode) ---
    const bgUrl =
      typeof payload.options?.background_image_url === 'string' && payload.options.background_image_url.trim()
        ? payload.options.background_image_url.trim()
        : ''
    const bgPath = bgUrl ? path.join(workDir, 'bg') : ''
    if (!useScenes && bgUrl) {
      try {
        await downloadToFile(bgUrl, bgPath)
      } catch {
        return res.status(200).json(buildFailureResponse('INVALID_PAYLOAD', 'background_image_url download failed'))
      }
    }

    // --- Generate TTS audio ---
    const ttsText =
      typeof payload.options?.tts_text === 'string' && payload.options.tts_text.trim()
        ? payload.options.tts_text.trim()
        : typeof script.script_text === 'string' && script.script_text.trim()
          ? script.script_text.trim()
          : lines.join(' ')

    let audioPath = path.join(workDir, 'voice.aiff')
    const audioWavPath = path.join(workDir, 'voice.wav')

    let audioOk = false
    if (ttsEngine === 'elevenlabs' && elevenLabsApiKey) {
      const elMp3Path = path.join(workDir, 'voice_el.mp3')
      audioOk = await generateAudioElevenLabs(ttsText, elMp3Path)
      if (audioOk) {
        audioPath = elMp3Path
      }
    }
    if (!audioOk && ttsEngine === 'say') {
      audioOk = await generateAudioSay(ttsText, audioPath)
    }
    if (!audioOk) {
      audioOk = await generateSilentAudio(ffmpegOk, durationSec, audioWavPath)
    }
    audioPath = (await exists(audioPath)) ? audioPath : audioWavPath
    if (!audioOk || !(await exists(audioPath))) {
      return res.status(200).json(buildFailureResponse('TEMPORARY', 'tts generation failed'))
    }

    // --- Render video ---
    const mp4Path = path.join(workDir, 'output.mp4')
    const thumbPath = path.join(workDir, 'thumbnail.jpg')

    let renderMode = 'legacy'
    try {
      if (useScenes) {
        renderMode = 'scenes'
        await renderMultiScene(workDir, rawScenes, durationSec, audioPath, srtPath, mp4Path)
      } else {
        await renderLegacy(workDir, bgUrl, bgPath, durationSec, audioPath, srtPath, mp4Path)
      }
    } catch (sceneErr) {
      // Fallback to legacy if scenes mode fails
      if (useScenes && bgUrl) {
        console.error(`[render] scenes mode failed, falling back to legacy: ${sceneErr.message}`)
        try {
          await downloadToFile(bgUrl, bgPath)
          await writeSrt(srtPath, lines, durationSec)
          await renderLegacy(workDir, bgUrl, bgPath, durationSec, audioPath, srtPath, mp4Path)
          renderMode = 'legacy-fallback'
        } catch {
          return res.status(200).json(buildFailureResponse('TEMPORARY', `render failed (scenes+fallback): ${sceneErr.message}`))
        }
      } else {
        return res.status(200).json(buildFailureResponse('TEMPORARY', `render failed: ${sceneErr.message}`))
      }
    }

    // --- Generate thumbnail ---
    const thumbResult = await run(ffmpegCmd, ['-y', '-i', mp4Path, '-ss', '0', '-vframes', '1', thumbPath])
    if (thumbResult.code !== 0 || !(await exists(thumbPath))) {
      await fs.writeFile(thumbPath, '')
    }

    const executedAt = new Date().toISOString()
    const assetUrl = `${publicBaseUrl}/artifacts/${renderJobId}/output.mp4`
    const thumbnailUrl = `${publicBaseUrl}/artifacts/${renderJobId}/thumbnail.jpg`
    res.json(
      buildSuccessResponse(renderJobId, assetUrl, thumbnailUrl, durationSec, executedAt, {
        duration_ms: Date.now() - startedAt,
        tts_engine: ttsEngine,
        background: useScenes ? 'scenes' : bgUrl ? 'image' : 'color',
        render_mode: renderMode,
        scenes_count: useScenes ? rawScenes.length : 0,
      })
    )
  } catch (e) {
    const message = e instanceof Error ? e.message : 'render executor failed'
    res.status(200).json(buildFailureResponse('TEMPORARY', message))
  }
})

await fs.mkdir(artifactsDir, { recursive: true })

app.listen(port, () => {
  process.stdout.write(`render executor listening on ${publicBaseUrl}\n`)
})
