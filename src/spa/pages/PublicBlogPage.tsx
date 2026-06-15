import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { applySeo } from '../lib/seo'
import { BLOG_AXES, BLOG_BRANDS, BLOG_SITE_DESCRIPTION, BLOG_SITE_NAME, classifyBlogAxis } from '../lib/blogTaxonomy'

type BlogPost = {
  id: string
  title: string
  excerpt: string
  category: string
  tags: string[]
  slug: string
  seo_description?: string
  featured_image?: string | null
  published_at: string | null
  created_at: string
}

type ListResponse = { items: BlogPost[]; total: number }

const KAKAO_CHAT_URL = 'https://pf.kakao.com/_wxexmxgn/chat'
const CONFERENCE_IMAGES = [
  { url: 'https://hongcomm.kr/img/page/c1.jpg', alt: '학회 현장 지류 명찰 자동 출력 시스템' },
  { url: 'https://hongcomm.kr/img/page/2.jpg', alt: '고속 명찰 자동 출력 장비 운영 현장' },
  { url: 'https://hongcomm.kr/img/page/b2.png', alt: '모바일 디지털 명찰 시스템 화면' },
  { url: 'https://hongcomm.kr/img/page/a1.png', alt: '학술대회 등록 시스템 화면' },
  { url: 'https://hongcomm.kr/img/page/6.jpg', alt: '행사 마스터 컨트롤러 통합 운영 시스템' },
]

const trustSignals = [
  '비오케이솔루션 개발 솔루션',
  '홍커뮤니케이션 MICE 레퍼런스',
  '학회·기관 홈페이지와 관리자 구축',
  '등록·결제·QR·명찰 운영 경험',
]

function formatDate(value: string | null) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString('ko-KR')
}

function stableImageIndex(post: BlogPost) {
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

export default function PublicBlogPage() {
  const [data, setData] = useState<ListResponse | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const posts = useMemo(() => data?.items ?? [], [data])
  const visiblePosts = posts
  const featured = visiblePosts[0]
  const articlePosts = featured ? visiblePosts.slice(1, 7) : visiblePosts.slice(0, 6)
  const featuredImage = featured ? displayImage(featured) : null
  const axisCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const post of posts) {
      const axis = classifyBlogAxis(post)
      counts.set(axis.key, (counts.get(axis.key) ?? 0) + 1)
    }
    return counts
  }, [posts])

  useEffect(() => {
    fetch('/api/blog-posts?status=published&limit=50')
      .then(r => r.json())
      .then(d => setData(d?.data ?? d))
      .catch(() => {})
      .finally(() => setIsLoading(false))
  }, [])

  useEffect(() => {
    const canonical = `${window.location.origin}/blog/`
    applySeo({
      title: BLOG_SITE_NAME,
      description: BLOG_SITE_DESCRIPTION,
      canonical,
      type: 'website',
      keywords: ['비오케이솔루션', '홈페이지 제작', '맞춤형 시스템 개발', '학회 운영', '명찰 출력', 'MICE', '홍커뮤니케이션'],
      jsonLd: [
        {
          '@context': 'https://schema.org',
          '@type': 'Blog',
          name: BLOG_SITE_NAME,
          description: BLOG_SITE_DESCRIPTION,
          url: canonical,
          inLanguage: 'ko-KR',
          publisher: {
            '@type': 'Organization',
            name: '비오케이솔루션',
            url: window.location.origin,
          },
        },
        {
          '@context': 'https://schema.org',
          '@type': 'ItemList',
          itemListElement: visiblePosts.slice(0, 20).map((post, index) => ({
            '@type': 'ListItem',
            position: index + 1,
            url: `${window.location.origin}/blog/${encodeURIComponent(post.slug || post.id)}`,
            name: post.title,
          })),
        },
      ],
    })
  }, [visiblePosts])

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-950 text-zinc-100">
        <p className="text-sm text-zinc-500">불러오는 중...</p>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800 bg-zinc-950">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link to="/blog/" className="text-sm font-semibold tracking-tight text-white">비오케이솔루션 · 홍커뮤니케이션</Link>
          <nav className="hidden items-center gap-6 text-sm text-zinc-400 md:flex">
            <a href="#articles" className="hover:text-white">최신 글</a>
            <a href="#services" className="hover:text-white">서비스</a>
            <a href="/blog/rss.xml" className="hover:text-white">RSS</a>
          </nav>
          <a
            href={KAKAO_CHAT_URL}
            target="_blank"
            rel="noreferrer"
            className="rounded-md border border-zinc-700 px-4 py-2 text-sm font-semibold text-zinc-100 hover:border-yellow-300 hover:text-yellow-200"
          >
            문의
          </a>
        </div>
      </header>

      <main>
        <section className="border-b border-zinc-800">
          <div className="mx-auto grid max-w-6xl gap-10 px-6 py-14 lg:grid-cols-[1.1fr_0.9fr] lg:py-18">
            <div>
              <p className="text-sm font-medium text-yellow-300">비오케이솔루션 × 홍커뮤니케이션 공식 블로그</p>
              <h1 className="mt-4 max-w-3xl text-4xl font-bold leading-tight text-white md:text-5xl">
                홈페이지·업무 시스템 개발과 MICE·학술대회 운영을 함께 정리합니다.
              </h1>
              <p className="mt-5 max-w-2xl text-base leading-7 text-zinc-400">
                비오케이솔루션의 개발 솔루션과 홍커뮤니케이션의 행사 운영 경험을 바탕으로, 의뢰 전에 확인해야 할 화면·데이터·권한·현장 동선을 사례와 체크리스트 중심으로 다룹니다.
              </p>
              <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                <a href="#articles" className="rounded-md bg-white px-5 py-3 text-center text-sm font-semibold text-zinc-950 hover:bg-zinc-200">
                  최신 글 보기
                </a>
                <a href="https://beoksolution.com" target="_blank" rel="noreferrer" className="rounded-md border border-yellow-300 px-5 py-3 text-center text-sm font-semibold text-yellow-200 hover:bg-yellow-300 hover:text-zinc-950">
                  비오케이솔루션
                </a>
                <a href="https://hongcomm.kr" target="_blank" rel="noreferrer" className="rounded-md border border-orange-300 px-5 py-3 text-center text-sm font-semibold text-orange-200 hover:bg-orange-300 hover:text-zinc-950">
                  홍커뮤니케이션
                </a>
              </div>
            </div>
            <div className="grid content-start gap-3 rounded-lg border border-zinc-800 bg-zinc-900/50 p-5">
              {trustSignals.map((item) => (
                <div key={item} className="flex items-center justify-between gap-4 border-b border-zinc-800 py-3 last:border-b-0">
                  <span className="text-sm text-zinc-300">{item}</span>
                  <span className="text-xs font-semibold text-yellow-300">확인</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="border-b border-zinc-800 bg-zinc-900/25">
          <div className="mx-auto max-w-6xl px-6 py-10">
            <div className="grid gap-4 md:grid-cols-2">
              {BLOG_BRANDS.map((brand) => (
                <a
                  key={brand.key}
                  href={brand.href}
                  target="_blank"
                  rel="noreferrer"
                  className="group rounded-lg border border-zinc-800 bg-zinc-950/70 p-5 transition hover:border-yellow-300/70 hover:bg-zinc-950"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className={`text-sm font-semibold ${brand.accent}`}>{brand.name}</p>
                      <h2 className="mt-2 text-xl font-bold text-white">{brand.label}</h2>
                    </div>
                    <span className="rounded-md border border-zinc-700 px-2.5 py-1 text-xs font-semibold text-zinc-400 group-hover:border-yellow-300 group-hover:text-yellow-200">
                      바로가기
                    </span>
                  </div>
                  <p className="mt-4 text-sm leading-6 text-zinc-400">{brand.description}</p>
                </a>
              ))}
            </div>
          </div>
        </section>

        <section id="articles" className="border-b border-zinc-800">
          <div className="mx-auto max-w-6xl px-6 py-14">
            <div className="flex items-end justify-between gap-6">
              <div>
                <h2 className="text-2xl font-bold text-white">최신 발행 글</h2>
                <p className="mt-3 text-sm leading-6 text-zinc-400">
                  비오케이솔루션과 홍커뮤니케이션의 서비스 맥락에서 홈페이지 제작, 시스템 개발, 학회·MICE 운영에 필요한 실무 글을 모았습니다.
                </p>
              </div>
              <span className="hidden rounded-md border border-zinc-800 px-3 py-2 text-xs font-semibold text-zinc-400 sm:block">
                공개 글 {posts.length}
              </span>
              <a href="/blog/rss.xml" className="hidden rounded-md border border-zinc-700 px-3 py-2 text-xs font-semibold text-zinc-300 hover:border-yellow-300 hover:text-yellow-200 sm:block">
                RSS
              </a>
            </div>

            {featured ? (
              <Link
                to={`/blog/${encodeURIComponent(featured.slug || featured.id)}`}
                className="group mt-8 grid gap-5 rounded-lg border border-zinc-800 bg-zinc-900/55 p-6 transition hover:border-yellow-300/70 hover:bg-zinc-900 md:grid-cols-[0.85fr_1.15fr]"
              >
                <div className="aspect-[16/10] overflow-hidden rounded-md border border-zinc-800 bg-zinc-950">
                  {featuredImage ? (
                    <img src={featuredImage.url} alt={featuredImage.alt} className="h-full w-full object-cover" />
                  ) : (
                    <div className="flex h-full items-center justify-center px-6 text-center text-sm text-zinc-500">비오케이솔루션 운영 인사이트</div>
                  )}
                </div>
                <div>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                    <span>{classifyBlogAxis(featured).shortLabel}</span>
                    <span>{formatDate(featured.published_at ?? featured.created_at)}</span>
                  </div>
                  <h3 className="mt-3 text-2xl font-bold leading-snug text-white group-hover:text-yellow-100">{featured.title}</h3>
                  <p className="mt-4 text-sm leading-7 text-zinc-400">
                    {featured.seo_description || featured.excerpt || '실무 운영 기준을 정리한 글입니다.'}
                  </p>
                </div>
              </Link>
            ) : null}

            <div className="mt-5 grid gap-4 lg:grid-cols-3">
              {articlePosts.map((post) => (
                <Link
                  key={post.id}
                  to={`/blog/${encodeURIComponent(post.slug || post.id)}`}
                  className="group rounded-lg border border-zinc-800 bg-zinc-900/45 p-5 transition hover:border-yellow-300/70 hover:bg-zinc-900"
                >
                  <div className="flex items-center justify-between gap-3 text-xs text-zinc-500">
                    <span>{classifyBlogAxis(post).shortLabel}</span>
                    <span>{formatDate(post.published_at ?? post.created_at)}</span>
                  </div>
                  <h3 className="mt-3 line-clamp-2 text-base font-semibold leading-6 text-zinc-100 group-hover:text-yellow-100">
                    {post.title}
                  </h3>
                  <p className="mt-3 line-clamp-3 text-sm leading-6 text-zinc-400">
                    {post.seo_description || post.excerpt || '실무 운영 기준을 정리한 글입니다.'}
                  </p>
                </Link>
              ))}
              {posts.length === 0 ? (
                <div className="rounded-lg border border-zinc-800 bg-zinc-900/45 p-5 text-sm text-zinc-500">
                  발행된 글이 없습니다.
                </div>
              ) : null}
            </div>
          </div>
        </section>

        <section id="services" className="border-b border-zinc-800 bg-zinc-900/25">
          <div className="mx-auto max-w-6xl px-6 py-14">
            <h2 className="text-2xl font-bold text-white">서비스 분야</h2>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-zinc-400">
              두 회사가 제공하는 개발·운영 범위에 따라 제작 방식, 운영 기능, 현장 대응 기준을 나눠 확인할 수 있습니다.
            </p>
            <div className="mt-8 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
              {BLOG_AXES.map((topic) => (
                <article key={topic.key} className="rounded-lg border border-zinc-800 bg-zinc-950/70 p-5">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className={`text-sm font-semibold ${topic.accent}`}>{topic.label}</h3>
                    <span className="text-xs font-semibold text-zinc-500">{axisCounts.get(topic.key) ?? 0}</span>
                  </div>
                  <p className="mt-3 text-sm leading-6 text-zinc-400">{topic.description}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-6 py-14">
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/45 p-6 md:flex md:items-center md:justify-between md:gap-8">
            <div>
              <h2 className="text-xl font-bold text-white">비오케이솔루션·홍커뮤니케이션이 함께 볼 수 있는 범위를 먼저 정리합니다.</h2>
              <p className="mt-3 text-sm leading-6 text-zinc-400">
                필요한 범위가 홈페이지인지, 관리자 시스템인지, 학회 접수·명찰 운영인지 알려주시면 개발과 현장 운영 흐름을 함께 검토합니다.
              </p>
            </div>
            <a
              href={KAKAO_CHAT_URL}
              target="_blank"
              rel="noreferrer"
              className="mt-5 block shrink-0 rounded-md bg-yellow-300 px-5 py-3 text-center text-sm font-semibold text-zinc-950 hover:bg-yellow-200 md:mt-0"
            >
              상담 문의
            </a>
          </div>
        </section>
      </main>

      <footer className="border-t border-zinc-800 py-6 text-center text-xs text-zinc-600">
        © {new Date().getFullYear()} 비오케이솔루션 · 홍커뮤니케이션
      </footer>
    </div>
  )
}
