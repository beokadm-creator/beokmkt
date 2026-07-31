import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

const VIDEO_W = 1080
const VIDEO_H = 1920
const VIDEO_DURATION_S = 5
const VIDEO_FPS = 30
const VIDEO_FRAMES = VIDEO_DURATION_S * VIDEO_FPS

interface InstagramCardModalProps {
  open: boolean
  onClose: () => void
  title: string
  excerpt: string
  content: string
  tags: string[]
  link?: string
}

const CARD_SIZE = 1080
const BRAND_LABEL = '비오케이솔루션 · 홍커뮤니케이션'

/** Strip HTML tags and collapse whitespace into plain text. */
function htmlToText(html: string): string {
  const tmp = document.createElement('div')
  tmp.innerHTML = html
  return (tmp.textContent ?? '').replace(/\s+/g, ' ').trim()
}

/** Word-wrap text on a canvas context to a max width, returning lines. */
function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word
    if (ctx.measureText(candidate).width <= maxWidth || !current) {
      current = candidate
    } else {
      lines.push(current)
      current = word
      if (lines.length === maxLines - 1) break
    }
  }
  if (current && lines.length < maxLines) lines.push(current)
  // Ellipsis if truncated
  if (lines.length === maxLines) {
    let last = lines[maxLines - 1]
    while (ctx.measureText(`${last}…`).width > maxWidth && last.length > 0) {
      last = last.slice(0, -1)
    }
    lines[maxLines - 1] = `${last}…`
  }
  return lines
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.arcTo(x + w, y, x + w, y + r, r)
  ctx.lineTo(x + w, y + h - r)
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r)
  ctx.lineTo(x + r, y + h)
  ctx.arcTo(x, y + h, x, y + h - r, r)
  ctx.lineTo(x, y + r)
  ctx.arcTo(x, y, x + r, y, r)
  ctx.closePath()
}

function pickVideoMime(): string {
  const types = ['video/mp4;codecs=h264', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
  for (const t of types) {
    if (MediaRecorder.isTypeSupported(t)) return t
  }
  return 'video/webm'
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t
}

/** Build Instagram caption: excerpt + link + hashtags. */
function buildCaption(title: string, excerpt: string, content: string, tags: string[], link?: string): string {
  const body = excerpt?.trim() || htmlToText(content).slice(0, 180)
  const hashtags = tags
    .map((t) => `#${t.replace(/\s+/g, '').replace(/^#/, '')}`)
    .filter((t) => t.length > 1)
    .join(' ')
  const parts = [title.trim(), '', body]
  if (link) parts.push('', `🔗 자세히 보기: ${link}`)
  if (hashtags) parts.push('', hashtags)
  return parts.join('\n')
}

export default function InstagramCardModal({ open, onClose, title, excerpt, content, tags, link }: InstagramCardModalProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [captionCopied, setCaptionCopied] = useState(false)
  const [imgDownloaded, setImgDownloaded] = useState(false)

  const caption = useMemo(
    () => buildCaption(title, excerpt, content, tags, link),
    [title, excerpt, content, tags, link],
  )

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Background gradient
    const grad = ctx.createLinearGradient(0, 0, CARD_SIZE, CARD_SIZE)
    grad.addColorStop(0, '#0f172a')
    grad.addColorStop(1, '#1e293b')
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, CARD_SIZE, CARD_SIZE)

    // Accent bar
    ctx.fillStyle = '#facc15'
    ctx.fillRect(96, 150, 90, 12)

    // Brand label
    ctx.fillStyle = '#facc15'
    ctx.font = '600 30px -apple-system, "Pretendard", "Malgun Gothic", sans-serif'
    ctx.textBaseline = 'alphabetic'
    ctx.fillText(BRAND_LABEL, 96, 130)

    // Title (big)
    ctx.fillStyle = '#ffffff'
    ctx.font = '800 68px -apple-system, "Pretendard", "Malgun Gothic", sans-serif'
    const titleLines = wrapLines(ctx, title.trim(), CARD_SIZE - 192, 5)
    let y = 320
    for (const line of titleLines) {
      ctx.fillText(line, 96, y)
      y += 92
    }

    // Excerpt (smaller, muted)
    const body = excerpt?.trim() || htmlToText(content).slice(0, 160)
    if (body) {
      ctx.fillStyle = '#cbd5e1'
      ctx.font = '400 36px -apple-system, "Pretendard", "Malgun Gothic", sans-serif'
      const bodyLines = wrapLines(ctx, body, CARD_SIZE - 192, 3)
      y += 30
      for (const line of bodyLines) {
        ctx.fillText(line, 96, y)
        y += 54
      }
    }

    // Footer
    ctx.fillStyle = '#64748b'
    ctx.font = '500 28px -apple-system, "Pretendard", "Malgun Gothic", sans-serif'
    ctx.fillText('beoksolution.com', 96, CARD_SIZE - 80)
  }, [title, excerpt, content])

  useEffect(() => {
    if (!open) return
    // Redraw once fonts are ready to avoid fallback flash
    draw()
    if (document.fonts?.ready) {
      document.fonts.ready.then(() => draw()).catch(() => {})
    }
  }, [open, draw])

  useEffect(() => {
    if (!open) return
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [open, onClose])

  const downloadImage = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.toBlob((blob) => {
      if (!blob) return
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      const slug = title.trim().replace(/[^\w가-힣]+/g, '-').slice(0, 40) || 'instagram-card'
      a.href = url
      a.download = `${slug}.png`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      setImgDownloaded(true)
      setTimeout(() => setImgDownloaded(false), 1400)
    }, 'image/png')
  }, [title])

  const copyCaption = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(caption)
      setCaptionCopied(true)
      setTimeout(() => setCaptionCopied(false), 1400)
    } catch {
      /* ignore */
    }
  }, [caption])

  const [isRecording, setIsRecording] = useState(false)
  const [recordProgress, setRecordProgress] = useState(0)

  const generateVideoCard = useCallback(() => {
    const canvas = document.createElement('canvas')
    canvas.width = VIDEO_W
    canvas.height = VIDEO_H
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const FONT = '-apple-system, "Pretendard", "Malgun Gothic", sans-serif'
    const body = excerpt?.trim() || htmlToText(content).slice(0, 160)
    const titleText = title.trim()
    const tagsList = tags.map((t) => `#${t.replace(/\s+/g, '')}`).filter((t) => t.length > 1)

    ctx.font = `800 48px ${FONT}`
    const titleLines = wrapLines(ctx, titleText, VIDEO_W - 160, 6)
    ctx.font = `400 28px ${FONT}`
    const excerptLines = body ? wrapLines(ctx, body, VIDEO_W - 160, 4) : []

    let tagTotalWidth = 0
    for (const tag of tagsList) {
      tagTotalWidth += ctx.measureText(tag).width + 48
    }

    const mime = pickVideoMime()
    const ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm'
    const stream = canvas.captureStream(VIDEO_FPS)
    const recorder = new MediaRecorder(stream, { mimeType: mime })
    const chunks: Blob[] = []
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data)
    }

    let frame = 0
    let rafId: number
    let stopped = false

    const drawFrame = () => {
      if (stopped) return
      const t = frame / VIDEO_FRAMES
      setRecordProgress(t)

      // Ken-burns scale at the end
      const scale = t > 0.9 ? 1 + (t - 0.9) * 0.2 : 1
      ctx.save()
      ctx.clearRect(0, 0, VIDEO_W, VIDEO_H)
      if (scale !== 1) {
        const cx = VIDEO_W / 2
        const cy = VIDEO_H / 2
        ctx.translate(cx, cy)
        ctx.scale(scale, scale)
        ctx.translate(-cx, -cy)
      }

      // Background gradient
      const grad = ctx.createLinearGradient(0, 0, VIDEO_W, VIDEO_H)
      grad.addColorStop(0, '#0a0a0b')
      grad.addColorStop(0.5, '#18181b')
      grad.addColorStop(1, '#0a0a0b')
      ctx.fillStyle = grad
      ctx.fillRect(0, 0, VIDEO_W, VIDEO_H)

      // Amber accent bar (top)
      const accentAlpha = t < 0.1 ? easeInOut(t / 0.1) : 1
      ctx.globalAlpha = accentAlpha
      ctx.fillStyle = '#facc15'
      ctx.fillRect(80, 240, 90, 10)
      ctx.globalAlpha = 1

      // Brand label
      ctx.globalAlpha = accentAlpha
      ctx.fillStyle = '#facc15'
      ctx.font = `600 28px ${FONT}`
      ctx.textBaseline = 'alphabetic'
      ctx.fillText(BRAND_LABEL, 80, 220)
      ctx.globalAlpha = 1

      // Title
      if (t >= 0.1) {
        const titleProgress = Math.min(1, (t - 0.1) / 0.2)
        const titleAlpha = easeInOut(titleProgress)
        const titleOffset = (1 - easeInOut(titleProgress)) * 40
        ctx.globalAlpha = titleAlpha
        ctx.fillStyle = '#ffffff'
        ctx.font = `800 48px ${FONT}`
        let y = 380 + titleOffset
        for (const line of titleLines) {
          ctx.fillText(line, 80, y)
          y += 64
        }
        ctx.globalAlpha = 1
      }

      // Excerpt
      if (t >= 0.2) {
        const excerptProgress = Math.min(1, (t - 0.2) / 0.2)
        const excerptAlpha = easeInOut(excerptProgress)
        const excerptOffset = (1 - easeInOut(excerptProgress)) * 40
        ctx.globalAlpha = excerptAlpha
        ctx.fillStyle = '#cbd5e1'
        ctx.font = `400 28px ${FONT}`
        let y = 380 + titleLines.length * 64 + 40 + excerptOffset
        for (const line of excerptLines) {
          ctx.fillText(line, 80, y)
          y += 42
        }
        ctx.globalAlpha = 1
      }

      // Tags
      const tagStartT = 0.4
      const tagSpacing = 0.03 // 0.03 * 5s = 0.15s apart
      if (tagsList.length > 0 && t >= tagStartT) {
        const tagY = VIDEO_H - 280
        const tagHeight = 40
        const tagGap = 12
        const totalTagW = tagTotalWidth + (tagsList.length - 1) * tagGap
        let tagX = (VIDEO_W - totalTagW) / 2

        for (let i = 0; i < tagsList.length; i++) {
          const tagT = tagStartT + i * tagSpacing
          if (t < tagT) continue
          const tagProgress = Math.min(1, (t - tagT) / 0.05)
          const tagAlpha = easeInOut(tagProgress)

          ctx.globalAlpha = tagAlpha
          const tw = ctx.measureText(tagsList[i]).width + 32
          ctx.fillStyle = 'rgba(250, 204, 21, 0.15)'
          roundRect(ctx, tagX, tagY, tw, tagHeight, 20)
          ctx.fill()

          ctx.fillStyle = '#facc15'
          ctx.font = `600 20px ${FONT}`
          ctx.textBaseline = 'middle'
          ctx.fillText(tagsList[i], tagX + 16, tagY + tagHeight / 2)
          ctx.textBaseline = 'alphabetic'
          tagX += tw + tagGap
        }
        ctx.globalAlpha = 1
      }

      // Footer
      if (t >= 0.6) {
        const footerProgress = Math.min(1, (t - 0.6) / 0.2)
        const footerAlpha = easeInOut(footerProgress)
        ctx.globalAlpha = footerAlpha
        ctx.fillStyle = '#facc15'
        ctx.font = `500 24px ${FONT}`
        ctx.textAlign = 'center'
        ctx.fillText('beoksolution.com', VIDEO_W / 2, VIDEO_H - 160)
        ctx.textAlign = 'left'
        ctx.globalAlpha = 1
      }

      ctx.restore()

      frame++
      if (frame <= VIDEO_FRAMES) {
        rafId = requestAnimationFrame(drawFrame)
      } else {
        recorder.stop()
        stream.getTracks().forEach((track) => track.stop())
      }
    }

    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: mime })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      const slug = title.trim().replace(/[^\w가-힣]+/g, '-').slice(0, 20) || 'instagram-video'
      a.href = url
      a.download = `인스타영상_${slug}.${ext}`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      setIsRecording(false)
      setRecordProgress(0)
      stopped = true
    }

    setIsRecording(true)
    setRecordProgress(0)
    frame = 0
    stopped = false
    recorder.start(100)       // collect chunks
    rafId = requestAnimationFrame(drawFrame)
  }, [title, excerpt, content, tags])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-xl border border-zinc-800 bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-3">
          <span className="text-sm font-medium text-zinc-200">인스타그램 카드 (수기 업로드용)</span>
          <button onClick={onClose} className="text-sm text-zinc-500 hover:text-zinc-300">
            ✕
          </button>
        </div>

        <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-5 py-4 md:flex-row">
          {/* Card preview */}
          <div className="flex flex-col gap-2 md:w-1/2">
            <div className="text-xs text-zinc-500">카드 미리보기 (1080×1080)</div>
            <canvas
              ref={canvasRef}
              width={CARD_SIZE}
              height={CARD_SIZE}
              className="w-full rounded-lg border border-zinc-700"
            />
            <button
              onClick={downloadImage}
              className="flex h-12 w-full items-center justify-center rounded-xl bg-gradient-to-r from-pink-600 to-purple-600 text-base font-bold text-white transition-opacity hover:opacity-90"
            >
              {imgDownloaded ? '✓ 이미지 저장됨' : '이미지 다운로드 (PNG)'}
            </button>
            <button
              onClick={generateVideoCard}
              disabled={isRecording || imgDownloaded}
              className="flex h-12 w-full items-center justify-center rounded-xl bg-gradient-to-r from-violet-600 to-fuchsia-600 text-base font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {isRecording ? `영상 생성 중... ${Math.round(recordProgress * 5)}/5초` : '영상 카드 만들기 (5초)'}
            </button>
          </div>

          {/* Caption */}
          <div className="flex flex-col gap-2 md:w-1/2">
            <div className="text-xs text-zinc-500">캡션 + 해시태그</div>
            <textarea
              readOnly
              value={caption}
              className="min-h-[280px] flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm leading-relaxed text-zinc-200"
            />
            <button
              onClick={copyCaption}
              className="flex h-12 w-full items-center justify-center rounded-xl border border-pink-600 bg-pink-900/20 text-base font-bold text-pink-200 transition-colors hover:bg-pink-900/40"
            >
              {captionCopied ? '✓ 캡션이 복사됐어요' : '캡션 전체 복사'}
            </button>
            <p className="text-xs leading-relaxed text-zinc-400">
              인스타그램 앱/웹에서 이미지를 업로드하고, 위 캡션을 붙여넣으세요. 이미지는 원하는 사진으로 교체해도 됩니다.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
