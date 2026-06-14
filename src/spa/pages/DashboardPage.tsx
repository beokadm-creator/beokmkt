import { useCallback, useEffect, useState } from 'react'
import { ApiRequestError, apiJson } from '../lib/api'
import StatusBadge from '../components/StatusBadge'

type ByStatus = Record<string, number>
type ChannelStats = { published: number; queued: number; needs_human: number }
type ByChannel = Record<string, ChannelStats>

type NeedsHumanPost = {
  id: number | string
  topic: string
  title?: string
  channel: string
  status: string
  last_error: string | null
  published_url?: string | null
  action?: string | null
  can_requeue?: boolean
  reason?: string | null
  quality?: {
    chars: number
    images: number
    headings: number
    grounding_ratio: number | null
  }
  updated_at: string
}

type RecentPost = {
  id: number | string
  topic: string
  channel: string
  status: string
  published_url: string | null
  updated_at: string
}

type PipelinePostDetail = {
  id: number | string
  cloud_id?: string
  channel: string
  status: string
  title: string
  topic?: string
  meta_desc?: string
  tags?: string[]
  published_url?: string | null
  last_error?: string | null
  action?: string | null
  can_requeue?: boolean
  requeue_block_reason?: string | null
  body_available?: boolean
  body?: string
  preview_html?: string
  quality?: {
    chars: number
    images: number
    headings: number
    grounding_ratio: number | null
  }
  updated_at?: string
}

type PipelineStats = {
  error?: string
  by_status: ByStatus
  by_channel: ByChannel
  published_today: number
  published_this_week: number
  public_quality?: {
    checked: number
    ok: number
    failed: number
    items: {
      id: number | string
      channel: string
      title: string
      url: string
      status: number | null
      chars: number
      images: number
      h1: number
      h2: number
      issues: string[]
    }[]
  }
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

function formatDate(value?: string | null) {
  if (!value) return '시각 없음'
  const normalized = /(?:Z|[+-]\d\d:?\d\d)$/.test(value) ? value : `${value}Z`
  const date = new Date(normalized)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('ko-KR')
}

function KpiCard({ label, value, sub, alert }: { label: string; value: number; sub?: string; alert?: boolean }) {
  return (
    <div className={['rounded-xl border p-4', alert && value > 0 ? 'border-rose-800 bg-rose-950/20' : 'border-zinc-900 bg-zinc-900/30'].join(' ')}>
      <div className="text-xs text-zinc-400">{label}</div>
      <div className={['mt-2 text-2xl font-semibold tabular-nums', alert && value > 0 ? 'text-rose-300' : ''].join(' ')}>{value}</div>
      {sub ? <div className="mt-1 text-xs text-zinc-500">{sub}</div> : null}
    </div>
  )
}

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof ApiRequestError) {
    const details = error.details && typeof error.details === 'object' && 'reason' in error.details
      ? String((error.details as { reason?: unknown }).reason)
      : ''
    return details || error.message || fallback
  }
  return error instanceof Error ? error.message : fallback
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

function LocalOpsPanel({ active }: { active: boolean }) {
  const commands = [
    { label: '대상 확인', command: 'cd blog_publisher && python3 run.py needs_human' },
    { label: '공개 품질 검증', command: 'cd blog_publisher && python3 run.py verify_public 20' },
    { label: '멈춘 작업 복구', command: 'cd blog_publisher && python3 run.py recover' },
    { label: '발행 워커 1회', command: 'cd blog_publisher && python3 run.py publish' },
    { label: 'DB 백업', command: 'cd blog_publisher && python3 run.py backup' },
  ]

  return (
    <div className={['rounded-xl border p-4', active ? 'border-amber-900/60 bg-amber-950/15' : 'border-zinc-900 bg-zinc-900/30'].join(' ')}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold">로컬 큐 조치</div>
          <div className="mt-1 text-xs text-zinc-500">클라우드 대시보드는 상태 확인용입니다. SQLite 큐 변경은 맥의 로컬 파이프라인에서 처리합니다.</div>
        </div>
        <span className={['rounded-md border px-2 py-1 text-xs', active ? 'border-amber-800 text-amber-200' : 'border-zinc-800 text-zinc-400'].join(' ')}>
          {active ? '조치 필요' : '대기'}
        </span>
      </div>
      <div className="mt-3 grid gap-2 md:grid-cols-2">
        {commands.map((item) => (
          <div key={item.label} className="rounded-lg border border-zinc-800 bg-zinc-950/70 p-3">
            <div className="text-xs font-medium text-zinc-400">{item.label}</div>
            <code className="mt-2 block overflow-x-auto whitespace-nowrap text-xs text-zinc-200">{item.command}</code>
          </div>
        ))}
      </div>
    </div>
  )
}

function PublicQualityPanel({ data }: { data?: PipelineStats['public_quality'] }) {
  if (!data) return null
  const failed = data.failed > 0
  return (
    <div className={['rounded-xl border p-4', failed ? 'border-rose-900/60 bg-rose-950/15' : 'border-emerald-900/50 bg-emerald-950/10'].join(' ')}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className={['text-sm font-semibold', failed ? 'text-rose-200' : 'text-emerald-200'].join(' ')}>
            공개 URL 품질 검증
          </div>
          <div className="mt-1 text-xs text-zinc-500">
            최근 공개 URL을 실제 HTML로 다시 읽어 URL 생성과 산출물 품질을 분리 확인합니다.
          </div>
        </div>
        <span className={['rounded-md border px-2 py-1 text-xs tabular-nums', failed ? 'border-rose-800 text-rose-200' : 'border-emerald-800 text-emerald-200'].join(' ')}>
          {data.ok}/{data.checked} 통과
        </span>
      </div>
      {data.items.length > 0 ? (
        <div className="mt-3 grid gap-2">
          {data.items.map((item) => (
            <a
              key={`${item.channel}-${item.id}-${item.url}`}
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-lg border border-zinc-800 bg-zinc-950/70 p-3 hover:bg-zinc-900"
            >
              <div className="flex items-center gap-2 text-xs">
                <span className="font-mono text-zinc-500">#{item.id}</span>
                <StatusBadge value={item.channel} />
                <span className="text-zinc-500">HTTP {item.status ?? 'error'}</span>
                <span className="text-zinc-500">본문 {item.chars.toLocaleString('ko-KR')}자</span>
                <span className="text-zinc-500">이미지 {item.images}</span>
              </div>
              <div className="mt-2 truncate text-sm text-zinc-200">{item.title || item.url}</div>
              <div className="mt-2 flex flex-wrap gap-1">
                {item.issues.map((issue) => (
                  <span key={issue} className="rounded-md border border-rose-900/50 bg-rose-950/20 px-2 py-0.5 text-[11px] text-rose-200">
                    {issue}
                  </span>
                ))}
              </div>
            </a>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function DetailPanel({
  detail,
  loading,
  error,
  requeueing,
  onClose,
  onRequeue,
}: {
  detail: PipelinePostDetail | null
  loading: boolean
  error: string | null
  requeueing: boolean
  onClose: () => void
  onRequeue: () => void
}) {
  if (!detail && !loading && !error) return null

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950/70">
      <div className="flex items-start justify-between gap-4 border-b border-zinc-900 px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs text-zinc-500">#{detail?.id ?? '...'}</span>
            {detail ? <StatusBadge value={detail.channel} /> : null}
            {detail ? <StatusBadge value={detail.status} /> : null}
          </div>
          <div className="mt-2 truncate text-sm font-semibold text-zinc-100">
            {loading ? '불러오는 중...' : detail?.title || '상세 없음'}
          </div>
        </div>
        <button type="button" onClick={onClose} className="rounded-md border border-zinc-800 px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-900">
          닫기
        </button>
      </div>

      {error ? <div className="m-4 rounded-lg border border-rose-900/50 bg-rose-950/20 px-3 py-2 text-sm text-rose-300">{error}</div> : null}

      {detail ? (
        <div className="grid gap-4 p-4 lg:grid-cols-[320px_1fr]">
          <div className="space-y-3">
            <div className="rounded-lg border border-zinc-900 bg-zinc-950 p-3">
              <div className="text-xs font-medium text-zinc-500">운영 조치</div>
              <div className="mt-2 text-sm text-zinc-200">{detail.action || '원인 확인'}</div>
              {detail.last_error ? <div className="mt-2 break-words text-xs text-rose-300">{detail.last_error}</div> : null}
              {detail.requeue_block_reason ? (
                <div className="mt-2 rounded-md border border-amber-900/40 bg-amber-950/20 px-2 py-1 text-xs text-amber-200">
                  {detail.requeue_block_reason}
                </div>
              ) : null}
              <button
                type="button"
                disabled={!detail.can_requeue || requeueing}
                onClick={onRequeue}
                className={[
                  'mt-3 h-8 w-full rounded-lg border px-3 text-xs',
                  detail.can_requeue
                    ? 'border-emerald-800 bg-emerald-950/30 text-emerald-200 hover:bg-emerald-900/30'
                    : 'cursor-not-allowed border-zinc-800 bg-zinc-900/40 text-zinc-600',
                ].join(' ')}
              >
                {requeueing ? '큐 등록 중...' : '재시도 큐 등록'}
              </button>
            </div>

            <div className="rounded-lg border border-zinc-900 bg-zinc-950 p-3">
              <div className="text-xs font-medium text-zinc-500">품질 신호</div>
              <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                <div className="rounded-md border border-zinc-900 bg-zinc-900/50 p-2">
                  <div className="text-base font-semibold tabular-nums">{detail.quality?.chars ?? 0}</div>
                  <div className="text-[11px] text-zinc-500">문자</div>
                </div>
                <div className="rounded-md border border-zinc-900 bg-zinc-900/50 p-2">
                  <div className="text-base font-semibold tabular-nums">{detail.quality?.images ?? 0}</div>
                  <div className="text-[11px] text-zinc-500">이미지</div>
                </div>
                <div className="rounded-md border border-zinc-900 bg-zinc-900/50 p-2">
                  <div className="text-base font-semibold tabular-nums">{detail.quality?.headings ?? 0}</div>
                  <div className="text-[11px] text-zinc-500">소제목</div>
                </div>
              </div>
            </div>

            {detail.published_url ? (
              <a href={detail.published_url} target="_blank" rel="noopener noreferrer" className="block rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-center text-xs text-zinc-200 hover:bg-zinc-800">
                공개 글 열기 ↗
              </a>
            ) : null}
          </div>

          <div className="min-w-0 rounded-lg border border-zinc-900 bg-white p-5 text-zinc-950">
            {detail.preview_html ? (
              <article
                className="prose prose-zinc max-w-none text-sm"
                dangerouslySetInnerHTML={{ __html: detail.preview_html }}
              />
            ) : (
              <div className="text-sm text-zinc-500">
                이 상세 정보에는 본문 미리보기가 없습니다. 클라우드 외부 발행 로그는 로컬 SQLite 본문을 포함하지 않습니다.
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}

export default function DashboardPage() {
  const [data, setData] = useState<PipelineStats | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [detail, setDetail] = useState<PipelinePostDetail | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [requeueing, setRequeueing] = useState(false)

  const fetchStats = useCallback(async () => {
    try {
      const d = await apiJson<PipelineStats>('/api/pipeline/stats')
      setData(d)
      setLastUpdated(new Date())
      if (d.error) setError(`DB 오류: ${d.error}`)
      else setError(null)
    } catch (e) {
      setError(errorMessage(e, '불러오기 실패'))
    }
  }, [])

  const openDetail = useCallback(async (id: number | string) => {
    setDetailLoading(true)
    setDetailError(null)
    try {
      const next = await apiJson<PipelinePostDetail>(`/api/pipeline/posts/${encodeURIComponent(String(id))}`)
      setDetail(next)
    } catch (e) {
      setDetail(null)
      setDetailError(errorMessage(e, '상세 불러오기 실패'))
    } finally {
      setDetailLoading(false)
    }
  }, [])

  const requeueSelected = useCallback(async () => {
    if (!detail) return
    setRequeueing(true)
    setDetailError(null)
    try {
      await apiJson(`/api/pipeline/posts/${encodeURIComponent(String(detail.id))}/requeue`, { method: 'POST' })
      await fetchStats()
      await openDetail(detail.id)
    } catch (e) {
      setDetailError(errorMessage(e, '재큐잉 실패'))
    } finally {
      setRequeueing(false)
    }
  }, [detail, fetchStats, openDetail])

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
          alert={totalFailures > 0}
        />
      </div>

      {/* 파이프라인 퍼널 */}
      <div className="rounded-xl border border-zinc-900 bg-zinc-900/30 p-4">
        <div className="mb-3 text-sm font-semibold">파이프라인 상태</div>
        {data ? <StageBar by_status={data.by_status} /> : <div className="text-sm text-zinc-500">로딩 중…</div>}
      </div>

      <LocalOpsPanel active={totalFailures > 0} />

      <PublicQualityPanel data={data?.public_quality} />

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
            <KpiCard label="짧은 글" value={data.quality.weak_posts} sub="1,800자 미만" alert={data.quality.weak_posts > 0} />
            <KpiCard label="평균 grounding" value={Math.round((data.quality.avg_grounding ?? 0) * 100)} sub={data.quality.avg_grounding == null ? '미측정' : '백분율'} alert={data.quality.avg_grounding != null && data.quality.avg_grounding < 0.9} />
          </div>
        </div>
      ) : null}

      <DetailPanel
        detail={detail}
        loading={detailLoading}
        error={detailError}
        requeueing={requeueing}
        onClose={() => {
          setDetail(null)
          setDetailError(null)
        }}
        onRequeue={requeueSelected}
      />

      {/* 채널별 현황 */}
      <div className="rounded-xl border border-zinc-900 bg-zinc-900/30 p-4">
        <div className="mb-3 text-sm font-semibold">채널별 현황</div>
        {data ? <ChannelTable by_channel={data.by_channel} /> : <div className="text-sm text-zinc-500">로딩 중…</div>}
      </div>

      {/* 수동 처리 필요 */}
      {data && data.needs_human_posts.length > 0 ? (
        <div className="rounded-xl border border-rose-900/50 bg-zinc-900/30 p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-rose-300">수동 처리 필요 ({data.needs_human_posts.length})</div>
              <div className="mt-1 text-xs text-zinc-500">자동 재시도 금지 사유와 공개 글 확인 대상을 먼저 분리합니다.</div>
            </div>
            <span className="rounded-md border border-zinc-800 px-2 py-1 text-xs text-zinc-400">
              재시도 가능 {data.needs_human_posts.filter((post) => post.can_requeue).length}
            </span>
          </div>
          <div className="flex flex-col gap-2">
            {data.needs_human_posts.map((post) => (
              <div key={post.id} className="flex items-start gap-3 rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-mono text-zinc-500">#{post.id}</span>
                    <StatusBadge value={post.channel} />
                    <StatusBadge value={post.status} />
                    <span
                      className={[
                        'rounded-md border px-2 py-0.5 text-[11px]',
                        post.can_requeue
                          ? 'border-emerald-900/60 bg-emerald-950/30 text-emerald-200'
                          : 'border-amber-900/60 bg-amber-950/30 text-amber-200',
                      ].join(' ')}
                    >
                      {post.can_requeue ? '재시도 가능' : '자동 차단'}
                    </span>
                  </div>
                  <div className="mt-1 truncate text-sm text-zinc-200">{post.topic}</div>
                  {post.last_error ? (
                    <div className="mt-1 truncate text-xs text-rose-400">{post.last_error}</div>
                  ) : null}
                  {!post.can_requeue && post.reason ? (
                    <div className="mt-2 inline-flex rounded-md border border-zinc-800 bg-zinc-900/60 px-2 py-1 text-xs text-zinc-300">
                      차단 사유: {post.reason}
                    </div>
                  ) : null}
                  {post.action ? (
                    <div className="mt-2 ml-0 inline-flex rounded-md border border-amber-900/40 bg-amber-950/20 px-2 py-1 text-xs text-amber-200">
                      다음 조치: {post.action}
                    </div>
                  ) : null}
                  <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-zinc-500">
                    <span>{formatDate(post.updated_at)}</span>
                    {post.quality ? (
                      <>
                        <span>본문 {post.quality.chars.toLocaleString('ko-KR')}자</span>
                        <span>이미지 {post.quality.images}</span>
                        <span>소제목 {post.quality.headings}</span>
                      </>
                    ) : null}
                  </div>
                </div>
                <div className="flex shrink-0 flex-col gap-2 self-center">
                  <button
                    type="button"
                    onClick={() => openDetail(post.id)}
                    className="rounded-md border border-zinc-800 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
                  >
                    원인 보기
                  </button>
                  {post.published_url ? (
                    <a
                      href={post.published_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="rounded-md border border-zinc-800 px-2 py-1 text-center text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                    >
                      공개 글
                    </a>
                  ) : null}
                </div>
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
                  {formatDate(post.updated_at)}
                </div>
              </div>
              <StatusBadge value={post.channel} />
              <StatusBadge value={post.status} />
              <button
                type="button"
                onClick={() => openDetail(post.id)}
                className="shrink-0 text-xs text-zinc-400 hover:text-zinc-200"
              >
                상세
              </button>
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
