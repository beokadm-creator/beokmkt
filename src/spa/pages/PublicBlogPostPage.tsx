import { Link, useParams } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { applySeo } from '../lib/seo'
import { BeoksolutionLandingTemplate, isBeoksolutionLandingSchema, type BeoksolutionLandingSchema } from '../components/BeoksolutionLandingTemplate'
import { BLOG_BRANDS, classifyBlogAxis } from '../lib/blogTaxonomy'

const KAKAO_CHAT_URL = 'https://pf.kakao.com/_wxexmxgn/chat'
const CONFERENCE_IMAGES = [
  { url: 'https://hongcomm.kr/img/page/c1.jpg', alt: '학회 현장 지류 명찰 자동 출력 시스템' },
  { url: 'https://hongcomm.kr/img/page/2.jpg', alt: '고속 명찰 자동 출력 장비 운영 현장' },
  { url: 'https://hongcomm.kr/img/page/b2.png', alt: '모바일 디지털 명찰 시스템 화면' },
  { url: 'https://hongcomm.kr/img/page/a1.png', alt: '학술대회 등록 시스템 화면' },
  { url: 'https://hongcomm.kr/img/page/6.jpg', alt: '행사 마스터 컨트롤러 통합 운영 시스템' },
]

type TocItem = {
  id: string
  text: string
  level: 2 | 3
}

function normalizeRenderedContent(html: string) {
  return String(html || '')
    .replace(/<article\b[^>]*>\s*<header\b[\s\S]*?<\/header>/i, '')
    .replace(/<\/article>\s*$/i, '')
    .replace(/<h1\b([^>]*)>/gi, '<h2$1>')
    .replace(/<\/h1>/gi, '</h2>')
    .trim()
}

function stripHtml(html: string) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

function headingId(text: string, index: number) {
  const normalized = text
    .replace(/<[^>]+>/g, '')
    .replace(/&[^;]+;/g, '')
    .replace(/[^\w가-힣\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 46)
  return normalized ? `section-${normalized}-${index}` : `section-${index}`
}

function enhanceContent(html: string) {
  const toc: TocItem[] = []
  let index = 0
  const body = html.replace(/<h([23])\b([^>]*)>([\s\S]*?)<\/h\1>/gi, (match, levelRaw, attrs, inner) => {
    const level = Number(levelRaw) as 2 | 3
    const text = stripHtml(inner)
    if (!text) return match
    index += 1
    const existingId = String(attrs || '').match(/\sid=["']([^"']+)["']/i)?.[1]
    const id = existingId || headingId(text, index)
    toc.push({ id, text, level })
    if (existingId) return match
    return `<h${level}${attrs} id="${id}">${inner}</h${level}>`
  })
  const plain = stripHtml(body)
  return {
    html: body,
    toc,
    chars: plain.length,
    readingMinutes: Math.max(1, Math.ceil(plain.length / 650)),
    images: (body.match(/<img\b/gi) || []).length,
    tables: (body.match(/<table\b/gi) || []).length,
  }
}

function wordCountForJsonLd(html: string) {
  const plain = stripHtml(html)
  if (!plain) return undefined
  return plain.split(/\s+/).filter(Boolean).length
}

function displayCategory(post: Pick<BlogPost, 'category' | 'title' | 'tags'> & Partial<Pick<BlogPost, 'excerpt' | 'seo_description'>>) {
  return classifyBlogAxis(post).shortLabel
}

function stableImageIndex(post: Pick<BlogPost, 'id' | 'title' | 'category'>) {
  const source = `${post.id} ${post.title} ${post.category}`
  let hash = 0
  for (let i = 0; i < source.length; i += 1) {
    hash = ((hash << 5) - hash + source.charCodeAt(i)) | 0
  }
  return Math.abs(hash) % CONFERENCE_IMAGES.length
}

function displayImage(post: BlogPost) {
  if (post.featured_image) return { url: post.featured_image, alt: post.title }
  const axis = classifyBlogAxis(post)
  return axis.key === 'conference' || axis.key === 'mice' ? CONFERENCE_IMAGES[stableImageIndex(post)] : null
}

type BlogPost = {
  id: string
  title: string
  content: string
  excerpt: string
  category: string
  tags: string[]
  slug: string
  seo_title: string
  seo_description: string
  featured_image: string | null
  published_at: string | null
  created_at: string
  updated_at?: string
  content_schema?: BeoksolutionLandingSchema | null
}

function relatedScore(current: BlogPost, candidate: BlogPost) {
  if (current.id === candidate.id) return -1
  if (current.slug && candidate.slug && current.slug === candidate.slug) return -1
  if (current.title.trim() === candidate.title.trim()) return -1
  const currentTags = new Set((current.tags ?? []).map((tag) => tag.toLowerCase()))
  const candidateTags = (candidate.tags ?? []).map((tag) => tag.toLowerCase())
  const tagOverlap = candidateTags.filter((tag) => currentTags.has(tag)).length
  const categoryMatch = current.category && candidate.category === current.category ? 1 : 0
  const axisMatch = classifyBlogAxis(current).key === classifyBlogAxis(candidate).key ? 1 : 0
  return tagOverlap * 3 + categoryMatch * 2 + axisMatch
}

function pickRelatedPosts(current: BlogPost, posts: BlogPost[], limit = 3) {
  return posts
    .map((candidate) => ({ candidate, score: relatedScore(current, candidate) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      const da = a.candidate.published_at ?? a.candidate.created_at
      const db = b.candidate.published_at ?? b.candidate.created_at
      return db.localeCompare(da)
    })
    .slice(0, limit)
    .map((entry) => entry.candidate)
}

function RelatedPostsSection({ posts }: { posts: BlogPost[] }) {
  if (!posts.length) return null
  return (
    <section className="mt-10 rounded-lg border border-white/10 bg-white/[0.04] p-5">
      <div className="flex items-end justify-between gap-4">
        <div>
          <p className="text-xs font-black uppercase tracking-[0.18em] text-yellow-200">NEXT READING</p>
          <h2 className="mt-2 text-xl font-black text-white">함께 읽으면 좋은 글</h2>
        </div>
        <Link to="/blog/" className="shrink-0 text-xs font-semibold text-zinc-400 hover:text-white">
          전체 보기
        </Link>
      </div>
      <div className="mt-5 grid gap-3 md:grid-cols-3">
        {posts.map((item) => (
          <Link
            key={item.id}
            to={`/blog/${encodeURIComponent(item.slug || item.id)}`}
            className="group rounded-lg border border-zinc-800 bg-zinc-950/70 p-4 hover:border-yellow-300/60 hover:bg-zinc-900"
          >
            <div className="flex items-center gap-2 text-[11px] text-zinc-500">
              <span>{displayCategory(item)}</span>
              <span>{new Date(item.published_at ?? item.created_at).toLocaleDateString('ko-KR')}</span>
            </div>
            <h3 className="mt-2 line-clamp-2 text-sm font-bold leading-6 text-zinc-100 group-hover:text-yellow-100">
              {item.title}
            </h3>
            <p className="mt-2 line-clamp-3 text-xs leading-5 text-zinc-500">
              {item.seo_description || item.excerpt || '관련 운영 기준을 정리한 글입니다.'}
            </p>
          </Link>
        ))}
      </div>
    </section>
  )
}

export default function PublicBlogPostPage() {
  const { slug } = useParams()
  const [post, setPost] = useState<BlogPost | null>(null)
  const [relatedPosts, setRelatedPosts] = useState<BlogPost[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!slug) {
      setError('글을 찾을 수 없습니다.')
      setIsLoading(false)
      return
    }

    fetch(`/api/blog-posts/slug/${encodeURIComponent(slug)}`)
      .then(async (r) => {
        const payload = await r.json().catch(() => null)
        if (!r.ok) throw new Error(payload?.error?.message || '글을 불러오지 못했습니다.')
        return payload?.data ?? payload
      })
      .then((data) => setPost(data))
      .catch((e) => setError(e instanceof Error ? e.message : '글을 불러오지 못했습니다.'))
      .finally(() => setIsLoading(false))
  }, [slug])

  useEffect(() => {
    if (!post) return

    const controller = new AbortController()
    fetch('/api/blog-posts?status=published&limit=50', { signal: controller.signal })
      .then(async (r) => {
        const payload = await r.json().catch(() => null)
        if (!r.ok) throw new Error('관련 글을 불러오지 못했습니다.')
        return (payload?.data ?? payload)?.items ?? []
      })
      .then((items: BlogPost[]) => setRelatedPosts(pickRelatedPosts(post, items)))
      .catch((e) => {
        if (e instanceof DOMException && e.name === 'AbortError') return
        setRelatedPosts([])
      })

    return () => controller.abort()
  }, [post])

  useEffect(() => {
    if (!post) return
    const canonical = `${window.location.origin}/blog/${encodeURIComponent(post.slug || post.id)}`
    const description = post.seo_description || post.excerpt || `${post.title} 블로그 글`
    const category = displayCategory(post)
    const contentStats = enhanceContent(normalizeRenderedContent(post.content || ''))
    const wordCount = wordCountForJsonLd(post.content || '')
    const seoImage = displayImage(post)
    applySeo({
      title: post.seo_title || post.title,
      description,
      canonical,
      image: seoImage?.url,
      type: 'article',
      keywords: [category, ...(post.tags ?? [])].filter(Boolean),
      publishedTime: post.published_at ?? post.created_at,
      modifiedTime: post.updated_at ?? post.published_at ?? post.created_at,
      jsonLd: [
        {
          '@context': 'https://schema.org',
          '@type': 'BlogPosting',
          headline: post.seo_title || post.title,
          description,
          url: canonical,
          mainEntityOfPage: canonical,
          datePublished: post.published_at ?? post.created_at,
          dateModified: post.updated_at ?? post.published_at ?? post.created_at,
          inLanguage: 'ko-KR',
          articleSection: category,
          wordCount,
          timeRequired: `PT${contentStats.readingMinutes}M`,
          keywords: (post.tags ?? []).join(', '),
          image: seoImage ? [seoImage.url] : undefined,
          author: {
            '@type': 'Organization',
            name: '비오케이솔루션',
          },
          publisher: {
            '@type': 'Organization',
            name: '비오케이솔루션',
            url: window.location.origin,
          },
        },
        {
          '@context': 'https://schema.org',
          '@type': 'BreadcrumbList',
          itemListElement: [
            {
              '@type': 'ListItem',
              position: 1,
              name: '블로그',
              item: `${window.location.origin}/blog/`,
            },
            {
              '@type': 'ListItem',
              position: 2,
              name: post.title,
              item: canonical,
            },
          ],
        },
      ],
    })
  }, [post])

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-950 text-zinc-100">
        <p className="text-sm text-zinc-500">불러오는 중…</p>
      </div>
    )
  }

  if (error || !post) {
    return (
      <div className="min-h-screen bg-zinc-950 px-6 py-20 text-zinc-100">
        <div className="mx-auto max-w-3xl">
          <Link to="/blog" className="text-sm text-zinc-400 hover:text-zinc-200">
            ← 블로그 목록으로
          </Link>
          <div className="mt-10 rounded-2xl border border-zinc-800 bg-zinc-900/50 p-8">
            <h1 className="text-xl font-semibold">글을 찾을 수 없습니다.</h1>
            <p className="mt-3 text-sm text-zinc-400">{error ?? '삭제되었거나 아직 공개되지 않은 글입니다.'}</p>
          </div>
        </div>
      </div>
    )
  }

  const publishedLabel = new Date(post.published_at ?? post.created_at).toLocaleDateString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\. /g, '.').replace(/\.$/, '')
  const content = enhanceContent(normalizeRenderedContent(post.content || '<p>본문이 없습니다.</p>'))
  const categoryLabel = displayCategory(post)
  const axis = classifyBlogAxis(post)
  const heroImage = displayImage(post)

  return (
    <div className="min-h-screen overflow-hidden bg-zinc-950 text-white">
      <div className="pointer-events-none fixed inset-0 bg-[linear-gradient(180deg,rgba(250,204,21,0.08),transparent_220px),linear-gradient(90deg,rgba(39,39,42,0.45)_1px,transparent_1px),linear-gradient(180deg,rgba(39,39,42,0.35)_1px,transparent_1px)] bg-[length:auto,48px_48px,48px_48px]" />
      <main className="relative mx-auto max-w-6xl px-5 py-8 md:px-8 md:py-12">
        <div className="mb-8 flex items-center justify-between gap-4 rounded-lg border border-zinc-800 bg-zinc-950/85 px-4 py-3 backdrop-blur">
          <Link to="/blog" className="text-sm font-medium text-zinc-300 hover:text-white">
            ← 블로그
          </Link>
          <a href={KAKAO_CHAT_URL} target="_blank" rel="noopener" className="rounded-md bg-yellow-300 px-4 py-2 text-sm font-bold text-zinc-950 hover:bg-yellow-200">상담 문의</a>
        </div>
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_320px]">
          <article className="min-w-0">
            <section className="rounded-lg border border-zinc-800 bg-zinc-900/70 p-6 shadow-xl shadow-black/20 backdrop-blur md:p-10">

              <div className="flex flex-wrap items-center gap-3 text-xs text-zinc-400">
                <span className="rounded-md border border-yellow-300/30 bg-yellow-300/10 px-3 py-1 font-bold text-yellow-200">{categoryLabel}</span>
                <time dateTime={post.published_at ?? post.created_at} className="font-medium">{publishedLabel}</time>
                <span className="rounded-md border border-zinc-700 px-3 py-1 text-zinc-300">읽기 {content.readingMinutes}분</span>
                <span className="rounded-md border border-zinc-700 px-3 py-1 text-zinc-300">소제목 {content.toc.length}</span>
              </div>

              <h1 className="mt-5 max-w-4xl text-4xl font-black leading-tight text-white md:text-5xl">{post.title}</h1>

              {post.excerpt ? <p className="mt-5 max-w-3xl text-lg leading-8 text-zinc-300">{post.excerpt}</p> : null}

              <div className="mt-7 flex flex-wrap gap-3">
                <a href={KAKAO_CHAT_URL} target="_blank" rel="noopener" className="rounded-md bg-yellow-300 px-5 py-3 text-sm font-bold text-zinc-950 hover:bg-yellow-200">상담 문의</a>
                <a href="https://beoksolution.com" target="_blank" rel="noopener" className="rounded-md border border-zinc-700 bg-zinc-950 px-5 py-3 text-sm font-bold text-white hover:border-yellow-300">비오케이솔루션 보기</a>
                <a href="https://hongcomm.kr" target="_blank" rel="noopener" className="rounded-md border border-zinc-700 bg-zinc-950 px-5 py-3 text-sm font-bold text-white hover:border-orange-300">홍커뮤니케이션 보기</a>
              </div>
            </section>

            {heroImage ? (
            <img
              src={heroImage.url}
              alt={heroImage.alt}
              className="mt-8 w-full rounded-2xl border border-zinc-800 object-cover"
              loading="eager"
            />
          ) : null}

            {post.tags?.length ? (
            <div className="mt-5 flex flex-wrap gap-2">
              {post.tags.map((tag) => (
                <span key={tag} className="rounded-full border border-zinc-800 px-3 py-1 text-xs text-zinc-400">
                  #{tag}
                </span>
              ))}
            </div>
          ) : null}

            {isBeoksolutionLandingSchema(post.content_schema) ? (
              <BeoksolutionLandingTemplate schema={post.content_schema} />
            ) : (
              <div
                className="mt-10 max-w-none scroll-mt-6 prose prose-invert prose-zinc prose-headings:scroll-mt-24 prose-headings:text-zinc-100 prose-h2:mt-12 prose-h2:border-t prose-h2:border-zinc-800 prose-h2:pt-8 prose-p:text-zinc-300 prose-a:no-underline prose-a:text-blue-300 prose-strong:text-white prose-li:text-zinc-300 prose-img:rounded-xl prose-table:block prose-table:overflow-x-auto prose-th:border prose-th:border-white/10 prose-th:bg-white/10 prose-th:px-3 prose-th:py-2 prose-td:border prose-td:border-white/10 prose-td:px-3 prose-td:py-2 [&_.summary-card]:not-prose [&_.summary-card]:mb-8 [&_.summary-card]:rounded-2xl [&_.summary-card]:border [&_.summary-card]:border-white/10 [&_.summary-card]:bg-white/[0.06] [&_.summary-card]:p-5 [&_.summary-kicker]:text-xs [&_.summary-kicker]:font-black [&_.summary-kicker]:uppercase [&_.summary-kicker]:tracking-[0.18em] [&_.summary-kicker]:text-emerald-200 [&_.summary-card_p]:mt-3 [&_.summary-card_p]:text-sm [&_.summary-card_p]:leading-7 [&_.summary-card_p]:text-zinc-300 [&_.summary-card_ul]:mt-4 [&_.summary-card_ul]:grid [&_.summary-card_ul]:gap-2 [&_.summary-card_li]:rounded-xl [&_.summary-card_li]:bg-black/20 [&_.summary-card_li]:px-3 [&_.summary-card_li]:py-2 [&_.summary-card_li]:text-sm [&_.summary-card_li]:text-zinc-200 [&_.summary-head]:flex [&_.summary-head]:items-center [&_.summary-head]:justify-between [&_.summary-head]:gap-3 [&_.summary-time]:rounded-full [&_.summary-time]:border [&_.summary-time]:border-white/10 [&_.summary-time]:px-2 [&_.summary-time]:py-1 [&_.summary-time]:text-xs [&_.summary-time]:text-zinc-400 [&_.summary-decision]:mt-4 [&_.summary-decision]:grid [&_.summary-decision]:gap-1 [&_.summary-decision]:rounded-xl [&_.summary-decision]:border [&_.summary-decision]:border-emerald-300/20 [&_.summary-decision]:bg-emerald-300/10 [&_.summary-decision]:p-3 [&_.summary-decision_strong]:text-xs [&_.summary-decision_strong]:font-black [&_.summary-decision_strong]:text-emerald-200 [&_.summary-decision_span]:text-sm [&_.summary-decision_span]:leading-6 [&_.summary-decision_span]:text-zinc-200 [&_.service-proof]:not-prose [&_.service-proof]:mb-8 [&_.service-proof]:rounded-2xl [&_.service-proof]:border [&_.service-proof]:border-white/10 [&_.service-proof]:bg-white/[0.05] [&_.service-proof]:p-5 [&_.proof-kicker]:text-xs [&_.proof-kicker]:font-black [&_.proof-kicker]:uppercase [&_.proof-kicker]:tracking-[0.18em] [&_.proof-kicker]:text-yellow-200 [&_.service-proof_p]:mt-3 [&_.service-proof_p]:text-sm [&_.service-proof_p]:leading-7 [&_.service-proof_p]:text-zinc-300 [&_.service-proof_ul]:mt-4 [&_.service-proof_ul]:grid [&_.service-proof_ul]:gap-3 md:[&_.service-proof_ul]:grid-cols-2 [&_.service-proof_li]:rounded-xl [&_.service-proof_li]:border [&_.service-proof_li]:border-white/10 [&_.service-proof_li]:bg-black/20 [&_.service-proof_li]:p-4 [&_.service-proof_li_strong]:block [&_.service-proof_li_strong]:text-sm [&_.service-proof_li_strong]:font-black [&_.service-proof_li_strong]:text-zinc-100 [&_.service-proof_li_span]:mt-1 [&_.service-proof_li_span]:block [&_.service-proof_li_span]:text-xs [&_.service-proof_li_span]:leading-6 [&_.service-proof_li_span]:text-zinc-400 [&_.soft-cta]:not-prose [&_.soft-cta]:mt-10 [&_.soft-cta]:rounded-2xl [&_.soft-cta]:border [&_.soft-cta]:border-emerald-300/20 [&_.soft-cta]:bg-emerald-300/10 [&_.soft-cta]:p-5 [&_.soft-cta_strong]:block [&_.soft-cta_strong]:text-lg [&_.soft-cta_strong]:font-black [&_.soft-cta_p]:mt-2 [&_.soft-cta_p]:text-sm [&_.soft-cta_p]:leading-7 [&_.soft-cta_p]:text-zinc-300 [&_.soft-cta_a]:mt-4 [&_.soft-cta_a]:inline-flex [&_.soft-cta_a]:rounded-xl [&_.soft-cta_a]:bg-white [&_.soft-cta_a]:px-4 [&_.soft-cta_a]:py-2 [&_.soft-cta_a]:text-sm [&_.soft-cta_a]:font-black [&_.soft-cta_a]:text-zinc-950"
                dangerouslySetInnerHTML={{ __html: content.html }}
              />
            )}

            <RelatedPostsSection posts={relatedPosts} />
          </article>

          <aside className="hidden lg:block">
            <div className="sticky top-8 space-y-4">
              <div className="rounded-lg border border-zinc-800 bg-zinc-900/80 p-6 shadow-xl shadow-black/20 backdrop-blur">
                <p className="text-xs font-bold uppercase tracking-[0.18em] text-yellow-200">ARTICLE MAP</p>
                <div className="mt-4 grid grid-cols-3 gap-2 text-center">
                  <div className="rounded-md border border-zinc-800 bg-zinc-950/70 p-2">
                    <div className="text-base font-black tabular-nums text-white">{content.readingMinutes}</div>
                    <div className="text-[11px] text-zinc-500">분</div>
                  </div>
                  <div className="rounded-md border border-zinc-800 bg-zinc-950/70 p-2">
                    <div className="text-base font-black tabular-nums text-white">{content.images}</div>
                    <div className="text-[11px] text-zinc-500">이미지</div>
                  </div>
                  <div className="rounded-md border border-zinc-800 bg-zinc-950/70 p-2">
                    <div className="text-base font-black tabular-nums text-white">{content.tables}</div>
                    <div className="text-[11px] text-zinc-500">표</div>
                  </div>
                </div>
                {content.toc.length ? (
                  <nav className="mt-5 border-t border-zinc-800 pt-4">
                    <div className="text-xs font-semibold text-zinc-500">본문 목차</div>
                    <div className="mt-3 max-h-[280px] space-y-2 overflow-y-auto pr-1">
                      {content.toc.slice(0, 12).map((item) => (
                        <a
                          key={item.id}
                          href={`#${item.id}`}
                          className={[
                            'block rounded-md px-2 py-1.5 text-xs leading-5 text-zinc-400 hover:bg-zinc-800 hover:text-white',
                            item.level === 3 ? 'ml-3' : '',
                          ].join(' ')}
                        >
                          {item.text}
                        </a>
                      ))}
                    </div>
                  </nav>
                ) : null}
              </div>
              <div className="rounded-lg border border-zinc-800 bg-zinc-900/80 p-6 shadow-xl shadow-black/20 backdrop-blur">
                <p className="text-xs font-bold uppercase tracking-[0.18em] text-yellow-200">SERVICE CONTEXT</p>
                <h2 className="mt-3 text-2xl font-black leading-tight">{axis.label}</h2>
                <p className="mt-3 text-sm leading-7 text-zinc-300">{axis.description}</p>
                <div className="mt-5 grid gap-2 text-sm text-zinc-300">
                  {axis.terms.slice(0, 4).map((term) => (
                    <div key={term} className="rounded-md border border-zinc-800 bg-zinc-950/70 p-3">{term}</div>
                  ))}
                </div>
                <a href={KAKAO_CHAT_URL} target="_blank" rel="noopener" className="mt-5 flex w-full justify-center rounded-md bg-yellow-300 px-5 py-3 text-sm font-bold text-zinc-950 hover:bg-yellow-200">운영 상담하기</a>
              </div>
              <div className="rounded-lg border border-zinc-800 bg-zinc-900/80 p-6 shadow-xl shadow-black/20 backdrop-blur">
                <p className="text-xs font-bold uppercase tracking-[0.18em] text-yellow-200">PROMOTION BLOG</p>
                <h2 className="mt-3 text-2xl font-black leading-tight">비오케이솔루션 · 홍커뮤니케이션</h2>
                <div className="mt-5 grid gap-3">
                  {BLOG_BRANDS.map((brand) => (
                    <a
                      key={brand.key}
                      href={brand.href}
                      target="_blank"
                      rel="noopener"
                      className="rounded-md border border-zinc-800 bg-zinc-950/70 p-4 hover:border-yellow-300/60"
                    >
                      <p className={`text-sm font-black ${brand.accent}`}>{brand.name}</p>
                      <p className="mt-1 text-sm font-semibold text-white">{brand.label}</p>
                      <p className="mt-2 text-xs leading-5 text-zinc-400">{brand.description}</p>
                    </a>
                  ))}
                </div>
              </div>
            </div>
          </aside>
        </div>
      </main>
    </div>
  )
}
