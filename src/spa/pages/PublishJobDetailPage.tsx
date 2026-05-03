import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import ActivityTimeline from '../components/ActivityTimeline'
import StatusBadge from '../components/StatusBadge'
import { apiJson } from '../lib/api'

type PublishJob = {
  id: string
  render_job_id: string
  platform: string
  platform_account_id: string | null
  status: string
  retry_count: number
  error_message: string | null
  payload: { title: string | null; description: string | null; hashtags: string[]; visibility: string }
  created_at: string
}

export default function PublishJobDetailPage() {
  const params = useParams()
  const id = params.id ?? ''
  const navigate = useNavigate()

  const [job, setJob] = useState<PublishJob | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isBusy, setIsBusy] = useState(false)

  const title = useMemo(() => (job ? `업로드 작업 ${job.id}` : '업로드 작업'), [job])

  const refresh = useCallback(async () => {
    if (!id) return
    const d = await apiJson<PublishJob>(`/api/publish-jobs/${id}`)
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

  async function onApprove() {
    if (!id) return
    setIsBusy(true)
    try {
      await apiJson(`/api/publish-jobs/${id}/approve`, { method: 'POST', body: JSON.stringify({ comment: 'approved' }) })
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : '승인 실패')
    } finally {
      setIsBusy(false)
    }
  }

  async function onRetry() {
    if (!id) return
    setIsBusy(true)
    try {
      await apiJson(`/api/publish-jobs/${id}/retry`, { method: 'POST', body: JSON.stringify({ reason: 'retry' }) })
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : '재시도 실패')
    } finally {
      setIsBusy(false)
    }
  }

  async function onCancel() {
    if (!id) return
    setIsBusy(true)
    try {
      await apiJson(`/api/publish-jobs/${id}/cancel`, { method: 'POST', body: JSON.stringify({ reason: 'cancel' }) })
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : '취소 실패')
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
            disabled={isBusy || !job || job.status !== 'awaiting_approval'}
            onClick={onApprove}
            className="h-9 rounded-lg bg-white px-3 text-sm font-medium text-zinc-950 disabled:opacity-60"
          >
            업로드 승인
          </button>
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
            onClick={onCancel}
            className="h-9 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm text-zinc-200 disabled:opacity-60"
          >
            취소
          </button>
        </div>
      </div>

      {isLoading ? <div className="text-sm text-zinc-500">로딩 중…</div> : null}
      {error ? <div className="text-sm text-rose-200">{error}</div> : null}

      {job ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div className="md:col-span-2 flex flex-col gap-4">
            <div className="rounded-xl border border-zinc-900 bg-zinc-900/30 p-4">
              <div className="text-xs text-zinc-400">설정</div>
              <div className="mt-2 grid grid-cols-1 gap-2 text-sm text-zinc-100">
                <div className="flex items-center justify-between">
                  <span>platform</span>
                  <span className="text-zinc-300">{job.platform}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span>visibility</span>
                  <span className="text-zinc-300">{job.payload.visibility}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span>title</span>
                  <span className="text-zinc-300">{job.payload.title ?? '-'}</span>
                </div>
              </div>
              <div className="mt-4 text-xs text-zinc-400">설명</div>
              <div className="mt-2 whitespace-pre-wrap text-sm text-zinc-300">{job.payload.description ?? '-'}</div>
              <div className="mt-4 text-xs text-zinc-400">해시태그</div>
              <div className="mt-2 flex flex-wrap gap-2 text-sm text-zinc-300">
                {job.payload.hashtags.length ? job.payload.hashtags.map((tag) => <span key={tag}>{tag}</span>) : <span>-</span>}
              </div>
              {job.error_message ? <div className="mt-3 text-sm text-rose-200">{job.error_message}</div> : null}
            </div>

            <ActivityTimeline key={job.id} targetType="publish_job" targetId={job.id} />
          </div>

          <div className="rounded-xl border border-zinc-900 bg-zinc-900/30 p-4">
            <div className="text-xs text-zinc-400">연관</div>
            <div className="mt-2 flex flex-col gap-2 text-sm text-zinc-100">
              <div className="flex items-center justify-between">
                <span>render</span>
                <Link className="underline" to={`/render-jobs/${job.render_job_id}`}>
                  열기
                </Link>
              </div>
              <div className="flex items-center justify-between">
                <span>account</span>
                <span className="text-zinc-300">{job.platform_account_id ?? '-'}</span>
              </div>
              <div className="flex items-center justify-between">
                <span>retry</span>
                <span className="text-zinc-300">{job.retry_count}</span>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
