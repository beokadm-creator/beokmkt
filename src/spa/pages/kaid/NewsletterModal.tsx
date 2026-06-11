import { useState, useCallback, useEffect } from 'react'
import { apiJson } from '../../lib/api'
import type { El, Config, NewsletterMeta, NewsletterFull } from './types'

export default function NewsletterModal({ onLoad, onClose, currentId, currentName, els, cfg }: {
  onLoad: (news: NewsletterFull) => void
  onClose: () => void
  currentId: string | null
  currentName: string
  els: El[]
  cfg: Config
}) {
  const [list, setList] = useState<NewsletterMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [saveName, setSaveName] = useState(currentName)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  const reload = useCallback(async () => {
    setLoading(true)
    try { setList(await apiJson<NewsletterMeta[]>('/api/kaid-newsletters')) } catch { setErr('목록 로드 실패') }
    setLoading(false)
  }, [])

  useEffect(() => { reload() }, [reload])

  const save = async () => {
    const name = saveName.trim()
    if (!name) return
    setSaving(true); setErr('')
    try {
      if (currentId) {
        await apiJson(`/api/kaid-newsletters/${currentId}`, { method: 'PUT', body: JSON.stringify({ name, config: cfg, els }) })
      } else {
        await apiJson('/api/kaid-newsletters', { method: 'POST', body: JSON.stringify({ name, config: cfg, els }) })
      }
      await reload()
    } catch { setErr('저장 실패') }
    setSaving(false)
  }

  const loadItem = async (id: string) => {
    try { onLoad(await apiJson<NewsletterFull>(`/api/kaid-newsletters/${id}`)) } catch { setErr('불러오기 실패') }
  }

  const del = async (id: string) => {
    if (!confirm('삭제하시겠습니까?')) return
    try { await apiJson(`/api/kaid-newsletters/${id}`, { method: 'DELETE' }); await reload() } catch { setErr('삭제 실패') }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onClose}>
      <div style={{ background: '#18181b', border: '1px solid #3f3f46', borderRadius: 8, width: 480, maxHeight: '80vh', display: 'flex', flexDirection: 'column' }} onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
          <span className="text-sm font-medium text-zinc-200">뉴스레터 저장 / 불러오기</span>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300 text-sm">✕</button>
        </div>

        <div className="px-4 py-3 border-b border-zinc-800">
          <p className="text-xs text-zinc-500 mb-2">{currentId ? '현재 뉴스레터 업데이트' : '현재 작업 저장'}</p>
          <div className="flex gap-2">
            <input value={saveName} onChange={e => setSaveName(e.target.value)} placeholder="뉴스레터 이름"
              className="flex-1 rounded border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-xs text-white focus:outline-none placeholder-zinc-600" />
            <button onClick={save} disabled={saving || !saveName.trim()}
              className="rounded bg-blue-600 px-3 py-1.5 text-xs text-white hover:bg-blue-500 disabled:opacity-50">
              {saving ? '저장 중…' : currentId ? '업데이트' : '저장'}
            </button>
          </div>
          <p className="text-xs text-zinc-700 mt-1.5">이미지 파일(Base64)은 서버에 저장되지 않습니다</p>
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          {err && <p className="text-xs text-red-400 px-2 mb-2">{err}</p>}
          {loading
            ? <p className="text-xs text-zinc-500 text-center py-6">로딩 중…</p>
            : list.length === 0
              ? <p className="text-xs text-zinc-600 text-center py-6">저장된 뉴스레터가 없습니다</p>
              : list.map(n => (
                  <div key={n.id} className={['flex items-center gap-2 rounded px-3 py-2 hover:bg-zinc-800 cursor-pointer', n.id === currentId ? 'bg-zinc-800/60 ring-1 ring-blue-600' : ''].join(' ')}>
                    <div className="flex-1 min-w-0" onClick={() => loadItem(n.id)}>
                      <p className="text-sm text-zinc-200 truncate">{n.name}</p>
                      <p className="text-xs text-zinc-600">{n.config?.date ?? ''} · {n.el_count}개 요소 · {new Date(n.updated_at).toLocaleDateString('ko')}</p>
                    </div>
                    <button onClick={() => del(n.id)} className="text-red-500 hover:text-red-400 text-xs flex-shrink-0 px-1">삭제</button>
                  </div>
                ))
          }
        </div>
      </div>
    </div>
  )
}
