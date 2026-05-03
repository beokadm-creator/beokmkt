import { useCallback, useEffect, useMemo, useState } from 'react'
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

type PlatformAccount = {
  id: string
  platform: string
  account_name: string
  status: string
}

export default function SourceItemDetailPage() {
  const params = useParams()
  const id = params.id ?? ''
  const navigate = useNavigate()

  const [item, setItem] = useState<SourceItem | null>(null)
  const [accounts, setAccounts] = useState<PlatformAccount[]>([])
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isGenerating, setIsGenerating] = useState(false)
  const [isRunningPipeline, setIsRunningPipeline] = useState(false)
  const [pipelineResult, setPipelineResult] = useState<string | null>(null)
  const [pipelineForm, setPipelineForm] = useState({
    ideaCount: '3',
    durationSec: '30',
    platform: 'youtube',
    platformAccountId: '',
    visibility: 'private',
    hashtags: '#shorts, #ai',
    publishTitle: '',
    publishDescription: '',
    autoApproveRender: true,
    autoApprovePublish: true,
  })

  const title = useMemo(() => item?.title ?? '원천 콘텐츠', [item?.title])
  const connectedAccounts = useMemo(() => accounts.filter((account) => account.status === 'connected'), [accounts])
  const availableAccounts = useMemo(
    () => connectedAccounts.filter((account) => account.platform === pipelineForm.platform),
    [connectedAccounts, pipelineForm.platform]
  )

  const refresh = useCallback(async () => {
    if (!id) return
    const d = await apiJson<SourceItem>(`/api/source-items/${id}`)
    setItem(d)
  }, [id])

  const refreshAccounts = useCallback(async () => {
    const d = await apiJson<{ items: PlatformAccount[] }>('/api/platform-accounts?limit=100&offset=0')
    setAccounts(d.items)
  }, [])

  useEffect(() => {
    if (!id) return
    setIsLoading(true)
    Promise.all([refresh(), refreshAccounts()])
      .then(() => {
        setError(null)
      })
      .catch((e) => setError(e instanceof Error ? e.message : '불러오기 실패'))
      .finally(() => setIsLoading(false))
  }, [id, refresh, refreshAccounts])

  useEffect(() => {
    if (!availableAccounts.length) {
      setPipelineForm((current) => (current.platformAccountId ? { ...current, platformAccountId: '' } : current))
      return
    }

    setPipelineForm((current) => {
      const hasCurrent = availableAccounts.some((account) => account.id === current.platformAccountId)
      if (hasCurrent) return current
      return { ...current, platformAccountId: availableAccounts[0].id }
    })
  }, [availableAccounts])

  async function onGenerateIdeas() {
    if (!id) return
    setIsGenerating(true)
    try {
      await apiJson<{ workflow_event_id: string }>(`/api/source-items/${id}/generate-ideas`, {
        method: 'POST',
        idempotencyKey: `gen-ideas-${id}-${Date.now()}`,
        body: JSON.stringify({ count: 5 }),
      })
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : '실행 실패')
    } finally {
      setIsGenerating(false)
    }
  }

  async function onRunAiPipeline() {
    if (!id) return
    if (!pipelineForm.platformAccountId) {
      setError('업로드 계정을 먼저 선택하세요')
      return
    }

    setIsRunningPipeline(true)
    setPipelineResult(null)
    try {
      const result = await apiJson<{
        lead_idea_id: string
        script_id: string
        render_job_id: string
        publish_job_id: string
      }>(`/api/source-items/${id}/run-ai-pipeline`, {
        method: 'POST',
        idempotencyKey: `ai-pipeline-${id}-${Date.now()}`,
        body: JSON.stringify({
          idea_count: Number(pipelineForm.ideaCount) || 3,
          duration_sec: Number(pipelineForm.durationSec) || 30,
          platform: pipelineForm.platform,
          platform_account_id: pipelineForm.platformAccountId,
          visibility: pipelineForm.visibility,
          hashtags: pipelineForm.hashtags
            .split(',')
            .map((tag) => tag.trim())
            .filter(Boolean),
          publish_title: pipelineForm.publishTitle.trim() || null,
          publish_description: pipelineForm.publishDescription.trim() || null,
          auto_approve_render: pipelineForm.autoApproveRender,
          auto_approve_publish: pipelineForm.autoApprovePublish,
        }),
      })
      await refresh()
      setPipelineResult(`아이디어 ${result.lead_idea_id} -> 대본 ${result.script_id} -> 렌더 ${result.render_job_id} -> 업로드 ${result.publish_job_id}`)
      navigate(`/publish-jobs/${result.publish_job_id}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'AI 자동 파이프라인 실행 실패')
    } finally {
      setIsRunningPipeline(false)
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

          <div className="md:col-span-3 rounded-xl border border-zinc-900 bg-zinc-900/30 p-4">
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold">AI 자동 파이프라인</div>
              <div className="text-xs text-zinc-500">원천 {'->'} 아이디어 {'->'} 대본 {'->'} 렌더 {'->'} 업로드</div>
            </div>

            <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
              <label className="flex flex-col gap-2">
                <span className="text-xs text-zinc-400">아이디어 수</span>
                <input
                  type="number"
                  min={1}
                  max={10}
                  className="h-10 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm"
                  value={pipelineForm.ideaCount}
                  onChange={(e) => setPipelineForm((current) => ({ ...current, ideaCount: e.target.value }))}
                />
              </label>
              <label className="flex flex-col gap-2">
                <span className="text-xs text-zinc-400">대본 길이(초)</span>
                <input
                  type="number"
                  min={10}
                  max={180}
                  className="h-10 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm"
                  value={pipelineForm.durationSec}
                  onChange={(e) => setPipelineForm((current) => ({ ...current, durationSec: e.target.value }))}
                />
              </label>
              <label className="flex flex-col gap-2">
                <span className="text-xs text-zinc-400">플랫폼</span>
                <select
                  className="h-10 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm"
                  value={pipelineForm.platform}
                  onChange={(e) => setPipelineForm((current) => ({ ...current, platform: e.target.value }))}
                >
                  <option value="youtube">youtube</option>
                  <option value="tiktok">tiktok</option>
                </select>
              </label>
              <label className="flex flex-col gap-2">
                <span className="text-xs text-zinc-400">업로드 계정</span>
                <select
                  className="h-10 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm disabled:opacity-60"
                  disabled={!availableAccounts.length}
                  value={pipelineForm.platformAccountId}
                  onChange={(e) => setPipelineForm((current) => ({ ...current, platformAccountId: e.target.value }))}
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
                <span className="text-xs text-zinc-400">공개 범위</span>
                <select
                  className="h-10 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm"
                  value={pipelineForm.visibility}
                  onChange={(e) => setPipelineForm((current) => ({ ...current, visibility: e.target.value }))}
                >
                  <option value="private">private</option>
                  <option value="unlisted">unlisted</option>
                  <option value="public">public</option>
                </select>
              </label>
              <label className="flex flex-col gap-2">
                <span className="text-xs text-zinc-400">해시태그</span>
                <input
                  className="h-10 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm"
                  value={pipelineForm.hashtags}
                  onChange={(e) => setPipelineForm((current) => ({ ...current, hashtags: e.target.value }))}
                  placeholder="#shorts, #ai"
                />
              </label>
              <label className="flex flex-col gap-2 md:col-span-3">
                <span className="text-xs text-zinc-400">업로드 제목</span>
                <input
                  className="h-10 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm"
                  value={pipelineForm.publishTitle}
                  onChange={(e) => setPipelineForm((current) => ({ ...current, publishTitle: e.target.value }))}
                  placeholder="비워두면 원천 제목 기반으로 자동 생성"
                />
              </label>
              <label className="flex flex-col gap-2 md:col-span-3">
                <span className="text-xs text-zinc-400">업로드 설명</span>
                <textarea
                  className="min-h-24 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm"
                  value={pipelineForm.publishDescription}
                  onChange={(e) => setPipelineForm((current) => ({ ...current, publishDescription: e.target.value }))}
                  placeholder="비워두면 원천 요약 기반으로 자동 생성"
                />
              </label>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-4 text-sm text-zinc-300">
              <label className="inline-flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={pipelineForm.autoApproveRender}
                  onChange={(e) => setPipelineForm((current) => ({ ...current, autoApproveRender: e.target.checked }))}
                />
                렌더 자동 승인
              </label>
              <label className="inline-flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={pipelineForm.autoApprovePublish}
                  onChange={(e) => setPipelineForm((current) => ({ ...current, autoApprovePublish: e.target.checked }))}
                />
                업로드 자동 승인
              </label>
            </div>

            {pipelineResult ? <div className="mt-3 text-sm text-emerald-200">{pipelineResult}</div> : null}

            <div className="mt-4 flex items-center justify-between gap-4">
              <div className="text-xs text-zinc-500">
                AI 호출자는 이 화면 없이도 `POST /api/source-items/:id/run-ai-pipeline` 엔드포인트로 같은 파이프라인을 실행할 수 있습니다.
              </div>
              <button
                type="button"
                disabled={isRunningPipeline || !pipelineForm.platformAccountId}
                onClick={onRunAiPipeline}
                className="inline-flex h-10 items-center justify-center rounded-lg bg-white px-4 text-sm font-medium text-zinc-950 disabled:opacity-60"
              >
                {isRunningPipeline ? 'AI 파이프라인 실행 중…' : 'AI 자동 파이프라인 실행'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
