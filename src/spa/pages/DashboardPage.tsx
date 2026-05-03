import { useEffect, useMemo, useState } from 'react'
import { apiJson } from '../lib/api'
import StatusBadge from '../components/StatusBadge'

type DashboardData = {
  source_items: { total: number; eligible: number; ineligible: number }
  short_ideas: { total: number; awaiting_review: number; approved: number; rejected: number }
  scripts: { total: number; awaiting_review: number; approved: number; revision_required: number }
}

function KpiCard(props: { label: string; value: number; hint?: string }) {
  return (
    <div className="rounded-xl border border-zinc-900 bg-zinc-900/30 p-4">
      <div className="text-xs text-zinc-400">{props.label}</div>
      <div className="mt-2 text-2xl font-semibold">{props.value}</div>
      {props.hint ? <div className="mt-1 text-xs text-zinc-500">{props.hint}</div> : null}
    </div>
  )
}

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    apiJson<DashboardData>('/api/dashboard')
      .then((d) => {
        if (!alive) return
        setData(d)
        setError(null)
      })
      .catch((e) => {
        if (!alive) return
        setError(e instanceof Error ? e.message : '불러오기 실패')
      })
    return () => {
      alive = false
    }
  }, [])

  const kpis = useMemo(() => {
    if (!data) return null
    return [
      { label: '원천 콘텐츠', value: data.source_items.total, hint: `eligible ${data.source_items.eligible}` },
      { label: '아이디어 검수 대기', value: data.short_ideas.awaiting_review },
      { label: '대본 검수 대기', value: data.scripts.awaiting_review },
      { label: '리젝', value: data.short_ideas.rejected },
    ]
  }, [data])

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
        {kpis ? kpis.map((k) => <KpiCard key={k.label} {...k} />) : <div className="text-sm text-zinc-500">로딩 중…</div>}
      </div>

      <div className="rounded-xl border border-zinc-900 bg-zinc-900/30 p-4">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold">파이프라인 요약</div>
          {error ? <StatusBadge value="failed" /> : null}
        </div>
        {error ? <div className="mt-2 text-sm text-rose-200">{error}</div> : null}
        {data ? (
          <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
              <div className="text-xs text-zinc-400">source_items</div>
              <div className="mt-2 flex flex-wrap gap-2 text-sm">
                <span className="text-zinc-300">total {data.source_items.total}</span>
                <StatusBadge value="eligible" />
                <span className="text-zinc-300">{data.source_items.eligible}</span>
                <StatusBadge value="ineligible" />
                <span className="text-zinc-300">{data.source_items.ineligible}</span>
              </div>
            </div>
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
              <div className="text-xs text-zinc-400">short_ideas</div>
              <div className="mt-2 flex flex-wrap gap-2 text-sm">
                <StatusBadge value="awaiting_review" />
                <span className="text-zinc-300">{data.short_ideas.awaiting_review}</span>
                <StatusBadge value="approved" />
                <span className="text-zinc-300">{data.short_ideas.approved}</span>
                <StatusBadge value="rejected" />
                <span className="text-zinc-300">{data.short_ideas.rejected}</span>
              </div>
            </div>
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
              <div className="text-xs text-zinc-400">scripts</div>
              <div className="mt-2 flex flex-wrap gap-2 text-sm">
                <StatusBadge value="awaiting_review" />
                <span className="text-zinc-300">{data.scripts.awaiting_review}</span>
                <StatusBadge value="approved" />
                <span className="text-zinc-300">{data.scripts.approved}</span>
                <StatusBadge value="revision_required" />
                <span className="text-zinc-300">{data.scripts.revision_required}</span>
              </div>
            </div>
          </div>
        ) : (
          <div className="mt-3 text-sm text-zinc-500">데이터 준비 중…</div>
        )}
      </div>
    </div>
  )
}

