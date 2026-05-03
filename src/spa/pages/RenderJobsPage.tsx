import { useCallback, useEffect, useMemo, useState } from 'react'
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
  const [busyId, setBusyId] = useState<string | null>(null)

  const queryString = useMemo(() => {
    const sp = new URLSearchParams()
    sp.set('limit', '50')
    sp.set('offset', '0')
    if (status) sp.set('status', status)
    return sp.toString()
  }, [status])

  const refresh = useCallback(async () => {
    setIsLoading(true)
    try {
      const d = await apiJson<ListResponse>(`/api/render-jobs?${queryString}`)
      setData(d)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : '불러오기 실패')
    } finally {
      setIsLoading(false)
    }
  }, [queryString])

  useEffect(() => {
    refresh()
  }, [refresh])

  const qcPendingCount = useMemo(
    () => data?.items.filter((item) => item.qc_status !== 'passed').length ?? 0,
    [data?.items]
  )

  async function onRetry(id: string) {
    setBusyId(id)
    try {
      await apiJson(`/api/render-jobs/${id}/retry`, {
        method: 'POST',
        body: JSON.stringify({ reason: '목록 빠른 재시도' }),
      })
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : '재시도 실패')
    } finally {
      setBusyId(null)
    }
  }

  async function onApproveForPublish(id: string) {
    setBusyId(id)
    try {
      await apiJson(`/api/render-jobs/${id}/approve-for-publish`, {
        method: 'POST',
        body: JSON.stringify({ comment: '목록 빠른 게시 승인' }),
      })
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : '게시 승인 실패')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold">영상 검수 (Render Jobs)</div>
        <div className="text-xs text-zinc-500">
          {isLoading ? '로딩 중…' : data ? `total ${data.total} · QC 대기 ${qcPendingCount}` : null}
        </div>
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
              <th className="w-[32%] px-4 py-3">id</th>
              <th className="w-[16%] px-4 py-3">status</th>
              <th className="w-[16%] px-4 py-3">qc</th>
              <th className="w-[12%] px-4 py-3">retry</th>
              <th className="w-[24%] px-4 py-3">action</th>
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
                <td className="px-4 py-3">
                  <StatusBadge value={it.qc_status} />
                </td>
                <td className="px-4 py-3 text-zinc-300">{it.retry_count}</td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    {it.qc_status !== 'passed' ? (
                      <button
                        type="button"
                        disabled={busyId === it.id}
                        onClick={() => onApproveForPublish(it.id)}
                        className="h-8 rounded-lg bg-white px-2 text-xs font-medium text-zinc-950 disabled:opacity-60"
                      >
                        승인
                      </button>
                    ) : null}
                    {it.status === 'failed' ? (
                      <button
                        type="button"
                        disabled={busyId === it.id}
                        onClick={() => onRetry(it.id)}
                        className="h-8 rounded-lg border border-zinc-800 bg-zinc-950 px-2 text-xs text-zinc-200 disabled:opacity-60"
                      >
                        재시도
                      </button>
                    ) : null}
                    {!((it.qc_status !== 'passed') || it.status === 'failed') ? (
                      <Link className="text-xs text-zinc-500 underline" to={`/render-jobs/${it.id}`}>
                        상세
                      </Link>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
            {!data?.items.length ? (
              <tr>
                <td className="px-4 py-8 text-sm text-zinc-500" colSpan={5}>
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
