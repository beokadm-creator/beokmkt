import { mkdir, writeFile } from 'fs/promises'
import { existsSync, readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { applicationDefault, cert, initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const publicDir = path.join(rootDir, 'public')
const blogDir = path.join(publicDir, 'blog')
const projectId = process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'beokmkt'
const baseUrl = (process.env.SPA_BASE_URL || 'https://beoksolution.com').replace(/\/+$/, '')
const secretKeyPath = path.join(rootDir, 'blog_publisher/.secrets/firebase-admin.json')
const explicitCredPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || ''

function initFirebase() {
  const credPath = explicitCredPath || (existsSync(secretKeyPath) ? secretKeyPath : '')
  if (credPath && existsSync(credPath)) {
    const sa = JSON.parse(readFileSync(credPath, 'utf8'))
    initializeApp({ projectId: sa.project_id || projectId, credential: cert(sa) })
    return
  }
  initializeApp({ projectId, credential: applicationDefault() })
}

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function slugifyBlogPost(value) {
  const slug = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100)
  return slug || 'post'
}

function publicBlogPath(post) {
  const slug = post.slug || slugifyBlogPost(post.title || post.id)
  return `/blog/${encodeURIComponent(slug)}`
}

function normalizeDate(value) {
  const raw = typeof value === 'string' ? value : ''
  return raw.split('T')[0] || new Date().toISOString().slice(0, 10)
}

function canonicalPublicUrl(value) {
  return String(value ?? '')
    .trim()
    .replace(/^https:\/\/beokmkt\.(web\.app|firebaseapp\.com)\//, `${baseUrl}/`)
}

function buildSitemapXml(posts, options = {}) {
  const today = new Date().toISOString().slice(0, 10)
  const includeRoot = options.includeRoot !== false
  const includeBlogIndex = options.includeBlogIndex !== false
  const includeImages = options.includeImages !== false
  const homepageUrls = [
    { loc: baseUrl, lastmod: today, priority: '1.0', changefreq: 'weekly' },
    { loc: `${baseUrl}/references/`, lastmod: today, priority: '0.9', changefreq: 'monthly' },
    { loc: `${baseUrl}/ai-search-summary.html`, lastmod: today, priority: '0.8', changefreq: 'monthly' },
    { loc: `${baseUrl}/llms.txt`, lastmod: today, priority: '0.6', changefreq: 'weekly' },
  ]
  const urls = [
    ...(includeRoot ? homepageUrls : []),
    ...(includeBlogIndex ? [{ loc: `${baseUrl}/blog/`, lastmod: today, priority: '0.9', changefreq: 'daily' }] : []),
    ...posts.map((post) => ({
      loc: `${baseUrl}${publicBlogPath(post)}`,
      lastmod: normalizeDate(post.updated_at || post.published_at || post.created_at),
      priority: '0.8',
      changefreq: 'weekly',
      image: typeof post.featured_image === 'string' ? canonicalPublicUrl(post.featured_image) : '',
    })),
  ]

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">',
  ]
  for (const entry of urls) {
    lines.push('  <url>')
    lines.push(`    <loc>${escapeXml(entry.loc)}</loc>`)
    lines.push(`    <lastmod>${escapeXml(entry.lastmod)}</lastmod>`)
    lines.push(`    <changefreq>${entry.changefreq}</changefreq>`)
    lines.push(`    <priority>${entry.priority}</priority>`)
    if (includeImages && entry.image) {
      lines.push('    <image:image>')
      lines.push(`      <image:loc>${escapeXml(entry.image)}</image:loc>`)
      lines.push('    </image:image>')
    }
    lines.push('  </url>')
  }
  lines.push('</urlset>')
  return `${lines.join('\n')}\n`
}



function buildRssXml(posts) {
  const items = posts.slice(0, 50).map((post) => {
    const url = `${baseUrl}${publicBlogPath(post)}`
    const description = post.excerpt || post.seo_description || ''
    const pubDate = new Date(post.published_at || post.created_at || Date.now()).toUTCString()
    return [
      '    <item>',
      `      <title>${escapeXml(post.title || '')}</title>`,
      `      <link>${escapeXml(url)}</link>`,
      `      <guid isPermaLink="true">${escapeXml(url)}</guid>`,
      `      <pubDate>${pubDate}</pubDate>`,
      `      <description>${escapeXml(description)}</description>`,
      post.category ? `      <category>${escapeXml(post.category)}</category>` : '',
      '    </item>',
    ].filter(Boolean).join('\n')
  }).join('\n')

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    '  <channel>',
    '    <title>비오케이솔루션 · 홍커뮤니케이션 블로그</title>',
    `    <link>${escapeXml(baseUrl)}/blog/</link>`,
    `    <atom:link href="${escapeXml(baseUrl)}/blog/rss.xml" rel="self" type="application/rss+xml" />`,
    '    <description>비오케이솔루션의 홈페이지·맞춤형 시스템 개발과 홍커뮤니케이션의 MICE·학술대회 운영 레퍼런스를 다루는 공식 실무 블로그입니다.</description>',
    '    <language>ko-KR</language>',
    items,
    '  </channel>',
    '</rss>',
    '',
  ].join('\n')
}

initFirebase()
const db = getFirestore()
const snap = await db.collection('blog_posts').where('status', '==', 'published').get()
const posts = snap.docs
  .map((doc) => ({ id: doc.id, ...doc.data() }))
  .filter((post) => !post.deleted_at)
  .sort((a, b) => String(b.published_at || b.created_at || '').localeCompare(String(a.published_at || a.created_at || '')))

await mkdir(blogDir, { recursive: true })
await writeFile(path.join(publicDir, 'sitemap.xml'), buildSitemapXml(posts), 'utf8')
await writeFile(path.join(publicDir, 'rss.xml'), buildRssXml(posts), 'utf8')
await writeFile(path.join(blogDir, 'rss.xml'), buildRssXml(posts), 'utf8')

console.log(`[generate-static-sitemaps] wrote ${posts.length} published posts → sitemap.xml + rss.xml`)
