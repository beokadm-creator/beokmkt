import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import ActivityTimeline from '../components/ActivityTimeline'
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

type PlatformAccount = {
  id: string
  platform: string
  account_name: string
  status: string
}

function firstAccountIdForPlatform(accounts: PlatformAccount[], platform: string) {
  return accounts.find((account) => account.platform === platform && account.status === 'connected')?.id ?? ''
}

export default function RenderJobDetailPage() {
  const params = useParams()
  const id = params.id ?? ''
  const navigate = useNavigate()

  const [job, setJob] = useState<RenderJob | null>(null)
  const [accounts, setAccounts] = useState<PlatformAccount[]>([])
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isBusy, setIsBusy] = useState(false)
  const [publishForm, setPublishForm] = useState({
    platform: 'youtube',
    platform_account_id: '',
    title: '',
    description: '',
    hashtags: '#shorts',
    visibility: 'private',
  })

  const title = useMemo(() => (job ? `렌더 작업 ${job.id}` : '렌더 작업'), [job])
  const connectedAccounts = useMemo(() => accounts.filter((account) => account.status === 'connected'), [accounts])
  const availableAccounts = useMemo(
    () => connectedAccounts.filter((account) => account.platform === publishForm.platform),
    [connectedAccounts, publishForm.platform]
  )

  const refresh = useCallback(async () => {
    if (!id) return
    const d = await apiJson<RenderJob>(`/api/render-jobs/${id}`)
    setJob(d)
  }, [id])

  const refreshAccounts = useCallback(async () => {
    const d = await apiJson<{ items: PlatformAccount[] }>('/api/platform-accounts?limit=100&offset=0')
    setAccounts(d.items)
    setPublishForm((current) => {
      const nextAccountId = d.items.some((account) => account.id === current.platform_account_id)
        ? current.platform_account_id
        : firstAccountIdForPlatform(d.items, current.platform)
      return nextAccountId === current.platform_account_id ? current : { ...current, platform_account_id: nextAccountId }
    })
  }, [])

  useEffect(() => {
    if (!id) return
    setIsLoading(true)
    Promise.all([refresh(), refreshAccounts()])
      .then(() => setError(null))
      .catch((e) => setError(e instanceof Error ? e.message : '불러오기 실패'))
      .finally(() => setIsLoading(false))
  }, [id, refresh, refreshAccounts])

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
    if (!publishForm.platform_account_id) {
      setError('업로드할 연결 계정을 먼저 선택하세요')
      return
    }

    setIsBusy(true)
    try {
      const created = await apiJson<{ id: string }>(`/api/publish-jobs`, {
        method: 'POST',
        idempotencyKey: `publish-from-render-${job.id}`,
        body: JSON.stringify({
          render_job_id: job.id,
          platform: publishForm.platform,
          platform_account_id: publishForm.platform_account_id,
          title: publishForm.title.trim() || null,
          description: publishForm.description.trim() || null,
          hashtags: publishForm.hashtags
            .split(',')
            .map((tag) => tag.trim())
            .filter(Boolean),
          visibility: publishForm.visibility,
        }),
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
          <div className="md:col-span-2 flex flex-col gap-4">
            <div className="rounded-xl border border-zinc-900 bg-zinc-900/30 p-4">
              <div className="text-xs text-zinc-400">상태</div>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                <StatusBadge value={job.status} />
                <span className="text-zinc-300">qc: {job.qc_status}</span>
                <span className="text-zinc-300">retry: {job.retry_count}</span>
              </div>
              {job.error_message ? <div className="mt-3 text-sm text-rose-200">{job.error_message}</div> : null}
            </div>

            <ActivityTimeline key={job.id} targetType="render_job" targetId={job.id} />
          </div>

          <div className="flex flex-col gap-4">
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

            <div className="rounded-xl border border-zinc-900 bg-zinc-900/30 p-4">
              <div className="flex items-center justify-between">
                <div className="text-xs text-zinc-400">업로드 설정</div>
                <div className="text-xs text-zinc-500">{availableAccounts.length}개 계정 사용 가능</div>
              </div>

              <div className="mt-3 grid grid-cols-1 gap-3">
                <label className="flex flex-col gap-2">
                  <span className="text-xs text-zinc-400">플랫폼</span>
                  <select
                    className="h-10 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm"
                    value={publishForm.platform}
                    onChange={(e) =>
                      setPublishForm((current) => ({
                        ...current,
                        platform: e.target.value,
                        platform_account_id: firstAccountIdForPlatform(accounts, e.target.value),
                      }))
                    }
                  >
                    <option value="youtube">youtube</option>
                    <option value="tiktok">tiktok</option>
                  </select>
                </label>

                <label className="flex flex-col gap-2">
                  <span className="text-xs text-zinc-400">연결 계정</span>
                  <select
                    className="h-10 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm disabled:opacity-60"
                    value={publishForm.platform_account_id}
                    disabled={!availableAccounts.length}
                    onChange={(e) => setPublishForm((current) => ({ ...current, platform_account_id: e.target.value }))}
                  >
                    {!availableAccounts.length ? <option value="">연결된 계정 없음</option> : null}
                    {availableAccounts.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.account_name}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="flex flex-col gap-2">
                  <span className="text-xs text-zinc-400">제목</span>
                  <input
                    className="h-10 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm"
                    value={publishForm.title}
                    onChange={(e) => setPublishForm((current) => ({ ...current, title: e.target.value }))}
                    placeholder="예: 30초 요약 숏츠"
                  />
                </label>

                <label className="flex flex-col gap-2">
                  <span className="text-xs text-zinc-400">설명</span>
                  <textarea
                    className="min-h-24 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm"
                    value={publishForm.description}
                    onChange={(e) => setPublishForm((current) => ({ ...current, description: e.target.value }))}
                    placeholder="영상 설명 또는 고정 문구"
                  />
                </label>

                <label className="flex flex-col gap-2">
                  <span className="text-xs text-zinc-400">해시태그</span>
                  <input
                    className="h-10 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm"
                    value={publishForm.hashtags}
                    onChange={(e) => setPublishForm((current) => ({ ...current, hashtags: e.target.value }))}
                    placeholder="#shorts, #marketing"
                  />
                </label>

                <label className="flex flex-col gap-2">
                  <span className="text-xs text-zinc-400">공개 범위</span>
                  <select
                    className="h-10 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm"
                    value={publishForm.visibility}
                    onChange={(e) => setPublishForm((current) => ({ ...current, visibility: e.target.value }))}
                  >
                    <option value="private">private</option>
                    <option value="unlisted">unlisted</option>
                    <option value="public">public</option>
                  </select>
                </label>
              </div>

              <div className="mt-3 text-xs text-zinc-500">
                연결 계정이 없으면 <Link to="/settings/platform-accounts" className="underline">플랫폼 계정 설정</Link>에서 YouTube 계정을 먼저 연동하세요.
              </div>

              <button
                type="button"
                disabled={isBusy || job.qc_status !== 'passed' || !publishForm.platform_account_id}
                onClick={onCreatePublishJob}
                className="mt-4 inline-flex h-10 w-full items-center justify-center rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm text-zinc-200 disabled:opacity-60"
              >
                업로드 작업 생성
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
