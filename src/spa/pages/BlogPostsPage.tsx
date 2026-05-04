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

export default function BlogPostsPage() {
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('')
  const [category, setCategory] = useState('')
  const [data, setData] = useState<ListResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isCreating, setIsCreating] = useState(false)

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
        <form onSubmit={onCreateEmpty}>
          <button
            type="submit"
            disabled={isCreating}
            className="inline-flex h-9 items-center justify-center rounded-lg bg-white px-3 text-sm font-medium text-zinc-950 disabled:opacity-60"
          >
            {isCreating ? '생성 중…' : '+ 새 글'}
          </button>
        </form>
      </div>

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

      {error ? <div className="rounded-lg bg-red-900/20 p-3 text-sm text-red-400">{error}</div> : null}

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
