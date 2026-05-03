import { useEffect, useMemo, useState } from 'react'
import { apiJson } from '../lib/api'

type AuditLog = {
  id: string
  actor_type: string
  action: string
  target_type: string
  target_id: string
  created_at: unknown
}

type AuditLogResponse = {
  items: AuditLog[]
  total: number
  limit: number
  offset: number
}

function formatDateTime(value: unknown) {
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value)
    if (!Number.isNaN(date.getTime())) return date.toLocaleString()
  }

  if (value && typeof value === 'object') {
    const maybeTimestamp = value as { seconds?: number; _seconds?: number }
    const seconds = maybeTimestamp.seconds ?? maybeTimestamp._seconds
    if (typeof seconds === 'number') return new Date(seconds * 1000).toLocaleString()
  }

  return '-'
}

function describeAction(action: string) {
  const mapped: Record<string, string> = {
    'render_job.created': '렌더 작업 생성',
    'render_job.retry': '렌더 재시도',
    'render_job.approved_for_publish': '게시 승인',
    'publish_job.created': '업로드 작업 생성',
    'publish_job.approved': '업로드 승인',
    'publish_job.retry': '업로드 재시도',
    'publish_job.cancelled': '업로드 취소',
    'script.approved': '대본 승인',
    'script.revision_requested': '대본 수정 요청',
  }

  return mapped[action] ?? action
}

export default function ActivityTimeline(props: { targetType: string; targetId: string; title?: string }) {
  const { targetType, targetId, title = '최근 이력' } = props
  const [data, setData] = useState<AuditLogResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  const queryString = useMemo(() => {
    const sp = new URLSearchParams()
    sp.set('limit', '8')
    sp.set('offset', '0')
    sp.set('target_type', targetType)
    sp.set('target_id', targetId)
    return sp.toString()
  }, [targetId, targetType])

  useEffect(() => {
    if (!targetId) return

    apiJson<AuditLogResponse>(`/api/audit-logs?${queryString}`)
      .then((next) => {
        setData(next)
        setError(null)
      })
      .catch((nextError) => setError(nextError instanceof Error ? nextError.message : '이력 불러오기 실패'))
      .finally(() => setIsLoading(false))
  }, [queryString, targetId])

  return (
    <div className="rounded-xl border border-zinc-900 bg-zinc-900/30 p-4">
      <div className="flex items-center justify-between">
        <div className="text-xs text-zinc-400">{title}</div>
        <div className="text-xs text-zinc-500">{isLoading ? '로딩 중…' : data ? `${data.total}건` : null}</div>
      </div>

      {error ? <div className="mt-3 text-sm text-rose-200">{error}</div> : null}

      <div className="mt-3 flex flex-col gap-3">
        {data?.items.map((item) => (
          <div key={item.id} className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm text-zinc-100">{describeAction(item.action)}</div>
              <div className="text-xs text-zinc-500">{formatDateTime(item.created_at)}</div>
            </div>
            <div className="mt-1 text-xs text-zinc-500">
              actor: {item.actor_type} · target: {item.target_type}
            </div>
          </div>
        ))}

        {!isLoading && !data?.items.length ? <div className="text-sm text-zinc-500">표시할 이력이 없습니다.</div> : null}
      </div>
    </div>
  )
}
