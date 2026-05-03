import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import StatusBadge from '../components/StatusBadge'
import { apiJson } from '../lib/api'

type RenderJob = {
  id: string
  script_id: string
  status: string
  qc_status: string
  retry_count: number
  created_at: string
}

type ListResponse = { items: RenderJob[]; total: number; limit: number; offset: number }

export default function RenderJobsPage() {
  const [status, setStatus] = useState('')
  const [data, setData] = useState<ListResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  const queryString = useMemo(() => {
    const sp = new URLSearchParams()
    sp.set('limit', '50')
    sp.set('offset', '0')
    if (status) sp.set('status', status)
    return sp.toString()
  }, [status])

  useEffect(() => {
    setIsLoading(true)
    apiJson<ListResponse>(`/api/render-jobs?${queryString}`)
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
        <div className="text-sm font-semibold">영상 검수 (Render Jobs)</div>
        <div className="text-xs text-zinc-500">{isLoading ? '로딩 중…' : data ? `total ${data.total}` : null}</div>
      </div>

      <div className="rounded-xl border border-zinc-900 bg-zinc-900/30 p-4">
        <label className="flex max-w-xs flex-col gap-2">
          <span className="text-xs text-zinc-400">상태</span>
          <select
            className="h-10 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="">전체</option>
            <option value="queued">queued</option>
            <option value="processing">processing</option>
            <option value="rendered">rendered</option>
            <option value="failed">failed</option>
          </select>
        </label>
      </div>

      {error ? <div className="text-sm text-rose-200">{error}</div> : null}

      <div className="overflow-hidden rounded-xl border border-zinc-900">
        <table className="w-full table-fixed">
          <thead className="bg-zinc-950">
            <tr className="text-left text-xs text-zinc-400">
              <th className="w-[44%] px-4 py-3">id</th>
              <th className="w-[20%] px-4 py-3">status</th>
              <th className="w-[20%] px-4 py-3">qc</th>
              <th className="w-[16%] px-4 py-3">retry</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-900 bg-zinc-950/40">
            {data?.items.map((it) => (
              <tr key={it.id} className="text-sm">
                <td className="px-4 py-3">
                  <Link className="text-zinc-100 hover:underline" to={`/render-jobs/${it.id}`}>
                    {it.id}
                  </Link>
                  <div className="mt-1 text-xs text-zinc-600">
                    <Link className="underline" to={`/scripts/${it.script_id}`}>
                      script
                    </Link>
                  </div>
                </td>
                <td className="px-4 py-3">
                  <StatusBadge value={it.status} />
                </td>
                <td className="px-4 py-3 text-zinc-300">{it.qc_status}</td>
                <td className="px-4 py-3 text-zinc-300">{it.retry_count}</td>
              </tr>
            ))}
            {!data?.items.length ? (
              <tr>
                <td className="px-4 py-8 text-sm text-zinc-500" colSpan={4}>
                  데이터가 없습니다. “대본 상세”에서 렌더 작업을 생성하세요.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  )
}

