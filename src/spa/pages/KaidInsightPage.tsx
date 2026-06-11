import { useState, useRef, useCallback, useEffect } from 'react'
import { apiJson } from '../lib/api'
import NewsletterModal from './kaid/NewsletterModal'
import ImageMapEditor from './kaid/ImageMapEditor'
import type { El, ImageEl, TextEl, ButtonEl, Config, ImageArea, SavedImage, SavedTemplate, NewsletterFull } from './kaid/types'

const CANVAS_W = 750
const MIN_SZ = 20

// ─── Constants ────────────────────────────────────────────────────────────────

const FONT_OPTIONS = [
  { label: '기본 (굴림)', value: '굴림,돋움,Arial,sans-serif' },
  { label: 'Arial', value: 'Arial,sans-serif' },
  { label: 'Noto Sans KR', value: "'Noto Sans KR',sans-serif" },
  { label: 'Nanum Gothic', value: "'Nanum Gothic',sans-serif" },
  { label: 'Nanum Myeongjo', value: "'Nanum Myeongjo',serif" },
  { label: 'Black Han Sans', value: "'Black Han Sans',sans-serif" },
  { label: 'Roboto', value: 'Roboto,sans-serif' },
]

const GOOGLE_FONTS = ['Noto Sans KR', 'Nanum Gothic', 'Nanum Myeongjo', 'Black Han Sans', 'Roboto']

// ─── Factories ────────────────────────────────────────────────────────────────

let _n = 0
const uid = () => `e${++_n}`

const mkImage = (y = 0): ImageEl => ({
  id: uid(), type: 'image', x: 0, y, width: CANVAS_W, height: 400,
  src: '', href: '', opacity: 1, areas: [],
})
const mkText = (x = 20, y = 50): TextEl => ({
  id: uid(), type: 'text', x, y, width: CANVAS_W - 40, height: 60, content: '텍스트를 입력하세요',
  fontSize: 16, color: '#333333', bgColor: 'transparent', align: 'left',
  bold: false, italic: false, padding: 10, lineHeight: 1.6, letterSpacing: 0,
  fontFamily: '굴림,돋움,Arial,sans-serif',
})
const mkButton = (x = 275, y = 50): ButtonEl => ({
  id: uid(), type: 'button', x, y, width: 200, height: 48, text: '자세히 보기',
  href: '', bgColor: '#005bac', textColor: '#ffffff', borderRadius: 4, fontSize: 14,
})

// ─── Resize helpers ───────────────────────────────────────────────────────────

const HANDLES = [
  { id: 'nw', cur: 'nw-resize' }, { id: 'n', cur: 'n-resize' }, { id: 'ne', cur: 'ne-resize' },
  { id: 'w',  cur: 'w-resize'  },                                { id: 'e',  cur: 'e-resize'  },
  { id: 'sw', cur: 'sw-resize' }, { id: 's', cur: 's-resize' }, { id: 'se', cur: 'se-resize' },
]

interface Drag {
  mode: 'move' | 'resize'; id: string; handle: string
  mx0: number; my0: number; ex0: number; ey0: number; ew0: number; eh0: number
}

function hpos(h: string, w: number, ht: number) {
  return { x: h.includes('e') ? w : h.includes('w') ? 0 : w / 2, y: h.includes('s') ? ht : h.includes('n') ? 0 : ht / 2 }
}

function applyResize(d: Drag, dx: number, dy: number) {
  let { ex0: x, ey0: y, ew0: w, eh0: h } = d
  if (d.handle.includes('e')) w = Math.max(MIN_SZ, d.ew0 + dx)
  if (d.handle.includes('w')) { x = d.ex0 + dx; w = Math.max(MIN_SZ, d.ew0 - dx) }
  if (d.handle.includes('s')) h = Math.max(MIN_SZ, d.eh0 + dy)
  if (d.handle.includes('n')) { y = d.ey0 + dy; h = Math.max(MIN_SZ, d.eh0 - dy) }
  if (x < 0) { w += x; x = 0 }
  if (x + w > CANVAS_W) w = CANVAS_W - x
  return { x, y, width: w, height: h }
}

// ─── Google Font loader ────────────────────────────────────────────────────────

function injectFont(family: string) {
  const id = `gf-${family.replace(/ /g, '-')}`
  if (document.getElementById(id)) return
  const link = document.createElement('link')
  link.id = id; link.rel = 'stylesheet'
  link.href = `https://fonts.googleapis.com/css2?family=${family.replace(/ /g, '+')}:wght@400;700&display=swap`
  document.head.appendChild(link)
}

function usedGoogleFonts(els: El[]) {
  const used = new Set<string>()
  for (const el of els) {
    if (el.type !== 'text') continue
    for (const f of GOOGLE_FONTS) { if (el.fontFamily.includes(f)) used.add(f) }
  }
  return [...used]
}

// ─── Header / Footer HTML ─────────────────────────────────────────────────────

function headerHTML(date: string, viewOnlineUrl: string) {
  const disp = `${date.slice(0, 4)}.${date.slice(4, 6)}.${date.slice(6, 8)}`
  return `<table border="0" align="center" cellpadding="0" cellspacing="0" width="${CANVAS_W}" style="border-collapse:collapse;font-family:굴림,Arial,sans-serif;">
<tr><td style="font-size:11px;color:#888;height:36px;line-height:36px;padding:0 10px;border-bottom:1px solid #eee;">
<b>KAID Insight</b>&nbsp;|&nbsp;${disp}${viewOnlineUrl ? `&nbsp;&nbsp;<a href="${viewOnlineUrl}" style="color:#888;text-decoration:none;">온라인 보기</a>` : ''}</td></tr></table>`
}

function footerHTML(date: string) {
  return `<table border="0" align="center" cellpadding="0" cellspacing="0" width="${CANVAS_W}" style="border-collapse:collapse;font-family:굴림,Arial,sans-serif;background:#f7f7f7;">
<tr><td style="font-size:10px;color:#aaa;padding:10px;text-align:center;">&copy; ${date.slice(0, 4)} KAID. All rights reserved.</td></tr></table>`
}

// ─── HTML export ──────────────────────────────────────────────────────────────

function genHTML(cfg: Config, els: El[], canvasH: number) {
  const fonts = usedGoogleFonts(els)
  const fontLink = fonts.length
    ? `\n<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=${fonts.map(f => f.replace(/ /g, '+')).join('&family=')}&display=swap">`
    : ''

  let mapIdx = 0
  const body = els.map(el => {
    const base = `position:absolute;left:${Math.round(el.x)}px;top:${Math.round(el.y)}px;width:${Math.round(el.width)}px;height:${Math.round(el.height)}px;`
    if (el.type === 'image') {
      const mapName = el.areas.length > 0 ? `Map${++mapIdx}` : ''
      const mapAttr = mapName ? ` usemap="#${mapName}"` : ''
      const linkAttr = !mapName && el.href ? el.href : ''
      const img = `<img src="${el.src}" style="${base}object-fit:contain;opacity:${el.opacity};display:block;" alt=""${mapAttr}>`
      const mapHtml = mapName
        ? `\n<map name="${mapName}">${el.areas.map(a => {
            const cx1 = Math.round(a.x * el.width), cy1 = Math.round(a.y * el.height)
            const cx2 = Math.round((a.x + a.w) * el.width), cy2 = Math.round((a.y + a.h) * el.height)
            return `\n  <area shape="rect" coords="${cx1},${cy1},${cx2},${cy2}" href="${a.href}" target="_blank">`
          }).join('')}\n</map>` : ''
      return linkAttr ? `<a href="${linkAttr}" target="_blank" style="${base}display:block;">${img}</a>${mapHtml}` : `${img}${mapHtml}`
    }
    if (el.type === 'text') {
      const s = `${base}font-family:${el.fontFamily};font-size:${el.fontSize}px;font-weight:${el.bold ? 'bold' : 'normal'};font-style:${el.italic ? 'italic' : 'normal'};color:${el.color};background-color:${el.bgColor === 'transparent' ? 'transparent' : el.bgColor};text-align:${el.align};line-height:${el.lineHeight};letter-spacing:${el.letterSpacing}px;padding:${el.padding}px;box-sizing:border-box;overflow:hidden;`
      return `<div style="${s}">${el.content.replace(/\n/g, '<br>')}</div>`
    }
    if (el.type === 'button') {
      const s = `${base}display:flex;align-items:center;justify-content:center;background-color:${el.bgColor};color:${el.textColor};font-family:Arial,sans-serif;font-size:${el.fontSize}px;font-weight:bold;text-decoration:none;border-radius:${el.borderRadius}px;`
      return el.href ? `<a href="${el.href}" target="_blank" style="${s}">${el.text}</a>` : `<div style="${s}">${el.text}</div>`
    }
    return ''
  }).join('\n  ')

  return `<!DOCTYPE html>
<html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"><title>KAID Insight</title>${fontLink}</head>
<body style="margin:0;padding:20px 0;background:#e5e5e5;">
<table width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center">
${headerHTML(cfg.date, cfg.viewOnlineUrl)}
<div style="position:relative;width:${CANVAS_W}px;height:${canvasH}px;background-color:${cfg.bgColor};overflow:hidden;">
  ${body}
</div>
${footerHTML(cfg.date)}
</td></tr></table>
</body></html>`
}

function dlFile(html: string, name: string) {
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' })),
    download: name,
  })
  a.click()
}

// ─── localStorage ─────────────────────────────────────────────────────────────

function lsGet<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(key) ?? '') } catch { return fallback }
}
function lsSet(key: string, val: unknown) {
  try { localStorage.setItem(key, JSON.stringify(val)) } catch { /* quota */ }
}

// ─── Canvas Visuals ───────────────────────────────────────────────────────────

function ImageViz({ el, showAreas }: { el: ImageEl; showAreas: boolean }) {
  return el.src
    ? <div style={{ width: '100%', height: '100%', position: 'relative' }}>
        <img src={el.src} draggable={false} style={{ width: '100%', height: '100%', objectFit: 'contain', opacity: el.opacity, display: 'block', pointerEvents: 'none' }} alt="" />
        {showAreas && el.areas.map((a, i) => (
          <div key={a.id} style={{ position: 'absolute', left: `${a.x * 100}%`, top: `${a.y * 100}%`, width: `${a.w * 100}%`, height: `${a.h * 100}%`, border: '2px solid #3b82f6', background: 'rgba(59,130,246,0.15)', boxSizing: 'border-box', pointerEvents: 'none' }}>
            <span style={{ position: 'absolute', top: 2, left: 3, fontSize: 9, color: '#fff', background: 'rgba(0,0,0,0.6)', padding: '0 3px', borderRadius: 2 }}>{i + 1}</span>
          </div>
        ))}
      </div>
    : <div style={{ width: '100%', height: '100%', background: '#f0f0f0', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, pointerEvents: 'none' }}>
        <span style={{ fontSize: 36, color: '#ccc' }}>🖼</span>
        <span style={{ fontSize: 12, color: '#bbb' }}>오른쪽 패널에서 이미지 추가</span>
      </div>
}

function TextViz({ el, editing, onEdit }: { el: TextEl; editing: boolean; onEdit: (v: string) => void }) {
  const ta = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { if (editing) { ta.current?.focus(); ta.current?.select() } }, [editing])
  const style: React.CSSProperties = {
    width: '100%', height: '100%', fontFamily: el.fontFamily, fontSize: el.fontSize,
    fontWeight: el.bold ? 'bold' : 'normal', fontStyle: el.italic ? 'italic' : 'normal',
    color: el.content ? el.color : '#bbb',
    backgroundColor: el.bgColor === 'transparent' ? 'transparent' : el.bgColor,
    textAlign: el.align, lineHeight: el.lineHeight, letterSpacing: el.letterSpacing,
    padding: el.padding, boxSizing: 'border-box', whiteSpace: 'pre-wrap', overflow: 'hidden',
  }
  if (editing) return (
    <textarea ref={ta} value={el.content} onChange={e => onEdit(e.target.value)}
      onMouseDown={e => e.stopPropagation()}
      style={{ ...style, resize: 'none', border: 'none', outline: 'none', cursor: 'text', pointerEvents: 'auto',
        background: el.bgColor === 'transparent' ? 'rgba(255,255,255,0.95)' : el.bgColor }} />
  )
  return <div style={{ ...style, pointerEvents: 'none' }}>{el.content || '텍스트를 입력하세요…'}</div>
}

function ButtonViz({ el }: { el: ButtonEl }) {
  return <div style={{ width: '100%', height: '100%', background: el.bgColor, color: el.textColor, fontFamily: 'Arial', fontSize: el.fontSize, fontWeight: 'bold', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: el.borderRadius, pointerEvents: 'none', userSelect: 'none' }}>{el.text || '버튼'}</div>
}

// ─── Property helpers ─────────────────────────────────────────────────────────

function Lbl({ t }: { t: string }) { return <label className="block text-xs text-zinc-400 mb-1">{t}</label> }
function TIn({ v, on, ph, mono }: { v: string; on: (s: string) => void; ph?: string; mono?: boolean }) {
  return <input type="text" value={v} onChange={e => on(e.target.value)} placeholder={ph}
    className={['w-full rounded border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-xs text-white placeholder-zinc-600 focus:border-blue-500 focus:outline-none', mono ? 'font-mono' : ''].join(' ')} />
}
function NIn({ v, on, min, max, step }: { v: number; on: (n: number) => void; min?: number; max?: number; step?: number }) {
  return <input type="number" value={v} min={min} max={max} step={step} onChange={e => on(Number(e.target.value))}
    className="w-full rounded border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-xs text-white focus:border-blue-500 focus:outline-none" />
}
function CIn({ v, on }: { v: string; on: (s: string) => void }) {
  return <div className="flex gap-1.5 items-center">
    <input type="color" value={v.startsWith('#') ? v : '#ffffff'} onChange={e => on(e.target.value)} className="h-7 w-8 rounded border border-zinc-700 bg-zinc-800 cursor-pointer flex-shrink-0 p-0.5" />
    <input type="text" value={v} onChange={e => on(e.target.value)} className="flex-1 rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-white font-mono focus:outline-none" />
  </div>
}

// ─── Type panels ──────────────────────────────────────────────────────────────

function ImgPanel({ el, on, onSaveImage, onOpenMapEditor }: {
  el: ImageEl; on: (e: El) => void
  onSaveImage: (img: SavedImage) => void
  onOpenMapEditor: () => void
}) {
  const fRef = useRef<HTMLInputElement>(null)
  const [saveName, setSaveName] = useState('')
  const pick = (f: File | null) => {
    if (!f) return
    const r = new FileReader()
    r.onload = ev => {
      const src = ev.target?.result as string
      const img = new window.Image()
      img.onload = () => {
        const w = Math.min(CANVAS_W, img.naturalWidth)
        on({ ...el, src, width: w, height: Math.round(w * img.naturalHeight / img.naturalWidth) })
      }
      img.src = src
    }
    r.readAsDataURL(f)
  }
  return <div className="space-y-3">
    <div><Lbl t="이미지 URL" /><TIn v={el.src.startsWith('data:') ? '(파일 첨부됨)' : el.src} on={v => on({ ...el, src: v })} ph="https://..." mono /></div>
    <div className="flex gap-2">
      <button onClick={() => fRef.current?.click()} className="flex-1 rounded border border-zinc-700 px-2 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800">📁 파일 첨부</button>
      {el.src && <button onClick={() => on({ ...el, src: '' })} className="rounded border border-red-900 px-2 py-1.5 text-xs text-red-400 hover:bg-red-950">초기화</button>}
      <input ref={fRef} type="file" accept="image/*" className="hidden" onChange={e => pick(e.target.files?.[0] ?? null)} />
    </div>
    {el.src && (
      <div className="flex gap-1">
        <input value={saveName} onChange={e => setSaveName(e.target.value)} placeholder="이름 입력 후 저장"
          className="flex-1 rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-white focus:outline-none placeholder-zinc-600" />
        <button onClick={() => { if (!saveName.trim() || !el.src) return; onSaveImage({ id: uid(), name: saveName.trim(), src: el.src }); setSaveName('') }}
          className="rounded border border-zinc-600 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800">저장</button>
      </div>
    )}
    <div><Lbl t="기본 링크 URL (영역 없을 때)" /><TIn v={el.href} on={v => on({ ...el, href: v })} ph="https://..." mono /></div>
    <div><Lbl t={`불투명도 (${Math.round(el.opacity * 100)}%)`} />
      <input type="range" min={0} max={1} step={0.05} value={el.opacity} onChange={e => on({ ...el, opacity: Number(e.target.value) })} className="w-full accent-blue-500" />
    </div>
    <div className="border-t border-zinc-800 pt-3">
      <div className="flex items-center justify-between mb-1">
        <Lbl t={`클릭 영역 (이미지맵) ${el.areas.length > 0 ? `· ${el.areas.length}개` : ''}`} />
      </div>
      <button onClick={onOpenMapEditor}
        className="w-full rounded border border-zinc-600 px-2 py-1.5 text-xs text-zinc-200 hover:bg-zinc-800">
        🗺 영역 편집
      </button>
    </div>
  </div>
}

function TxtPanel({ el, on }: { el: TextEl; on: (e: El) => void }) {
  useEffect(() => {
    for (const f of GOOGLE_FONTS) { if (el.fontFamily.includes(f)) injectFont(f) }
  }, [el.fontFamily])

  return <div className="space-y-3">
    <div>
      <Lbl t="텍스트 내용" />
      <textarea value={el.content} onChange={e => on({ ...el, content: e.target.value })} rows={3}
        className="w-full rounded border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-xs text-white focus:border-blue-500 focus:outline-none resize-y" />
    </div>
    <div><Lbl t="웹폰트" />
      <select value={el.fontFamily} onChange={e => on({ ...el, fontFamily: e.target.value })}
        className="w-full rounded border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-xs text-white focus:outline-none">
        {FONT_OPTIONS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
      </select>
    </div>
    <div className="grid grid-cols-2 gap-2">
      <div><Lbl t="글자 크기" /><NIn v={el.fontSize} on={v => on({ ...el, fontSize: v })} min={8} /></div>
      <div><Lbl t="행간" /><NIn v={el.lineHeight} on={v => on({ ...el, lineHeight: v })} min={1} step={0.1} /></div>
    </div>
    <div><Lbl t={`자간 (${el.letterSpacing}px)`} />
      <input type="range" min={-5} max={20} step={0.5} value={el.letterSpacing} onChange={e => on({ ...el, letterSpacing: Number(e.target.value) })} className="w-full accent-blue-500" />
    </div>
    <div className="flex gap-1">
      {(['left', 'center', 'right'] as const).map(a => (
        <button key={a} onClick={() => on({ ...el, align: a })} className={['flex-1 rounded border py-1 text-xs', el.align === a ? 'border-blue-500 bg-blue-600/20 text-blue-400' : 'border-zinc-700 text-zinc-400 hover:bg-zinc-800'].join(' ')}>
          {a === 'left' ? '좌' : a === 'center' ? '중' : '우'}
        </button>
      ))}
      <button onClick={() => on({ ...el, bold: !el.bold })} className={['flex-1 rounded border py-1 text-xs font-bold', el.bold ? 'border-blue-500 bg-blue-600/20 text-blue-400' : 'border-zinc-700 text-zinc-400 hover:bg-zinc-800'].join(' ')}>B</button>
      <button onClick={() => on({ ...el, italic: !el.italic })} className={['flex-1 rounded border py-1 text-xs italic', el.italic ? 'border-blue-500 bg-blue-600/20 text-blue-400' : 'border-zinc-700 text-zinc-400 hover:bg-zinc-800'].join(' ')}>I</button>
    </div>
    <div><Lbl t="글자 색상" /><CIn v={el.color} on={v => on({ ...el, color: v })} /></div>
    <div><Lbl t="배경 색상" /><CIn v={el.bgColor} on={v => on({ ...el, bgColor: v })} /></div>
    <div><Lbl t="내부 패딩 (px)" /><NIn v={el.padding} on={v => on({ ...el, padding: v })} min={0} /></div>
  </div>
}

function BtnPanel({ el, on }: { el: ButtonEl; on: (e: El) => void }) {
  return <div className="space-y-3">
    <div><Lbl t="버튼 텍스트" /><TIn v={el.text} on={v => on({ ...el, text: v })} ph="자세히 보기" /></div>
    <div><Lbl t="링크 URL" /><TIn v={el.href} on={v => on({ ...el, href: v })} ph="https://..." mono /></div>
    <div className="grid grid-cols-2 gap-2">
      <div><Lbl t="글자 크기" /><NIn v={el.fontSize} on={v => on({ ...el, fontSize: v })} min={8} /></div>
      <div><Lbl t="모서리 둥글기" /><NIn v={el.borderRadius} on={v => on({ ...el, borderRadius: v })} min={0} /></div>
    </div>
    <div><Lbl t="배경 색상" /><CIn v={el.bgColor} on={v => on({ ...el, bgColor: v })} /></div>
    <div><Lbl t="글자 색상" /><CIn v={el.textColor} on={v => on({ ...el, textColor: v })} /></div>
  </div>
}

function PosPanel({ el, on }: { el: El; on: (e: El) => void }) {
  return <div className="grid grid-cols-2 gap-2">
    <div><Lbl t="X" /><NIn v={Math.round(el.x)} on={v => on({ ...el, x: Math.max(0, Math.min(CANVAS_W - MIN_SZ, v)) })} min={0} max={CANVAS_W} /></div>
    <div><Lbl t="Y" /><NIn v={Math.round(el.y)} on={v => on({ ...el, y: Math.max(0, v) })} min={0} /></div>
    <div><Lbl t="너비" /><NIn v={Math.round(el.width)} on={v => on({ ...el, width: Math.max(MIN_SZ, Math.min(CANVAS_W, v)) })} min={MIN_SZ} max={CANVAS_W} /></div>
    <div><Lbl t="높이" /><NIn v={Math.round(el.height)} on={v => on({ ...el, height: Math.max(MIN_SZ, v) })} min={MIN_SZ} /></div>
  </div>
}

// ─── Alignment toolbar ────────────────────────────────────────────────────────

function AlignToolbar({ selIds, els, setEls }: { selIds: string[]; els: El[]; setEls: React.Dispatch<React.SetStateAction<El[]>> }) {
  const sel = els.filter(e => selIds.includes(e.id))
  if (sel.length < 2) return null

  const apply = (fn: (e: El) => Partial<El>) =>
    setEls(p => p.map(e => selIds.includes(e.id) ? { ...e, ...fn(e) } as El : e))

  const minX = Math.min(...sel.map(e => e.x))
  const maxR = Math.max(...sel.map(e => e.x + e.width))
  const minY = Math.min(...sel.map(e => e.y))
  const maxB = Math.max(...sel.map(e => e.y + e.height))

  const distH = () => {
    const sorted = [...sel].sort((a, b) => a.x - b.x)
    const totalW = sorted.reduce((s, e) => s + e.width, 0)
    const gap = (maxR - minX - totalW) / (sorted.length - 1)
    let cx = minX; const pos: Record<string, number> = {}
    for (const e of sorted) { pos[e.id] = cx; cx += e.width + gap }
    setEls(p => p.map(e => selIds.includes(e.id) ? { ...e, x: pos[e.id] ?? e.x } : e))
  }
  const distV = () => {
    const sorted = [...sel].sort((a, b) => a.y - b.y)
    const totalH = sorted.reduce((s, e) => s + e.height, 0)
    const gap = (maxB - minY - totalH) / (sorted.length - 1)
    let cy = minY; const pos: Record<string, number> = {}
    for (const e of sorted) { pos[e.id] = cy; cy += e.height + gap }
    setEls(p => p.map(e => selIds.includes(e.id) ? { ...e, y: pos[e.id] ?? e.y } : e))
  }

  const btn = (label: string, title: string, fn: () => void) => (
    <button title={title} onClick={fn} className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-800">{label}</button>
  )
  return (
    <div className="flex items-center gap-1 px-3 py-1.5 bg-zinc-900 border-b border-zinc-800 flex-wrap shrink-0">
      <span className="text-xs text-zinc-500 mr-1">{sel.length}개 선택</span>
      {btn('⇐ 좌', '왼쪽 정렬', () => apply(() => ({ x: minX })))}
      {btn('⇔ 중앙', '수평 중앙', () => apply(e => ({ x: Math.round((CANVAS_W - e.width) / 2) })))}
      {btn('⇒ 우', '오른쪽 정렬', () => apply(e => ({ x: maxR - e.width })))}
      {btn('⇑ 상', '위 정렬', () => apply(() => ({ y: minY })))}
      {btn('↕ 중', '수직 중앙', () => apply(e => ({ y: Math.round((maxB - minY - e.height) / 2 + minY) })))}
      {btn('⇓ 하', '아래 정렬', () => apply(e => ({ y: maxB - e.height })))}
      <div className="w-px h-4 bg-zinc-700 mx-0.5" />
      {btn('⇆ 균등H', '수평 균등', distH)}
      {btn('⇅ 균등V', '수직 균등', distV)}
    </div>
  )
}

// ─── Assets panel ─────────────────────────────────────────────────────────────

function AssetsPanel({ savedImages, savedTemplates, onLoadImage, onDeleteImage, onLoadTemplate, onDeleteTemplate }: {
  savedImages: SavedImage[]; savedTemplates: SavedTemplate[]
  onLoadImage: (img: SavedImage) => void; onDeleteImage: (id: string) => void
  onLoadTemplate: (els: El[]) => void; onDeleteTemplate: (id: string) => void
}) {
  const [tab, setTab] = useState<'images' | 'templates'>('images')
  return (
    <div className="w-36 shrink-0 border-r border-zinc-800 bg-zinc-950 flex flex-col">
      <div className="flex border-b border-zinc-800">
        {(['images', 'templates'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={['flex-1 py-2 text-xs font-medium', tab === t ? 'bg-zinc-800 text-white' : 'text-zinc-500 hover:text-zinc-300'].join(' ')}>
            {t === 'images' ? '이미지' : '템플릿'}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto p-1.5 space-y-1.5">
        {tab === 'images' && (
          savedImages.length === 0
            ? <p className="text-xs text-zinc-600 text-center mt-4 px-2">저장된 이미지 없음</p>
            : savedImages.map(img => (
                <div key={img.id} className="group relative rounded overflow-hidden border border-zinc-800 cursor-pointer hover:border-blue-500" onClick={() => onLoadImage(img)}>
                  <img src={img.src} className="w-full aspect-video object-cover" alt={img.name} />
                  <div className="absolute inset-x-0 bottom-0 bg-black/70 px-1.5 py-0.5 flex items-center justify-between">
                    <span className="text-xs text-zinc-300 truncate leading-tight">{img.name}</span>
                    <button onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onDeleteImage(img.id) }} className="text-red-400 text-xs ml-1 opacity-0 group-hover:opacity-100 flex-shrink-0">✕</button>
                  </div>
                </div>
              ))
        )}
        {tab === 'templates' && (
          savedTemplates.length === 0
            ? <p className="text-xs text-zinc-600 text-center mt-4 px-2">저장된 템플릿 없음</p>
            : savedTemplates.map(tpl => (
                <div key={tpl.id} className="group flex items-center gap-1 rounded border border-zinc-800 px-2 py-1.5 cursor-pointer hover:border-blue-500" onClick={() => onLoadTemplate(tpl.els)}>
                  <span className="flex-1 text-xs text-zinc-300 truncate">{tpl.name}</span>
                  <button onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onDeleteTemplate(tpl.id) }} className="text-red-400 text-xs opacity-0 group-hover:opacity-100 flex-shrink-0">✕</button>
                </div>
              ))
        )}
      </div>
    </div>
  )
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function KaidInsightPage() {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const [cfg, setCfg] = useState<Config>({ date: today, lang: 'KOR', viewOnlineUrl: '', bgColor: '#ffffff' })
  const [els, setEls] = useState<El[]>([])
  const [selIds, setSelIds] = useState<string[]>([])
  const [editId, setEditId] = useState<string | null>(null)
  const [cfgOpen, setCfgOpen] = useState(false)
  const [preview, setPreview] = useState<string | null>(null)
  const [savedImages, setSavedImages] = useState<SavedImage[]>(() => lsGet<SavedImage[]>('kaid_images', []))
  const [savedTemplates, setSavedTemplates] = useState<SavedTemplate[]>(() => lsGet<SavedTemplate[]>('kaid_templates', []))
  const [tplName, setTplName] = useState('')
  const [showSaveTpl, setShowSaveTpl] = useState(false)
  const [newsOpen, setNewsOpen] = useState(false)
  const [currentNewsId, setCurrentNewsId] = useState<string | null>(null)
  const [currentNewsName, setCurrentNewsName] = useState('')
  const [translating, setTranslating] = useState(false)
  const [translateErr, setTranslateErr] = useState('')
  const [mapEditorId, setMapEditorId] = useState<string | null>(null)

  const drag = useRef<Drag | null>(null)
  const elsRef = useRef(els)
  const selIdsRef = useRef(selIds)
  useEffect(() => { elsRef.current = els }, [els])
  useEffect(() => { selIdsRef.current = selIds }, [selIds])

  const canvasH = Math.max(600, ...els.map(e => e.y + e.height + 80), 100)
  const selId = selIds.length === 1 ? selIds[0] : null
  const sel = selId ? (els.find(e => e.id === selId) ?? null) : null

  const upd = useCallback((updated: El) => setEls(p => p.map(e => e.id === updated.id ? updated : e)), [])
  const del = useCallback((id: string) => {
    setEls(p => p.filter(e => e.id !== id)); setSelIds(s => s.filter(x => x !== id)); setEditId(s => s === id ? null : s)
  }, [])

  const addImg = () => {
    const maxY = els.length ? Math.max(...els.map(e => e.y + e.height)) : 0
    const el = mkImage(maxY); setEls(p => [...p, el]); setSelIds([el.id])
  }
  const addTxt = () => { const el = mkText(20, Math.max(40, canvasH / 3)); setEls(p => [...p, el]); setSelIds([el.id]) }
  const addBtn = () => { const el = mkButton(275, Math.max(40, canvasH / 3)); setEls(p => [...p, el]); setSelIds([el.id]) }

  const onSaveImage = useCallback((img: SavedImage) => {
    setSavedImages(p => { const n = [...p, img]; lsSet('kaid_images', n); return n })
  }, [])
  const onDeleteImage = useCallback((id: string) => {
    setSavedImages(p => { const n = p.filter(x => x.id !== id); lsSet('kaid_images', n); return n })
  }, [])
  const onLoadImage = useCallback((img: SavedImage) => {
    const maxY = elsRef.current.length ? Math.max(...elsRef.current.map(e => e.y + e.height)) : 0
    const el: ImageEl = { ...mkImage(maxY), src: img.src }
    setEls(p => [...p, el]); setSelIds([el.id])
  }, [])

  const onSaveTemplate = (name: string) => {
    const tpl: SavedTemplate = { id: uid(), name, els: elsRef.current }
    setSavedTemplates(p => { const n = [...p, tpl]; lsSet('kaid_templates', n); return n })
  }
  const onDeleteTemplate = useCallback((id: string) => {
    setSavedTemplates(p => { const n = p.filter(x => x.id !== id); lsSet('kaid_templates', n); return n })
  }, [])
  const onLoadTemplate = useCallback((tplEls: El[]) => {
    setEls(tplEls); setSelIds([]); setEditId(null)
  }, [])

  const translate = async (targetLang: 'ENG' | 'KOR') => {
    setTranslating(true); setTranslateErr('')
    try {
      const result = await apiJson<{ els: El[] }>('/api/kaid-newsletters/translate', {
        method: 'POST', body: JSON.stringify({ els: elsRef.current, targetLang }),
      })
      setEls(result.els); setCfg(c => ({ ...c, lang: targetLang }))
    } catch (e) { setTranslateErr(e instanceof Error ? e.message : '번역 실패') }
    setTranslating(false)
  }

  const onNewsLoad = useCallback((news: NewsletterFull) => {
    setEls(news.els); setCfg(news.config); setSelIds([]); setEditId(null)
    setCurrentNewsId(news.id); setCurrentNewsName(news.name); setNewsOpen(false)
  }, [])

  const startDrag = useCallback((e: React.MouseEvent, id: string, mode: 'move' | 'resize', handle: string) => {
    e.preventDefault(); e.stopPropagation()
    const el = elsRef.current.find(x => x.id === id); if (!el) return
    if (e.shiftKey) setSelIds(p => p.includes(id) ? p : [...p, id])
    else if (!selIdsRef.current.includes(id)) setSelIds([id])
    drag.current = { mode, id, handle, mx0: e.clientX, my0: e.clientY, ex0: el.x, ey0: el.y, ew0: el.width, eh0: el.height }
  }, [])

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = drag.current; if (!d) return
      const dx = e.clientX - d.mx0, dy = e.clientY - d.my0
      if (d.mode === 'move') {
        const x = Math.max(0, Math.min(CANVAS_W - d.ew0, d.ex0 + dx)), y = Math.max(0, d.ey0 + dy)
        const adx = x - d.ex0, ady = y - d.ey0
        setEls(p => p.map(el => selIdsRef.current.includes(el.id) ? { ...el, x: Math.max(0, el.x + adx), y: Math.max(0, el.y + ady) } as El : el))
      } else {
        setEls(p => p.map(el => el.id === d.id ? { ...el, ...applyResize(d, dx, dy) } : el))
      }
    }
    const onUp = () => { drag.current = null }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
  }, [])

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setSelIds([]); setEditId(null); return }
      if (!selId || editId) return
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); del(selId); return }
      const d = e.shiftKey ? 10 : 1
      const map: Record<string, [number, number]> = { ArrowLeft: [-d, 0], ArrowRight: [d, 0], ArrowUp: [0, -d], ArrowDown: [0, d] }
      if (map[e.key]) { e.preventDefault(); const [ddx, ddy] = map[e.key]; setEls(p => p.map(el => el.id === selId ? { ...el, x: Math.max(0, el.x + ddx), y: Math.max(0, el.y + ddy) } : el)) }
    }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [selId, editId, del])

  const filename = `KAIDINSIGHT_${cfg.date}_${cfg.lang}.html`
  const dateDisp = `${cfg.date.slice(0, 4)}.${cfg.date.slice(4, 6)}.${cfg.date.slice(6, 8)}`
  const mapEditorEl = mapEditorId ? (els.find(e => e.id === mapEditorId) as ImageEl | undefined) : undefined

  return (
    <div className="flex flex-col -mx-6 -mt-6" style={{ height: '100vh', overflow: 'hidden' }}>

      {/* Toolbar */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-zinc-800 bg-zinc-950 shrink-0 flex-wrap">
        <button onClick={() => setCfgOpen(o => !o)} className={['rounded-lg border px-3 py-1.5 text-xs font-medium', cfgOpen ? 'border-blue-600 bg-blue-600/20 text-blue-400' : 'border-zinc-700 text-zinc-400 hover:bg-zinc-800'].join(' ')}>⚙ 설정</button>
        <div className="w-px h-5 bg-zinc-800" />
        <button onClick={addImg} className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-800">🖼 이미지</button>
        <button onClick={addTxt} className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-800">📝 텍스트</button>
        <button onClick={addBtn} className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-800">🔘 버튼</button>
        <div className="w-px h-5 bg-zinc-800" />
        {showSaveTpl
          ? <div className="flex gap-1">
              <input value={tplName} onChange={e => setTplName(e.target.value)} placeholder="템플릿 이름"
                className="rounded border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-xs text-white focus:outline-none w-28 placeholder-zinc-600" />
              <button onClick={() => { if (!tplName.trim()) return; onSaveTemplate(tplName.trim()); setTplName(''); setShowSaveTpl(false) }} className="rounded border border-zinc-600 px-2 py-1.5 text-xs text-zinc-200 hover:bg-zinc-800">저장</button>
              <button onClick={() => setShowSaveTpl(false)} className="rounded border border-zinc-800 px-2 py-1.5 text-xs text-zinc-500 hover:bg-zinc-900">✕</button>
            </div>
          : <button onClick={() => setShowSaveTpl(true)} className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800">💾 템플릿 저장</button>
        }
        <div className="flex-1" />
        {translateErr && <span className="text-xs text-red-400">{translateErr}</span>}
        <button onClick={() => translate(cfg.lang === 'KOR' ? 'ENG' : 'KOR')} disabled={translating || els.length === 0}
          className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40">
          {translating ? '번역 중…' : cfg.lang === 'KOR' ? '🌐 → ENG' : '🌐 → KOR'}
        </button>
        <div className="w-px h-5 bg-zinc-800" />
        <button onClick={() => setNewsOpen(true)} className={['rounded-lg border px-3 py-1.5 text-xs font-medium', currentNewsId ? 'border-blue-600 bg-blue-600/20 text-blue-400' : 'border-zinc-700 text-zinc-400 hover:bg-zinc-800'].join(' ')}>
          {currentNewsId ? `💾 ${currentNewsName || '저장됨'}` : '📂 저장/불러오기'}
        </button>
        <span className="text-xs text-zinc-600 font-mono hidden xl:block">{filename}</span>
        <button onClick={() => setPreview(genHTML(cfg, els, canvasH))} className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800">미리보기</button>
        <button onClick={() => dlFile(genHTML(cfg, els, canvasH), filename)} className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs text-white hover:bg-blue-500 font-medium">↓ 다운로드</button>
      </div>

      {/* Config */}
      {cfgOpen && (
        <div className="flex items-center gap-3 px-4 py-3 border-b border-zinc-800 bg-zinc-900 shrink-0 flex-wrap">
          <div className="flex items-center gap-2">
            <span className="text-xs text-zinc-400">발행일</span>
            <input type="text" value={cfg.date} onChange={e => setCfg(c => ({ ...c, date: e.target.value }))}
              className="rounded border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-xs text-white focus:outline-none w-24" placeholder="YYYYMMDD" />
          </div>
          <div className="flex rounded border border-zinc-700 overflow-hidden">
            {(['KOR', 'ENG'] as const).map(l => (
              <button key={l} onClick={() => setCfg(c => ({ ...c, lang: l }))}
                className={['px-3 py-1.5 text-xs font-medium', cfg.lang === l ? 'bg-blue-600 text-white' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'].join(' ')}>{l}</button>
            ))}
          </div>
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <span className="text-xs text-zinc-400 whitespace-nowrap">온라인 URL</span>
            <input type="text" value={cfg.viewOnlineUrl} onChange={e => setCfg(c => ({ ...c, viewOnlineUrl: e.target.value }))}
              className="flex-1 rounded border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-xs text-white font-mono focus:outline-none" />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-zinc-400">배경</span>
            <input type="color" value={cfg.bgColor} onChange={e => setCfg(c => ({ ...c, bgColor: e.target.value }))} className="h-7 w-8 rounded border border-zinc-700 cursor-pointer" />
          </div>
          <div className="text-xs text-zinc-600 border border-zinc-800 rounded px-2 py-1">헤더/푸터 자동 포함 · {dateDisp}</div>
        </div>
      )}

      {/* Alignment toolbar */}
      <AlignToolbar selIds={selIds} els={els} setEls={setEls} />

      {/* Editor body */}
      <div className="flex flex-1 overflow-hidden">

        <AssetsPanel
          savedImages={savedImages} savedTemplates={savedTemplates}
          onLoadImage={onLoadImage} onDeleteImage={onDeleteImage}
          onLoadTemplate={onLoadTemplate} onDeleteTemplate={onDeleteTemplate}
        />

        {/* Canvas area */}
        <div className="flex-1 overflow-auto bg-zinc-700/40 p-8"
          onMouseDown={() => { setSelIds([]); setEditId(null) }}>

          {/* Header preview */}
          <div style={{ width: CANVAS_W, margin: '0 auto', background: '#fff', borderBottom: '1px solid #eee', padding: '0 10px', height: 36, display: 'flex', alignItems: 'center', fontSize: 11, color: '#888', fontFamily: 'Arial', boxSizing: 'border-box' }}>
            <b>KAID Insight</b>&nbsp;|&nbsp;{dateDisp}
            {cfg.viewOnlineUrl && <>&nbsp;&nbsp;<span style={{ textDecoration: 'underline', color: '#888' }}>온라인 보기</span></>}
          </div>

          {/* Canvas */}
          <div style={{ width: CANVAS_W, margin: '0 auto', position: 'relative', height: canvasH, background: cfg.bgColor, boxShadow: '0 8px 48px rgba(0,0,0,0.6)' }}
            onMouseDown={e => e.stopPropagation()}>

            {els.length === 0 && (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, color: '#aaa', pointerEvents: 'none' }}>
                <span style={{ fontSize: 40 }}>+</span>
                <span style={{ fontSize: 13 }}>이미지, 텍스트, 버튼을 추가하세요</span>
                <span style={{ fontSize: 11, color: '#888' }}>드래그 이동 · 모서리 크기조절 · 더블클릭 텍스트 편집</span>
              </div>
            )}

            {els.map(el => {
              const isSel = selIds.includes(el.id)
              return (
                <div key={el.id}
                  style={{ position: 'absolute', left: el.x, top: el.y, width: el.width, height: el.height,
                    outline: isSel ? '2px solid #3b82f6' : '1px dashed transparent', outlineOffset: 1,
                    cursor: 'move', userSelect: 'none', zIndex: isSel ? 100 : 1 }}
                  onMouseDown={e => startDrag(e, el.id, 'move', 'move')}
                  onDoubleClick={e => { e.stopPropagation(); if (el.type === 'text') { setSelIds([el.id]); setEditId(el.id) } }}
                  onClick={e => { e.stopPropagation(); if (e.shiftKey) setSelIds(p => p.includes(el.id) ? p.filter(x => x !== el.id) : [...p, el.id]); else setSelIds([el.id]) }}>

                  {el.type === 'image'  && <ImageViz el={el} showAreas={isSel} />}
                  {el.type === 'text'   && <TextViz  el={el} editing={editId === el.id} onEdit={v => upd({ ...el, content: v } as El)} />}
                  {el.type === 'button' && <ButtonViz el={el} />}

                  {isSel && <>
                    <div style={{ position: 'absolute', top: -20, left: 0, display: 'flex', alignItems: 'center', gap: 3, zIndex: 20 }}>
                      <span style={{ background: '#3b82f6', color: '#fff', fontSize: 9, padding: '1px 4px', borderRadius: 3, userSelect: 'none', whiteSpace: 'nowrap' }}>
                        {el.type === 'image' ? '🖼' : el.type === 'text' ? '📝' : '🔘'}
                      </span>
                      {selIds.length === 1 && (
                        <button onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); del(el.id) }}
                          style={{ background: '#ef4444', color: '#fff', border: 'none', fontSize: 9, padding: '1px 4px', borderRadius: 3, cursor: 'pointer' }}>✕</button>
                      )}
                    </div>
                    {selIds.length === 1 && HANDLES.map(h => {
                      const { x: hx, y: hy } = hpos(h.id, el.width, el.height)
                      return <div key={h.id}
                        style={{ position: 'absolute', left: hx - 5, top: hy - 5, width: 10, height: 10, background: '#fff', border: '2px solid #3b82f6', borderRadius: 2, cursor: h.cur, zIndex: 30 }}
                        onMouseDown={e => startDrag(e, el.id, 'resize', h.id)} />
                    })}
                  </>}
                </div>
              )
            })}
          </div>

          {/* Footer preview */}
          <div style={{ width: CANVAS_W, margin: '0 auto', background: '#f7f7f7', padding: '8px 10px', fontSize: 10, color: '#aaa', fontFamily: 'Arial', textAlign: 'center', boxSizing: 'border-box' }}>
            &copy; {cfg.date.slice(0, 4)} KAID. All rights reserved.
          </div>
        </div>

        {/* Properties panel */}
        <div className="w-60 shrink-0 border-l border-zinc-800 bg-zinc-950 overflow-y-auto">
          {sel ? (
            <div className="p-4">
              <div className="flex items-center justify-between mb-3 pb-3 border-b border-zinc-800">
                <span className="text-sm font-medium text-zinc-200">
                  {sel.type === 'image' ? '🖼 이미지' : sel.type === 'text' ? '📝 텍스트' : '🔘 버튼'}
                </span>
                <div className="flex gap-1">
                  <button title="레이어 아래로" onClick={() => setEls(p => { const i = p.findIndex(e => e.id === sel.id); if (i <= 0) return p; const n = [...p]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; return n })} className="rounded border border-zinc-700 px-1.5 py-1 text-xs text-zinc-500 hover:bg-zinc-800">↓</button>
                  <button title="레이어 위로"  onClick={() => setEls(p => { const i = p.findIndex(e => e.id === sel.id); if (i >= p.length - 1) return p; const n = [...p]; [n[i], n[i + 1]] = [n[i + 1], n[i]]; return n })} className="rounded border border-zinc-700 px-1.5 py-1 text-xs text-zinc-500 hover:bg-zinc-800">↑</button>
                  <button onClick={() => del(sel.id)} className="rounded border border-red-900 px-1.5 py-1 text-xs text-red-400 hover:bg-red-950">✕</button>
                </div>
              </div>
              <div className="mb-3 pb-3 border-b border-zinc-800">
                <p className="text-xs text-zinc-600 mb-2">위치 / 크기</p>
                <PosPanel el={sel} on={upd} />
              </div>
              {sel.type === 'image'  && <ImgPanel el={sel} on={upd} onSaveImage={onSaveImage} onOpenMapEditor={() => setMapEditorId(sel.id)} />}
              {sel.type === 'text'   && <TxtPanel el={sel} on={upd} />}
              {sel.type === 'button' && <BtnPanel el={sel} on={upd} />}
            </div>
          ) : selIds.length > 1 ? (
            <div className="flex flex-col items-center justify-center h-48 px-4 text-center gap-2">
              <span className="text-2xl text-zinc-500">⊞</span>
              <p className="text-sm text-zinc-400">{selIds.length}개 선택됨</p>
              <p className="text-xs text-zinc-600">위 정렬 툴바를 사용하세요</p>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-48 px-4 text-center text-zinc-600 gap-2">
              <span className="text-2xl">←</span>
              <p className="text-sm">요소를 클릭하면 여기서 편집합니다</p>
              <p className="text-xs text-zinc-700">Shift+클릭: 다중선택<br />Delete: 삭제 · 방향키: 이동</p>
            </div>
          )}
        </div>
      </div>

      {/* Image map editor modal */}
      {mapEditorEl && (
        <ImageMapEditor
          el={mapEditorEl}
          onChange={(areas: ImageArea[]) => upd({ ...mapEditorEl, areas })}
          onClose={() => setMapEditorId(null)}
        />
      )}

      {/* Newsletter modal */}
      {newsOpen && (
        <NewsletterModal
          onLoad={onNewsLoad} onClose={() => setNewsOpen(false)}
          currentId={currentNewsId} currentName={currentNewsName}
          els={els} cfg={cfg}
        />
      )}

      {/* Preview modal */}
      {preview && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 50, background: 'rgba(0,0,0,0.85)', display: 'flex', flexDirection: 'column' }}>
          <div className="flex items-center justify-between px-4 py-3 bg-zinc-950 border-b border-zinc-800 shrink-0">
            <span className="text-sm font-medium text-zinc-200">미리보기</span>
            <div className="flex gap-2">
              <button onClick={() => window.open(URL.createObjectURL(new Blob([preview], { type: 'text/html;charset=utf-8' })), '_blank')} className="rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800">새 탭</button>
              <button onClick={() => dlFile(preview, filename)} className="rounded bg-blue-600 px-3 py-1.5 text-xs text-white hover:bg-blue-500">다운로드</button>
              <button onClick={() => setPreview(null)} className="rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800">닫기</button>
            </div>
          </div>
          <iframe srcDoc={preview} style={{ flex: 1, border: 'none', background: '#fff' }} title="미리보기" />
        </div>
      )}
    </div>
  )
}
