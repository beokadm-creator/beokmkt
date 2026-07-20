import { useCallback, useEffect, useMemo, useState } from 'react'
import { toNaverPasteHtml } from '../lib/naverPasteHtml'

interface NaverPasteModalProps {
  open: boolean
  onClose: () => void
  title: string
  content: string
  tags: string[]
}

/**
 * Dual-strategy clipboard copy for text/html + text/plain.
 * Strategy 1: Range-select a hidden rendered node + execCommand('copy')
 * Strategy 2: navigator.clipboard.write with ClipboardItem
 * Returns true on success.
 */
async function copyHtmlToClipboard(html: string, plain: string): Promise<boolean> {
  // Strategy 1: Range-select hidden node + execCommand
  try {
    const container = document.createElement('div')
    container.style.position = 'fixed'
    container.style.opacity = '0'
    container.style.top = '-9999px'
    container.innerHTML = html
    document.body.appendChild(container)

    const range = document.createRange()
    range.selectNodeContents(container)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)

    const ok = document.execCommand('copy')
    sel?.removeAllRanges()
    document.body.removeChild(container)
    if (ok) return true
  } catch {
    // fall through
  }

  // Strategy 2: ClipboardItem API
  if (typeof ClipboardItem !== 'undefined') {
    try {
      const item = new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([plain], { type: 'text/plain' }),
      })
      await navigator.clipboard.write([item])
      return true
    } catch {
      // fall through
    }
  }

  return false
}

export default function NaverPasteModal({ open, onClose, title, content, tags }: NaverPasteModalProps) {
  const [titleCopied, setTitleCopied] = useState(false)
  const [tagsCopied, setTagsCopied] = useState(false)
  const [bodyCopied, setBodyCopied] = useState(false)
  const [bodyCopyFailed, setBodyCopyFailed] = useState(false)

  const { html, cleanTitle, cleanTags, tagsDisplay, plainText } = useMemo(() => {
    const result = toNaverPasteHtml(content, title, tags)
    const cleanTitle = result.title
    const cleanTags = result.tags.map((t) => `#${t}`)
    const tagsDisplay = cleanTags.join(' ')
    // Extract plain text for clipboard fallback
    const tmp = document.createElement('div')
    tmp.innerHTML = result.html
    const plainText = tmp.textContent ?? ''
    return { html: result.html, cleanTitle, cleanTags, tagsDisplay, plainText }
  }, [content, title, tags])

  // Close on Escape
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
    const ok = await copyHtmlToClipboard(html, plainText)
    if (ok) {
      flash(setBodyCopied)
    } else {
      setBodyCopyFailed(true)
    }
  }, [html, plainText, flash])

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
          <span className="text-sm font-medium text-zinc-200">네이버 발행용 HTML</span>
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
              className="flex-1 cursor-pointer rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-left text-sm text-zinc-200 transition-colors hover:border-amber-600 hover:bg-amber-900/20"
            >
              {titleCopied ? '✓ 복사됨' : cleanTitle}
            </button>
          </div>

          {/* Tags row */}
          <div className="mb-4 flex items-start gap-3">
            <span className="min-w-[48px] pt-2 text-xs text-zinc-500">태그</span>
            <button
              onClick={copyTags}
              className="flex-1 cursor-pointer rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-left text-sm text-zinc-200 transition-colors hover:border-amber-600 hover:bg-amber-900/20"
            >
              {tagsCopied ? '✓ 복사됨' : tagsDisplay || '—'}
            </button>
          </div>

          {/* Body copy button */}
          <button
            onClick={copyBody}
            className="mb-2 flex h-12 w-full items-center justify-center rounded-xl bg-[#03c75a] text-base font-bold text-white transition-colors hover:bg-[#02b350]"
          >
            {bodyCopied ? '✓ 본문이 복사됐어요' : '본문 전체 복사'}
          </button>

          {bodyCopyFailed && (
            <p className="mb-2 text-xs text-amber-400">
              자동 복사가 실패했습니다. 아래 미리보기를 드래그로 전체 선택한 뒤 Ctrl+C(⌘+C) 하세요.
            </p>
          )}

          {/* Instructions */}
          <p className="mb-4 text-xs leading-relaxed text-zinc-400">
            스마트에디터에서 Ctrl+V(⌘+V)로 붙여넣으세요. 📷 사진 슬롯은 붙여넣은 뒤 실제 사진으로 교체하고, 소제목은 에디터의 '소제목' 스타일로 지정하세요.
          </p>

          {/* Preview */}
          <div className="mb-1 text-xs text-zinc-500">미리보기 (복사되는 내용)</div>
          <div
            className="rounded-lg border border-zinc-700 bg-white p-6 text-sm leading-relaxed text-zinc-900"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </div>
      </div>
    </div>
  )
}
