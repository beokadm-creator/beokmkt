import { useState, useRef } from 'react'
import type { ImageEl, ImageArea } from './types'

let _n = 0
const uid = () => `a${++_n}`

interface Drawing { x0: number; y0: number; x1: number; y1: number }

export default function ImageMapEditor({ el, onChange, onClose }: {
  el: ImageEl
  onChange: (areas: ImageArea[]) => void
  onClose: () => void
}) {
  const [areas, setAreas] = useState<ImageArea[]>(el.areas ?? [])
  const [drawing, setDrawing] = useState<Drawing | null>(null)
  const [selId, setSelId] = useState<string | null>(null)
  const [editHref, setEditHref] = useState('')
  const boxRef = useRef<HTMLDivElement>(null)

  const MAX_W = Math.min(700, window.innerWidth - 80)
  const scale = el.src ? Math.min(1, MAX_W / el.width) : 1
  const dw = el.width * scale
  const dh = el.height * scale

  const toFrac = (px: number, dim: number) => Math.max(0, Math.min(1, px / dim))

  const onMouseDown = (e: React.MouseEvent) => {
    if (!el.src) return
    e.preventDefault()
    const rect = boxRef.current!.getBoundingClientRect()
    const x = toFrac(e.clientX - rect.left, dw)
    const y = toFrac(e.clientY - rect.top, dh)
    setDrawing({ x0: x, y0: y, x1: x, y1: y })
    setSelId(null)
  }

  const onMouseMove = (e: React.MouseEvent) => {
    if (!drawing) return
    const rect = boxRef.current!.getBoundingClientRect()
    const x = toFrac(e.clientX - rect.left, dw)
    const y = toFrac(e.clientY - rect.top, dh)
    setDrawing(d => d ? { ...d, x1: x, y1: y } : null)
  }

  const onMouseUp = () => {
    if (!drawing) return
    const x = Math.min(drawing.x0, drawing.x1)
    const y = Math.min(drawing.y0, drawing.y1)
    const w = Math.abs(drawing.x1 - drawing.x0)
    const h = Math.abs(drawing.y1 - drawing.y0)
    setDrawing(null)
    if (w < 0.01 || h < 0.01) return
    const id = uid()
    setAreas(p => [...p, { id, x, y, w, h, href: '' }])
    setSelId(id)
    setEditHref('')
  }

  const updateHref = (id: string, href: string) =>
    setAreas(p => p.map(a => a.id === id ? { ...a, href } : a))

  const del = (id: string) => { setAreas(p => p.filter(a => a.id !== id)); setSelId(null) }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 70, background: 'rgba(0,0,0,0.85)', display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '20px 0', overflow: 'auto' }}
      onClick={onClose}>
      <div style={{ background: '#18181b', border: '1px solid #3f3f46', borderRadius: 8, maxWidth: MAX_W + 40, width: '100%' }}
        onClick={e => e.stopPropagation()}>

        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
          <span className="text-sm font-medium text-zinc-200">이미지 맵 영역 편집</span>
          <div className="flex gap-2">
            <button onClick={() => { onChange(areas); onClose() }} className="rounded bg-blue-600 px-3 py-1.5 text-xs text-white hover:bg-blue-500">저장</button>
            <button onClick={onClose} className="rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800">취소</button>
          </div>
        </div>

        <div className="p-4">
          <p className="text-xs text-zinc-500 mb-3">이미지 위를 드래그해서 클릭 영역을 그리세요</p>

          {el.src
            ? <div ref={boxRef} style={{ width: dw, height: dh, position: 'relative', cursor: 'crosshair', userSelect: 'none' }}
                onMouseDown={onMouseDown} onMouseMove={onMouseMove} onMouseUp={onMouseUp}>
                <img src={el.src} style={{ width: '100%', height: '100%', display: 'block', pointerEvents: 'none' }} alt="" draggable={false} />

                {areas.map((a, i) => (
                  <div key={a.id}
                    style={{ position: 'absolute', left: a.x * dw, top: a.y * dh, width: a.w * dw, height: a.h * dh,
                      border: `2px solid ${selId === a.id ? '#ef4444' : '#3b82f6'}`,
                      background: selId === a.id ? 'rgba(239,68,68,0.15)' : 'rgba(59,130,246,0.15)',
                      cursor: 'pointer', boxSizing: 'border-box' }}
                    onMouseDown={e => { e.stopPropagation(); setSelId(a.id); setEditHref(a.href) }}>
                    <span style={{ position: 'absolute', top: 2, left: 4, fontSize: 10, color: '#fff', background: 'rgba(0,0,0,0.5)', padding: '0 3px', borderRadius: 2 }}>{i + 1}</span>
                  </div>
                ))}

                {drawing && (
                  <div style={{ position: 'absolute', pointerEvents: 'none',
                    left: Math.min(drawing.x0, drawing.x1) * dw, top: Math.min(drawing.y0, drawing.y1) * dh,
                    width: Math.abs(drawing.x1 - drawing.x0) * dw, height: Math.abs(drawing.y1 - drawing.y0) * dh,
                    border: '2px dashed #fbbf24', background: 'rgba(251,191,36,0.1)', boxSizing: 'border-box' }} />
                )}
              </div>
            : <div style={{ width: dw, height: 120, background: '#27272a', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 4 }}>
                <span className="text-xs text-zinc-500">이미지를 먼저 첨부하세요</span>
              </div>
          }

          {/* Area list */}
          <div className="mt-4 space-y-2">
            {areas.map((a, i) => (
              <div key={a.id} className={['flex items-center gap-2 rounded px-2 py-1.5 border', selId === a.id ? 'border-red-700 bg-red-950/30' : 'border-zinc-800'].join(' ')}>
                <span className="text-xs text-zinc-400 w-4 text-center flex-shrink-0">{i + 1}</span>
                <input value={selId === a.id ? editHref : a.href}
                  onFocus={() => { setSelId(a.id); setEditHref(a.href) }}
                  onChange={e => { setEditHref(e.target.value); updateHref(a.id, e.target.value) }}
                  placeholder="https://..."
                  className="flex-1 rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-white font-mono focus:outline-none placeholder-zinc-600" />
                <button onClick={() => del(a.id)} className="text-red-500 hover:text-red-400 text-xs flex-shrink-0 px-1">✕</button>
              </div>
            ))}
            {areas.length === 0 && <p className="text-xs text-zinc-600 text-center py-2">아직 영역이 없습니다</p>}
          </div>
        </div>
      </div>
    </div>
  )
}
