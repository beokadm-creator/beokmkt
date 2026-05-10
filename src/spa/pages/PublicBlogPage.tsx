import { useEffect, useState } from 'react'
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

export default function PublicBlogPage() {
  const [data, setData] = useState<ListResponse | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const posts = data?.items ?? []

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
      title: '홍커뮤니케이션 블로그',
      description: 'MICE 행사기획, 국제회의, 컨퍼런스 운영, IT 솔루션, 동시통역 관련 실무형 인사이트를 확인하세요.',
      canonical,
      type: 'website',
      keywords: ['MICE', '행사기획', '컨퍼런스', '국제회의', '동시통역', 'IT 솔루션', '홍커뮤니케이션'],
      jsonLd: [
        {
          '@context': 'https://schema.org',
          '@type': 'Blog',
          name: '홍커뮤니케이션 블로그',
          description: 'MICE 행사기획, 국제회의, 컨퍼런스 운영, IT 솔루션, 동시통역 관련 실무형 인사이트',
          url: canonical,
          inLanguage: 'ko-KR',
          publisher: {
            '@type': 'Organization',
            name: '홍커뮤니케이션',
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
              item: canonical,
            },
          ],
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
      <div className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center">
        <p className="text-zinc-500 text-sm">불러오는 중…</p>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800">
        <div className="mx-auto max-w-3xl px-6 py-8">
          <h1 className="text-2xl font-bold tracking-tight">홍커뮤니케이션 블로그</h1>
          <p className="mt-2 text-sm text-zinc-400">
            MICE 행사기획, 국제회의, 컨퍼런스 운영, IT 솔루션, 동시통역 관련 실무형 인사이트를 다룹니다.
          </p>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-10">
        <section className="mb-10 rounded-2xl border border-zinc-800 bg-zinc-900/40 p-6">
          <h2 className="text-lg font-semibold text-white">행사 운영과 콘텐츠 실무를 위한 아카이브</h2>
          <p className="mt-3 text-sm leading-6 text-zinc-400">
            현장 운영 경험을 바탕으로 행사기획, 컨퍼런스 운영, 동시통역, 디지털 실행, 마케팅 실무에 바로 적용할 수
            있는 내용을 정리합니다.
          </p>
        </section>

        {posts.length === 0 ? (
          <p className="text-center text-zinc-500 py-20">아직 발행된 글이 없습니다.</p>
        ) : (
          <div className="flex flex-col gap-8">
            {posts.map((post) => (
              <Link
                key={post.id}
                to={`/blog/${encodeURIComponent(post.slug || post.id)}`}
                className="group block rounded-xl border border-zinc-800 bg-zinc-900/40 p-6 transition hover:border-zinc-600 hover:bg-zinc-900/70"
              >
                <div className="flex items-center gap-3 text-xs text-zinc-500">
                  <span className="rounded bg-zinc-800 px-2 py-0.5">{post.category || '일반'}</span>
                  <span>{new Date(post.published_at ?? post.created_at).toLocaleDateString('ko-KR')}</span>
                </div>
                <h2 className="mt-3 text-lg font-semibold group-hover:text-white">{post.title}</h2>
                {post.excerpt ? (
                  <p className="mt-2 text-sm leading-relaxed text-zinc-400 line-clamp-3">{post.excerpt}</p>
                ) : null}
                {post.tags?.length ? (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {post.tags.map(t => (
                      <span key={t} className="text-xs text-zinc-600">#{t}</span>
                    ))}
                  </div>
                ) : null}
              </Link>
            ))}
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-zinc-800 py-6 text-center text-xs text-zinc-600">
        © {new Date().getFullYear()} 홍커뮤니케이션 · beoksolution
      </footer>
    </div>
  )
}
