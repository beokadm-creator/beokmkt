import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
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
        body: JSON.stringify({ comment: 'approved via console', fact_check_status: 'passed' }),
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
        body: JSON.stringify({ reason: 'revision requested via console', instructions: '첫 3초 훅 강화' }),
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
          <div className="md:col-span-2 rounded-xl border border-zinc-900 bg-zinc-900/30 p-4">
            <div className="text-xs text-zinc-400">대본</div>
            <pre className="mt-2 whitespace-pre-wrap text-sm text-zinc-100">{script.script_text}</pre>
            <div className="mt-4 text-xs text-zinc-400">자막</div>
            <pre className="mt-2 whitespace-pre-wrap text-sm text-zinc-100">{script.subtitle_text}</pre>
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
          </div>
        </div>
      ) : null}
    </div>
  )
}
