import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

type BlogPost = {
  id: string
  title: string
  excerpt: string
  category: string
  tags: string[]
  published_at: string | null
  created_at: string
}

type ListResponse = { items: BlogPost[]; total: number }

export default function PublicBlogPage() {
  const [data, setData] = useState<ListResponse | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    fetch('/api/blog-posts?status=published&limit=50')
      .then(r => r.json())
      .then(d => setData(d?.data ?? d))
      .catch(() => {})
      .finally(() => setIsLoading(false))
  }, [])

  if (isLoading) {
    return (
      <div className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center">
        <p className="text-zinc-500 text-sm">불러오는 중…</p>
      </div>
    )
  }

  const posts = data?.items ?? []

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      {/* Header */}
      <header className="border-b border-zinc-800">
        <div className="mx-auto max-w-3xl px-6 py-8">
          <h1 className="text-2xl font-bold tracking-tight">홍커뮤니케이션 블로그</h1>
          <p className="mt-2 text-sm text-zinc-400">MICE 행사기획 · IT 솔루션 · 동시통역 — 현장 인사이트와 트렌드</p>
        </div>
      </header>

      {/* Post List */}
      <main className="mx-auto max-w-3xl px-6 py-10">
        {posts.length === 0 ? (
          <p className="text-center text-zinc-500 py-20">아직 발행된 글이 없습니다.</p>
        ) : (
          <div className="flex flex-col gap-8">
            {posts.map((post) => (
              <Link
                key={post.id}
                to={`/blog/${post.id}`}
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
