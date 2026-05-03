const COLORS: Record<string, string> = {
  received: 'border-sky-900/60 bg-sky-950/30 text-sky-200',
  normalized: 'border-sky-900/60 bg-sky-950/30 text-sky-200',
  eligible: 'border-emerald-900/60 bg-emerald-950/30 text-emerald-200',
  ineligible: 'border-rose-900/60 bg-rose-950/30 text-rose-200',
  archived: 'border-zinc-800 bg-zinc-900/40 text-zinc-300',

  generated: 'border-zinc-800 bg-zinc-900/40 text-zinc-200',
  awaiting_review: 'border-amber-900/60 bg-amber-950/30 text-amber-200',
  approved: 'border-emerald-900/60 bg-emerald-950/30 text-emerald-200',
  rejected: 'border-rose-900/60 bg-rose-950/30 text-rose-200',

  queued: 'border-amber-900/60 bg-amber-950/30 text-amber-200',
  processing: 'border-amber-900/60 bg-amber-950/30 text-amber-200',
  failed: 'border-rose-900/60 bg-rose-950/30 text-rose-200',
  uploaded: 'border-sky-900/60 bg-sky-950/30 text-sky-200',
  published: 'border-emerald-900/60 bg-emerald-950/30 text-emerald-200',
}

export default function StatusBadge(props: { value: string }) {
  const cls = COLORS[props.value] ?? 'border-zinc-800 bg-zinc-900/40 text-zinc-300'
  return (
    <span className={['inline-flex items-center rounded-md border px-2 py-0.5 text-xs', cls].join(' ')}>
      {props.value}
    </span>
  )
}

