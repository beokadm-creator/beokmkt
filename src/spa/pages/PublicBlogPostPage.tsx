import { Link, useParams } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { applySeo } from '../lib/seo'

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
            name: '홍커뮤니케이션',
          },
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
              item: `${window.location.origin}/blog`,
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

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <main className="mx-auto max-w-3xl px-6 py-12">
        <Link to="/blog" className="text-sm text-zinc-400 hover:text-zinc-200">
          ← 블로그 목록으로
        </Link>

        <article className="mt-8">
          <div className="flex items-center gap-3 text-xs text-zinc-500">
            <span className="rounded bg-zinc-800 px-2 py-0.5">{post.category || '일반'}</span>
            <time dateTime={post.published_at ?? post.created_at}>
              {new Date(post.published_at ?? post.created_at).toLocaleDateString('ko-KR')}
            </time>
          </div>

          <h1 className="mt-4 text-3xl font-bold tracking-tight">{post.title}</h1>

          {post.excerpt ? <p className="mt-4 text-base leading-7 text-zinc-400">{post.excerpt}</p> : null}

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

          <div
            className="mt-10 max-w-none text-zinc-100"
            dangerouslySetInnerHTML={{ __html: post.content || '<p>본문이 없습니다.</p>' }}
          />
        </article>
      </main>
    </div>
  )
}
