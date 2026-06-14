type Benefit = {
  title: string
  description: string
}

type ComparisonRow = {
  item: string
  old: string
  new: string
}

type ProcessStep = {
  title: string
  description: string
}

type FaqItem = {
  q: string
  a: string
}

export type BeoksolutionLandingSchema = {
  template: 'beoksolution_landing_v1'
  hero?: {
    eyebrow?: string
    title?: string
    subtitle?: string
  }
  preview?: {
    eyebrow?: string
    title?: string
    description?: string
  }
  benefits_title?: string
  benefits?: Benefit[]
  comparison_title?: string
  comparison?: ComparisonRow[]
  process_title?: string
  process?: ProcessStep[]
  faq?: FaqItem[]
  final_cta?: {
    eyebrow?: string
    title?: string
    description?: string
    label?: string
    href?: string
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

export function isBeoksolutionLandingSchema(value: unknown): value is BeoksolutionLandingSchema {
  return isRecord(value) && value.template === 'beoksolution_landing_v1'
}

export function BeoksolutionLandingTemplate({ schema }: { schema: BeoksolutionLandingSchema }) {
  const preview = schema.preview ?? {}
  const benefits = schema.benefits ?? []
  const comparison = schema.comparison ?? []
  const process = schema.process ?? []
  const faq = schema.faq ?? []
  const finalCta = schema.final_cta ?? {}

  return (
    <div className="mt-10 space-y-12 [overflow-wrap:break-word] [word-break:keep-all]">
      <section className="grid gap-5 md:grid-cols-[1.05fr_0.95fr]">
        <div className="rounded-[28px] border border-white/10 bg-gradient-to-br from-slate-950 via-slate-900 to-blue-950/70 p-7">
          <p className="mb-3 text-xs font-black uppercase tracking-[0.18em] text-emerald-200">{preview.eyebrow ?? 'SERVICE PREVIEW'}</p>
          <h2 className="text-3xl font-black leading-tight tracking-[-0.045em] text-white md:text-4xl">{preview.title}</h2>
          <p className="mt-4 text-base leading-8 text-slate-300">{preview.description}</p>
        </div>
        <div className="rounded-[28px] border border-white/10 bg-slate-950 p-5 shadow-2xl shadow-black/40">
          <div className="mb-4 flex gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-red-500" />
            <span className="h-2.5 w-2.5 rounded-full bg-amber-500" />
            <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
          </div>
          <div className="rounded-3xl border border-white/10 bg-gradient-to-br from-slate-900 to-slate-950 p-5">
            <div className="mb-5 h-3 w-5/12 rounded-full bg-white/80" />
            <div className="mb-3 h-12 rounded-2xl bg-gradient-to-r from-blue-400 to-emerald-400" />
            <div className="mb-4 grid grid-cols-3 gap-2">
              <div className="h-14 rounded-2xl bg-white/10" />
              <div className="h-14 rounded-2xl bg-white/10" />
              <div className="h-14 rounded-2xl bg-white/10" />
            </div>
            <div className="mb-2 h-3 w-11/12 rounded-full bg-white/20" />
            <div className="h-3 w-8/12 rounded-full bg-white/15" />
          </div>
        </div>
      </section>

      <section>
        <h2 className="mb-5 text-3xl font-black tracking-[-0.04em] text-white">{schema.benefits_title ?? '비오케이솔루션 운영 기준'}</h2>
        <div className="grid gap-4 md:grid-cols-3">
          {benefits.map((item, index) => (
            <div key={`${item.title}-${index}`} className="rounded-[24px] border border-white/10 bg-white/[0.055] p-6">
              <b className="mb-2 block text-sm font-black text-emerald-200">{String(index + 1).padStart(2, '0')} {item.title}</b>
              <p className="m-0 leading-7 text-slate-300">{item.description}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-[28px] border border-white/10 bg-slate-950/80 p-7">
        <h2 className="mb-5 text-3xl font-black tracking-[-0.04em] text-white">{schema.comparison_title ?? '일반 외주와 무엇이 다른가요?'}</h2>
        <div className="grid gap-3">
          {comparison.map((row, index) => (
            <div key={`${row.item}-${index}`} className="grid gap-2 rounded-2xl bg-white/[0.045] p-4 text-sm md:grid-cols-[0.8fr_1fr_1fr] md:items-center">
              <b className="text-slate-400">{row.item}</b>
              <span className="text-slate-400">{row.old}</span>
              <strong className="text-emerald-200">{row.new}</strong>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-5 text-3xl font-black tracking-[-0.04em] text-white">{schema.process_title ?? '진행 방식'}</h2>
        <div className="grid gap-3 md:grid-cols-4">
          {process.map((step, index) => (
            <div key={`${step.title}-${index}`} className="rounded-[22px] border border-white/10 bg-white/[0.05] p-5 text-slate-300">
              <b className="text-white">{index + 1}. {step.title}</b>
              <p className="mt-2 text-sm leading-6">{step.description}</p>
            </div>
          ))}
        </div>
      </section>

      {faq.length ? (
        <section>
          <h2 className="mb-5 text-3xl font-black tracking-[-0.04em] text-white">자주 묻는 질문</h2>
          <div className="grid gap-3">
            {faq.map((item, index) => (
              <div key={`${item.q}-${index}`} className="rounded-[22px] border border-white/10 bg-white/[0.045] p-5">
                <b className="block text-white">{item.q}</b>
                <p className="mt-2 leading-7 text-slate-300">{item.a}</p>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className="rounded-[30px] border border-blue-300/20 bg-gradient-to-br from-blue-500/25 to-emerald-400/10 p-8">
        <p className="mb-3 text-xs font-black uppercase tracking-[0.2em] text-blue-200">{finalCta.eyebrow ?? 'START WITH BOK SOLUTION'}</p>
        <h2 className="text-3xl font-black leading-tight tracking-[-0.045em] text-white md:text-4xl">{finalCta.title}</h2>
        <p className="mt-4 leading-8 text-blue-100">{finalCta.description}</p>
        <a href={finalCta.href ?? 'https://beoksolution.com'} target="_blank" rel="noopener" className="mt-6 inline-flex rounded-2xl bg-white px-5 py-3 text-sm font-black text-slate-950 hover:bg-slate-100">
          {finalCta.label ?? '무료 상담 신청하기'}
        </a>
      </section>
    </div>
  )
}
