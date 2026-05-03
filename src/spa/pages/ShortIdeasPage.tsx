import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import StatusBadge from '../components/StatusBadge'
import { apiJson } from '../lib/api'

type ShortIdea = {
  id: string
  source_item_id: string
  title: string
  hook: string
  status: string
  risk_score: number | null
  target_duration_sec: number
  created_at: string
}

type ListResponse = { items: ShortIdea[]; total: number; limit: number; offset: number }

export default function ShortIdeasPage() {
  const location = useLocation()
  const spFromUrl = useMemo(() => new URLSearchParams(location.search), [location.search])
  const sourceItemId = spFromUrl.get('source_item_id') ?? ''

  const [status, setStatus] = useState('')
  const [data, setData] = useState<ListResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  const queryString = useMemo(() => {
    const sp = new URLSearchParams()
    sp.set('limit', '50')
    sp.set('offset', '0')
    if (sourceItemId) sp.set('source_item_id', sourceItemId)
    if (status) sp.set('status', status)
    return sp.toString()
  }, [sourceItemId, status])

  useEffect(() => {
    setIsLoading(true)
    apiJson<ListResponse>(`/api/short-ideas?${queryString}`)
      .then((d) => {
        setData(d)
        setError(null)
      })
      .catch((e) => setError(e instanceof Error ? e.message : '불러오기 실패'))
      .finally(() => setIsLoading(false))
  }, [queryString])

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold">숏폼 아이디어</div>
        <div className="text-xs text-zinc-500">{isLoading ? '로딩 중…' : data ? `total ${data.total}` : null}</div>
      </div>

      <div className="rounded-xl border border-zinc-900 bg-zinc-900/30 p-4">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <label className="flex flex-col gap-2">
            <span className="text-xs text-zinc-400">상태</span>
            <select
              className="h-10 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              <option value="">전체</option>
              <option value="awaiting_review">awaiting_review</option>
              <option value="approved">approved</option>
              <option value="rejected">rejected</option>
              <option value="archived">archived</option>
            </select>
          </label>
          <div className="flex items-end text-xs text-zinc-500">
            {sourceItemId ? (
              <span>
                source_item_id: <span className="text-zinc-300">{sourceItemId}</span>
              </span>
            ) : null}
          </div>
        </div>
      </div>

      {error ? <div className="text-sm text-rose-200">{error}</div> : null}

      <div className="overflow-hidden rounded-xl border border-zinc-900">
        <table className="w-full table-fixed">
          <thead className="bg-zinc-950">
            <tr className="text-left text-xs text-zinc-400">
              <th className="w-[40%] px-4 py-3">제목</th>
              <th className="w-[32%] px-4 py-3">훅</th>
              <th className="w-[12%] px-4 py-3">duration</th>
              <th className="w-[16%] px-4 py-3">status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-900 bg-zinc-950/40">
            {data?.items.map((it) => (
              <tr key={it.id} className="text-sm">
                <td className="px-4 py-3">
                  <Link className="text-zinc-100 hover:underline" to={`/short-ideas/${it.id}`}>
                    {it.title}
                  </Link>
                  <div className="mt-1 text-xs text-zinc-600">
                    <Link className="underline" to={`/source-items/${it.source_item_id}`}>
                      source
                    </Link>
                  </div>
                </td>
                <td className="px-4 py-3 text-zinc-300">{it.hook}</td>
                <td className="px-4 py-3 text-zinc-300">{it.target_duration_sec}s</td>
                <td className="px-4 py-3">
                  <StatusBadge value={it.status} />
                </td>
              </tr>
            ))}
            {!data?.items.length ? (
              <tr>
                <td className="px-4 py-8 text-sm text-zinc-500" colSpan={4}>
                  데이터가 없습니다. 원천 콘텐츠에서 “아이디어 생성 트리거”를 실행하세요.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  )
}

