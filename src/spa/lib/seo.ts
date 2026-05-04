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

export function applySeo(options: {
  title: string
  description: string
  canonical: string
  image?: string
}) {
  document.title = options.title
  upsertMeta('meta[name="description"]', { name: 'description', content: options.description })
  upsertMeta('meta[property="og:title"]', { property: 'og:title', content: options.title })
  upsertMeta('meta[property="og:description"]', { property: 'og:description', content: options.description })
  upsertMeta('meta[property="og:type"]', { property: 'og:type', content: 'article' })
  upsertMeta('meta[property="og:url"]', { property: 'og:url', content: options.canonical })
  upsertMeta('meta[name="twitter:card"]', { name: 'twitter:card', content: 'summary_large_image' })
  upsertMeta('meta[name="twitter:title"]', { name: 'twitter:title', content: options.title })
  upsertMeta('meta[name="twitter:description"]', { name: 'twitter:description', content: options.description })
  if (options.image) {
    upsertMeta('meta[property="og:image"]', { property: 'og:image', content: options.image })
    upsertMeta('meta[name="twitter:image"]', { name: 'twitter:image', content: options.image })
  }
  upsertLink('link[rel="canonical"]', { rel: 'canonical', href: options.canonical })
}
