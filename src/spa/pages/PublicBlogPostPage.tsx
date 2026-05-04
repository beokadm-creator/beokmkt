import { Link, useParams } from 'react-router-dom'
import { useEffect, useState } from 'react'

type BlogPost = {
  id: string
  title: string
  content: string
  excerpt: string
  category: string
  tags: string[]
  published_at: string | null
  created_at: string
}

export default function PublicBlogPostPage() {
  const { id } = useParams()
  const [post, setPost] = useState<BlogPost | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!id) {
      setError('글을 찾을 수 없습니다.')
      setIsLoading(false)
      return
    }

    fetch(`/api/blog-posts/${id}`)
      .then(async (r) => {
        const payload = await r.json().catch(() => null)
        if (!r.ok) throw new Error(payload?.error?.message || '글을 불러오지 못했습니다.')
        return payload?.data ?? payload
      })
      .then((data) => setPost(data))
      .catch((e) => setError(e instanceof Error ? e.message : '글을 불러오지 못했습니다.'))
      .finally(() => setIsLoading(false))
  }, [id])

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
          <Link to="/" className="text-sm text-zinc-400 hover:text-zinc-200">
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

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <main className="mx-auto max-w-3xl px-6 py-12">
        <Link to="/" className="text-sm text-zinc-400 hover:text-zinc-200">
          ← 블로그 목록으로
        </Link>

        <article className="mt-8">
          <div className="flex items-center gap-3 text-xs text-zinc-500">
            <span className="rounded bg-zinc-800 px-2 py-0.5">{post.category || '일반'}</span>
            <span>{new Date(post.published_at ?? post.created_at).toLocaleDateString('ko-KR')}</span>
          </div>

          <h1 className="mt-4 text-3xl font-bold tracking-tight">{post.title}</h1>

          {post.excerpt ? <p className="mt-4 text-base leading-7 text-zinc-400">{post.excerpt}</p> : null}

          {post.tags?.length ? (
            <div className="mt-5 flex flex-wrap gap-2">
              {post.tags.map((tag) => (
                <span key={tag} className="rounded-full border border-zinc-800 px-3 py-1 text-xs text-zinc-400">
                  #{tag}
                </span>
              ))}
            </div>
          ) : null}

          <div
            className="prose prose-invert mt-10 max-w-none prose-headings:text-zinc-50 prose-p:text-zinc-300 prose-a:text-sky-300"
            dangerouslySetInnerHTML={{ __html: post.content || '<p>본문이 없습니다.</p>' }}
          />
        </article>
      </main>
    </div>
  )
}
