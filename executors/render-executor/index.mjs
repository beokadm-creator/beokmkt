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
const require = createRequire(import.meta.url)
let ffmpegCmd = 'ffmpeg'
try {
  const resolved = require('ffmpeg-static')
  if (typeof resolved === 'string' && resolved) ffmpegCmd = resolved
} catch {}

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

const app = express()
app.use(express.json({ limit: '10mb' }))
app.use('/artifacts', express.static(artifactsDir))

app.get('/health', async (req, res) => {
  res.json({ ok: true, ffmpeg_cmd: ffmpegCmd, tts_engine: ttsEngine })
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

    const srtPath = path.join(workDir, 'subtitles.srt')
    await writeSrt(srtPath, lines, durationSec)

    const bgUrl =
      typeof payload.options?.background_image_url === 'string' && payload.options.background_image_url.trim()
        ? payload.options.background_image_url.trim()
        : ''
    const bgPath = bgUrl ? path.join(workDir, 'bg') : ''
    if (bgUrl) {
      try {
        await downloadToFile(bgUrl, bgPath)
      } catch {
        return res.status(200).json(buildFailureResponse('INVALID_PAYLOAD', 'background_image_url download failed'))
      }
    }

    const ttsText =
      typeof payload.options?.tts_text === 'string' && payload.options.tts_text.trim()
        ? payload.options.tts_text.trim()
        : typeof script.script_text === 'string' && script.script_text.trim()
          ? script.script_text.trim()
          : lines.join(' ')

    const audioAiffPath = path.join(workDir, 'voice.aiff')
    const audioWavPath = path.join(workDir, 'voice.wav')

    let audioOk = false
    if (ttsEngine === 'say') {
      audioOk = await generateAudioSay(ttsText, audioAiffPath)
    }
    if (!audioOk) {
      audioOk = await generateSilentAudio(ffmpegOk, durationSec, audioWavPath)
    }
    const audioPath = (await exists(audioAiffPath)) ? audioAiffPath : audioWavPath
    if (!audioOk || !(await exists(audioPath))) {
      return res.status(200).json(buildFailureResponse('TEMPORARY', 'tts generation failed'))
    }

    const mp4Path = path.join(workDir, 'output.mp4')
    const thumbPath = path.join(workDir, 'thumbnail.jpg')

    const style = "Fontsize=48,PrimaryColour=&H00FFFFFF&,OutlineColour=&H00000000&,BorderStyle=3,Outline=2,Shadow=0,Alignment=2,MarginV=120"
    const vfFromColor = `subtitles=${srtPath.replaceAll('\\', '\\\\').replaceAll(':', '\\\\:')}:force_style='${style}'`
    const vfFromImage = `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,${vfFromColor}`

    const videoArgs = bgUrl
      ? ['-y', '-loop', '1', '-i', bgPath, '-i', audioPath, '-t', String(durationSec), '-vf', vfFromImage, '-shortest', '-r', '30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', mp4Path]
      : ['-y', '-f', 'lavfi', '-i', `color=c=black:s=1080x1920:r=30:d=${durationSec}`, '-i', audioPath, '-vf', vfFromColor, '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', mp4Path]

    const renderResult = await run(ffmpegCmd, videoArgs)
    if (renderResult.code !== 0 || !(await exists(mp4Path))) {
      return res.status(200).json(buildFailureResponse('TEMPORARY', 'ffmpeg render failed'))
    }

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
        background: bgUrl ? 'image' : 'color',
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
