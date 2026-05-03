import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import ActivityTimeline from '../components/ActivityTimeline'
import StatusBadge from '../components/StatusBadge'
import { apiJson } from '../lib/api'

type ShortIdea = {
  id: string
  source_item_id: string
  title: string
  hook: string
  angle: string
  cta: string | null
  status: string
  target_duration_sec: number
  risk_score: number | null
  rejection_reason: string | null
  created_at: string
}

export default function ShortIdeaDetailPage() {
  const params = useParams()
  const id = params.id ?? ''
  const navigate = useNavigate()

  const [idea, setIdea] = useState<ShortIdea | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isBusy, setIsBusy] = useState(false)
  const [reviewForm, setReviewForm] = useState({
    approvalComment: '',
    rejectionReason: '',
    rejectionComment: '',
    durationSec: '30',
  })

  const title = useMemo(() => idea?.title ?? '숏폼 아이디어', [idea?.title])

  const refresh = useCallback(async () => {
    if (!id) return
    const d = await apiJson<ShortIdea>(`/api/short-ideas/${id}`)
    setIdea(d)
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
      await apiJson(`/api/short-ideas/${id}/approve`, {
        method: 'POST',
        body: JSON.stringify({ comment: reviewForm.approvalComment.trim() || 'console approved' }),
      })
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : '승인 실패')
    } finally {
      setIsBusy(false)
    }
  }

  async function onReject() {
    if (!id) return
    setIsBusy(true)
    try {
      await apiJson(`/api/short-ideas/${id}/reject`, {
        method: 'POST',
        body: JSON.stringify({
          reason: reviewForm.rejectionReason.trim() || '보완 필요',
          comment: reviewForm.rejectionComment.trim() || null,
        }),
      })
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : '리젝 실패')
    } finally {
      setIsBusy(false)
    }
  }

  async function onGenerateScript() {
    if (!id) return
    setIsBusy(true)
    try {
      await apiJson(`/api/short-ideas/${id}/generate-script`, {
        method: 'POST',
        idempotencyKey: `gen-script-${id}-${Date.now()}`,
        body: JSON.stringify({ duration_sec: Number(reviewForm.durationSec) || idea?.target_duration_sec || 30 }),
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : '대본 생성 실패')
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
          {idea ? <StatusBadge value={idea.status} /> : null}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={isBusy || !idea || idea.status !== 'awaiting_review'}
            onClick={onApprove}
            className="h-9 rounded-lg bg-white px-3 text-sm font-medium text-zinc-950 disabled:opacity-60"
          >
            승인
          </button>
          <button
            type="button"
            disabled={isBusy || !idea || idea.status !== 'awaiting_review'}
            onClick={onReject}
            className="h-9 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm text-zinc-200 disabled:opacity-60"
          >
            리젝
          </button>
          <button
            type="button"
            disabled={isBusy || !idea || idea.status !== 'approved'}
            onClick={onGenerateScript}
            className="h-9 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm text-zinc-200 disabled:opacity-60"
          >
            대본 생성
          </button>
        </div>
      </div>

      {isLoading ? <div className="text-sm text-zinc-500">로딩 중…</div> : null}
      {error ? <div className="text-sm text-rose-200">{error}</div> : null}

      {idea ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div className="md:col-span-2 flex flex-col gap-4">
            <div className="rounded-xl border border-zinc-900 bg-zinc-900/30 p-4">
              <div className="text-xs text-zinc-400">훅</div>
              <div className="mt-2 text-sm text-zinc-100">{idea.hook}</div>
              <div className="mt-4 text-xs text-zinc-400">앵글</div>
              <div className="mt-2 text-sm text-zinc-100">{idea.angle}</div>
              <div className="mt-4 text-xs text-zinc-400">CTA</div>
              <div className="mt-2 text-sm text-zinc-100">{idea.cta ?? '-'}</div>
              {idea.rejection_reason ? (
                <>
                  <div className="mt-4 text-xs text-zinc-400">리젝 사유</div>
                  <div className="mt-2 text-sm text-rose-200">{idea.rejection_reason}</div>
                </>
              ) : null}
            </div>

            <div className="rounded-xl border border-zinc-900 bg-zinc-900/30 p-4">
              <div className="text-xs text-zinc-400">검수 입력</div>
              <div className="mt-3 grid grid-cols-1 gap-3">
                <label className="flex flex-col gap-2">
                  <span className="text-xs text-zinc-400">승인 코멘트</span>
                  <textarea
                    className="min-h-20 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm"
                    value={reviewForm.approvalComment}
                    onChange={(e) => setReviewForm((current) => ({ ...current, approvalComment: e.target.value }))}
                    placeholder="예: 훅 강하고 리스크 낮아 승인"
                  />
                </label>

                <label className="flex flex-col gap-2">
                  <span className="text-xs text-zinc-400">리젝 사유</span>
                  <input
                    className="h-10 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm"
                    value={reviewForm.rejectionReason}
                    onChange={(e) => setReviewForm((current) => ({ ...current, rejectionReason: e.target.value }))}
                    placeholder="예: 메시지 훅 약함"
                  />
                </label>

                <label className="flex flex-col gap-2">
                  <span className="text-xs text-zinc-400">리젝 메모</span>
                  <textarea
                    className="min-h-20 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm"
                    value={reviewForm.rejectionComment}
                    onChange={(e) => setReviewForm((current) => ({ ...current, rejectionComment: e.target.value }))}
                    placeholder="예: 첫 3초를 더 공격적으로 수정 필요"
                  />
                </label>

                <label className="flex flex-col gap-2">
                  <span className="text-xs text-zinc-400">대본 길이(초)</span>
                  <input
                    type="number"
                    min={10}
                    max={120}
                    className="h-10 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm"
                    value={reviewForm.durationSec}
                    onChange={(e) => setReviewForm((current) => ({ ...current, durationSec: e.target.value }))}
                  />
                </label>
              </div>
            </div>

            <ActivityTimeline key={idea.id} targetType="short_idea" targetId={idea.id} />
          </div>

          <div className="rounded-xl border border-zinc-900 bg-zinc-900/30 p-4">
            <div className="text-xs text-zinc-400">메타</div>
            <div className="mt-2 flex flex-col gap-2 text-sm text-zinc-100">
              <div className="flex items-center justify-between">
                <span>duration</span>
                <span>{idea.target_duration_sec}s</span>
              </div>
              <div className="flex items-center justify-between">
                <span>risk_score</span>
                <span>{idea.risk_score ?? '-'}</span>
              </div>
              <div className="flex items-center justify-between">
                <span>source</span>
                <Link className="underline" to={`/source-items/${idea.source_item_id}`}>
                  열기
                </Link>
              </div>
              <div className="flex items-center justify-between">
                <span>scripts</span>
                <Link className="underline" to={`/scripts?short_idea_id=${idea.id}`}>
                  보기
                </Link>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
