import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import StatusBadge from '../components/StatusBadge'
import { apiJson } from '../lib/api'

type SourceItem = {
  id: string
  title: string
  body: string
  summary: string | null
  category: string | null
  tags: string[]
  status: string
  created_at: string
  short_ideas_summary: { total: number; awaiting_review: number; approved: number; rejected: number }
}

export default function SourceItemDetailPage() {
  const params = useParams()
  const id = params.id ?? ''
  const navigate = useNavigate()

  const [item, setItem] = useState<SourceItem | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isGenerating, setIsGenerating] = useState(false)

  const title = useMemo(() => item?.title ?? '원천 콘텐츠', [item?.title])

  useEffect(() => {
    if (!id) return
    setIsLoading(true)
    apiJson<SourceItem>(`/api/source-items/${id}`)
      .then((d) => {
        setItem(d)
        setError(null)
      })
      .catch((e) => setError(e instanceof Error ? e.message : '불러오기 실패'))
      .finally(() => setIsLoading(false))
  }, [id])

  async function onGenerateIdeas() {
    if (!id) return
    setIsGenerating(true)
    try {
      await apiJson<{ workflow_event_id: string }>(`/api/source-items/${id}/generate-ideas`, {
        method: 'POST',
        idempotencyKey: `gen-ideas-${id}-${Date.now()}`,
        body: JSON.stringify({ count: 5 }),
      })
      const d = await apiJson<SourceItem>(`/api/source-items/${id}`)
      setItem(d)
    } catch (e) {
      setError(e instanceof Error ? e.message : '실행 실패')
    } finally {
      setIsGenerating(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => navigate(-1)}
            className="h-9 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm text-zinc-200"
          >
            뒤로
          </button>
          <div className="text-sm font-semibold">{title}</div>
          {item ? <StatusBadge value={item.status} /> : null}
        </div>
        <button
          type="button"
          disabled={isGenerating || !item}
          onClick={onGenerateIdeas}
          className="inline-flex h-9 items-center justify-center rounded-lg bg-white px-3 text-sm font-medium text-zinc-950 disabled:opacity-60"
        >
          {isGenerating ? '생성 중…' : '아이디어 생성 트리거'}
        </button>
      </div>

      {isLoading ? <div className="text-sm text-zinc-500">로딩 중…</div> : null}
      {error ? <div className="text-sm text-rose-200">{error}</div> : null}

      {item ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div className="md:col-span-2 rounded-xl border border-zinc-900 bg-zinc-900/30 p-4">
            <div className="text-xs text-zinc-400">본문</div>
            <pre className="mt-2 whitespace-pre-wrap text-sm text-zinc-100">{item.body}</pre>
          </div>

          <div className="rounded-xl border border-zinc-900 bg-zinc-900/30 p-4">
            <div className="text-xs text-zinc-400">요약</div>
            <div className="mt-2 text-sm text-zinc-100">{item.summary ?? '-'}</div>

            <div className="mt-4 text-xs text-zinc-400">아이디어 현황</div>
            <div className="mt-2 flex flex-col gap-2 text-sm text-zinc-100">
              <div className="flex items-center justify-between">
                <span>total</span>
                <span>{item.short_ideas_summary.total}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-2">
                  <StatusBadge value="awaiting_review" />
                </span>
                <span>{item.short_ideas_summary.awaiting_review}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-2">
                  <StatusBadge value="approved" />
                </span>
                <span>{item.short_ideas_summary.approved}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-2">
                  <StatusBadge value="rejected" />
                </span>
                <span>{item.short_ideas_summary.rejected}</span>
              </div>
            </div>

            <div className="mt-4">
              <Link className="text-sm text-zinc-300 underline" to={`/short-ideas?source_item_id=${item.id}`}>
                이 원천의 아이디어 보기 →
              </Link>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

