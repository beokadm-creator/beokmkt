import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { apiJson } from '../lib/api'
import StatusBadge from '../components/StatusBadge'

type ByStatus = Record<string, number>
type ChannelStats = { published: number; queued: number; needs_human: number }
type ByChannel = Record<string, ChannelStats>

type NeedsHumanPost = {
  id: number
  topic: string
  channel: string
  last_error: string | null
  action?: string | null
  updated_at: string
}

type RecentPost = {
  id: number
  topic: string
  channel: string
  status: string
  published_url: string | null
  updated_at: string
}

type PipelineStats = {
  error?: string
  by_status: ByStatus
  by_channel: ByChannel
  published_today: number
  published_this_week: number
  quality?: {
    measured_posts: number
    avg_chars: number
    with_images: number
    weak_posts: number
    avg_grounding: number | null
  }
  needs_human_posts: NeedsHumanPost[]
  recent: RecentPost[]
}

const PIPELINE_STAGES: { key: string; label: string }[] = [
  { key: 'draft', label: '초안' },
  { key: 'generating', label: '생성중' },
  { key: 'factchecking', label: '팩트체크' },
  { key: 'reviewing', label: '검토중' },
  { key: 'reviewed', label: '검토완료' },
  { key: 'queued', label: '발행예약' },
  { key: 'publishing', label: '발행중' },
  { key: 'published', label: '발행됨' },
]

const CHANNELS: { key: string; label: string }[] = [
  { key: 'naver', label: 'Naver' },
  { key: 'tistory', label: 'Tistory' },
  { key: 'selfhosted', label: '자체 블로그' },
]

function KpiCard({ label, value, sub, alert }: { label: string; value: number; sub?: string; alert?: boolean }) {
  return (
    <div className={['rounded-xl border p-4', alert && value > 0 ? 'border-rose-800 bg-rose-950/20' : 'border-zinc-900 bg-zinc-900/30'].join(' ')}>
      <div className="text-xs text-zinc-400">{label}</div>
      <div className={['mt-2 text-2xl font-semibold tabular-nums', alert && value > 0 ? 'text-rose-300' : ''].join(' ')}>{value}</div>
      {sub ? <div className="mt-1 text-xs text-zinc-500">{sub}</div> : null}
    </div>
  )
}

function StageBar({ by_status }: { by_status: ByStatus }) {
  const total = Object.values(by_status).reduce((a, b) => a + b, 0)
  if (total === 0) return <div className="text-sm text-zinc-500">데이터 없음</div>

  return (
    <div className="flex flex-wrap gap-2">
      {PIPELINE_STAGES.map(({ key, label }) => {
        const n = by_status[key] ?? 0
        const active = n > 0
        return (
          <div
            key={key}
            className={[
              'flex flex-col items-center rounded-lg border px-3 py-2 min-w-[72px]',
              active ? 'border-zinc-700 bg-zinc-900/60' : 'border-zinc-900 bg-zinc-950/40 opacity-50',
            ].join(' ')}
          >
            <span className={['text-lg font-semibold tabular-nums', active ? 'text-zinc-100' : 'text-zinc-500'].join(' ')}>{n}</span>
            <span className="mt-0.5 text-xs text-zinc-400">{label}</span>
          </div>
        )
      })}

      {/* 격리 상태 */}
      {(['needs_human', 'failed'] as const).map((key) => {
        const n = by_status[key] ?? 0
        return (
          <div
            key={key}
            className={[
              'flex flex-col items-center rounded-lg border px-3 py-2 min-w-[72px]',
              n > 0 ? 'border-rose-800 bg-rose-950/20' : 'border-zinc-900 bg-zinc-950/40 opacity-40',
            ].join(' ')}
          >
            <span className={['text-lg font-semibold tabular-nums', n > 0 ? 'text-rose-300' : 'text-zinc-500'].join(' ')}>{n}</span>
            <span className={['mt-0.5 text-xs', n > 0 ? 'text-rose-400' : 'text-zinc-500'].join(' ')}>
              {key === 'needs_human' ? '수동처리' : '실패'}
            </span>
          </div>
        )
      })}
    </div>
  )
}

function ChannelTable({ by_channel }: { by_channel: ByChannel }) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-zinc-800 text-left">
          <th className="pb-2 text-xs font-medium text-zinc-400">채널</th>
          <th className="pb-2 text-xs font-medium text-zinc-400 text-right">발행됨</th>
          <th className="pb-2 text-xs font-medium text-zinc-400 text-right">예약</th>
          <th className="pb-2 text-xs font-medium text-zinc-400 text-right">수동처리</th>
        </tr>
      </thead>
      <tbody>
        {CHANNELS.map(({ key, label }) => {
          const ch = by_channel[key] ?? { published: 0, queued: 0, needs_human: 0 }
          return (
            <tr key={key} className="border-b border-zinc-900/60">
              <td className="py-2 text-zinc-200">{label}</td>
              <td className="py-2 text-right tabular-nums text-emerald-300">{ch.published}</td>
              <td className="py-2 text-right tabular-nums text-amber-300">{ch.queued}</td>
              <td className={['py-2 text-right tabular-nums', ch.needs_human > 0 ? 'text-rose-300 font-medium' : 'text-zinc-500'].join(' ')}>
                {ch.needs_human}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

export default function DashboardPage() {
  const [data, setData] = useState<PipelineStats | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)

  const fetchStats = useCallback(async () => {
    try {
      const d = await apiJson<PipelineStats>('/api/pipeline/stats')
      setData(d)
      setLastUpdated(new Date())
      if (d.error) setError(`DB 오류: ${d.error}`)
      else setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : '불러오기 실패')
    }
  }, [])

  useEffect(() => {
    fetchStats()
    const timer = setInterval(fetchStats, 30_000)
    return () => clearInterval(timer)
  }, [fetchStats])

  const totalFailures = (data?.by_status?.needs_human ?? 0) + (data?.by_status?.failed ?? 0)

  return (
    <div className="flex flex-col gap-5">
      {/* 헤더 */}
      <div className="flex items-center justify-between">
        <div>
          <div className="text-base font-semibold">파이프라인 모니터링</div>
          <div className="text-xs text-zinc-500">
            {lastUpdated ? `마지막 갱신: ${lastUpdated.toLocaleTimeString('ko-KR')}` : '로딩 중…'}
            {' · '}30초 자동 갱신
          </div>
        </div>
        <button
          type="button"
          onClick={fetchStats}
          className="h-8 rounded-lg border border-zinc-800 bg-zinc-900 px-3 text-xs text-zinc-300 hover:bg-zinc-800"
        >
          새로고침
        </button>
      </div>

      {error ? (
        <div className="rounded-lg border border-rose-900/50 bg-rose-950/20 px-4 py-3 text-sm text-rose-300">{error}</div>
      ) : null}

      {/* KPI 카드 */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard
          label="전체 글"
          value={data ? Object.values(data.by_status).reduce((a, b) => a + b, 0) : 0}
          sub="파이프라인 전체"
        />
        <KpiCard
          label="오늘 발행"
          value={data?.published_today ?? 0}
          sub="KST 자정 기준"
        />
        <KpiCard
          label="이번 주 발행"
          value={data?.published_this_week ?? 0}
          sub="최근 7일"
        />
        <KpiCard
          label="수동 처리 필요"
          value={totalFailures}
          sub={totalFailures > 0 ? '즉시 확인 필요' : '이상 없음'}
          alert
        />
      </div>

      {/* 파이프라인 퍼널 */}
      <div className="rounded-xl border border-zinc-900 bg-zinc-900/30 p-4">
        <div className="mb-3 text-sm font-semibold">파이프라인 상태</div>
        {data ? <StageBar by_status={data.by_status} /> : <div className="text-sm text-zinc-500">로딩 중…</div>}
      </div>

      {/* 품질 지표 */}
      {data?.quality ? (
        <div className="rounded-xl border border-zinc-900 bg-zinc-900/30 p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-semibold">품질 지표</div>
              <div className="mt-1 text-xs text-zinc-500">발행·검토·예약 글 기준. 실제 산출물 확인용 신호입니다.</div>
            </div>
            <span className="rounded-md border border-zinc-800 px-2 py-1 text-xs text-zinc-400">
              측정 {data.quality.measured_posts}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <KpiCard label="평균 본문 길이" value={data.quality.avg_chars} sub="문자 수" alert={data.quality.avg_chars > 0 && data.quality.avg_chars < 1800} />
            <KpiCard label="이미지 포함" value={data.quality.with_images} sub="시각 요소 있는 글" />
            <KpiCard label="짧은 글" value={data.quality.weak_posts} sub="1,800자 미만" alert />
            <KpiCard label="평균 grounding" value={Math.round((data.quality.avg_grounding ?? 0) * 100)} sub={data.quality.avg_grounding == null ? '미측정' : '백분율'} alert={data.quality.avg_grounding != null && data.quality.avg_grounding < 0.9} />
          </div>
        </div>
      ) : null}

      {/* 채널별 현황 */}
      <div className="rounded-xl border border-zinc-900 bg-zinc-900/30 p-4">
        <div className="mb-3 text-sm font-semibold">채널별 현황</div>
        {data ? <ChannelTable by_channel={data.by_channel} /> : <div className="text-sm text-zinc-500">로딩 중…</div>}
      </div>

      {/* 수동 처리 필요 */}
      {data && data.needs_human_posts.length > 0 ? (
        <div className="rounded-xl border border-rose-900/50 bg-zinc-900/30 p-4">
          <div className="mb-3 text-sm font-semibold text-rose-300">수동 처리 필요 ({data.needs_human_posts.length})</div>
          <div className="flex flex-col gap-2">
            {data.needs_human_posts.map((post) => (
              <div key={post.id} className="flex items-start gap-3 rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-mono text-zinc-500">#{post.id}</span>
                    <StatusBadge value={post.channel} />
                  </div>
                  <div className="mt-1 truncate text-sm text-zinc-200">{post.topic}</div>
                  {post.last_error ? (
                    <div className="mt-1 truncate text-xs text-rose-400">{post.last_error}</div>
                  ) : null}
                  {post.action ? (
                    <div className="mt-2 inline-flex rounded-md border border-amber-900/40 bg-amber-950/20 px-2 py-1 text-xs text-amber-200">
                      다음 조치: {post.action}
                    </div>
                  ) : null}
                  <div className="mt-1 text-xs text-zinc-600">
                    {new Date(post.updated_at + 'Z').toLocaleString('ko-KR')}
                  </div>
                </div>
                <Link
                  to={`/blog-posts?pipeline_id=${post.id}`}
                  className="shrink-0 self-center text-xs text-zinc-400 hover:text-zinc-200"
                >
                  글 목록 →
                </Link>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {/* 최근 업데이트 */}
      {data && data.recent.length > 0 ? (
        <div className="rounded-xl border border-zinc-900 bg-zinc-900/30">
          <div className="border-b border-zinc-900 px-4 py-3 text-sm font-semibold">최근 업데이트</div>
          {data.recent.map((post) => (
            <div key={post.id} className="flex items-center gap-3 border-b border-zinc-900/60 px-4 py-3">
              <span className="text-xs font-mono text-zinc-600 w-8 shrink-0">#{post.id}</span>
              <div className="flex-1 min-w-0">
                <div className="truncate text-sm text-zinc-200">{post.topic || '(제목 없음)'}</div>
                <div className="mt-0.5 text-xs text-zinc-500">
                  {new Date(post.updated_at + 'Z').toLocaleString('ko-KR')}
                </div>
              </div>
              <StatusBadge value={post.channel} />
              <StatusBadge value={post.status} />
              {post.published_url ? (
                <a
                  href={post.published_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="shrink-0 text-xs text-zinc-400 hover:text-zinc-200"
                >
                  링크 ↗
                </a>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
