import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import StatusBadge from '../components/StatusBadge'
import { apiJson } from '../lib/api'

type BlogPost = {
  id: string
  title: string
  excerpt: string
  category: string
  tags: string[]
  status: string
  published_at: string | null
  created_at: string
}

type ListResponse = { items: BlogPost[]; total: number; limit: number; offset: number }

type PipelineResult = {
  post_id: string
  slug: string
  status: string
  title: string
  seo_title: string
  tags: string[]
  published_at: string | null
  template_version: number
}

type WizardStep = 'topic' | 'draft' | 'publish'

const CATEGORIES = [
  { value: 'mice', label: 'MICE / 이벤트' },
  { value: 'marketing', label: '마케팅' },
  { value: 'company', label: '회사 소식' },
]

const TONES = [
  { value: 'professional', label: '전문적' },
  { value: 'casual', label: '친근한' },
  { value: 'informative', label: '정보 전달' },
  { value: 'persuasive', label: '설득형' },
]

const LENGTHS = [
  { value: 'short', label: '짧게 (300~500자)' },
  { value: 'medium', label: '보통 (800~1500자)' },
  { value: 'long', label: '길게 (2000~4000자)' },
]

function StepIndicator({ current }: { current: WizardStep }) {
  const steps: { key: WizardStep; num: number; label: string }[] = [
    { key: 'topic', num: 1, label: '주제 설정' },
    { key: 'draft', num: 2, label: '원고 작성' },
    { key: 'publish', num: 3, label: '디자인 & 발행' },
  ]
  const order: Record<WizardStep, number> = { topic: 1, draft: 2, publish: 3 }
  const currentNum = order[current]

  return (
    <div className="flex items-center gap-2">
      {steps.map((step, i) => (
        <div key={step.key} className="flex items-center gap-2">
          <div
            className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-bold ${
              step.num < currentNum
                ? 'bg-green-600 text-white'
                : step.num === currentNum
                  ? 'bg-blue-600 text-white'
                  : 'bg-zinc-800 text-zinc-400'
            }`}
          >
            {step.num < currentNum ? '✓' : step.num}
          </div>
          <span className={`text-sm ${step.num <= currentNum ? 'text-zinc-100' : 'text-zinc-500'}`}>
            {step.label}
          </span>
          {i < steps.length - 1 ? <div className="mx-1 h-px w-6 bg-zinc-700" /> : null}
        </div>
      ))}
    </div>
  )
}

export default function BlogPostsPage() {
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('')
  const [category, setCategory] = useState('')
  const [data, setData] = useState<ListResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  const [showWizard, setShowWizard] = useState(false)

  const [wizardStep, setWizardStep] = useState<WizardStep>('topic')
  const [wizTitle, setWizTitle] = useState('')
  const [wizTopic, setWizTopic] = useState('')
  const [wizCategory, setWizCategory] = useState('marketing')
  const [wizTone, setWizTone] = useState('professional')
  const [wizLength, setWizLength] = useState('medium')
  const [wizKeywords, setWizKeywords] = useState('')
  const [wizAutoPublish, setWizAutoPublish] = useState(false)

  const [isCreating, setIsCreating] = useState(false)
  const [pipelineResult, setPipelineResult] = useState<PipelineResult | null>(null)
  const [createdPostId, setCreatedPostId] = useState<string | null>(null)

  const queryString = useMemo(() => {
    const sp = new URLSearchParams()
    sp.set('limit', '50')
    sp.set('offset', '0')
    if (q.trim()) sp.set('q', q.trim())
    if (status) sp.set('status', status)
    if (category.trim()) sp.set('category', category.trim())
    return sp.toString()
  }, [q, status, category])

  const refresh = useCallback(async () => {
    setIsLoading(true)
    try {
      const next = await apiJson<ListResponse>(`/api/blog-posts?${queryString}`)
      setData(next)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : '불러오기 실패')
    } finally {
      setIsLoading(false)
    }
  }, [queryString])

  useEffect(() => {
    refresh()
  }, [refresh])

  function openWizard() {
    setWizardStep('topic')
    setWizTitle('')
    setWizTopic('')
    setWizCategory('marketing')
    setWizTone('professional')
    setWizLength('medium')
    setWizKeywords('')
    setWizAutoPublish(false)
    setPipelineResult(null)
    setCreatedPostId(null)
    setShowWizard(true)
  }

  function closeWizard() {
    setShowWizard(false)
    refresh()
  }

  async function handleTopicNext(e: FormEvent) {
    e.preventDefault()
    if (!wizTitle.trim()) return
    setWizardStep('draft')
  }

  async function handleGenerateDraft() {
    setIsCreating(true)
    setError(null)
    try {
      const result = await apiJson<PipelineResult>('/api/ai/execute-blog-pipeline', {
        method: 'POST',
        idempotencyKey: `blog-wizard-${Date.now()}`,
        body: JSON.stringify({
          title: wizTitle.trim(),
          topic: wizTopic.trim() || wizTitle.trim(),
          category: wizCategory,
          tone: wizTone,
          keywords: wizKeywords.split(',').map((k) => k.trim()).filter(Boolean),
          target_length: wizLength,
          auto_publish: false,
        }),
      })
      setPipelineResult(result)
      setCreatedPostId(result.post_id)
      setWizardStep('publish')
    } catch (e) {
      setError(e instanceof Error ? e.message : '원고 생성 실패')
    } finally {
      setIsCreating(false)
    }
  }

  async function handlePublishFromWizard() {
    if (!createdPostId) return
    setIsCreating(true)
    try {
      await apiJson(`/api/blog-posts/${createdPostId}/publish`, {
        method: 'POST',
        body: JSON.stringify({}),
      })
      closeWizard()
    } catch (e) {
      setError(e instanceof Error ? e.message : '발행 실패')
    } finally {
      setIsCreating(false)
    }
  }

  async function onCreateEmpty(e: FormEvent) {
    e.preventDefault()
    setIsCreating(true)
    try {
      await apiJson<{ id: string }>('/api/blog-posts', {
        method: 'POST',
        body: JSON.stringify({
          title: `새 블로그 글 ${new Date().toLocaleDateString('ko-KR')}`,
          status: 'draft',
          ai_generate: false,
        }),
      })
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : '생성 실패')
    } finally {
      setIsCreating(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold">블로그 글</div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={openWizard}
            className="inline-flex h-9 items-center justify-center rounded-lg bg-blue-600 px-3 text-sm font-medium text-white hover:bg-blue-700"
          >
            파이프라인으로 작성
          </button>
          <form onSubmit={onCreateEmpty}>
            <button
              type="submit"
              disabled={isCreating}
              className="inline-flex h-9 items-center justify-center rounded-lg bg-white px-3 text-sm font-medium text-zinc-950 disabled:opacity-60"
            >
              {isCreating ? '생성 중…' : '+ 빈 글'}
            </button>
          </form>
        </div>
      </div>

      {showWizard ? (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/60">
          <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-4">
            <StepIndicator current={wizardStep} />
            <button
              type="button"
              onClick={closeWizard}
              className="text-sm text-zinc-400 hover:text-zinc-200"
            >
              닫기
            </button>
          </div>

          <div className="p-5">
            {error ? <div className="mb-4 rounded-lg bg-red-900/20 p-3 text-sm text-red-400">{error}</div> : null}

            {wizardStep === 'topic' ? (
              <form onSubmit={handleTopicNext} className="flex flex-col gap-4">
                <div>
                  <h3 className="text-base font-semibold text-zinc-100">주제를 설정하세요</h3>
                  <p className="mt-1 text-xs text-zinc-400">제목, 카테고리, 어조를 정하면 그에 맞는 프롬프트로 원고를 생성합니다.</p>
                </div>

                <label className="flex flex-col gap-2">
                  <span className="text-xs text-zinc-400">제목 *</span>
                  <input
                    className="h-10 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm"
                    value={wizTitle}
                    onChange={(e) => setWizTitle(e.target.value)}
                    placeholder="예: 하이브리드 이벤트 운영 가이드"
                    required
                  />
                </label>

                <label className="flex flex-col gap-2">
                  <span className="text-xs text-zinc-400">주제 설명 (선택)</span>
                  <input
                    className="h-10 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm"
                    value={wizTopic}
                    onChange={(e) => setWizTopic(e.target.value)}
                    placeholder="제목과 다르게 구체적인 주제가 있으면 입력"
                  />
                </label>

                <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                  <label className="flex flex-col gap-2">
                    <span className="text-xs text-zinc-400">카테고리</span>
                    <select
                      className="h-10 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm"
                      value={wizCategory}
                      onChange={(e) => setWizCategory(e.target.value)}
                    >
                      {CATEGORIES.map((c) => (
                        <option key={c.value} value={c.value}>{c.label}</option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-2">
                    <span className="text-xs text-zinc-400">어조</span>
                    <select
                      className="h-10 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm"
                      value={wizTone}
                      onChange={(e) => setWizTone(e.target.value)}
                    >
                      {TONES.map((t) => (
                        <option key={t.value} value={t.value}>{t.label}</option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-2">
                    <span className="text-xs text-zinc-400">길이</span>
                    <select
                      className="h-10 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm"
                      value={wizLength}
                      onChange={(e) => setWizLength(e.target.value)}
                    >
                      {LENGTHS.map((l) => (
                        <option key={l.value} value={l.value}>{l.label}</option>
                      ))}
                    </select>
                  </label>
                </div>

                <label className="flex flex-col gap-2">
                  <span className="text-xs text-zinc-400">키워드 (쉼표로 구분)</span>
                  <input
                    className="h-10 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm"
                    value={wizKeywords}
                    onChange={(e) => setWizKeywords(e.target.value)}
                    placeholder="예: 하이브리드, 이벤트, MICE"
                  />
                </label>

                <div className="flex justify-end">
                  <button
                    type="submit"
                    disabled={!wizTitle.trim()}
                    className="h-10 rounded-lg bg-blue-600 px-5 text-sm font-medium text-white disabled:opacity-40"
                  >
                    다음: 원고 작성 →
                  </button>
                </div>
              </form>
            ) : null}

            {wizardStep === 'draft' ? (
              <div className="flex flex-col gap-4">
                <div>
                  <h3 className="text-base font-semibold text-zinc-100">원고를 생성합니다</h3>
                  <p className="mt-1 text-xs text-zinc-400">
                    아래 설정으로 파이프라인이 실행됩니다. 고정 프롬프트 템플릿 + 품질 검증을 거쳐 일관된 퀄리티의 원고가 생성됩니다.
                  </p>
                </div>

                <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-4">
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div><span className="text-zinc-500">제목:</span> <span className="text-zinc-200">{wizTitle}</span></div>
                    <div><span className="text-zinc-500">카테고리:</span> <span className="text-zinc-200">{CATEGORIES.find((c) => c.value === wizCategory)?.label}</span></div>
                    <div><span className="text-zinc-500">어조:</span> <span className="text-zinc-200">{TONES.find((t) => t.value === wizTone)?.label}</span></div>
                    <div><span className="text-zinc-500">길이:</span> <span className="text-zinc-200">{LENGTHS.find((l) => l.value === wizLength)?.label}</span></div>
                    {wizKeywords.trim() ? (
                      <div className="col-span-2"><span className="text-zinc-500">키워드:</span> <span className="text-zinc-200">{wizKeywords}</span></div>
                    ) : null}
                  </div>
                </div>

                <div className="flex items-center justify-between">
                  <button
                    type="button"
                    onClick={() => setWizardStep('topic')}
                    className="h-10 rounded-lg border border-zinc-800 bg-zinc-950 px-4 text-sm text-zinc-200"
                  >
                    ← 주제 수정
                  </button>
                  <button
                    type="button"
                    onClick={handleGenerateDraft}
                    disabled={isCreating}
                    className="h-10 rounded-lg bg-purple-600 px-5 text-sm font-medium text-white disabled:opacity-60"
                  >
                    {isCreating ? 'AI 원고 생성 중…' : '원고 생성 실행'}
                  </button>
                </div>
              </div>
            ) : null}

            {wizardStep === 'publish' && pipelineResult ? (
              <div className="flex flex-col gap-4">
                <div>
                  <h3 className="text-base font-semibold text-zinc-100">원고 생성 완료</h3>
                  <p className="mt-1 text-xs text-zinc-400">아래 결과를 확인하고 발행하거나, 상세 페이지에서 수정 후 발행할 수 있습니다.</p>
                </div>

                <div className="rounded-lg border border-green-900/40 bg-green-950/20 p-4">
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div><span className="text-zinc-500">상태:</span> <span className="text-green-400">{pipelineResult.status}</span></div>
                    <div><span className="text-zinc-500">slug:</span> <span className="text-zinc-200">{pipelineResult.slug}</span></div>
                    <div><span className="text-zinc-500">SEO 제목:</span> <span className="text-zinc-200">{pipelineResult.seo_title}</span></div>
                    <div><span className="text-zinc-500">태그:</span> <span className="text-zinc-200">{pipelineResult.tags?.join(', ') ?? '-'}</span></div>
                    <div><span className="text-zinc-500">템플릿 버전:</span> <span className="text-zinc-200">v{pipelineResult.template_version}</span></div>
                  </div>
                </div>

                <div className="flex items-center justify-between">
                  <Link
                    to={`/blog-posts/${createdPostId}`}
                    className="h-10 inline-flex items-center rounded-lg border border-zinc-800 bg-zinc-950 px-4 text-sm text-zinc-200"
                  >
                    상세 페이지에서 확인
                  </Link>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={closeWizard}
                      className="h-10 rounded-lg border border-zinc-800 bg-zinc-950 px-4 text-sm text-zinc-200"
                    >
                      초안으로 보관
                    </button>
                    <button
                      type="button"
                      onClick={handlePublishFromWizard}
                      disabled={isCreating}
                      className="h-10 rounded-lg bg-green-600 px-5 text-sm font-medium text-white disabled:opacity-60"
                    >
                      {isCreating ? '발행 중…' : '발행하기'}
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="rounded-xl border border-zinc-900 bg-zinc-900/30 p-4">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <label className="flex flex-col gap-2">
            <span className="text-xs text-zinc-400">검색</span>
            <input
              className="h-10 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="제목/본문 검색"
            />
          </label>
          <label className="flex flex-col gap-2">
            <span className="text-xs text-zinc-400">상태</span>
            <select
              className="h-10 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              <option value="">전체</option>
              <option value="draft">초안</option>
              <option value="published">발행</option>
              <option value="archived">보관</option>
            </select>
          </label>
          <label className="flex flex-col gap-2">
            <span className="text-xs text-zinc-400">카테고리</span>
            <input
              className="h-10 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="예: 마케팅"
            />
          </label>
        </div>
      </div>

      <div className="rounded-xl border border-zinc-900 bg-zinc-900/30">
        <div className="border-b border-zinc-900 px-4 py-3 text-xs text-zinc-500">
          {isLoading ? '불러오는 중…' : `${data?.total ?? 0}개 글`}
        </div>

        {!isLoading && data?.items.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-zinc-500">블로그 글이 없습니다.</div>
        ) : null}

        {data?.items.map((post) => (
          <Link
            key={post.id}
            to={`/blog-posts/${post.id}`}
            className="flex items-center gap-4 border-b border-zinc-900/60 px-4 py-3 transition hover:bg-zinc-900/40"
          >
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{post.title}</div>
              <div className="mt-1 truncate text-xs text-zinc-500">
                {post.category || 'general'}
                {post.tags?.length ? ` · ${post.tags.join(', ')}` : ''}
              </div>
              {post.excerpt ? <div className="mt-2 line-clamp-2 text-xs text-zinc-400">{post.excerpt}</div> : null}
            </div>
            <StatusBadge value={post.status} />
            <span className="shrink-0 text-xs text-zinc-600">
              {new Date(post.published_at ?? post.created_at).toLocaleDateString('ko-KR')}
            </span>
          </Link>
        ))}
      </div>
    </div>
  )
}
