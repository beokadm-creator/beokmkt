import { Link, useParams } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { applySeo } from '../lib/seo'
import { BeoksolutionLandingTemplate, isBeoksolutionLandingSchema, type BeoksolutionLandingSchema } from '../components/BeoksolutionLandingTemplate'

const KAKAO_CHAT_URL = 'https://pf.kakao.com/_wxexmxgn/chat'

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

export default function PublicBlogPostPage() {
  const { slug } = useParams()
  const [post, setPost] = useState<BlogPost | null>(null)
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
    const canonical = `${window.location.origin}/blog/${encodeURIComponent(post.slug || post.id)}`
    const description = post.seo_description || post.excerpt || `${post.title} 블로그 글`
    applySeo({
      title: post.seo_title || post.title,
      description,
      canonical,
      image: post.featured_image || undefined,
      type: 'article',
      keywords: [post.category, ...(post.tags ?? [])].filter(Boolean),
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
          articleSection: post.category || '일반',
          keywords: (post.tags ?? []).join(', '),
          image: post.featured_image ? [post.featured_image] : undefined,
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
                <span className="rounded-md border border-yellow-300/30 bg-yellow-300/10 px-3 py-1 font-bold text-yellow-200">{post.category || '운영 글'}</span>
                <time dateTime={post.published_at ?? post.created_at} className="font-medium">{publishedLabel}</time>
              </div>

              <h1 className="mt-5 max-w-4xl text-4xl font-black leading-tight text-white md:text-5xl">{post.title}</h1>

              {post.excerpt ? <p className="mt-5 max-w-3xl text-lg leading-8 text-zinc-300">{post.excerpt}</p> : null}

              <div className="mt-7 flex flex-wrap gap-3">
                <a href={KAKAO_CHAT_URL} target="_blank" rel="noopener" className="rounded-md bg-yellow-300 px-5 py-3 text-sm font-bold text-zinc-950 hover:bg-yellow-200">명찰 운영 상담</a>
                <a href="https://beoksolution.com" target="_blank" rel="noopener" className="rounded-md border border-zinc-700 bg-zinc-950 px-5 py-3 text-sm font-bold text-white hover:border-yellow-300">비오케이솔루션 보기</a>
              </div>
            </section>

            {post.featured_image ? (
            <img
              src={post.featured_image}
              alt={post.title}
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
                className="mt-10 max-w-none prose prose-invert prose-zinc prose-headings:text-zinc-100 prose-p:text-zinc-300 prose-a:no-underline prose-a:text-blue-300 prose-strong:text-white prose-li:text-zinc-300 prose-img:rounded-xl prose-table:block prose-table:overflow-x-auto prose-th:border prose-th:border-white/10 prose-th:bg-white/10 prose-th:px-3 prose-th:py-2 prose-td:border prose-td:border-white/10 prose-td:px-3 prose-td:py-2 [&_.summary-card]:not-prose [&_.summary-card]:mb-8 [&_.summary-card]:rounded-2xl [&_.summary-card]:border [&_.summary-card]:border-white/10 [&_.summary-card]:bg-white/[0.06] [&_.summary-card]:p-5 [&_.summary-kicker]:text-xs [&_.summary-kicker]:font-black [&_.summary-kicker]:uppercase [&_.summary-kicker]:tracking-[0.18em] [&_.summary-kicker]:text-emerald-200 [&_.summary-card_p]:mt-3 [&_.summary-card_p]:text-sm [&_.summary-card_p]:leading-7 [&_.summary-card_p]:text-zinc-300 [&_.summary-card_ul]:mt-4 [&_.summary-card_ul]:grid [&_.summary-card_ul]:gap-2 [&_.summary-card_li]:rounded-xl [&_.summary-card_li]:bg-black/20 [&_.summary-card_li]:px-3 [&_.summary-card_li]:py-2 [&_.summary-card_li]:text-sm [&_.summary-card_li]:text-zinc-200 [&_.summary-meta]:mt-4 [&_.summary-meta]:text-xs [&_.summary-meta]:text-zinc-500 [&_.soft-cta]:not-prose [&_.soft-cta]:mt-10 [&_.soft-cta]:rounded-2xl [&_.soft-cta]:border [&_.soft-cta]:border-emerald-300/20 [&_.soft-cta]:bg-emerald-300/10 [&_.soft-cta]:p-5 [&_.soft-cta_strong]:block [&_.soft-cta_strong]:text-lg [&_.soft-cta_strong]:font-black [&_.soft-cta_p]:mt-2 [&_.soft-cta_p]:text-sm [&_.soft-cta_p]:leading-7 [&_.soft-cta_p]:text-zinc-300 [&_.soft-cta_a]:mt-4 [&_.soft-cta_a]:inline-flex [&_.soft-cta_a]:rounded-xl [&_.soft-cta_a]:bg-white [&_.soft-cta_a]:px-4 [&_.soft-cta_a]:py-2 [&_.soft-cta_a]:text-sm [&_.soft-cta_a]:font-black [&_.soft-cta_a]:text-zinc-950"
                dangerouslySetInnerHTML={{ __html: post.content || '<p>본문이 없습니다.</p>' }}
              />
            )}
          </article>

          <aside className="hidden lg:block">
            <div className="sticky top-8 rounded-lg border border-zinc-800 bg-zinc-900/80 p-6 shadow-xl shadow-black/20 backdrop-blur">
              <p className="text-xs font-bold uppercase tracking-[0.18em] text-yellow-200">BOK SOLUTION</p>
              <h2 className="mt-3 text-2xl font-black leading-tight">학회 운영 사무국 명찰 출력</h2>
              <p className="mt-3 text-sm leading-7 text-zinc-300">참가자 명단, QR·바코드 확인, 현장 재발행 기준을 실제 운영 흐름에 맞춰 정리합니다.</p>
              <div className="mt-5 grid gap-2 text-sm text-zinc-300">
                <div className="rounded-md border border-zinc-800 bg-zinc-950/70 p-3">명단 정리와 오탈자 검수</div>
                <div className="rounded-md border border-zinc-800 bg-zinc-950/70 p-3">QR·바코드 식별값 확인</div>
                <div className="rounded-md border border-zinc-800 bg-zinc-950/70 p-3">현장 재발행 승인 동선</div>
                <div className="rounded-md border border-zinc-800 bg-zinc-950/70 p-3">공개 발행 URL 품질 확인</div>
              </div>
              <a href={KAKAO_CHAT_URL} target="_blank" rel="noopener" className="mt-5 flex w-full justify-center rounded-md bg-yellow-300 px-5 py-3 text-sm font-bold text-zinc-950 hover:bg-yellow-200">운영 상담하기</a>
            </div>
          </aside>
        </div>
      </main>
    </div>
  )
}
