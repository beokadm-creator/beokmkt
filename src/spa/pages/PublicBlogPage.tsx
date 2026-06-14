import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { applySeo } from '../lib/seo'

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
  'https://hongcomm.kr/img/page/c1.jpg',
  'https://hongcomm.kr/img/page/2.jpg',
  'https://hongcomm.kr/img/page/b2.png',
  'https://hongcomm.kr/img/page/a1.png',
  'https://hongcomm.kr/img/page/6.jpg',
]

const focusTopics = [
  { label: '명단 데이터', desc: '이름, 소속, 직함, 등록 구분, QR 식별값을 출력 전 같은 기준으로 검수합니다.' },
  { label: '출력 운영', desc: '재단선, 용지, 케이스, 현장 프린터, 여분 자재까지 사무국 체크리스트로 정리합니다.' },
  { label: '현장 재발행', desc: '오탈자, 당일 등록, 직함 변경을 승인 기준과 출력 로그로 관리합니다.' },
  { label: '발행 자동화', desc: '자체 블로그, 티스토리, 네이버 발행 결과를 실제 URL과 품질 지표로 확인합니다.' },
]

const trustSignals = [
  '등록·결제·QR 출결 운영 경험',
  '학회·기관 홈페이지와 관리자 구축',
  '현장 접수와 명찰 출력 동선 이해',
  '발행 후 공개 URL 품질 확인',
]

function formatDate(value: string | null) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString('ko-KR')
}

function isConferenceBadgePost(post: Pick<BlogPost, 'category' | 'title' | 'tags'>) {
  const haystack = `${post.title} ${post.category} ${(post.tags ?? []).join(' ')}`
  return /학회|명찰|사무국|재발행|참가자|바코드|QR/i.test(haystack)
}

function displayCategory(post: Pick<BlogPost, 'category' | 'title' | 'tags'>) {
  if (isConferenceBadgePost(post)) return '학회운영'
  return post.category || '블로그'
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
  return isConferenceBadgePost(post) ? CONFERENCE_IMAGES[stableImageIndex(post)] : post.featured_image
}

export default function PublicBlogPage() {
  const [data, setData] = useState<ListResponse | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const posts = useMemo(() => data?.items ?? [], [data])
  const featured = posts[0]
  const articlePosts = featured ? posts.slice(1, 7) : posts.slice(0, 6)

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
      title: '비오케이솔루션 학회 운영 사무국 명찰 출력 발행',
      description: '학회 운영 사무국의 명찰 출력, 현장 재발행, 참가자 데이터 정리와 발행 자동화 실무 콘텐츠입니다.',
      canonical,
      type: 'website',
      keywords: ['학회 운영', '사무국', '명찰 출력', '현장 재발행', '참가자 데이터', '비오케이솔루션'],
      jsonLd: [
        {
          '@context': 'https://schema.org',
          '@type': 'Blog',
          name: '비오케이솔루션 학회 운영 사무국 명찰 출력 발행',
          description: '학회 운영, 명찰 출력, 현장 재발행, 참가자 데이터 정리 관련 실무형 인사이트',
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
          itemListElement: posts.slice(0, 20).map((post, index) => ({
            '@type': 'ListItem',
            position: index + 1,
            url: `${window.location.origin}/blog/${encodeURIComponent(post.slug || post.id)}`,
            name: post.title,
          })),
        },
      ],
    })
  }, [posts])

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
          <Link to="/blog/" className="text-sm font-semibold tracking-tight text-white">비오케이솔루션</Link>
          <nav className="hidden items-center gap-6 text-sm text-zinc-400 md:flex">
            <a href="#articles" className="hover:text-white">최신 글</a>
            <a href="#topics" className="hover:text-white">운영 주제</a>
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
              <p className="text-sm font-medium text-yellow-300">학회 운영 · 사무국 데이터 · 명찰 출력</p>
              <h1 className="mt-4 max-w-3xl text-4xl font-bold leading-tight text-white md:text-5xl">
                명찰 출력과 현장 재발행을 사무국 기준으로 정리합니다.
              </h1>
              <p className="mt-5 max-w-2xl text-base leading-7 text-zinc-400">
                참가자 명단 검수, QR·바코드 확인, 출력 자재, 현장 재발행 승인, 공개 발행 검증까지 실제 운영에 필요한 기준만 모읍니다.
              </p>
              <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                <a href="#articles" className="rounded-md bg-white px-5 py-3 text-center text-sm font-semibold text-zinc-950 hover:bg-zinc-200">
                  최신 글 보기
                </a>
                <a href="#topics" className="rounded-md border border-yellow-300 px-5 py-3 text-center text-sm font-semibold text-yellow-200 hover:bg-yellow-300 hover:text-zinc-950">
                  운영 주제 보기
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

        <section id="articles" className="border-b border-zinc-800">
          <div className="mx-auto max-w-6xl px-6 py-14">
            <div className="flex items-end justify-between gap-6">
              <div>
                <h2 className="text-2xl font-bold text-white">최신 발행 글</h2>
                <p className="mt-3 text-sm leading-6 text-zinc-400">
                  공개 URL로 확인된 글을 기준으로 명찰 출력과 현장 운영 기준을 추적합니다.
                </p>
              </div>
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
                  {displayImage(featured) ? (
                    <img src={displayImage(featured) || ''} alt={featured.title} className="h-full w-full object-cover" />
                  ) : (
                    <div className="flex h-full items-center justify-center px-6 text-center text-sm text-zinc-500">비오케이솔루션 운영 인사이트</div>
                  )}
                </div>
                <div>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                    <span>{displayCategory(featured)}</span>
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
                    <span>{displayCategory(post)}</span>
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

        <section id="topics" className="border-b border-zinc-800 bg-zinc-900/25">
          <div className="mx-auto max-w-6xl px-6 py-14">
            <h2 className="text-2xl font-bold text-white">운영 주제</h2>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-zinc-400">
              콘텐츠는 검색 유입보다 먼저 실제 사무국이 반복 확인하는 절차를 기준으로 분류합니다.
            </p>
            <div className="mt-8 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
              {focusTopics.map((topic) => (
                <article key={topic.label} className="rounded-lg border border-zinc-800 bg-zinc-950/70 p-5">
                  <h3 className="text-sm font-semibold text-yellow-200">{topic.label}</h3>
                  <p className="mt-3 text-sm leading-6 text-zinc-400">{topic.desc}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-6 py-14">
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/45 p-6 md:flex md:items-center md:justify-between md:gap-8">
            <div>
              <h2 className="text-xl font-bold text-white">현장 운영 자료가 필요하면 사무국 기준으로 먼저 정리합니다.</h2>
              <p className="mt-3 text-sm leading-6 text-zinc-400">
                행사 규모, 명단 형식, 출력 방식, 현장 재발행 동선을 알려주시면 필요한 체크리스트와 운영 흐름을 맞춰봅니다.
              </p>
            </div>
            <a
              href={KAKAO_CHAT_URL}
              target="_blank"
              rel="noreferrer"
              className="mt-5 block shrink-0 rounded-md bg-yellow-300 px-5 py-3 text-center text-sm font-semibold text-zinc-950 hover:bg-yellow-200 md:mt-0"
            >
              운영 상담
            </a>
          </div>
        </section>
      </main>

      <footer className="border-t border-zinc-800 py-6 text-center text-xs text-zinc-600">
        © {new Date().getFullYear()} 비오케이솔루션 · beoksolution
      </footer>
    </div>
  )
}
