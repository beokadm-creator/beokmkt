import { useCallback, useEffect, useMemo, useState } from 'react'
import { toTistoryPasteHtml } from '../lib/tistoryPasteHtml'

interface TistoryPasteModalProps {
  open: boolean
  onClose: () => void
  title: string
  content: string
  tags: string[]
}

/**
 * Copy for Tistory. Puts the HTML **source** on text/plain (so pasting into
 * Tistory's HTML editor mode yields the markup) and the rich HTML on text/html
 * (so pasting into the basic editor renders it). Falls back to a hidden textarea.
 */
async function copyTistoryHtml(html: string): Promise<boolean> {
  if (typeof ClipboardItem !== 'undefined') {
    try {
      const item = new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([html], { type: 'text/plain' }),
      })
      await navigator.clipboard.write([item])
      return true
    } catch {
      // fall through
    }
  }

  // Fallback: copy the source as plain text
  try {
    await navigator.clipboard.writeText(html)
    return true
  } catch {
    // fall through
  }

  try {
    const ta = document.createElement('textarea')
    ta.value = html
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    ta.style.top = '-9999px'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

export default function TistoryPasteModal({ open, onClose, title, content, tags }: TistoryPasteModalProps) {
  const [titleCopied, setTitleCopied] = useState(false)
  const [tagsCopied, setTagsCopied] = useState(false)
  const [bodyCopied, setBodyCopied] = useState(false)
  const [bodyCopyFailed, setBodyCopyFailed] = useState(false)

  const { html, cleanTitle, tagsDisplay } = useMemo(() => {
    const result = toTistoryPasteHtml(content, title, tags)
    return {
      html: result.html,
      cleanTitle: result.title,
      tagsDisplay: result.tags.join(', '),
    }
  }, [content, title, tags])

  useEffect(() => {
    if (!open) return
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [open, onClose])

  const flash = useCallback((setter: (v: boolean) => void) => {
    setter(true)
    setTimeout(() => setter(false), 1400)
  }, [])

  const copyTitle = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(cleanTitle)
      flash(setTitleCopied)
    } catch { /* ignore */ }
  }, [cleanTitle, flash])

  const copyTags = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(tagsDisplay)
      flash(setTagsCopied)
    } catch { /* ignore */ }
  }, [tagsDisplay, flash])

  const copyBody = useCallback(async () => {
    setBodyCopyFailed(false)
    const ok = await copyTistoryHtml(html)
    if (ok) flash(setBodyCopied)
    else setBodyCopyFailed(true)
  }, [html, flash])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl border border-zinc-800 bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-3">
          <span className="text-sm font-medium text-zinc-200">티스토리 발행용 HTML</span>
          <button onClick={onClose} className="text-sm text-zinc-500 hover:text-zinc-300">
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {/* Title row */}
          <div className="mb-3 flex items-start gap-3">
            <span className="min-w-[48px] pt-2 text-xs text-zinc-500">제목</span>
            <button
              onClick={copyTitle}
              className="flex-1 cursor-pointer rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-left text-sm text-zinc-200 transition-colors hover:border-orange-600 hover:bg-orange-900/20"
            >
              {titleCopied ? '✓ 복사됨' : cleanTitle}
            </button>
          </div>

          {/* Tags row */}
          <div className="mb-4 flex items-start gap-3">
            <span className="min-w-[48px] pt-2 text-xs text-zinc-500">태그</span>
            <button
              onClick={copyTags}
              className="flex-1 cursor-pointer rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-left text-sm text-zinc-200 transition-colors hover:border-orange-600 hover:bg-orange-900/20"
            >
              {tagsCopied ? '✓ 복사됨' : tagsDisplay || '—'}
            </button>
          </div>

          {/* Body copy button */}
          <button
            onClick={copyBody}
            className="mb-2 flex h-12 w-full items-center justify-center rounded-xl bg-[#e06c1f] text-base font-bold text-white transition-colors hover:bg-[#c95d16]"
          >
            {bodyCopied ? '✓ HTML이 복사됐어요' : 'HTML 소스 복사'}
          </button>

          {bodyCopyFailed && (
            <p className="mb-2 text-xs text-amber-400">
              자동 복사가 실패했습니다. 아래 소스 상자를 드래그로 전체 선택한 뒤 Ctrl+C(⌘+C) 하세요.
            </p>
          )}

          {/* Instructions */}
          <p className="mb-4 text-xs leading-relaxed text-zinc-400">
            티스토리 글쓰기에서 우측 상단 모드를 <span className="text-zinc-200">기본모드 → HTML</span>로 바꾼 뒤 Ctrl+V(⌘+V)로 붙여넣으세요.
            이미지는 hongcomm.kr 외부 링크로 들어갑니다. 필요하면 티스토리에서 이미지를 다시 업로드하세요.
          </p>

          {/* Rendered preview */}
          <div className="mb-1 text-xs text-zinc-500">미리보기 (렌더링 결과)</div>
          <div
            className="mb-4 rounded-lg border border-zinc-700 bg-white p-6 text-sm leading-relaxed text-zinc-900"
            dangerouslySetInnerHTML={{ __html: html }}
          />

          {/* HTML source (selectable fallback) */}
          <div className="mb-1 text-xs text-zinc-500">HTML 소스</div>
          <textarea
            readOnly
            value={html}
            onFocus={(e) => e.currentTarget.select()}
            className="h-40 w-full resize-none rounded-lg border border-zinc-700 bg-zinc-950 p-3 font-mono text-xs text-zinc-300"
          />
        </div>
      </div>
    </div>
  )
}
