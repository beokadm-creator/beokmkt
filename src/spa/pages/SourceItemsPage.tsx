import { FormEvent, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import StatusBadge from '../components/StatusBadge'
import { apiJson } from '../lib/api'

type SourceItem = {
  id: string
  title: string
  source_type: string
  status: string
  published_at: string | null
  created_at: string
}

type ListResponse = { items: SourceItem[]; total: number; limit: number; offset: number }

export default function SourceItemsPage() {
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('')
  const [data, setData] = useState<ListResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  const queryString = useMemo(() => {
    const sp = new URLSearchParams()
    sp.set('limit', '50')
    sp.set('offset', '0')
    if (q.trim()) sp.set('q', q.trim())
    if (status) sp.set('status', status)
    return sp.toString()
  }, [q, status])

  useEffect(() => {
    setIsLoading(true)
    apiJson<ListResponse>(`/api/source-items?${queryString}`)
      .then((d) => {
        setData(d)
        setError(null)
      })
      .catch((e) => setError(e instanceof Error ? e.message : '불러오기 실패'))
      .finally(() => setIsLoading(false))
  }, [queryString])

  async function onCreateDemo(e: FormEvent) {
    e.preventDefault()
    const idempotencyKey = `demo-source-${Date.now()}`
    await apiJson<{ id: string }>('/api/source-items/import', {
      method: 'POST',
      idempotencyKey,
      body: JSON.stringify({
        source_type: 'manual',
        source_ref_id: null,
        title: `데모 원천 콘텐츠 ${new Date().toISOString()}`,
        body: '데모 본문입니다. 여기서 숏폼 아이디어를 생성합니다.',
        summary: '데모 요약',
        category: 'demo',
        tags: ['demo'],
        origin_url: null,
        published_at: null,
      }),
    })
    const d = await apiJson<ListResponse>(`/api/source-items?${queryString}`)
    setData(d)
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold">원천 콘텐츠</div>
        <form onSubmit={onCreateDemo}>
          <button
            type="submit"
            className="inline-flex h-9 items-center justify-center rounded-lg bg-white px-3 text-sm font-medium text-zinc-950"
          >
            데모 원천 추가
          </button>
        </form>
      </div>

      <div className="rounded-xl border border-zinc-900 bg-zinc-900/30 p-4">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <label className="flex flex-col gap-2">
            <span className="text-xs text-zinc-400">검색</span>
            <input
              className="h-10 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="제목/키워드"
            />
          </label>
          <label className="flex flex-col gap-2">
            <span className="text-xs text-zinc-400">상태</span>
            <select
              className="h-10 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              <option value="">전체</option>
              <option value="received">received</option>
              <option value="normalized">normalized</option>
              <option value="eligible">eligible</option>
              <option value="ineligible">ineligible</option>
              <option value="archived">archived</option>
            </select>
          </label>
          <div className="flex items-end text-xs text-zinc-500">{isLoading ? '로딩 중…' : data ? `total ${data.total}` : null}</div>
        </div>
      </div>

      {error ? <div className="text-sm text-rose-200">{error}</div> : null}

      <div className="overflow-hidden rounded-xl border border-zinc-900">
        <table className="w-full table-fixed">
          <thead className="bg-zinc-950">
            <tr className="text-left text-xs text-zinc-400">
              <th className="w-[52%] px-4 py-3">제목</th>
              <th className="w-[14%] px-4 py-3">type</th>
              <th className="w-[18%] px-4 py-3">status</th>
              <th className="w-[16%] px-4 py-3">created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-900 bg-zinc-950/40">
            {data?.items.map((it) => (
              <tr key={it.id} className="text-sm">
                <td className="px-4 py-3">
                  <Link className="text-zinc-100 hover:underline" to={`/source-items/${it.id}`}>
                    {it.title}
                  </Link>
                </td>
                <td className="px-4 py-3 text-zinc-300">{it.source_type}</td>
                <td className="px-4 py-3">
                  <StatusBadge value={it.status} />
                </td>
                <td className="px-4 py-3 text-zinc-500">{new Date(it.created_at).toLocaleString()}</td>
              </tr>
            ))}
            {!data?.items.length ? (
              <tr>
                <td className="px-4 py-8 text-sm text-zinc-500" colSpan={4}>
                  데이터가 없습니다. “데모 원천 추가”로 시작하세요.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  )
}

