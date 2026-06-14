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
  external_doc_id?: string | null
  can_archive?: boolean
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

type QualityItem = {
  id: number | string
  topic: string
  title?: string
  channel: string
  status: string
  published_url?: string | null
  quality: {
    chars: number
    images: number
    headings: number
    grounding_ratio: number | null
  }
  issues: string[]
  action?: string | null
  body_available?: boolean
  body_excerpt?: string
  preview_html?: string
  preview_mode?: string
  preview_contract?: string[]
  updated_at: string
}

type OpsStats = {
  reviewed_target: number
  inventory_target?: number
  inventory?: number
  focus_name?: string
  focus_inventory?: number
  focus_inventory_by_channel?: Record<string, number>
  external_auto_seed_enabled?: boolean
  reviewed: number
  queued: number
  queued_due: number
  next_queued_at: string | null
  publishing: number
  stale: Record<string, number>
  stuck_threshold_min: number
  snapshot_source?: string
  snapshot_generated_at?: string | null
  snapshot_synced_at?: string | null
  snapshot_age_sec?: number | null
  snapshot_stale?: boolean
  quality_gate?: {
    min_grounding_ratio: number
    min_review_score: number
    enforced: boolean
    ok: boolean
  }
  search_health?: {
    provider: string | null
    general_search_ok: boolean
    naver_serp_ok: boolean
    ok: boolean
    reason: string | null
  }
  image_asset_health?: {
    ok: boolean
    beoksolution_public_images: number
    beok_conference_actual_images: number
    fallback_images: number
    reason: string | null
    action?: string | null
  }
  session_health?: {
    channel: string
    exists: boolean
    ok: boolean
    reason?: string | null
    action?: string | null
    error_post_id?: number | string | null
    path: string
    updated_at: string | null
    age_hours: number | null
    size: number
  }[]
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
  external_doc_id?: string | null
  can_archive?: boolean
  body_available?: boolean
  body?: string
  preview_html?: string
  preview_mode?: string
  preview_contract?: string[]
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
      cache_bust_ok?: boolean
      cache_bust_url?: string | null
      action?: string | null
    }[]
  }
  quality?: {
    measured_posts: number
    avg_chars: number
    with_images: number
    weak_posts: number
    avg_grounding: number | null
  }
  quality_items?: QualityItem[]
  ops?: OpsStats | null
  local_snapshot?: {
    generated_at: string | null
    synced_at: string | null
    age_sec: number | null
    stale: boolean
  } | null
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

function ChannelTable({ by_channel, ops }: { by_channel: ByChannel; ops?: OpsStats | null }) {
  const focusByChannel = ops?.focus_inventory_by_channel ?? {}
  const externalAutoSeed = ops?.external_auto_seed_enabled === true
  return (
    <div>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-800 text-left">
            <th className="pb-2 text-xs font-medium text-zinc-400">채널</th>
            <th className="pb-2 text-xs font-medium text-zinc-400 text-right">목표재고</th>
            <th className="pb-2 text-xs font-medium text-zinc-400 text-right">발행됨</th>
            <th className="pb-2 text-xs font-medium text-zinc-400 text-right">예약</th>
            <th className="pb-2 text-xs font-medium text-zinc-400 text-right">수동처리</th>
          </tr>
        </thead>
        <tbody>
          {CHANNELS.map(({ key, label }) => {
            const ch = by_channel[key] ?? { published: 0, queued: 0, needs_human: 0 }
            const focus = focusByChannel[key] ?? 0
            const externalBlocked = (key === 'naver' || key === 'tistory') && !externalAutoSeed
            return (
              <tr key={key} className="border-b border-zinc-900/60">
                <td className="py-2 text-zinc-200">
                  {label}
                  {externalBlocked ? <span className="ml-2 rounded border border-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-500">자동시드 off</span> : null}
                </td>
                <td className={['py-2 text-right tabular-nums', focus > 0 ? 'text-emerald-300' : externalBlocked ? 'text-zinc-500' : 'text-amber-300'].join(' ')}>
                  {focus}
                </td>
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
      {!externalAutoSeed ? (
        <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-950/60 p-3 text-xs leading-5 text-zinc-500">
          네이버·티스토리 목표재고 0은 현재 정책입니다. 외부 채널 자동 시드는 중복/품질 리스크 때문에 `ALLOW_EXTERNAL_AUTO_SEED=true` 설정 전까지 보류됩니다.
        </div>
      ) : null}
    </div>
  )
}

function OpsReadinessPanel({ ops }: { ops?: OpsStats | null }) {
  if (!ops) return null
  const staleTotal = Object.values(ops.stale ?? {}).reduce((sum, n) => sum + n, 0)
  const inventoryTarget = ops.inventory_target ?? ops.reviewed_target
  const inventory = ops.inventory ?? ops.reviewed
  const focusInventory = ops.focus_inventory ?? inventory
  const focusInventoryLow = focusInventory < inventoryTarget
  const inventoryLow = inventory < inventoryTarget
  const stockLow = ops.reviewed < ops.reviewed_target
  const dueBlocked = ops.queued_due > 0 && ops.publishing === 0
  const snapshotStale = ops.snapshot_stale === true
  const gate = ops.quality_gate
  const gateAlert = gate ? !gate.ok || !gate.enforced : false
  const search = ops.search_health
  const searchAlert = search ? !search.ok : false
  const imageHealth = ops.image_asset_health
  const imageAlert = imageHealth ? !imageHealth.ok : false
  const sessionHealth = ops.session_health ?? []
  const sessionAlert = sessionHealth.some((session) => !session.ok)
  const active = inventoryLow || focusInventoryLow || dueBlocked || staleTotal > 0 || snapshotStale || gateAlert || searchAlert || imageAlert || sessionAlert
  const snapshotAgeMin = typeof ops.snapshot_age_sec === 'number' ? Math.round(ops.snapshot_age_sec / 60) : null
  const cells = [
    {
      label: '로컬 동기화',
      value: snapshotStale ? '지연' : '정상',
      sub: ops.snapshot_generated_at ? `${formatDate(ops.snapshot_generated_at)}${snapshotAgeMin == null ? '' : ` · ${snapshotAgeMin}분 전`}` : '스냅샷 없음',
      alert: snapshotStale,
    },
    {
      label: '품질 게이트',
      value: gate ? (gate.ok ? '정상' : '확인') : '미측정',
      sub: gate ? `grounding ${gate.min_grounding_ratio} · review ${gate.min_review_score}` : '스냅샷 갱신 필요',
      alert: gateAlert,
    },
    {
      label: '검색/근거',
      value: search ? (search.ok ? '정상' : '확인') : '미측정',
      sub: search ? `${search.provider ?? '없음'} · naver ${search.naver_serp_ok ? 'on' : 'off'}` : '스냅샷 갱신 필요',
      alert: searchAlert,
    },
    {
      label: 'beok 이미지',
      value: imageHealth ? (imageHealth.ok ? '정상' : '제한') : '미측정',
      sub: imageHealth ? `실제 ${imageHealth.beok_conference_actual_images} · 대체 ${imageHealth.fallback_images}` : '스냅샷 갱신 필요',
      alert: imageAlert,
    },
    {
      label: '채널 세션',
      value: sessionAlert ? '확인' : sessionHealth.length ? '정상' : '미측정',
      sub: sessionHealth.length
        ? sessionHealth.map((session) => {
          const state = session.ok
            ? (session.age_hours == null ? '없음' : `${session.age_hours}h`)
            : (session.action || session.reason || '재인증 필요')
          return `${session.channel} ${state}`
        }).join(' · ')
        : '스냅샷 갱신 필요',
      alert: sessionAlert,
    },
    {
      label: '전발행 재고',
      value: `${inventory}/${inventoryTarget}`,
      sub: inventoryLow ? '목표 미달' : '목표 충족',
      alert: inventoryLow,
    },
    {
      label: '목표 주제',
      value: `${focusInventory}/${inventoryTarget}`,
      sub: focusInventoryLow ? (ops.focus_name ?? '주제 재고 부족') : '주제 충족',
      alert: focusInventoryLow,
    },
    {
      label: '검토완료',
      value: `${ops.reviewed}/${ops.reviewed_target}`,
      sub: stockLow ? '전환 대기' : '목표 충족',
      alert: false,
    },
    {
      label: '예약 대기',
      value: String(ops.queued),
      sub: ops.next_queued_at ? `다음 ${formatDate(ops.next_queued_at)}` : '예약 없음',
      alert: false,
    },
    {
      label: '즉시 발행 대상',
      value: String(ops.queued_due),
      sub: ops.queued_due > 0 ? 'publish 대상' : 'due 없음',
      alert: dueBlocked,
    },
    {
      label: '멈춘 작업',
      value: String(staleTotal),
      sub: `${ops.stuck_threshold_min}분 초과`,
      alert: staleTotal > 0,
    },
  ]

  return (
    <div className={['rounded-xl border p-4', active ? 'border-amber-900/60 bg-amber-950/15' : 'border-emerald-900/50 bg-emerald-950/10'].join(' ')}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold">운영 준비도</div>
          <div className="mt-1 text-xs text-zinc-500">재고, 예약, due 큐, stuck 작업을 분리해서 봅니다.</div>
        </div>
        <span className={['rounded-md border px-2 py-1 text-xs', active ? 'border-amber-800 text-amber-200' : 'border-emerald-800 text-emerald-200'].join(' ')}>
          {active ? '확인 필요' : '정상'}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 xl:grid-cols-11">
        {cells.map((cell) => (
          <div
            key={cell.label}
            className={[
              'rounded-lg border bg-zinc-950/50 p-3',
              cell.alert ? 'border-amber-800/70' : 'border-zinc-800',
            ].join(' ')}
          >
            <div className="text-xs text-zinc-500">{cell.label}</div>
            <div className={['mt-1 text-xl font-semibold tabular-nums', cell.alert ? 'text-amber-200' : 'text-zinc-100'].join(' ')}>
              {cell.value}
            </div>
            <div className={['mt-1 truncate text-xs', cell.alert ? 'text-amber-300' : 'text-zinc-500'].join(' ')}>
              {cell.sub}
            </div>
          </div>
        ))}
      </div>
      {imageAlert ? (
        <div className="mt-3 rounded-lg border border-amber-900/60 bg-zinc-950/50 p-3">
          <div className="text-xs font-semibold text-amber-200">이미지 자산 제한</div>
          <div className="mt-1 text-xs leading-5 text-zinc-400">{imageHealth?.reason}</div>
          {imageHealth?.action ? <div className="mt-1 text-xs leading-5 text-zinc-500">{imageHealth.action}</div> : null}
        </div>
      ) : null}
    </div>
  )
}

function LocalOpsPanel({ active }: { active: boolean }) {
  const commands = [
    { label: '대상 확인', command: 'cd blog_publisher && python3 run.py needs_human' },
    { label: '검색 설정 확인', command: 'cd blog_publisher && grep -E "^(SEARCH_PROVIDER|TAVILY_API_KEY|NAVER_CLIENT_ID|NAVER_CLIENT_SECRET)=" .env' },
    { label: '발행 전 품질 셀프테스트', command: 'cd blog_publisher && python3 run.py quality_selftest' },
    { label: '이미지 자산 감사', command: 'cd blog_publisher && python3 run.py image_audit' },
    { label: '공개 품질 검증', command: 'cd blog_publisher && python3 run.py verify_public 20' },
    { label: '멈춘 작업 복구', command: 'cd blog_publisher && python3 run.py recover' },
    { label: '발행 워커 1회', command: 'cd blog_publisher && python3 run.py publish' },
    { label: '지정 글 1건 발행', command: 'cd blog_publisher && python3 run.py publish_one <post_id>' },
    { label: '대시보드 동기화', command: 'cd blog_publisher && python3 run.py sync_snapshot' },
    { label: '로컬 실패 보관', command: 'cd blog_publisher && python3 run.py archive_local --all-reviewed --reason operator_reviewed' },
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

function SearchRecoveryPanel({ search }: { search?: OpsStats['search_health'] }) {
  if (!search || search.ok) return null
  const commands = [
    {
      label: '현재 설정 확인',
      command: 'cd blog_publisher && grep -E "^(SEARCH_PROVIDER|TAVILY_API_KEY|NAVER_CLIENT_ID|NAVER_CLIENT_SECRET)=" .env',
    },
    {
      label: '일반 검색 연결',
      command: 'cd blog_publisher && printf "\\nSEARCH_PROVIDER=tavily\\nTAVILY_API_KEY=<키 입력>\\n" >> .env',
    },
    {
      label: '생성 재개 확인',
      command: 'cd blog_publisher && python3 run.py generate && python3 run.py status',
    },
    {
      label: '대시보드 반영',
      command: 'cd blog_publisher && python3 run.py sync_snapshot',
    },
  ]

  return (
    <div className="rounded-xl border border-amber-900/60 bg-amber-950/15 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-amber-200">신규 원고 생성 중단</div>
          <div className="mt-1 text-xs leading-5 text-zinc-500">
            {search.reason || '검색/근거 수집 설정이 없어 근거 기반 생성이 중단됩니다.'}
            {' '}품질 게이트가 켜진 상태에서는 검색 출처 없이 새 글을 만들지 않습니다.
          </div>
        </div>
        <span className="rounded-md border border-amber-800 px-2 py-1 text-xs text-amber-200">
          검색 연결 필요
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

function SessionRecoveryPanel({ sessions }: { sessions?: OpsStats['session_health'] }) {
  const failed = (sessions ?? []).filter((session) => !session.ok)
  if (!failed.length) return null

  const commandFor = (channel: string) => {
    if (channel === 'tistory') return 'cd executors/naver-blog-worker && npm run tistory-auth'
    if (channel === 'naver') return 'cd executors/naver-blog-worker && npm run login'
    return 'cd executors/naver-blog-worker && npm run login'
  }

  return (
    <div className="rounded-xl border border-rose-900/60 bg-rose-950/15 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-rose-200">외부 채널 세션 조치 필요</div>
          <div className="mt-1 text-xs leading-5 text-zinc-500">
            네이버·티스토리 발행은 브라우저 세션이 살아 있어야 합니다. 세션 만료 글은 자동 재시도하지 않고 재로그인 후 수동으로 재큐잉합니다.
          </div>
        </div>
        <span className="rounded-md border border-rose-800 px-2 py-1 text-xs text-rose-200">
          {failed.length}채널 확인
        </span>
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-2">
        {failed.map((session) => (
          <div key={session.channel} className="rounded-lg border border-zinc-800 bg-zinc-950/70 p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-zinc-300">{session.channel}</div>
                <div className="mt-1 text-[11px] text-zinc-500">
                  {session.exists ? `세션 파일 ${session.age_hours ?? '?'}h 전` : '세션 파일 없음'}
                  {session.error_post_id ? ` · 차단 글 #${session.error_post_id}` : ''}
                </div>
              </div>
              <span className="rounded-md border border-rose-900/60 bg-rose-950/20 px-2 py-0.5 text-[11px] text-rose-200">
                재인증
              </span>
            </div>
            {session.reason ? (
              <div className="mt-2 line-clamp-2 text-xs leading-5 text-rose-300">{session.reason}</div>
            ) : null}
            <div className="mt-3 space-y-2">
              <div>
                <div className="text-[11px] font-medium text-zinc-500">1. 브라우저 재로그인</div>
                <code className="mt-1 block overflow-x-auto whitespace-nowrap rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-xs text-zinc-200">
                  {commandFor(session.channel)}
                </code>
              </div>
              <div>
                <div className="text-[11px] font-medium text-zinc-500">2. 워커·대시보드 반영</div>
                <code className="mt-1 block overflow-x-auto whitespace-nowrap rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-xs text-zinc-200">
                  launchctl kickstart -k gui/$(id -u)/com.beok.blog-worker && cd blog_publisher && python3 run.py sync_snapshot
                </code>
              </div>
              <div>
                <div className="text-[11px] font-medium text-zinc-500">3. 대상 확인</div>
                <code className="mt-1 block overflow-x-auto whitespace-nowrap rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-xs text-zinc-200">
                  cd blog_publisher && python3 run.py needs_human
                </code>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function QualityActionPanel({ quality }: { quality?: PipelineStats['quality'] }) {
  if (!quality) return null
  const weak = quality.weak_posts > 0
  const lowGrounding = quality.avg_grounding != null && quality.avg_grounding < 0.9
  if (!weak && !lowGrounding) return null

  const actions = [
    {
      label: '렌더러·리라이터 회귀검사',
      command: 'cd blog_publisher && python3 run.py quality_selftest',
      active: weak,
    },
    {
      label: '공개 URL 실제 품질검증',
      command: 'cd blog_publisher && python3 run.py verify_public 20',
      active: weak,
    },
    {
      label: '품질 게이트 설정 확인',
      command: 'cd blog_publisher && grep -E "^(MIN_GROUNDING_RATIO|MIN_REVIEW_SCORE)=" .env',
      active: lowGrounding,
    },
    {
      label: '대시보드 스냅샷 갱신',
      command: 'cd blog_publisher && python3 run.py sync_snapshot',
      active: true,
    },
  ].filter((item) => item.active)

  return (
    <div className="rounded-xl border border-amber-900/60 bg-amber-950/15 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-amber-200">품질 조치 필요</div>
          <div className="mt-1 text-xs leading-5 text-zinc-500">
            짧은 글 {quality.weak_posts}건, 평균 grounding {quality.avg_grounding == null ? '미측정' : quality.avg_grounding.toFixed(2)}입니다.
            검증은 실제 산출물 기준으로 실행합니다.
          </div>
        </div>
        <span className="rounded-md border border-amber-800 px-2 py-1 text-xs text-amber-200">
          운영 점검
        </span>
      </div>
      <div className="mt-3 grid gap-2 md:grid-cols-2">
        {actions.map((item) => (
          <div key={item.label} className="rounded-lg border border-zinc-800 bg-zinc-950/70 p-3">
            <div className="text-xs font-medium text-zinc-400">{item.label}</div>
            <code className="mt-2 block overflow-x-auto whitespace-nowrap text-xs text-zinc-200">{item.command}</code>
          </div>
        ))}
      </div>
    </div>
  )
}

function QualityItemsPanel({
  items,
  onOpenDetail,
}: {
  items?: QualityItem[]
  onOpenDetail: (id: number | string) => void
}) {
  if (!items?.length) return null
  return (
    <div className="rounded-xl border border-amber-900/60 bg-zinc-950/50 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-amber-100">품질 보강 대상</div>
          <div className="mt-1 text-xs text-zinc-500">짧은 글·근거 부족·구조 부족처럼 실제 산출물 기준으로 보강할 글입니다.</div>
        </div>
        <span className="rounded-md border border-amber-900/60 bg-amber-950/20 px-2 py-1 text-xs text-amber-200">
          {items.length}건 표시
        </span>
      </div>
      <div className="flex flex-col gap-2">
        {items.map((item) => (
          <div key={`${item.channel}-${item.id}`} className="rounded-lg border border-zinc-800 bg-zinc-950/70 p-3">
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs text-zinc-500">#{item.id}</span>
                  <StatusBadge value={item.channel} />
                  <StatusBadge value={item.status} />
                  {item.issues.slice(0, 4).map((issue) => (
                    <span key={issue} className="rounded-md border border-amber-900/50 bg-amber-950/20 px-2 py-0.5 text-[11px] text-amber-200">
                      {issue}
                    </span>
                  ))}
                </div>
                <div className="mt-2 truncate text-sm text-zinc-200">{item.title || item.topic}</div>
                {item.body_excerpt ? (
                  <p className="mt-2 line-clamp-2 text-xs leading-5 text-zinc-500">
                    {item.body_excerpt}
                  </p>
                ) : null}
                {item.action ? (
                  <div className="mt-2 inline-flex rounded-md border border-zinc-800 bg-zinc-900/60 px-2 py-1 text-xs text-zinc-300">
                    다음 조치: {item.action}
                  </div>
                ) : null}
                <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-zinc-500">
                  <span>{formatDate(item.updated_at)}</span>
                  <span>본문 {item.quality.chars.toLocaleString('ko-KR')}자</span>
                  <span>이미지 {item.quality.images}</span>
                  <span>소제목 {item.quality.headings}</span>
                  <span>grounding {item.quality.grounding_ratio == null ? '미측정' : item.quality.grounding_ratio.toFixed(2)}</span>
                  {item.preview_html ? <span>미리보기 있음</span> : null}
                  {item.preview_contract?.length ? <span>렌더 계약 {item.preview_contract.length}</span> : null}
                </div>
              </div>
              <div className="flex shrink-0 gap-2 md:flex-col">
                <button
                  type="button"
                  onClick={() => onOpenDetail(item.id)}
                  className="rounded-md border border-zinc-800 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
                >
                  상세
                </button>
                {item.published_url ? (
                  <a
                    href={item.published_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded-md border border-zinc-800 px-2 py-1 text-center text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                  >
                    공개 글
                  </a>
                ) : null}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function PublicQualityPanel({
  data,
  onOpenDetail,
}: {
  data?: PipelineStats['public_quality']
  onOpenDetail: (id: number | string) => void
}) {
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
            <div
              key={`${item.channel}-${item.id}-${item.url}`}
              className="rounded-lg border border-zinc-800 bg-zinc-950/70 p-3"
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
              {item.cache_bust_ok && item.cache_bust_url ? (
                <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-sky-900/50 bg-sky-950/20 px-2 py-1 text-[11px] text-sky-200">
                  <span>캐시 우회 정상</span>
                  <span className="text-sky-400/70">기본 URL 캐시 잔존 가능</span>
                  <span className="font-mono text-sky-100">{item.cache_bust_url}</span>
                </div>
              ) : null}
              {item.action ? (
                <div className="mt-2 rounded-md border border-amber-900/50 bg-amber-950/15 px-2 py-1 text-[11px] text-amber-200">
                  {item.action}
                </div>
              ) : null}
              <div className="mt-3 flex flex-wrap gap-2">
                <a
                  href={item.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded-md border border-zinc-800 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
                >
                  공개 글 열기
                </a>
                {typeof item.id === 'number' || /^\d+$/.test(String(item.id)) ? (
                  <button
                    type="button"
                    onClick={() => onOpenDetail(item.id)}
                    className="rounded-md border border-zinc-800 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
                  >
                    로컬 상세
                  </button>
                ) : null}
              </div>
            </div>
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
  archiving,
  onClose,
  onRequeue,
  onArchive,
}: {
  detail: PipelinePostDetail | null
  loading: boolean
  error: string | null
  requeueing: boolean
  archiving: boolean
  onClose: () => void
  onRequeue: () => void
  onArchive: () => void
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
              <button
                type="button"
                disabled={!detail.can_archive || archiving}
                onClick={onArchive}
                className={[
                  'mt-2 h-8 w-full rounded-lg border px-3 text-xs',
                  detail.can_archive
                    ? 'border-zinc-700 bg-zinc-900 text-zinc-200 hover:bg-zinc-800'
                    : 'cursor-not-allowed border-zinc-800 bg-zinc-900/40 text-zinc-600',
                ].join(' ')}
              >
                {archiving ? '보관 중...' : '확인 완료 보관'}
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
            <div className="mb-4 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2">
              <div className="text-xs font-semibold text-zinc-600">
                {detail.preview_mode === 'selfhosted_rendered_preview' ? '자체 블로그 렌더 미리보기' : '본문 미리보기'}
              </div>
              {detail.preview_contract?.length ? (
                <div className="mt-2 flex flex-wrap gap-1">
                  {detail.preview_contract.map((item) => (
                    <span key={item} className="rounded-md border border-zinc-300 bg-white px-2 py-0.5 text-[11px] text-zinc-700">
                      {item}
                    </span>
                  ))}
                </div>
              ) : (
                <div className="mt-1 text-[11px] text-zinc-500">
                  DB 본문 기준 미리보기입니다.
                </div>
              )}
            </div>
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
  const [archivingId, setArchivingId] = useState<string | null>(null)

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

  const archivePost = useCallback(async (post: Pick<NeedsHumanPost, 'id' | 'external_doc_id'>) => {
    const archiveId = post.external_doc_id || String(post.id)
    setArchivingId(archiveId)
    setDetailError(null)
    try {
      if (post.external_doc_id) {
        await apiJson(`/api/pipeline/external-results/${encodeURIComponent(post.external_doc_id)}/archive`, {
          method: 'POST',
          body: JSON.stringify({ reason: 'operator_reviewed' }),
        })
      } else {
        await apiJson(`/api/pipeline/posts/${encodeURIComponent(String(post.id))}/archive`, {
          method: 'POST',
          body: JSON.stringify({ reason: 'operator_reviewed' }),
        })
      }
      await fetchStats()
      if (detail && String(detail.id) === String(post.id)) setDetail(null)
    } catch (e) {
      setDetailError(errorMessage(e, '보관 실패'))
    } finally {
      setArchivingId(null)
    }
  }, [detail, fetchStats])

  const archiveSelected = useCallback(async () => {
    if (!detail) return
    await archivePost({ id: detail.id, external_doc_id: detail.external_doc_id })
  }, [archivePost, detail])

  useEffect(() => {
    fetchStats()
    const timer = setInterval(fetchStats, 30_000)
    return () => clearInterval(timer)
  }, [fetchStats])

  const queueFailures = (data?.by_status?.needs_human ?? 0) + (data?.by_status?.failed ?? 0)
  const listedFailures = data?.needs_human_posts?.length ?? 0
  const publicFailures = data?.public_quality?.failed ?? 0
  const operationalFailures = Math.max(queueFailures, listedFailures)
  const totalFailures = operationalFailures + publicFailures

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
          label="운영 확인 필요"
          value={totalFailures}
          sub={totalFailures > 0 ? `처리목록 ${operationalFailures} · 공개 ${publicFailures}` : '이상 없음'}
          alert={totalFailures > 0}
        />
      </div>

      {/* 파이프라인 퍼널 */}
      <div className="rounded-xl border border-zinc-900 bg-zinc-900/30 p-4">
        <div className="mb-3 text-sm font-semibold">파이프라인 상태</div>
        {data ? <StageBar by_status={data.by_status} /> : <div className="text-sm text-zinc-500">로딩 중…</div>}
      </div>

      <OpsReadinessPanel ops={data?.ops} />

      <SessionRecoveryPanel sessions={data?.ops?.session_health} />

      <SearchRecoveryPanel search={data?.ops?.search_health} />

      <LocalOpsPanel active={totalFailures > 0} />

      <PublicQualityPanel data={data?.public_quality} onOpenDetail={openDetail} />

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

      <QualityActionPanel quality={data?.quality} />

      <QualityItemsPanel items={data?.quality_items} onOpenDetail={openDetail} />

      <DetailPanel
        detail={detail}
        loading={detailLoading}
        error={detailError}
        requeueing={requeueing}
        archiving={Boolean(detail && archivingId === (detail.external_doc_id || String(detail.id)))}
        onClose={() => {
          setDetail(null)
          setDetailError(null)
        }}
        onRequeue={requeueSelected}
        onArchive={archiveSelected}
      />

      {/* 채널별 현황 */}
      <div className="rounded-xl border border-zinc-900 bg-zinc-900/30 p-4">
        <div className="mb-3 text-sm font-semibold">채널별 현황</div>
        {data ? <ChannelTable by_channel={data.by_channel} ops={data.ops} /> : <div className="text-sm text-zinc-500">로딩 중…</div>}
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
                  {post.can_archive ? (
                    <button
                      type="button"
                      disabled={archivingId === (post.external_doc_id || String(post.id))}
                      onClick={() => archivePost(post)}
                      className="rounded-md border border-zinc-800 px-2 py-1 text-center text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 disabled:cursor-not-allowed disabled:text-zinc-700"
                    >
                      {archivingId === (post.external_doc_id || String(post.id)) ? '보관 중' : '보관'}
                    </button>
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
