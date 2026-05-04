import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import StatusBadge from '../components/StatusBadge'
import { apiJson } from '../lib/api'

type BlogPost = {
  id: string
  title: string
  content: string
  excerpt: string
  category: string
  tags: string[]
  slug: string
  status: string
  tone: string
  language: string
  seo_title: string
  seo_description: string
  published_at: string | null
  created_at: string
  updated_at: string
}

export default function BlogPostDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const [post, setPost] = useState<BlogPost | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [isGenerating, setIsGenerating] = useState(false)
  const [isPublishing, setIsPublishing] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)

  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [excerpt, setExcerpt] = useState('')
  const [category, setCategory] = useState('')
  const [tagsStr, setTagsStr] = useState('')
  const [seoTitle, setSeoTitle] = useState('')
  const [seoDesc, setSeoDesc] = useState('')

  const tags = useMemo(() => tagsStr.split(',').map((tag) => tag.trim()).filter(Boolean), [tagsStr])

  const applyPost = useCallback((next: BlogPost) => {
    setPost(next)
    setTitle(next.title)
    setContent(next.content ?? '')
    setExcerpt(next.excerpt ?? '')
    setCategory(next.category ?? '')
    setTagsStr(next.tags?.join(', ') ?? '')
    setSeoTitle(next.seo_title ?? '')
    setSeoDesc(next.seo_description ?? '')
  }, [])

  const refresh = useCallback(async () => {
    if (!id) return
    const next = await apiJson<BlogPost>(`/api/blog-posts/${id}`)
    applyPost(next)
  }, [applyPost, id])

  useEffect(() => {
    if (!id) return
    setIsLoading(true)
    refresh()
      .then(() => setError(null))
      .catch((e) => setError(e instanceof Error ? e.message : '불러오기 실패'))
      .finally(() => setIsLoading(false))
  }, [id, refresh])

  async function handleSave(e?: FormEvent) {
    e?.preventDefault()
    if (!id) return
    setIsSaving(true)
    try {
      const updated = await apiJson<BlogPost>(`/api/blog-posts/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          title,
          content,
          excerpt,
          category,
          tags,
          seo_title: seoTitle,
          seo_description: seoDesc,
        }),
      })
      applyPost(updated)
      setError(null)
      return updated
    } catch (e) {
      setError(e instanceof Error ? e.message : '저장 실패')
      return null
    } finally {
      setIsSaving(false)
    }
  }

  async function handlePublish() {
    if (!id) return
    setIsPublishing(true)
    try {
      const saved = await handleSave()
      if (!saved) return

      const updated = await apiJson<BlogPost>(`/api/blog-posts/${id}/publish`, {
        method: 'POST',
        body: JSON.stringify({}),
      })
      applyPost(updated)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : '발행 실패')
    } finally {
      setIsPublishing(false)
    }
  }

  async function handleAiGenerate() {
    if (!id) return
    setIsGenerating(true)
    try {
      const updated = await apiJson<BlogPost>(`/api/blog-posts/${id}/generate-content`, {
        method: 'POST',
        idempotencyKey: `blog-generate-${id}-${Date.now()}`,
        body: JSON.stringify({ target_length: 'medium' }),
      })
      applyPost(updated)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'AI 생성 실패')
    } finally {
      setIsGenerating(false)
    }
  }

  async function handleDelete() {
    if (!id) return
    const confirmed = window.confirm('이 블로그 글을 보관 처리할까요?')
    if (!confirmed) return

    setIsDeleting(true)
    try {
      await apiJson(`/api/blog-posts/${id}`, {
        method: 'DELETE',
        body: JSON.stringify({}),
      })
      navigate('/blog-posts')
    } catch (e) {
      setError(e instanceof Error ? e.message : '삭제 실패')
    } finally {
      setIsDeleting(false)
    }
  }

  if (isLoading) return <div className="text-sm text-zinc-500">불러오는 중…</div>
  if (error && !post) return <div className="rounded-lg bg-red-900/20 p-3 text-sm text-red-400">{error}</div>
  if (!post) return <div className="text-sm text-zinc-500">블로그 글을 찾을 수 없습니다.</div>

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => navigate('/blog-posts')}
            className="h-9 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm text-zinc-200"
          >
            ← 목록
          </button>
          <div className="text-sm font-semibold">{post.title}</div>
          <StatusBadge value={post.status} />
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={handleAiGenerate}
            disabled={isGenerating || isSaving || isPublishing || isDeleting}
            className="h-9 rounded-lg bg-purple-600 px-3 text-sm font-medium text-white disabled:opacity-60"
          >
            {isGenerating ? 'AI 생성 중…' : 'AI 글 생성'}
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={isSaving || isGenerating || isPublishing || isDeleting}
            className="h-9 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm text-zinc-200 disabled:opacity-60"
          >
            {isSaving ? '저장 중…' : '저장'}
          </button>
          <button
            type="button"
            onClick={handlePublish}
            disabled={post.status === 'published' || isSaving || isGenerating || isPublishing || isDeleting}
            className="h-9 rounded-lg bg-green-600 px-3 text-sm font-medium text-white disabled:opacity-60"
          >
            {isPublishing ? '발행 중…' : '발행'}
          </button>
          <button
            type="button"
            onClick={handleDelete}
            disabled={isDeleting || isSaving || isGenerating || isPublishing}
            className="h-9 rounded-lg border border-red-900/60 bg-red-950/20 px-3 text-sm text-red-200 disabled:opacity-60"
          >
            {isDeleting ? '삭제 중…' : '삭제'}
          </button>
        </div>
      </div>

      {error ? <div className="rounded-lg bg-red-900/20 p-3 text-sm text-red-400">{error}</div> : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="rounded-xl border border-zinc-900 bg-zinc-900/30 p-4">
          <form className="flex flex-col gap-4" onSubmit={(e) => void handleSave(e)}>
            <label className="flex flex-col gap-2">
              <span className="text-xs text-zinc-400">제목</span>
              <input
                className="h-10 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <label className="flex flex-col gap-2">
                <span className="text-xs text-zinc-400">카테고리</span>
                <input
                  className="h-10 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                />
              </label>
              <label className="flex flex-col gap-2">
                <span className="text-xs text-zinc-400">태그</span>
                <input
                  className="h-10 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm"
                  value={tagsStr}
                  onChange={(e) => setTagsStr(e.target.value)}
                  placeholder="마케팅, SEO, 블로그"
                />
              </label>
            </div>

            <label className="flex flex-col gap-2">
              <span className="text-xs text-zinc-400">본문 (HTML)</span>
              <textarea
                className="min-h-[400px] rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-sm"
                value={content}
                onChange={(e) => setContent(e.target.value)}
              />
            </label>

            <label className="flex flex-col gap-2">
              <span className="text-xs text-zinc-400">요약</span>
              <input
                className="h-10 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm"
                value={excerpt}
                onChange={(e) => setExcerpt(e.target.value)}
              />
            </label>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <label className="flex flex-col gap-2">
                <span className="text-xs text-zinc-400">SEO 제목</span>
                <input
                  className="h-10 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm"
                  value={seoTitle}
                  onChange={(e) => setSeoTitle(e.target.value)}
                />
              </label>
              <label className="flex flex-col gap-2">
                <span className="text-xs text-zinc-400">SEO 설명</span>
                <input
                  className="h-10 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm"
                  value={seoDesc}
                  onChange={(e) => setSeoDesc(e.target.value)}
                />
              </label>
            </div>

            {content ? (
              <div className="flex flex-col gap-2">
                <span className="text-xs text-zinc-400">미리보기</span>
                <div
                  className="prose prose-zinc max-w-none rounded-lg border border-zinc-800 bg-white p-6 text-sm text-zinc-900"
                  dangerouslySetInnerHTML={{ __html: content }}
                />
              </div>
            ) : null}
          </form>
        </div>

        <div className="rounded-xl border border-zinc-900 bg-zinc-900/30 p-4">
          <div className="text-xs text-zinc-400">메타</div>
          <div className="mt-3 flex flex-col gap-3 text-sm text-zinc-200">
            <div className="flex items-center justify-between gap-4">
              <span className="text-zinc-500">slug</span>
              <span className="truncate text-right">{post.slug}</span>
            </div>
            <div className="flex items-center justify-between gap-4">
              <span className="text-zinc-500">language</span>
              <span>{post.language}</span>
            </div>
            <div className="flex items-center justify-between gap-4">
              <span className="text-zinc-500">tone</span>
              <span>{post.tone}</span>
            </div>
            <div className="flex items-center justify-between gap-4">
              <span className="text-zinc-500">created</span>
              <span>{new Date(post.created_at).toLocaleString('ko-KR')}</span>
            </div>
            <div className="flex items-center justify-between gap-4">
              <span className="text-zinc-500">updated</span>
              <span>{new Date(post.updated_at).toLocaleString('ko-KR')}</span>
            </div>
            <div className="flex items-center justify-between gap-4">
              <span className="text-zinc-500">published</span>
              <span>{post.published_at ? new Date(post.published_at).toLocaleString('ko-KR') : '-'}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
