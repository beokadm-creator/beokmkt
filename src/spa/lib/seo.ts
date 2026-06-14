function upsertMeta(selector: string, attrs: Record<string, string>) {
  let node = document.head.querySelector(selector) as HTMLMetaElement | null
  if (!node) {
    node = document.createElement('meta')
    document.head.appendChild(node)
  }
  Object.entries(attrs).forEach(([key, value]) => node?.setAttribute(key, value))
}

function upsertLink(selector: string, attrs: Record<string, string>) {
  let node = document.head.querySelector(selector) as HTMLLinkElement | null
  if (!node) {
    node = document.createElement('link')
    document.head.appendChild(node)
  }
  Object.entries(attrs).forEach(([key, value]) => node?.setAttribute(key, value))
}

function removeNode(selector: string) {
  const node = document.head.querySelector(selector)
  node?.parentNode?.removeChild(node)
}

function replaceJsonLd(nodes: Array<Record<string, unknown>>) {
  document.head.querySelectorAll('script[data-seo-json-ld="true"]').forEach((node) => node.parentNode?.removeChild(node))

  nodes.forEach((entry) => {
    const script = document.createElement('script')
    script.type = 'application/ld+json'
    script.setAttribute('data-seo-json-ld', 'true')
    script.textContent = JSON.stringify(entry)
    document.head.appendChild(script)
  })
}

export function applySeo(options: {
  title: string
  description: string
  canonical: string
  image?: string
  type?: 'website' | 'article'
  robots?: string
  keywords?: string[]
  publishedTime?: string | null
  modifiedTime?: string | null
  jsonLd?: Record<string, unknown> | Array<Record<string, unknown>>
}) {
  const robots = options.robots ?? 'index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1'
  const type = options.type ?? 'website'

  document.title = options.title
  upsertMeta('meta[name="description"]', { name: 'description', content: options.description })
  upsertMeta('meta[name="robots"]', { name: 'robots', content: robots })
  upsertMeta('meta[name="author"]', { name: 'author', content: '비오케이솔루션' })
  upsertMeta('meta[name="language"]', { name: 'language', content: 'ko-KR' })
  upsertMeta('meta[name="theme-color"]', { name: 'theme-color', content: '#09090b' })
  upsertMeta('meta[property="og:title"]', { property: 'og:title', content: options.title })
  upsertMeta('meta[property="og:description"]', { property: 'og:description', content: options.description })
  upsertMeta('meta[property="og:type"]', { property: 'og:type', content: type })
  upsertMeta('meta[property="og:url"]', { property: 'og:url', content: options.canonical })
  upsertMeta('meta[property="og:site_name"]', { property: 'og:site_name', content: '비오케이솔루션 학회 운영 사무국 명찰 출력 발행' })
  upsertMeta('meta[property="og:locale"]', { property: 'og:locale', content: 'ko_KR' })
  upsertMeta('meta[name="twitter:card"]', { name: 'twitter:card', content: options.image ? 'summary_large_image' : 'summary' })
  upsertMeta('meta[name="twitter:title"]', { name: 'twitter:title', content: options.title })
  upsertMeta('meta[name="twitter:description"]', { name: 'twitter:description', content: options.description })
  if (options.image) {
    upsertMeta('meta[property="og:image"]', { property: 'og:image', content: options.image })
    upsertMeta('meta[name="twitter:image"]', { name: 'twitter:image', content: options.image })
  } else {
    removeNode('meta[property="og:image"]')
    removeNode('meta[name="twitter:image"]')
  }

  if (options.keywords?.length) {
    upsertMeta('meta[name="keywords"]', { name: 'keywords', content: options.keywords.join(', ') })
  } else {
    removeNode('meta[name="keywords"]')
  }

  if (type === 'article' && options.publishedTime) {
    upsertMeta('meta[property="article:published_time"]', {
      property: 'article:published_time',
      content: options.publishedTime,
    })
  } else {
    removeNode('meta[property="article:published_time"]')
  }

  if (type === 'article' && options.modifiedTime) {
    upsertMeta('meta[property="article:modified_time"]', {
      property: 'article:modified_time',
      content: options.modifiedTime,
    })
  } else {
    removeNode('meta[property="article:modified_time"]')
  }

  upsertLink('link[rel="canonical"]', { rel: 'canonical', href: options.canonical })
  upsertLink('link[rel="sitemap"]', { rel: 'sitemap', type: 'application/xml', href: '/sitemap.xml' })
  upsertLink('link[rel="alternate"][type="application/rss+xml"]', {
    rel: 'alternate',
    type: 'application/rss+xml',
    title: '비오케이솔루션 학회 운영 사무국 명찰 출력 발행 RSS',
    href: '/blog/rss.xml',
  })
  upsertLink('link[rel="alternate"][type="text/markdown"]', {
    rel: 'alternate',
    type: 'text/markdown',
    title: 'LLMs guide',
    href: '/llms.txt',
  })

  const jsonLdEntries = options.jsonLd
    ? Array.isArray(options.jsonLd)
      ? options.jsonLd
      : [options.jsonLd]
    : []

  replaceJsonLd(jsonLdEntries)
}
