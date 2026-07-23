import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiJson } from '../lib/api'

const workerUrl = (import.meta.env.VITE_BLOG_WORKER_URL as string | undefined) || 'http://localhost:8788'

type PortfolioItem = {
  wr_id: string
  title: string
  category: string
  venue: string
  date: string
  thumbUrl: string
  detailUrl: string
}

type ListResponse = {
  items: PortfolioItem[]
  page: number
}

const CATEGORIES = ['전체', '학회', '기업', '대학', '심포지움'] as const

const CATEGORY_COLORS: Record<string, string> = {
  학회: 'bg-blue-900/40 text-blue-300',
  기업: 'bg-green-900/40 text-green-300',
  대학: 'bg-purple-900/40 text-purple-300',
  심포지움: 'bg-amber-900/40 text-amber-300',
}

function categoryBadge(category: string) {
  const color = CATEGORY_COLORS[category] ?? 'bg-zinc-800 text-zinc-300'
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium ${color}`}>
      {category}
    </span>
  )
}

export default function PortfolioToNaverPage() {
  const navigate = useNavigate()

  const [items, setItems] = useState<PortfolioItem[]>([])
  const [page, setPage] = useState(1)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [activeCategory, setActiveCategory] = useState('전체')
  const [generatingId, setGeneratingId] = useState<string | null>(null)
  const [imgErrors, setImgErrors] = useState<Set<string>>(new Set())

  const filteredItems = useMemo(() => {
    if (activeCategory === '전체') return items
    return items.filter((item) => item.category === activeCategory)
  }, [items, activeCategory])

  const refresh = useCallback(async (p: number) => {
    setIsLoading(true)
    setError(null)
    try {
      const categoryParam = activeCategory !== '전체' ? `&category=${encodeURIComponent(activeCategory)}` : ''
      const res = await fetch(`${workerUrl}/portfolio-list?page=${p}${categoryParam}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setItems(data.items ?? [])
      setPage(data.page ?? p)
    } catch (e) {
      setError(e instanceof Error ? e.message : '포트폴리오 목록을 불러오지 못했습니다.')
    } finally {
      setIsLoading(false)
    }
  }, [activeCategory])

  useEffect(() => {
    refresh(1)
  }, [refresh])

  function handleImgError(wrId: string) {
    setImgErrors((prev) => new Set(prev).add(wrId))
  }

  async function handleGenerate(item: PortfolioItem) {
    if (
      !window.confirm(
        '이 행사로 네이버 원고를 생성할까요?\n행사 사진을 모두 포함해 작성합니다. 보통 20초 안팎이며, 응답이 지연되면 자동 재시도로 최대 수 분 걸릴 수 있어요.'
      )
    ) {
      return
    }
    setGeneratingId(item.wr_id)
    setError(null)
    try {
      const res = await fetch(`${workerUrl}/generate-portfolio`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ wr_id: item.wr_id }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
        throw new Error(err.error || `HTTP ${res.status}`)
      }
      const result = await res.json()
      if (!result.ok || !result.manuscript || !result.portfolio) {
        throw new Error('응답에 manuscript 또는 portfolio가 없습니다.')
      }
      
      // Save to Cloud Functions using Firebase auth
      const saveResult = await apiJson<{ data: { id: string } }>(
        '/api/portfolio-to-naver/save-generated',
        {
          method: 'POST',
          idempotencyKey: `portfolio-save-${item.wr_id}-${Date.now()}`,
          body: JSON.stringify({
            title: result.manuscript.seo_title || result.portfolio.title,
            content: result.manuscript.html,
            excerpt: result.manuscript.excerpt,
            category: 'portfolio-recap',
            tags: result.manuscript.tags,
            featured_image: result.portfolio.thumbUrl,
            seo_title: result.manuscript.seo_title,
            seo_description: result.manuscript.seo_description,
            source_portfolio: {
              wr_id: result.portfolio.wr_id,
              raw_url: result.portfolio.raw_url,
              event_name: result.portfolio.event_name || result.portfolio.title,
              venue: result.portfolio.venue,
              date: result.portfolio.date,
              category: result.portfolio.category,
              photos_count: result.portfolio.photos_count,
              selected_photos: result.portfolio.selected_photos,
            },
          }),
        }
      )
      
      navigate(`/blog-posts/${saveResult.data.id}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : '원고 생성에 실패했습니다.')
    } finally {
      setGeneratingId(null)
    }
  }

  const isGenerating = generatingId !== null

  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="text-sm font-semibold">포트폴리오 → 네이버 원고 생성</div>
        <p className="mt-1 text-xs text-zinc-400">
          hongcomm.kr 포트폴리오에서 행사를 골라 AI가 네이버용 후기 원고를 작성합니다.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {CATEGORIES.map((cat) => (
          <button
            key={cat}
            type="button"
            onClick={() => setActiveCategory(cat)}
            className={`h-8 rounded-lg px-3 text-xs font-medium transition ${
              activeCategory === cat
                ? 'bg-zinc-700 text-zinc-100'
                : 'bg-zinc-900 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
            }`}
          >
            {cat}
          </button>
        ))}
        <span className="ml-auto text-xs text-zinc-500">
          {page}페이지 · {filteredItems.length}건
        </span>
      </div>

      {error ? (
        <div className="flex items-center justify-between rounded-lg bg-red-900/20 p-3 text-sm text-red-400">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => refresh(page)}
            className="rounded border border-red-800 px-2 py-0.5 text-xs text-red-300 hover:bg-red-900/40"
          >
            재시도
          </button>
        </div>
      ) : null}

      {isGenerating ? (
        <div className="flex items-center justify-center gap-3 rounded-xl border border-amber-800/40 bg-amber-950/20 px-6 py-10">
          <svg
            className="h-5 w-5 animate-spin text-amber-400"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            />
          </svg>
          <span className="text-sm text-amber-200">
            AI 원고 생성 중… (보통 20초 안팎, 지연 시 자동 재시도)
          </span>
        </div>
      ) : null}

      {isLoading ? (
        <div className="flex justify-center py-10 text-sm text-zinc-500">불러오는 중…</div>
      ) : filteredItems.length === 0 ? (
        <div className="py-10 text-center text-sm text-zinc-500">불러온 포트폴리오가 없습니다.</div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {filteredItems.map((item) => (
            <div
              key={item.wr_id}
              className="flex flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/40"
            >
              <div className="relative aspect-video w-full bg-zinc-950">
                {!imgErrors.has(item.wr_id) && item.thumbUrl ? (
                  <img
                    src={item.thumbUrl}
                    alt={item.title}
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    onError={() => handleImgError(item.wr_id)}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-xs text-zinc-600">
                    이미지 없음
                  </div>
                )}
                <div className="absolute left-2 top-2">{categoryBadge(item.category)}</div>
              </div>

              <div className="flex flex-1 flex-col gap-1.5 p-3">
                <div className="line-clamp-2 text-sm font-medium text-zinc-100">{item.title}</div>
                <div className="text-xs text-zinc-500">
                  {item.venue}
                  {item.date ? ` · ${item.date}` : ''}
                </div>

                <div className="mt-auto pt-2">
                  <button
                    type="button"
                    onClick={() => handleGenerate(item)}
                    disabled={isGenerating}
                    className="h-9 w-full rounded-lg bg-green-600 px-3 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-60"
                  >
                    네이버 원고 생성
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center justify-center gap-2">
        <button
          type="button"
          disabled={page <= 1 || isLoading || isGenerating}
          onClick={() => refresh(page - 1)}
          className="h-9 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm text-zinc-200 disabled:opacity-40"
        >
          ← 이전
        </button>
        <span className="text-xs text-zinc-400">{page} 페이지</span>
        <button
          type="button"
          disabled={isLoading || isGenerating}
          onClick={() => refresh(page + 1)}
          className="h-9 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm text-zinc-200 disabled:opacity-40"
        >
          다음 →
        </button>
      </div>
    </div>
  )
}
