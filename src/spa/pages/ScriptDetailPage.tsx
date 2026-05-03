import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import ActivityTimeline from '../components/ActivityTimeline'
import StatusBadge from '../components/StatusBadge'
import { apiJson } from '../lib/api'

type Script = {
  id: string
  short_idea_id: string
  version: number
  duration_sec: number
  script_text: string
  subtitle_text: string
  status: string
  fact_check_status: string
  revision_reason?: string | null
  created_at: string
}

export default function ScriptDetailPage() {
  const params = useParams()
  const id = params.id ?? ''
  const navigate = useNavigate()

  const [script, setScript] = useState<Script | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isBusy, setIsBusy] = useState(false)
  const [reviewForm, setReviewForm] = useState({
    approvalComment: '',
    factCheckStatus: 'passed',
    revisionReason: '',
    revisionInstructions: '',
    revisionComment: '',
  })

  const title = useMemo(() => (script ? `대본 v${script.version}` : '대본'), [script])

  const refresh = useCallback(async () => {
    if (!id) return
    const d = await apiJson<Script>(`/api/scripts/${id}`)
    setScript(d)
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
      await apiJson(`/api/scripts/${id}/approve`, {
        method: 'POST',
        body: JSON.stringify({
          comment: reviewForm.approvalComment.trim() || 'console approved',
          fact_check_status: reviewForm.factCheckStatus,
        }),
      })
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : '승인 실패')
    } finally {
      setIsBusy(false)
    }
  }

  async function onRequestRevision() {
    if (!id) return
    setIsBusy(true)
    try {
      await apiJson(`/api/scripts/${id}/request-revision`, {
        method: 'POST',
        idempotencyKey: `revise-${id}-${Date.now()}`,
        body: JSON.stringify({
          reason: reviewForm.revisionReason.trim() || '수정 필요',
          instructions: reviewForm.revisionInstructions.trim() || '첫 3초 훅 강화',
          comment: reviewForm.revisionComment.trim() || null,
        }),
      })
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : '수정 요청 실패')
    } finally {
      setIsBusy(false)
    }
  }

  async function onCreateRenderJob() {
    if (!script) return
    setIsBusy(true)
    try {
      const created = await apiJson<{ id: string }>(`/api/render-jobs`, {
        method: 'POST',
        idempotencyKey: `render-from-script-${script.id}-${script.version}`,
        body: JSON.stringify({ script_id: script.id }),
      })
      navigate(`/render-jobs/${created.id}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : '렌더 작업 생성 실패')
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
          {script ? <StatusBadge value={script.status} /> : null}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={isBusy || !script || script.status !== 'awaiting_review'}
            onClick={onApprove}
            className="h-9 rounded-lg bg-white px-3 text-sm font-medium text-zinc-950 disabled:opacity-60"
          >
            승인
          </button>
          <button
            type="button"
            disabled={isBusy || !script || script.status !== 'awaiting_review'}
            onClick={onRequestRevision}
            className="h-9 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm text-zinc-200 disabled:opacity-60"
          >
            수정 요청
          </button>
          <button
            type="button"
            disabled={isBusy || !script || script.status !== 'approved'}
            onClick={onCreateRenderJob}
            className="h-9 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm text-zinc-200 disabled:opacity-60"
          >
            렌더 작업 생성
          </button>
        </div>
      </div>

      {isLoading ? <div className="text-sm text-zinc-500">로딩 중…</div> : null}
      {error ? <div className="text-sm text-rose-200">{error}</div> : null}

      {script ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div className="md:col-span-2 flex flex-col gap-4">
            <div className="rounded-xl border border-zinc-900 bg-zinc-900/30 p-4">
              <div className="text-xs text-zinc-400">대본</div>
              <pre className="mt-2 whitespace-pre-wrap text-sm text-zinc-100">{script.script_text}</pre>
              <div className="mt-4 text-xs text-zinc-400">자막</div>
              <pre className="mt-2 whitespace-pre-wrap text-sm text-zinc-100">{script.subtitle_text}</pre>
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
                    placeholder="예: 사실 검수 완료, 렌더 진행 가능"
                  />
                </label>

                <label className="flex flex-col gap-2">
                  <span className="text-xs text-zinc-400">팩트체크 상태</span>
                  <select
                    className="h-10 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm"
                    value={reviewForm.factCheckStatus}
                    onChange={(e) => setReviewForm((current) => ({ ...current, factCheckStatus: e.target.value }))}
                  >
                    <option value="passed">passed</option>
                    <option value="pending">pending</option>
                    <option value="needs_review">needs_review</option>
                  </select>
                </label>

                <label className="flex flex-col gap-2">
                  <span className="text-xs text-zinc-400">수정 사유</span>
                  <input
                    className="h-10 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm"
                    value={reviewForm.revisionReason}
                    onChange={(e) => setReviewForm((current) => ({ ...current, revisionReason: e.target.value }))}
                    placeholder="예: 구조는 좋지만 오프닝 임팩트 부족"
                  />
                </label>

                <label className="flex flex-col gap-2">
                  <span className="text-xs text-zinc-400">수정 지시</span>
                  <textarea
                    className="min-h-20 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm"
                    value={reviewForm.revisionInstructions}
                    onChange={(e) => setReviewForm((current) => ({ ...current, revisionInstructions: e.target.value }))}
                    placeholder="예: 첫 문장을 질문형으로 바꾸고 CTA를 더 짧게 정리"
                  />
                </label>

                <label className="flex flex-col gap-2">
                  <span className="text-xs text-zinc-400">검수 메모</span>
                  <textarea
                    className="min-h-20 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm"
                    value={reviewForm.revisionComment}
                    onChange={(e) => setReviewForm((current) => ({ ...current, revisionComment: e.target.value }))}
                    placeholder="예: 정보는 유지하되 템포를 더 빠르게"
                  />
                </label>
              </div>
            </div>

            <ActivityTimeline key={script.id} targetType="script" targetId={script.id} />
          </div>
          <div className="rounded-xl border border-zinc-900 bg-zinc-900/30 p-4">
            <div className="text-xs text-zinc-400">메타</div>
            <div className="mt-2 flex flex-col gap-2 text-sm text-zinc-100">
              <div className="flex items-center justify-between">
                <span>duration</span>
                <span>{script.duration_sec}s</span>
              </div>
              <div className="flex items-center justify-between">
                <span>fact_check</span>
                <span>{script.fact_check_status}</span>
              </div>
              <div className="flex items-center justify-between">
                <span>idea</span>
                <Link className="underline" to={`/short-ideas/${script.short_idea_id}`}>
                  열기
                </Link>
              </div>
            </div>
            {script.revision_reason ? (
              <>
                <div className="mt-4 text-xs text-zinc-400">현재 수정 지시</div>
                <div className="mt-2 text-sm text-zinc-300">{script.revision_reason}</div>
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}
