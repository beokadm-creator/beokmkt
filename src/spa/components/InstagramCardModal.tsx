import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

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
    ctx.fillText('beokmkt.web.app', 96, CARD_SIZE - 80)
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
