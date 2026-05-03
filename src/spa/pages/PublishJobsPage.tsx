import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import StatusBadge from '../components/StatusBadge'
import { apiJson } from '../lib/api'

type PublishJob = {
  id: string
  render_job_id: string
  platform: string
  status: string
  retry_count: number
  created_at: string
}

type ListResponse = { items: PublishJob[]; total: number; limit: number; offset: number }

export default function PublishJobsPage() {
  const location = useLocation()
  const spFromUrl = useMemo(() => new URLSearchParams(location.search), [location.search])
  const statusFromUrl = spFromUrl.get('status') ?? ''
  const platformFromUrl = spFromUrl.get('platform') ?? ''

  const [status, setStatus] = useState(statusFromUrl)
  const [platform, setPlatform] = useState(platformFromUrl)
  const [data, setData] = useState<ListResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  useEffect(() => {
    setStatus(statusFromUrl)
    setPlatform(platformFromUrl)
  }, [platformFromUrl, statusFromUrl])

  const queryString = useMemo(() => {
    const sp = new URLSearchParams()
    sp.set('limit', '50')
    sp.set('offset', '0')
    if (status) sp.set('status', status)
    if (platform) sp.set('platform', platform)
    return sp.toString()
  }, [platform, status])

  const refresh = useCallback(async () => {
    setIsLoading(true)
    try {
      const d = await apiJson<ListResponse>(`/api/publish-jobs?${queryString}`)
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

  const awaitingApprovalCount = useMemo(
    () => data?.items.filter((item) => item.status === 'awaiting_approval').length ?? 0,
    [data?.items]
  )

  async function onApprove(id: string) {
    setBusyId(id)
    try {
      await apiJson(`/api/publish-jobs/${id}/approve`, {
        method: 'POST',
        body: JSON.stringify({ comment: '목록 빠른 업로드 승인' }),
      })
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : '업로드 승인 실패')
    } finally {
      setBusyId(null)
    }
  }

  async function onRetry(id: string) {
    setBusyId(id)
    try {
      await apiJson(`/api/publish-jobs/${id}/retry`, {
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

  async function onCancel(id: string) {
    setBusyId(id)
    try {
      await apiJson(`/api/publish-jobs/${id}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ reason: '목록 빠른 취소' }),
      })
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : '취소 실패')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold">업로드 (Publish Jobs)</div>
        <div className="text-xs text-zinc-500">
          {isLoading ? '로딩 중…' : data ? `total ${data.total} · 승인 대기 ${awaitingApprovalCount}` : null}
        </div>
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
              <option value="awaiting_approval">awaiting_approval</option>
              <option value="queued">queued</option>
              <option value="uploading">uploading</option>
              <option value="uploaded">uploaded</option>
              <option value="failed">failed</option>
              <option value="cancelled">cancelled</option>
            </select>
          </label>
          <label className="flex flex-col gap-2">
            <span className="text-xs text-zinc-400">플랫폼</span>
            <select
              className="h-10 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm"
              value={platform}
              onChange={(e) => setPlatform(e.target.value)}
            >
              <option value="">전체</option>
              <option value="youtube">youtube</option>
              <option value="tiktok">tiktok</option>
            </select>
          </label>
        </div>
      </div>

      {error ? <div className="text-sm text-rose-200">{error}</div> : null}

      <div className="overflow-hidden rounded-xl border border-zinc-900">
        <table className="w-full table-fixed">
          <thead className="bg-zinc-950">
            <tr className="text-left text-xs text-zinc-400">
              <th className="w-[30%] px-4 py-3">id</th>
              <th className="w-[14%] px-4 py-3">platform</th>
              <th className="w-[18%] px-4 py-3">status</th>
              <th className="w-[12%] px-4 py-3">retry</th>
              <th className="w-[26%] px-4 py-3">action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-900 bg-zinc-950/40">
            {data?.items.map((it) => (
              <tr key={it.id} className="text-sm">
                <td className="px-4 py-3">
                  <Link className="text-zinc-100 hover:underline" to={`/publish-jobs/${it.id}`}>
                    {it.id}
                  </Link>
                  <div className="mt-1 text-xs text-zinc-600">
                    <Link className="underline" to={`/render-jobs/${it.render_job_id}`}>
                      render
                    </Link>
                  </div>
                </td>
                <td className="px-4 py-3 text-zinc-300">{it.platform}</td>
                <td className="px-4 py-3">
                  <StatusBadge value={it.status} />
                </td>
                <td className="px-4 py-3 text-zinc-300">{it.retry_count}</td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    {it.status === 'awaiting_approval' ? (
                      <button
                        type="button"
                        disabled={busyId === it.id}
                        onClick={() => onApprove(it.id)}
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
                    {it.status !== 'cancelled' && it.status !== 'uploaded' ? (
                      <button
                        type="button"
                        disabled={busyId === it.id}
                        onClick={() => onCancel(it.id)}
                        className="h-8 rounded-lg border border-zinc-800 bg-zinc-950 px-2 text-xs text-zinc-200 disabled:opacity-60"
                      >
                        취소
                      </button>
                    ) : null}
                    {it.status === 'cancelled' || it.status === 'uploaded' ? (
                      <Link className="text-xs text-zinc-500 underline" to={`/publish-jobs/${it.id}`}>
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
                  데이터가 없습니다. 렌더 작업 상세에서 “업로드 작업 생성”을 실행하세요.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  )
}
