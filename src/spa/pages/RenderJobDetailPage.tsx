import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import StatusBadge from '../components/StatusBadge'
import { apiJson } from '../lib/api'

type RenderJob = {
  id: string
  script_id: string
  short_idea_id: string
  status: string
  qc_status: string
  retry_count: number
  error_message: string | null
  render_profile: string
  created_at: string
}

export default function RenderJobDetailPage() {
  const params = useParams()
  const id = params.id ?? ''
  const navigate = useNavigate()

  const [job, setJob] = useState<RenderJob | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isBusy, setIsBusy] = useState(false)

  const title = useMemo(() => (job ? `렌더 작업 ${job.id}` : '렌더 작업'), [job])

  const refresh = useCallback(async () => {
    if (!id) return
    const d = await apiJson<RenderJob>(`/api/render-jobs/${id}`)
    setJob(d)
  }, [id])

  useEffect(() => {
    if (!id) return
    setIsLoading(true)
    refresh()
      .then(() => setError(null))
      .catch((e) => setError(e instanceof Error ? e.message : '불러오기 실패'))
      .finally(() => setIsLoading(false))
  }, [id, refresh])

  async function onRetry() {
    if (!id) return
    setIsBusy(true)
    try {
      await apiJson(`/api/render-jobs/${id}/retry`, { method: 'POST', body: JSON.stringify({ reason: 'retry' }) })
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : '재시도 실패')
    } finally {
      setIsBusy(false)
    }
  }

  async function onApproveForPublish() {
    if (!id) return
    setIsBusy(true)
    try {
      await apiJson(`/api/render-jobs/${id}/approve-for-publish`, {
        method: 'POST',
        body: JSON.stringify({ comment: 'approved via console' }),
      })
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : '승인 실패')
    } finally {
      setIsBusy(false)
    }
  }

  async function onCreatePublishJob() {
    if (!job) return
    setIsBusy(true)
    try {
      const created = await apiJson<{ id: string }>(`/api/publish-jobs`, {
        method: 'POST',
        idempotencyKey: `publish-from-render-${job.id}`,
        body: JSON.stringify({ render_job_id: job.id, platform: 'youtube', visibility: 'private' }),
      })
      navigate(`/publish-jobs/${created.id}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : '생성 실패')
    } finally {
      setIsBusy(false)
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
          {job ? <StatusBadge value={job.status} /> : null}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={isBusy || !job}
            onClick={onRetry}
            className="h-9 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm text-zinc-200 disabled:opacity-60"
          >
            재시도
          </button>
          <button
            type="button"
            disabled={isBusy || !job}
            onClick={onApproveForPublish}
            className="h-9 rounded-lg bg-white px-3 text-sm font-medium text-zinc-950 disabled:opacity-60"
          >
            게시 승인
          </button>
          <button
            type="button"
            disabled={isBusy || !job || job.qc_status !== 'passed'}
            onClick={onCreatePublishJob}
            className="h-9 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm text-zinc-200 disabled:opacity-60"
          >
            업로드 작업 생성
          </button>
        </div>
      </div>

      {isLoading ? <div className="text-sm text-zinc-500">로딩 중…</div> : null}
      {error ? <div className="text-sm text-rose-200">{error}</div> : null}

      {job ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div className="md:col-span-2 rounded-xl border border-zinc-900 bg-zinc-900/30 p-4">
            <div className="text-xs text-zinc-400">상태</div>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
              <StatusBadge value={job.status} />
              <span className="text-zinc-300">qc: {job.qc_status}</span>
              <span className="text-zinc-300">retry: {job.retry_count}</span>
            </div>
            {job.error_message ? <div className="mt-3 text-sm text-rose-200">{job.error_message}</div> : null}
          </div>

          <div className="rounded-xl border border-zinc-900 bg-zinc-900/30 p-4">
            <div className="text-xs text-zinc-400">연관</div>
            <div className="mt-2 flex flex-col gap-2 text-sm text-zinc-100">
              <div className="flex items-center justify-between">
                <span>script</span>
                <Link className="underline" to={`/scripts/${job.script_id}`}>
                  열기
                </Link>
              </div>
              <div className="flex items-center justify-between">
                <span>idea</span>
                <Link className="underline" to={`/short-ideas/${job.short_idea_id}`}>
                  열기
                </Link>
              </div>
              <div className="flex items-center justify-between">
                <span>profile</span>
                <span className="text-zinc-300">{job.render_profile}</span>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

