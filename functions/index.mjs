// @version 2026-05-26a — scanner cleanup
import express from 'express'
import { onRequest } from 'firebase-functions/v2/https'
import { onSchedule } from 'firebase-functions/v2/scheduler'
import { initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { FieldValue, getFirestore } from 'firebase-admin/firestore'
import { randomUUID } from 'crypto'
import { ssrTemplate, assetPaths } from './ssr-template.mjs'
import { executeBlogPipeline, PipelineError } from './blog-pipeline/executor.mjs'
import { getBlogPromptTemplate, resolveLengthGuide } from './blog-pipeline/prompts.mjs'
import { researchKeywords, KeywordResearchError } from './blog-pipeline/keyword-research.mjs'
import {
  isRunnablePipelineCommand,
  pipelineCommandTimeMs,
  selectClaimablePipelineCommand,
} from './pipeline-command-queue.mjs'

initializeApp()
const db = getFirestore()

const adminEmailAllowlist = String(process.env.ADMIN_EMAILS ?? process.env.ALLOWED_ADMIN_EMAILS ?? '')
  .split(',')
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean)
const adminUidAllowlist = String(process.env.ADMIN_UIDS ?? process.env.ALLOWED_ADMIN_UIDS ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)

function isAllowedAdminUser(user = {}) {
  if (adminEmailAllowlist.length > 0) {
    const email = typeof user.email === 'string' ? user.email.trim().toLowerCase() : ''
    if (!email || !adminEmailAllowlist.includes(email)) return false
  }
  if (adminUidAllowlist.length > 0) {
    const uid = typeof user.uid === 'string' ? user.uid.trim() : ''
    if (!uid || !adminUidAllowlist.includes(uid)) return false
  }
  return adminEmailAllowlist.length > 0 || adminUidAllowlist.length > 0
}

const app = express()
app.use(express.json({ limit: '1mb' }))

const PIPELINE_COMMAND_TASKS = new Set([
  'status',
  'quality-selftest',
  'reset-draft-backlog',
  'content-reboot',
  'cleanup-selfhosted-blocked',
  'stock-seed',
  'generate',
  'factcheck',
  'review',
  'schedule',
  'publish',
  'sync-snapshot',
  'recover',
  'verify-public',
  'image-audit',
  'backup',
])

const PIPELINE_COMMAND_RUNBOOKS = {
  'status-refresh': ['status', 'sync-snapshot'],
  'drain-once': ['generate', 'factcheck', 'review', 'schedule', 'publish', 'sync-snapshot'],
  'reset-draft-backlog-and-drain': [
    'reset-draft-backlog',
    'generate',
    'factcheck',
    'review',
    'schedule',
    'sync-snapshot',
  ],
}

function normalizePipelineCommandRequest(body = {}) {
  let tasks = []
  const runbook = typeof body.runbook === 'string' ? body.runbook.trim() : ''
  if (runbook) {
    tasks = PIPELINE_COMMAND_RUNBOOKS[runbook] ?? []
    if (!tasks.length) {
      throw Object.assign(new Error(`unknown runbook: ${runbook}`), { status: 400, code: 'UNKNOWN_RUNBOOK' })
    }
  } else if (Array.isArray(body.tasks)) {
    tasks = body.tasks
  } else if (typeof body.task === 'string') {
    tasks = [body.task]
  }

  tasks = tasks.map((task) => String(task ?? '').trim()).filter(Boolean)
  if (!tasks.length) {
    throw Object.assign(new Error('task, tasks, or runbook is required'), { status: 400, code: 'VALIDATION_ERROR' })
  }

  const invalid = tasks.filter((task) => !PIPELINE_COMMAND_TASKS.has(task))
  if (invalid.length) {
    throw Object.assign(new Error(`unsupported task: ${invalid.join(', ')}`), {
      status: 400,
      code: 'UNSUPPORTED_TASK',
      details: { allowed: [...PIPELINE_COMMAND_TASKS].sort() },
    })
  }
  return { tasks, runbook: runbook || null }
}

app.use(async (req, res, next) => {
  if (!req.path.startsWith('/api/')) return next()
  if (req.path === '/api/health') return next()
  if (req.path === '/api/pipeline/stats') return next()

  // Blog API: GET public, POST/PATCH/DELETE via X-API-Key or Firebase Auth
  if (req.path.startsWith('/api/blog-posts') && req.method === 'GET') return next()

  // Check X-API-Key header first
  const apiKey = req.header('X-API-Key')
  if (apiKey && apiKey === process.env.BLOG_API_KEY) {
    req.user = { email: 'api-key', role: 'publisher' }
    return next()
  }

  const header = req.header('Authorization') ?? ''
  const m = header.match(/^Bearer\s+(.+)$/)
  const token = m?.[1]
  if (!token) return fail(res, 401, 'UNAUTHENTICATED', 'missing token', {})

  try {
    const decoded = await getAuth().verifyIdToken(token)
    if (!isAllowedAdminUser(decoded)) {
      return fail(res, 403, 'FORBIDDEN', 'admin access required', { email: decoded.email ?? null, uid: decoded.uid ?? null })
    }
    req.user = decoded
    return next()
  } catch {
    return fail(res, 401, 'UNAUTHENTICATED', 'invalid token', {})
  }
})

function ok(res, data, meta) {
  res.json({ data: serializeValue(data), meta: serializeValue(meta ?? {}) })
}

function fail(res, status, code, message, details) {
  res.status(status).json({ error: { code, message, details } })
}

function serializeValue(value) {
  if (value == null) return value
  if (Array.isArray(value)) return value.map((item) => serializeValue(item))
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object' && typeof value.toDate === 'function') {
    return value.toDate().toISOString()
  }
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, serializeValue(item)]))
  }
  return value
}

function envValue(name) {
  return typeof process.env[name] === 'string' ? process.env[name].trim() : ''
}

function spaBaseUrl(req) {
  const explicit = envValue('SPA_BASE_URL')
  if (explicit) return explicit.replace(/\/+$/, '')
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https'
  const host = req.headers['x-forwarded-host'] || req.get('host')
  return `${proto}://${host}`.replace(/\/+$/, '')
}

function publicBlogPath(post) {
  const slug = typeof post?.slug === 'string' && post.slug.trim() ? post.slug.trim() : post?.id
  return `/blog/${encodeURIComponent(slug)}`
}

function actionForExternalIssue(channel, error = '') {
  const msg = String(error ?? '')
  if (channel === 'tistory' && /세션|login|auth|TISTORY/i.test(msg)) {
    return '티스토리 재인증 후 워커 재시작'
  }
  if (channel === 'naver' && /404|삭제|품질|구조|PASTE|SmartEditor/i.test(msg)) {
    return '네이버 공개상태·본문 품질 확인 후 재발행 판단'
  }
  if (/세션|login|auth/i.test(msg)) return '채널 세션 재인증'
  if (/품질|review|grounding|구조/i.test(msg)) return '본문 품질 재검토'
  return '원인 확인'
}

function cloudRequeuePolicy(reason = '클라우드 대시보드에서는 로컬 SQLite 큐 재등록을 수행하지 않습니다.') {
  return { can_requeue: false, reason }
}

function plainTextFromContent(content = '') {
  return String(content)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[#*_>`~\[\]()!-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function pipelineQuality(body = '', groundingRatio = null) {
  const content = String(body ?? '')
  const plain = plainTextFromContent(content)
  return {
    chars: plain.length,
    images: (content.match(/<img\b/gi) || []).length + (content.match(/!\[[^\]]*]\([^)\s]+\)/g) || []).length,
    headings: (content.match(/^#{2,3}\s+/gm) || []).length + (content.match(/<h[23]\b/gi) || []).length,
    grounding_ratio: groundingRatio == null ? null : Number(groundingRatio),
  }
}

function qualityIssueLabels(quality) {
  const issues = []
  if (quality.chars > 0 && quality.chars < 1800) issues.push('본문 1,800자 미만')
  if (quality.images === 0) issues.push('이미지 없음')
  if (quality.headings < 3) issues.push('소제목 부족')
  if (quality.grounding_ratio == null) issues.push('grounding 미측정')
  else if (quality.grounding_ratio < 0.9) issues.push('grounding 0.90 미만')
  return issues
}

function qualityActionFor(issues = [], status = '') {
  const text = issues.join(' ')
  if (/grounding/.test(text)) return '검색 연결/근거팩 확인 후 factcheck·review 재실행'
  if (/본문|소제목/.test(text)) return status === 'published' ? '공개 글 삭제/수정 판단 후 재작성' : '본문 재작성 후 review 재실행'
  if (/이미지/.test(text)) return 'beok 자산 URL 연결 또는 이미지 보강 후보 확인'
  return '본문 품질 확인'
}

function publicQualityIssues({ channel = '', title = '', url = '', html = '', status = null }) {
  const issues = []
  const content = String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  const text = stripHtml(content)
  const images = (content.match(/<img\b/gi) || []).length
  const h1 = (content.match(/<h1\b/gi) || []).length
  const h2 = (content.match(/<h2\b/gi) || []).length

  if (status !== 200) issues.push(`HTTP ${status ?? 'error'}`)
  const forbidden = ['꿀팁', '환장', '대박', '지옥', '끝판왕', '충격', '실화', '[이미지:']
    .filter((word) => content.includes(word) || text.includes(word))
  if (forbidden.length) issues.push(`금칙/마커: ${forbidden.slice(0, 3).join(', ')}`)
  const visibleStrike = [...content.matchAll(/<(?:s|strike|del)\b[^>]*>([\s\S]*?)<\/(?:s|strike|del)>/gi)]
    .some((match) => stripHtml(match[1]).replace(/\u200b|\ufeff/g, '').trim())
  if (visibleStrike || /text-decoration\s*:\s*line-through/i.test(content)) issues.push('보이는 취소선')

  if (channel === 'selfhosted') {
    if (text.length < 1000) issues.push(`본문 짧음(${text.length}자)`)
    if (h1 !== 1) issues.push(`h1 ${h1}개`)
    if (/<article\b[^>]*>\s*<header\b/i.test(content)) issues.push('본문 header 중복')
    if (/학회|명찰/i.test(title) && images < 1) issues.push('학회/명찰 이미지 없음')
  } else if (channel === 'tistory') {
    if (!/^https:\/\/[^/]+\.tistory\.com\/\d+(?:[/?#].*)?$/.test(url)) issues.push('공개 URL 형식 아님')
    if (text.length < 800) issues.push(`본문 짧음(${text.length}자)`)
    if (h2 < 2) issues.push(`소제목 부족(${h2})`)
  } else if (channel === 'naver') {
    if (!/PostView\.naver|blog\.naver\.com\/[^/?#]+\/\d+/.test(url)) issues.push('공개 URL 형식 아님')
    if (status === 200 && text.length < 500) issues.push(`본문 짧음(${text.length}자)`)
  }

  return { issues, chars: text.length, images, h1, h2 }
}

function publicQualityAction(channel, issues = []) {
  const issueText = issues.join(' ')
  if (/캐시|CDN|Hosting/i.test(issueText)) return '본문은 수정됨. Hosting/CDN 캐시 만료 또는 재배포 후 공개 품질 재검증'
  if (channel === 'tistory' && /금칙|마커|취소선|본문|소제목/i.test(issueText)) {
    return '티스토리 관리자에서 공개 글 본문 수정 또는 삭제 후 공개 품질 재검증'
  }
  if (channel === 'selfhosted') return '자체 블로그 글 수정 또는 비공개 처리 후 공개 품질 재검증'
  if (channel === 'naver') return '네이버 공개 글 본문 확인 후 삭제/수정 판단'
  return '공개 URL 본문 확인 후 정정'
}

async function fetchPublicQualityItem(item) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 6000)
  try {
    const res = await fetch(item.url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 beok-public-quality/1.0',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    })
    const html = await res.text()
    const measured = publicQualityIssues({ ...item, html, status: res.status })
    let cache_bust_ok = false
    let cache_bust_url = null
    if (item.channel === 'selfhosted' && measured.issues.length > 0 && item.url && !String(item.url).includes('?')) {
      cache_bust_url = `${item.url}?v=public-quality-${encodeURIComponent(String(item.id ?? Date.now()))}`
      const bust = await fetch(cache_bust_url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(6000),
        headers: {
          'user-agent': 'Mozilla/5.0 beok-public-quality/1.0',
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      }).catch(() => null)
      if (bust?.ok) {
        const bustHtml = await bust.text().catch(() => '')
        const bustMeasured = publicQualityIssues({ ...item, html: bustHtml, status: bust.status })
        cache_bust_ok = bustMeasured.issues.length === 0
        if (cache_bust_ok) measured.issues.push('캐시 우회 URL은 정상(Hosting/CDN 캐시 잔존 의심)')
      }
    }
    return {
      ...item,
      status: res.status,
      ...measured,
      ok: measured.issues.length === 0,
      cache_bust_ok,
      cache_bust_url,
      action: measured.issues.length ? publicQualityAction(item.channel, measured.issues) : null,
    }
  } catch (error) {
    const issues = [error instanceof Error ? error.message : 'fetch failed']
    return {
      ...item,
      status: null,
      chars: 0,
      images: 0,
      h1: 0,
      h2: 0,
      ok: false,
      issues,
      action: publicQualityAction(item.channel, issues),
    }
  } finally {
    clearTimeout(timer)
  }
}

async function publicQualitySnapshot(items) {
  const unique = []
  const seen = new Set()
  for (const item of items) {
    if (!item?.url || seen.has(item.url)) continue
    seen.add(item.url)
    unique.push(item)
    if (unique.length >= 8) break
  }
  const checked = await Promise.all(unique.map(fetchPublicQualityItem))
  const failed = checked.filter((item) => !item.ok)
  return {
    checked: checked.length,
    ok: checked.length - failed.length,
    failed: failed.length,
    items: failed.slice(0, 5),
  }
}

function sanitizePreviewHtml(html = '') {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/\s+on\w+="[^"]*"/gi, '')
    .replace(/\s+on\w+='[^']*'/gi, '')
    .replace(/javascript:/gi, '')
}

function snapshotPostDetail(item, id) {
  if (!item || typeof item !== 'object') return null
  if (String(item.id ?? '') !== String(id)) return null
  const previewHtml = sanitizePreviewHtml(item.preview_html ?? '')
  const bodyExcerpt = String(item.body_excerpt ?? '')
  const channel = typeof item.channel === 'string' ? item.channel : 'selfhosted'
  return {
    id: item.id ?? id,
    channel,
    status: typeof item.status === 'string' ? item.status : 'unknown',
    title: item.title ?? item.topic ?? '',
    topic: item.topic ?? item.title ?? '',
    published_url: item.published_url ?? item.url ?? null,
    last_error: item.last_error ?? null,
    action: item.action ?? actionForExternalIssue(channel, item.last_error ?? ''),
    can_requeue: false,
    requeue_block_reason: '로컬 SQLite 스냅샷 항목입니다. 맥 로컬 관리자 또는 CLI에서 처리하세요.',
    can_archive: false,
    body_available: Boolean(previewHtml || bodyExcerpt || item.body_available),
    body: bodyExcerpt,
    preview_html: previewHtml,
    quality: item.quality && typeof item.quality === 'object' ? item.quality : pipelineQuality(bodyExcerpt),
    issues: Array.isArray(item.issues) ? item.issues : [],
    updated_at: serializeValue(item.updated_at ?? '') ?? '',
    snapshot_source: 'local_sqlite',
  }
}

function findSnapshotPostDetail(snapshot, id) {
  const lists = [
    snapshot?.quality_items,
    snapshot?.needs_human_posts,
    snapshot?.recent,
    snapshot?.public_quality?.items,
  ]
  for (const list of lists) {
    if (!Array.isArray(list)) continue
    for (const item of list) {
      const detail = snapshotPostDetail(item, id)
      if (detail) return detail
    }
  }
  return null
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

function slugCandidateWithSuffix(baseSlug, index) {
  if (index <= 1) return baseSlug
  const suffix = `-${index}`
  const trimmedBase = baseSlug
    .slice(0, Math.max(1, 100 - suffix.length))
    .replace(/-+$/g, '')

  return `${trimmedBase || 'post'}${suffix}`
}

async function ensureUniqueBlogSlug(value, excludeId = null) {
  const baseSlug = slugifyBlogPost(value)

  for (let index = 1; index < 1000; index += 1) {
    const candidate = slugCandidateWithSuffix(baseSlug, index)
    const snap = await db.collection('blog_posts').where('slug', '==', candidate).limit(10).get()
    const hasConflict = snap.docs.some((doc) => doc.id !== excludeId && !doc.data()?.deleted_at)
    if (!hasConflict) return candidate
  }

  return `${baseSlug.slice(0, 87).replace(/-+$/g, '') || 'post'}-${newId().slice(0, 12)}`
}

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function buildSitemapXml(baseUrl, posts, options = {}) {
  const today = new Date().toISOString().split('T')[0]
  const includeBlogIndex = options.includeBlogIndex !== false
  const includeImages = options.includeImages !== false

  const urls = [
    ...(options.includeRoot === false ? [] : [{ loc: baseUrl, lastmod: today, priority: '1.0', changefreq: 'daily' }]),
    ...(includeBlogIndex ? [{ loc: `${baseUrl}/blog/`, lastmod: today, priority: '0.9', changefreq: 'daily' }] : []),
    ...posts.map((post) => ({
      loc: `${baseUrl}${publicBlogPath(post)}`,
      lastmod: (post.updated_at || post.published_at || post.created_at || '').split('T')[0] || today,
      priority: '0.8',
      changefreq: 'weekly',
      image: typeof post.featured_image === 'string' && post.featured_image.trim() ? post.featured_image.trim() : '',
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
  return lines.join('\n')
}

async function getOptionalAdminUser(req) {
  const header = req.header('Authorization') ?? ''
  const m = header.match(/^Bearer\s+(.+)$/)
  const token = m?.[1]
  if (!token) return null
  try {
    const decoded = await getAuth().verifyIdToken(token)
    return isAllowedAdminUser(decoded) ? decoded : null
  } catch {
    return null
  }
}

async function sitemapHandler(req, res) {
  const baseUrl = spaBaseUrl(req)
  const snap = await db.collection('blog_posts').where('status', '==', 'published').get()
  const posts = snap.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter((post) => !post.deleted_at)
  const visiblePosts = publicVisibleBlogPosts(posts)

  res.set('Content-Type', 'application/xml; charset=utf-8')
  res.set('Cache-Control', 'public, max-age=600, s-maxage=3600')
  res.set('Vary', 'Accept-Encoding')
  res.removeHeader('X-Very-Need-Authorization')
  const isBlogOnlySitemap = req.path === '/blog/sitemap.xml' || req.path === '/blog/sitemap-posts.xml'
  res.send(buildSitemapXml(baseUrl, visiblePosts, {
    includeRoot: !isBlogOnlySitemap,
    includeBlogIndex: !isBlogOnlySitemap,
    includeImages: req.path !== '/blog/sitemap-posts.xml',
  }))
}

app.get('/sitemap.xml', sitemapHandler)
app.get('/blog/sitemap.xml', sitemapHandler)
app.get('/blog/sitemap-posts.xml', sitemapHandler)

// ─── RSS 피드 ───────────────────────────────────────────────────────────────
// 네이버 서치어드바이저 RSS 제출, 구글/빙/AI 크롤러의 신규 글 발견용

function buildRssXml(baseUrl, posts) {
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
  ].join('\n')
}

async function rssHandler(req, res) {
  const baseUrl = spaBaseUrl(req)
  const snap = await db.collection('blog_posts').where('status', '==', 'published').get()
  const posts = snap.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter((post) => !post.deleted_at)
    .sort((a, b) => {
      const da = a.published_at || a.created_at || ''
      const db2 = b.published_at || b.created_at || ''
      return db2.localeCompare(da)
    })
  const visiblePosts = publicVisibleBlogPosts(posts)

  res.set('Content-Type', 'application/rss+xml; charset=utf-8')
  res.set('Cache-Control', 'public, max-age=600, s-maxage=3600')
  res.send(buildRssXml(baseUrl, visiblePosts))
}

app.get('/rss.xml', rssHandler)
app.get('/blog/rss.xml', rssHandler)

// ─── IndexNow (발행 즉시 색인 요청: Bing/네이버 등 IndexNow 참여 엔진) ────────

const SITE_BASE_URL = (process.env.SPA_BASE_URL || 'https://beokmkt.web.app').replace(/\/+$/, '')
const KAKAO_CHAT_URL = 'https://pf.kakao.com/_wxexmxgn/chat'
const INDEXNOW_KEY = process.env.INDEXNOW_KEY || 'beokmktindexnow2026key'

async function pingIndexNow(urls, baseUrl = SITE_BASE_URL) {
  const urlList = (Array.isArray(urls) ? urls : [urls]).filter(Boolean)
  if (!urlList.length) return
  try {
    const host = new URL(baseUrl).host
    const res = await fetch('https://api.indexnow.org/indexnow', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        host,
        key: INDEXNOW_KEY,
        keyLocation: `${baseUrl}/${INDEXNOW_KEY}.txt`,
        urlList,
      }),
    })
    console.log(`[indexnow] pinged ${urlList.length} url(s), status=${res.status}`)
  } catch (error) {
    console.warn('[indexnow] ping failed:', error instanceof Error ? error.message : error)
  }
}

function blogPostAbsoluteUrl(post, baseUrl = SITE_BASE_URL) {
  return `${baseUrl}${publicBlogPath(post)}`
}

// 내부 링크용 최근 발행 글 목록 (콘텐츠 생성 프롬프트에 주입)
async function listPublishedPostsForLinks(limit = 12) {
  const snap = await db.collection('blog_posts').where('status', '==', 'published').get()
  return snap.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter((post) => !post.deleted_at && post.slug)
    .sort((a, b) => {
      const da = a.published_at || a.created_at || ''
      const db2 = b.published_at || b.created_at || ''
      return db2.localeCompare(da)
    })
    .slice(0, limit)
    .map((post) => ({
      title: post.title || '',
      url: blogPostAbsoluteUrl(post),
      tags: Array.isArray(post.tags) ? post.tags : [],
    }))
}

function newId() {
  return randomUUID()
}

function nowIso() {
  return new Date().toISOString()
}

function idempotencyKey(req) {
  const v = req.header('Idempotency-Key')
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

async function withIdempotency(req, res, handler) {
  const key = idempotencyKey(req)
  if (key) {
    const snap = await db.collection('idempotency').doc(key).get()
    if (snap.exists) {
      const cached = snap.data()
      return ok(res, cached?.data ?? null, cached?.meta ?? {})
    }
  }

  const result = await handler()

  if (key) {
    await db
      .collection('idempotency')
      .doc(key)
      .set({ data: result.data ?? null, meta: result.meta ?? {}, updated_at: FieldValue.serverTimestamp() }, { merge: true })
  }

  return ok(res, result.data, result.meta)
}

async function addAuditLog(action, target_type, target_id, actor_type = 'system', details = null) {
  const entry = {
    actor_type,
    action,
    target_type,
    target_id,
    created_at: FieldValue.serverTimestamp(),
  }
  if (details && typeof details === 'object') entry.details = details
  await db.collection('audit_logs').add(entry)
}

async function addApprovalRecord(entity_type, entity_id, approval_stage, decision, comment = null) {
  await db.collection('approvals').add({
    entity_type,
    entity_id,
    approval_stage,
    decision,
    reviewer_id: null,
    reviewer_name: null,
    comment,
    requested_at: FieldValue.serverTimestamp(),
    decided_at: FieldValue.serverTimestamp(),
    created_at: FieldValue.serverTimestamp(),
    updated_at: FieldValue.serverTimestamp(),
  })
}

function defaultModelForProvider(provider) {
  const table = {
    openai: 'gpt-4o-mini',
    anthropic: 'claude-3-5-sonnet-20241022',
    gemini: 'gemini-1.5-flash',
    mistral: 'mistral-small-latest',
    cohere: 'command-r',
    zhipu: 'glm-4-flash',
    zai: 'glm-5.1',
  }
  return table[provider] ?? 'gpt-4o-mini'
}

let aiProviderDefaultsCache = {
  fetched_at_ms: 0,
  value: null,
  inflight: null,
}

async function fetchAiProviderDefaults() {
  const snap = await db.collection('settings').doc('ai_provider_defaults').get()
  if (!snap.exists) return null
  const data = snap.data() ?? {}
  return {
    provider: typeof data.provider === 'string' ? data.provider : '',
    apiKey: typeof data.api_key === 'string' ? data.api_key : '',
    model: typeof data.model === 'string' ? data.model : '',
    endpoint: typeof data.endpoint === 'string' ? data.endpoint : '',
    updated_at: data.updated_at ?? null,
  }
}

async function getAiProviderDefaults(options = {}) {
  const force = Boolean(options.force)
  const ttlMs = 30_000
  const now = Date.now()
  if (!force && aiProviderDefaultsCache.value && now - aiProviderDefaultsCache.fetched_at_ms < ttlMs) return aiProviderDefaultsCache.value

  if (!force && aiProviderDefaultsCache.inflight) return aiProviderDefaultsCache.inflight

  const p = fetchAiProviderDefaults()
    .then((value) => {
      aiProviderDefaultsCache.value = value
      aiProviderDefaultsCache.fetched_at_ms = Date.now()
      aiProviderDefaultsCache.inflight = null
      return value
    })
    .catch(() => {
      aiProviderDefaultsCache.inflight = null
      return null
    })

  aiProviderDefaultsCache.inflight = p
  return p
}

async function resolveAiConfig(body = {}) {
  const stored = await getAiProviderDefaults()

  const bodyProvider = typeof body.ai_provider === 'string' ? body.ai_provider.trim() : ''
  const envProvider = process.env.AI_PROVIDER ?? ''
  const provider = bodyProvider || stored?.provider || envProvider

  const bodyApiKey = typeof body.ai_api_key === 'string' ? body.ai_api_key.trim() : ''
  const storedApiKey = stored?.provider && stored.provider === provider ? stored.apiKey : ''
  const envApiKey = process.env.AI_API_KEY ?? ''
  const apiKey = bodyApiKey || storedApiKey || envApiKey

  const bodyModel = typeof body.ai_model === 'string' ? body.ai_model.trim() : ''
  const storedModel = stored?.provider && stored.provider === provider ? stored.model : ''
  const envModel = process.env.AI_MODEL ?? ''
  const model = bodyModel || storedModel || envModel || defaultModelForProvider(provider)

  const bodyEndpoint = typeof body.ai_endpoint === 'string' ? body.ai_endpoint.trim() : ''
  const storedEndpoint = stored?.provider && stored.provider === provider ? stored.endpoint : ''
  const envEndpoint = process.env.AI_ENDPOINT ?? ''
  const endpoint = bodyEndpoint || storedEndpoint || envEndpoint

  return { provider, apiKey, model, endpoint }
}

function aiTraceFromConfig(config = {}) {
  return {
    provider: typeof config.provider === 'string' ? config.provider : '',
    model: typeof config.model === 'string' ? config.model : '',
    endpoint: typeof config.endpoint === 'string' ? config.endpoint : '',
  }
}

function extractTextFromResponse(provider, data) {
  if (!data) return ''

  if (provider === 'anthropic') {
    return Array.isArray(data.content) ? data.content.map((item) => item?.text ?? '').filter(Boolean).join('\n').trim() : ''
  }

  if (provider === 'gemini') {
    const parts = data?.candidates?.[0]?.content?.parts
    return Array.isArray(parts) ? parts.map((part) => part?.text ?? '').filter(Boolean).join('\n').trim() : ''
  }

  if (provider === 'cohere') {
    if (typeof data?.text === 'string') return data.text.trim()
    const content = data?.message?.content
    if (Array.isArray(content)) return content.map((item) => item?.text ?? '').filter(Boolean).join('\n').trim()
    return ''
  }

  const msg = data?.choices?.[0]?.message
  const content = msg?.content
  if (typeof content === 'string' && content.trim()) return content.trim()
  if (Array.isArray(content)) return content.map((item) => item?.text ?? '').filter(Boolean).join('\n').trim()
  // reasoning models (e.g. GLM) may put output in reasoning_content when content is empty
  if (typeof msg?.reasoning_content === 'string' && msg.reasoning_content.trim()) return msg.reasoning_content.trim()
  return ''
}

function maybeParseJson(text) {
  if (!text) return null
  const trimmed = text.trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    const fenced = trimmed.match(/```json\s*([\s\S]*?)```/i) ?? trimmed.match(/```([\s\S]*?)```/i)
    if (fenced?.[1]) {
      try {
        return JSON.parse(fenced[1].trim())
      } catch {
        return null
      }
    }
  }
  return null
}

function defaultTestEndpointForProvider(provider) {
  const table = {
    openai: 'https://api.openai.com/v1/models',
    anthropic: 'https://api.anthropic.com/v1/messages',
    gemini: 'https://generativelanguage.googleapis.com/v1beta/models',
    mistral: 'https://api.mistral.ai/v1/chat/completions',
    cohere: 'https://api.cohere.ai/v1/chat',
    zhipu: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    zai: 'https://api.z.ai/api/coding/paas/v4/chat/completions',
  }
  return table[provider] ?? ''
}

async function validateApiKey(provider, apiKey, endpointOverride = '', modelOverride = '') {
  if (!provider || !apiKey) {
    return {
      valid: false,
      details: 'Provider and API key are required',
      diagnostics: { provider, endpoint: endpointOverride || defaultTestEndpointForProvider(provider), model: modelOverride || defaultModelForProvider(provider), http_status: null },
    }
  }

  let isValid = false
  let errorDetails = ''
  let httpStatus = null
  let usedEndpoint = endpointOverride || defaultTestEndpointForProvider(provider)
  let usedModel = modelOverride || defaultModelForProvider(provider)

  try {
    let response = null

    switch (provider) {
      case 'openai': {
        usedEndpoint = endpointOverride || defaultTestEndpointForProvider(provider)
        response = await fetch(usedEndpoint, {
          method: 'GET',
          headers: { Authorization: `Bearer ${apiKey}` },
        })
        httpStatus = response.status
        if (response.ok) {
          const data = await response.json().catch(() => null)
          isValid = true
          errorDetails = `API 연결 성공 - ${data?.object || 'models'}`
        } else {
          const errorData = await response.json().catch(() => null)
          errorDetails = errorData?.error?.message || `HTTP ${response.status}`
        }
        break
      }

      case 'gemini': {
        const models = modelOverride ? [modelOverride] : ['gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-2.0-flash-exp']
        for (const model of models) {
          usedModel = model
          usedEndpoint =
            endpointOverride && endpointOverride.includes(':generateContent')
              ? endpointOverride
              : `${endpointOverride || defaultTestEndpointForProvider(provider)}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`
          response = await fetch(
            usedEndpoint,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ contents: [{ parts: [{ text: 'hi' }] }] }),
            }
          ).catch(() => null)

          if (response?.ok) {
            httpStatus = response.status
            isValid = true
            errorDetails = `Gemini API 연결 성공 (${model})`
            break
          }
          httpStatus = response?.status ?? null
        }

        if (!isValid) {
          const errorData = response ? await response.json().catch(() => null) : null
          errorDetails = errorData?.error?.message || 'Gemini API 연결 실패'
        }
        break
      }

      case 'zhipu': {
        usedEndpoint = endpointOverride || defaultTestEndpointForProvider(provider)
        response = await fetch(usedEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: usedModel,
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 10,
          }),
        })
        httpStatus = response.status

        if (response.ok) {
          isValid = true
          errorDetails = `Zhipu API 연결 성공 (${usedModel})`
        } else {
          const errorData = await response.json().catch(() => null)
          errorDetails = errorData?.error?.message || `HTTP ${response.status}`
        }
        break
      }

      case 'zai': {
        usedEndpoint = endpointOverride || defaultTestEndpointForProvider(provider)
        response = await fetch(usedEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: usedModel,
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 10,
          }),
        })
        httpStatus = response.status

        if (response.ok) {
          isValid = true
          errorDetails = `Z.ai API 연결 성공 (${usedModel})`
        } else {
          const errorData = await response.json().catch(() => null)
          errorDetails = errorData?.error?.message || errorData?.message || `HTTP ${response.status}`
        }
        break
      }

      case 'anthropic': {
        usedEndpoint = endpointOverride || defaultTestEndpointForProvider(provider)
        response = await fetch(usedEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: usedModel,
            max_tokens: 10,
            messages: [{ role: 'user', content: 'hi' }],
          }),
        })
        httpStatus = response.status

        if (response.ok) {
          isValid = true
          errorDetails = 'Anthropic API 연결 성공'
        } else {
          const errorData = await response.json().catch(() => null)
          errorDetails = errorData?.error?.message || `HTTP ${response.status}`
        }
        break
      }

      case 'cohere': {
        usedEndpoint = endpointOverride || defaultTestEndpointForProvider(provider)
        response = await fetch(usedEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: usedModel,
            message: 'hi',
            max_tokens: 10,
          }),
        })
        httpStatus = response.status

        if (response.ok) {
          isValid = true
          errorDetails = 'Cohere API 연결 성공'
        } else {
          const errorData = await response.json().catch(() => null)
          errorDetails = errorData?.message || `HTTP ${response.status}`
        }
        break
      }

      case 'mistral': {
        usedEndpoint = endpointOverride || defaultTestEndpointForProvider(provider)
        response = await fetch(usedEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: usedModel,
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 10,
          }),
        })
        httpStatus = response.status

        if (response.ok) {
          isValid = true
          errorDetails = 'Mistral API 연결 성공'
        } else {
          const errorData = await response.json().catch(() => null)
          errorDetails = errorData?.message || `HTTP ${response.status}`
        }
        break
      }

      default:
        return {
          valid: false,
          details: 'Unknown provider',
          diagnostics: { provider, endpoint: usedEndpoint, model: usedModel, http_status: httpStatus },
        }
    }
  } catch (e) {
    return {
      valid: false,
      details: e instanceof Error ? e.message : 'Network error',
      diagnostics: { provider, endpoint: usedEndpoint, model: usedModel, http_status: httpStatus },
    }
  }

  return {
    valid: isValid,
    details: isValid ? 'API 연결 성공' : errorDetails,
    diagnostics: { provider, endpoint: usedEndpoint, model: usedModel, http_status: httpStatus },
  }
}

async function generateAiText(config, systemPrompt, userPrompt, options = {}) {
  if (!config.provider || !config.apiKey) return null

  if (config.provider === 'anthropic') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: config.model || defaultModelForProvider(config.provider),
        max_tokens: 1200,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    })
    const data = await res.json().catch(() => null)
    if (!res.ok) throw new Error(data?.error?.message || `Anthropic HTTP ${res.status}`)
    return extractTextFromResponse(config.provider, data)
  }

  if (config.provider === 'gemini') {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.model || defaultModelForProvider(config.provider))}:generateContent?key=${encodeURIComponent(config.apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }] }],
        }),
      }
    )
    const data = await res.json().catch(() => null)
    if (!res.ok) throw new Error(data?.error?.message || `Gemini HTTP ${res.status}`)
    return extractTextFromResponse(config.provider, data)
  }

  if (config.provider === 'cohere') {
    const res = await fetch('https://api.cohere.ai/v1/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model || defaultModelForProvider(config.provider),
        message: userPrompt,
        preamble: systemPrompt,
      }),
    })
    const data = await res.json().catch(() => null)
    if (!res.ok) throw new Error(data?.message || `Cohere HTTP ${res.status}`)
    return extractTextFromResponse(config.provider, data)
  }

  const endpointTable = {
    openai: 'https://api.openai.com/v1/chat/completions',
    mistral: 'https://api.mistral.ai/v1/chat/completions',
    zhipu: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    zai: 'https://api.z.ai/api/coding/paas/v4/chat/completions',
  }

  const endpoint = endpointTable[config.provider]
  if (!endpoint) return null

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model || defaultModelForProvider(config.provider),
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.7,
      ...(options.max_tokens ? { max_tokens: options.max_tokens } : {}),
    }),
  })
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new Error(data?.error?.message || data?.message || `${config.provider} HTTP ${res.status}`)
  return extractTextFromResponse(config.provider, data)
}

async function generateIdeasWithAi(config, item, options) {
  const count = options.ideaCount
  const systemPrompt =
    'You generate short-form content ideas for marketing automation. Return strict JSON only.'
  const userPrompt = [
    `Source title: ${item.title}`,
    `Source summary: ${item.summary ?? ''}`,
    `Source body: ${item.body ?? ''}`,
    `Target platform: ${options.platform}`,
    `Target duration seconds: ${options.durationSec}`,
    `Generate ${count} short-form ideas.`,
    'Return JSON object with key "ideas".',
    'Each idea must have: title, hook, angle, cta, hashtags.',
  ].join('\n')

  const text = await generateAiText(config, systemPrompt, userPrompt)
  const parsed = maybeParseJson(text)
  const ideas = Array.isArray(parsed?.ideas) ? parsed.ideas : null
  if (!ideas?.length) return null
  return ideas.slice(0, count)
}

async function generateScriptWithAi(config, item, idea, options) {
  const systemPrompt =
    'You generate short-form marketing scripts. Return strict JSON only.'
  const userPrompt = [
    `Source title: ${item.title}`,
    `Source summary: ${item.summary ?? ''}`,
    `Idea title: ${idea.title}`,
    `Hook: ${idea.hook}`,
    `Angle: ${idea.angle}`,
    `CTA: ${idea.cta ?? ''}`,
    `Duration seconds: ${options.durationSec}`,
    'Return JSON with keys: script_text, subtitle_text, caption_text, hashtags, tone, language.',
  ].join('\n')

  const text = await generateAiText(config, systemPrompt, userPrompt)
  const parsed = maybeParseJson(text)
  if (!parsed || typeof parsed !== 'object') return null
  return parsed
}

async function generateBlogPostWithAi(config, options) {
  const template = getBlogPromptTemplate(options.category ?? 'marketing', options.tone ?? 'professional')
  const userPrompt = template.buildUserPrompt({
    title: options.title,
    topic: options.topic,
    toneLabel: template.toneLabel,
    lengthGuide: resolveLengthGuide(options.target_length),
    keywords: options.keywords ?? [],
    source_text: options.source_text ?? '',
  })

  const text = await generateAiText(config, template.system, userPrompt, { max_tokens: 4096 })
  const parsed = maybeParseJson(text)
  if (!parsed || typeof parsed !== 'object') return null
  return parsed
}

async function generatePublishMetadataWithAi(config, item, script, options) {
  const systemPrompt =
    'You generate YouTube Shorts or TikTok upload metadata. Return strict JSON only.'
  const userPrompt = [
    `Platform: ${options.platform}`,
    `Source title: ${item.title}`,
    `Source summary: ${item.summary ?? ''}`,
    `Script: ${script.script_text}`,
    `Subtitle: ${script.subtitle_text}`,
    'Return JSON with keys: title, description, hashtags.',
  ].join('\n')

  const text = await generateAiText(config, systemPrompt, userPrompt)
  const parsed = maybeParseJson(text)
  if (!parsed || typeof parsed !== 'object') return null
  return parsed
}

function defaultRenderAssetUrl(id) {
  return `https://storage.googleapis.com/beokmkt-demo/render/${id}.mp4`
}

function defaultThumbnailUrl(id) {
  return `https://storage.googleapis.com/beokmkt-demo/render/${id}.jpg`
}

function defaultPublishPermalink(platform, mediaId) {
  if (platform === 'tiktok') return `https://www.tiktok.com/@beokmkt/video/${mediaId}`
  return `https://www.youtube.com/shorts/${mediaId}`
}

function parseJsonObject(raw) {
  if (!raw || typeof raw !== 'string') return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function buildWebhookConfig(kind, body = {}) {
  const upper = kind === 'render' ? 'RENDER' : 'PUBLISH'
  const url =
    typeof body[`${kind}_webhook_url`] === 'string' && body[`${kind}_webhook_url`].trim()
      ? body[`${kind}_webhook_url`].trim()
      : process.env[`${upper}_EXECUTOR_URL`] ?? ''
  const token =
    typeof body[`${kind}_webhook_token`] === 'string' && body[`${kind}_webhook_token`].trim()
      ? body[`${kind}_webhook_token`].trim()
      : process.env[`${upper}_EXECUTOR_TOKEN`] ?? ''
  const bodyHeaders =
    body[`${kind}_webhook_headers`] && typeof body[`${kind}_webhook_headers`] === 'object' && !Array.isArray(body[`${kind}_webhook_headers`])
      ? body[`${kind}_webhook_headers`]
      : null
  const envHeaders = parseJsonObject(process.env[`${upper}_EXECUTOR_HEADERS_JSON`] ?? '')
  const headers = { ...(envHeaders ?? {}), ...(bodyHeaders ?? {}) }
  return { url, token, headers }
}

async function callWebhookExecutor(config, payload) {
  if (!config.url) return null

  const headers = new Headers({ 'Content-Type': 'application/json' })
  Object.entries(config.headers ?? {}).forEach(([key, value]) => {
    if (typeof value === 'string') headers.set(key, value)
  })
  if (config.token && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${config.token}`)

  const startedAt = Date.now()
  const response = await fetch(config.url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  })
  const data = await response.json().catch(() => null)
  if (!response.ok) {
    const message = data?.error?.message || data?.message || `Webhook HTTP ${response.status}`
    const error = new Error(message)
    error.name = 'WebhookExecutionError'
    const safe = data && typeof data === 'object' && !Array.isArray(data) ? data : {}
    error.details = { ...safe, http_status: response.status, duration_ms: Date.now() - startedAt }
    throw error
  }
  return data
}

async function callWebhookExecutorWithMeta(config, payload) {
  const startedAt = Date.now()
  const data = await callWebhookExecutor(config, payload)
  return { data, meta: { duration_ms: Date.now() - startedAt } }
}

function appendExecutionTrace(execution, trace, limit = 20) {
  const current = Array.isArray(execution?.traces) ? execution.traces.filter(Boolean) : []
  const next = [trace, ...current].slice(0, limit)
  return { ...(execution ?? {}), traces: next }
}

function parseBooleanLike(value, fallback = false) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    if (value === 'true') return true
    if (value === 'false') return false
  }
  return fallback
}

function isRetryDue(nextRetryAt, now = Date.now()) {
  if (!nextRetryAt || typeof nextRetryAt !== 'string') return true
  const ts = Date.parse(nextRetryAt)
  if (Number.isNaN(ts)) return true
  return ts <= now
}

function isDeadLettered(job) {
  const value = job?.dead_lettered_at ?? job?.execution?.dead_lettered_at ?? null
  return typeof value === 'string' && value.trim().length > 0
}

function isExecutionLocked(job, now = Date.now()) {
  const until = job?.execution?.lock_expires_at ?? job?.lock_expires_at
  if (!until || typeof until !== 'string') return false
  const ts = Date.parse(until)
  if (Number.isNaN(ts)) return false
  return ts > now
}

function sortByUpdatedDesc(a, b) {
  const aTime = Date.parse(a.updated_at ?? a.created_at ?? '') || 0
  const bTime = Date.parse(b.updated_at ?? b.created_at ?? '') || 0
  return bTime - aTime
}

function mapFailedJobSummary(jobType, job) {
  return {
    job_type: jobType,
    id: job.id,
    status: job.status,
    error_message: job.error_message ?? null,
    retry_count: Number(job.retry_count ?? 0),
    updated_at: job.updated_at ?? null,
    created_at: job.created_at ?? null,
    provider: job.execution?.provider ?? null,
    adapter: job.execution?.adapter ?? null,
    attempt_count: Number(job.execution?.attempt_count ?? 0),
    last_attempt_at: job.execution?.last_attempt_at ?? null,
    last_error_code: job.execution?.last_error_code ?? null,
    next_retry_at: job.execution?.next_retry_at ?? null,
    lock_expires_at: job.execution?.lock_expires_at ?? null,
    locked_by: job.execution?.locked_by ?? null,
    max_attempts: Number(job.execution?.max_attempts ?? 0),
    dead_lettered_at: job.execution?.dead_lettered_at ?? null,
    dead_letter_reason: job.execution?.dead_letter_reason ?? null,
    platform: job.platform ?? null,
    render_profile: job.render_profile ?? null,
  }
}

function minutesFromNow(minutes) {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString()
}

function computeRetryPolicy(errorCode, attemptCount, body = {}) {
  if (typeof body.next_retry_at === 'string' && body.next_retry_at.trim()) {
    return {
      retryable: true,
      next_retry_at: body.next_retry_at.trim(),
      max_attempts: Number(body.max_attempts ?? 5) || 5,
      dead_lettered_at: null,
      dead_letter_reason: null,
    }
  }

  const code = typeof errorCode === 'string' && errorCode.trim() ? errorCode.trim().toUpperCase() : 'UNKNOWN'
  const permanent = new Set(['AUTH_ERROR', 'INVALID_PAYLOAD', 'UNSUPPORTED_PLATFORM', 'PLATFORM_ACCOUNT_NOT_CONNECTED', 'NOT_FOUND'])
  if (permanent.has(code)) {
    return {
      retryable: false,
      next_retry_at: null,
      max_attempts: attemptCount,
      dead_lettered_at: new Date().toISOString(),
      dead_letter_reason: `permanent:${code}`,
    }
  }

  let maxAttempts = Number(body.max_attempts ?? 0) || 0
  let delayMinutes = 10

  if (code === 'RATE_LIMIT') {
    maxAttempts = maxAttempts || 6
    delayMinutes = Math.min(60, 15 * attemptCount)
  } else if (code === 'RENDER_TIMEOUT' || code === 'NETWORK_ERROR' || code === 'WEBHOOK_ERROR' || code === 'WEBHOOK_FAILED' || code === 'TEMPORARY') {
    maxAttempts = maxAttempts || 5
    delayMinutes = Math.min(120, 5 * 2 ** Math.max(0, attemptCount - 1))
  } else {
    maxAttempts = maxAttempts || 4
    delayMinutes = Math.min(90, 10 * attemptCount)
  }

  if (attemptCount >= maxAttempts) {
    return {
      retryable: false,
      next_retry_at: null,
      max_attempts: maxAttempts,
      dead_lettered_at: new Date().toISOString(),
      dead_letter_reason: `max_attempts:${code}`,
    }
  }

  return {
    retryable: true,
    next_retry_at: minutesFromNow(delayMinutes),
    max_attempts: maxAttempts,
    dead_lettered_at: null,
    dead_letter_reason: null,
  }
}

function normalizeExecutorErrorCode(rawCode, message = '') {
  const code = typeof rawCode === 'string' && rawCode.trim() ? rawCode.trim().toUpperCase() : ''
  if (
    code === 'AUTH_ERROR' ||
    code === 'INVALID_PAYLOAD' ||
    code === 'UNSUPPORTED_PLATFORM' ||
    code === 'PLATFORM_ACCOUNT_NOT_CONNECTED' ||
    code === 'NOT_FOUND' ||
    code === 'RATE_LIMIT' ||
    code === 'NETWORK_ERROR' ||
    code === 'RENDER_TIMEOUT' ||
    code === 'TEMPORARY'
  ) {
    return code
  }

  const text = `${code} ${typeof message === 'string' ? message : ''}`.toLowerCase()
  if (text.includes('rate limit') || text.includes('quota') || text.includes('too many requests')) return 'RATE_LIMIT'
  if (text.includes('timeout') || text.includes('timed out')) return 'RENDER_TIMEOUT'
  if (text.includes('network') || text.includes('econnreset') || text.includes('econnrefused') || text.includes('fetch failed')) return 'NETWORK_ERROR'
  if (text.includes('unauthorized') || text.includes('forbidden') || text.includes('invalid token') || text.includes('auth')) return 'AUTH_ERROR'
  if (text.includes('invalid payload') || text.includes('validation') || text.includes('bad request')) return 'INVALID_PAYLOAD'
  if (text.includes('unsupported platform')) return 'UNSUPPORTED_PLATFORM'
  if (text.includes('platform account') && text.includes('not connected')) return 'PLATFORM_ACCOUNT_NOT_CONNECTED'
  if (text.includes('not found') || text.includes('missing')) return 'NOT_FOUND'
  return 'TEMPORARY'
}

function resolveExecutionErrorCode(error, fallbackCode = 'WEBHOOK_ERROR') {
  if (!error || typeof error !== 'object') return normalizeExecutorErrorCode(fallbackCode)

  const directCode = typeof error.errorCode === 'string' ? error.errorCode : null
  const detailCode =
    typeof error.details?.error?.code === 'string'
      ? error.details.error.code
      : typeof error.details?.code === 'string'
        ? error.details.code
        : null
  const message = error instanceof Error ? error.message : typeof error.message === 'string' ? error.message : ''
  return normalizeExecutorErrorCode(directCode ?? detailCode ?? fallbackCode, message)
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function normalizePublishStatus(value, fallback) {
  const s = typeof value === 'string' ? value : ''
  if (s === 'published' || s === 'uploaded') return s
  if (s === 'failed') return 'failed'
  return fallback
}

async function acquireJobExecutionLock(ref, desiredStatus, actorType, ttlMinutes, allowedStatuses = null) {
  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists) return { exists: false }
    const job = snap.data() ?? {}

    if (isDeadLettered(job)) return { exists: true, acquired: false, reason: 'dead_lettered', job: { id: snap.id, ...job } }
    if (Array.isArray(allowedStatuses) && allowedStatuses.length && !allowedStatuses.includes(job.status)) {
      return { exists: true, acquired: false, reason: 'not_runnable', job: { id: snap.id, ...job } }
    }

    const now = Date.now()
    if (isExecutionLocked({ execution: job.execution }, now)) {
      return {
        exists: true,
        acquired: false,
        reason: 'locked',
        job: { id: snap.id, ...job },
        lock_expires_at: job.execution?.lock_expires_at ?? null,
        locked_by: job.execution?.locked_by ?? null,
      }
    }

    const lastAttemptAt = new Date().toISOString()
    const attemptCount = Number(job.execution?.attempt_count ?? 0) + 1
    const execution = {
      ...(job.execution ?? {}),
      attempt_count: attemptCount,
      last_attempt_at: lastAttemptAt,
      last_error_code: null,
      next_retry_at: null,
      locked_at: lastAttemptAt,
      lock_expires_at: minutesFromNow(ttlMinutes),
      locked_by: actorType,
    }

    tx.set(
      ref,
      {
        status: desiredStatus,
        error_message: null,
        execution,
        updated_at: FieldValue.serverTimestamp(),
      },
      { merge: true }
    )

    return { exists: true, acquired: true, job: { id: snap.id, ...job, status: desiredStatus, execution }, attemptCount, lastAttemptAt }
  })

  if (!result.exists) throw new Error('job_not_found')
  return result
}

async function restoreDeadLetterJob(jobType, jobId, body = {}, actorType = 'ai') {
  const isRender = jobType === 'render'
  const collectionName = isRender ? 'render_jobs' : 'publish_jobs'
  const targetType = isRender ? 'render_job' : 'publish_job'
  const ref = db.collection(collectionName).doc(jobId)
  const snap = await ref.get()
  if (!snap.exists) throw new Error(`${targetType}_not_found`)

  const job = { id: snap.id, ...snap.data() }
  if (job.status !== 'failed') throw new Error('job_not_failed')
  if (!isDeadLettered(job)) throw new Error('job_not_dead_lettered')

  const resetAttempts = body.reset_attempts === true
  const nextRetryAt =
    typeof body.next_retry_at === 'string' && body.next_retry_at.trim() ? body.next_retry_at.trim() : null
  const currentMaxAttempts = Number(job.execution?.max_attempts ?? 0) || null
  const requestedMaxAttempts = Number(body.max_attempts ?? 0) || currentMaxAttempts

  await ref.set(
    {
      retry_count: resetAttempts ? 0 : Number(job.retry_count ?? 0),
      execution: {
        ...(job.execution ?? {}),
        attempt_count: resetAttempts ? 0 : Number(job.execution?.attempt_count ?? 0),
        last_attempt_at: resetAttempts ? null : job.execution?.last_attempt_at ?? null,
        next_retry_at: nextRetryAt,
        max_attempts: requestedMaxAttempts,
        dead_lettered_at: null,
        dead_letter_reason: null,
        locked_at: null,
        lock_expires_at: null,
        locked_by: null,
      },
      updated_at: FieldValue.serverTimestamp(),
    },
    { merge: true }
  )
  await addAuditLog(`${targetType}.dead_letter_restored`, targetType, jobId, actorType)

  return {
    job_type: jobType,
    id: jobId,
    status: 'failed',
    next_retry_at: nextRetryAt,
    max_attempts: requestedMaxAttempts,
    reset_attempts: resetAttempts,
  }
}

async function executeRenderJobById(renderJobId, body = {}, actorType = 'ai') {
  const ref = db.collection('render_jobs').doc(renderJobId)
  const locked = await acquireJobExecutionLock(ref, 'rendering', actorType, 15, ['queued', 'failed', 'rendering'])
  if (!locked.acquired) throw new Error(locked.reason === 'locked' ? 'job_locked' : locked.reason === 'dead_lettered' ? 'job_dead_lettered' : 'job_not_runnable')
  const renderJob = locked.job
  const attemptCount = locked.attemptCount
  const lastAttemptAt = locked.lastAttemptAt
  const webhook = buildWebhookConfig('render', body)

  const executedAt = new Date().toISOString()
  try {
    const scriptSnap = await db.collection('scripts').doc(renderJob.script_id).get()
    if (!scriptSnap.exists) throw new Error('script_not_found')
    const script = scriptSnap.data()

    if (body.simulate_failure === true) {
      const retryPolicy = computeRetryPolicy('SIMULATED_FAILURE', attemptCount, body)
      await ref.set(
        {
          status: 'failed',
          error_message: typeof body.error_message === 'string' ? body.error_message : 'AI render execution failed',
          execution: {
            ...(renderJob.execution ?? {}),
            adapter: 'local',
            provider: typeof body.render_provider === 'string' ? body.render_provider : 'ai-renderer',
            attempt_count: attemptCount,
            last_attempt_at: lastAttemptAt,
            last_error_code: 'SIMULATED_FAILURE',
            next_retry_at: retryPolicy.next_retry_at,
            max_attempts: retryPolicy.max_attempts,
            dead_lettered_at: retryPolicy.dead_lettered_at,
            dead_letter_reason: retryPolicy.dead_letter_reason,
            locked_at: null,
            lock_expires_at: null,
            locked_by: null,
          },
          updated_at: FieldValue.serverTimestamp(),
        },
        { merge: true }
      )
      await addAuditLog('render_job.execution_failed', 'render_job', renderJobId, actorType)
      return {
        id: renderJobId,
        status: 'failed',
        qc_status: renderJob.qc_status ?? 'pending',
        error_message: typeof body.error_message === 'string' ? body.error_message : 'AI render execution failed',
      }
    }

    const autoPassQc = body.auto_pass_qc !== false
    let output = {
      asset_url: typeof body.output_url === 'string' && body.output_url.trim() ? body.output_url.trim() : defaultRenderAssetUrl(renderJobId),
      thumbnail_url: typeof body.thumbnail_url === 'string' && body.thumbnail_url.trim() ? body.thumbnail_url.trim() : defaultThumbnailUrl(renderJobId),
      duration_sec: Number(body.duration_sec ?? script?.duration_sec ?? 0) || 0,
      subtitles_included: body.subtitles_included !== false,
      render_provider: typeof body.render_provider === 'string' ? body.render_provider : 'ai-renderer',
      executed_at: executedAt,
    }
    let qcStatus = autoPassQc ? 'passed' : renderJob.qc_status ?? 'pending'
    let execution = {
      ...(renderJob.execution ?? {}),
      adapter: webhook.url ? 'webhook' : 'local',
      provider: typeof body.render_provider === 'string' ? body.render_provider : 'ai-renderer',
      attempt_count: attemptCount,
      last_attempt_at: lastAttemptAt,
      last_error_code: null,
      next_retry_at: null,
      external_job_id: null,
      locked_at: null,
      lock_expires_at: null,
      locked_by: null,
    }

    if (webhook.url) {
      try {
        const webhookResult = await callWebhookExecutorWithMeta(webhook, {
          kind: 'render',
          render_job_id: renderJobId,
          script_id: renderJob.script_id,
          short_idea_id: renderJob.short_idea_id,
          render_profile: renderJob.render_profile,
          script,
          options: body,
        })
        const external = webhookResult?.data

      output = {
        asset_url: typeof external?.output?.asset_url === 'string' ? external.output.asset_url : typeof external?.asset_url === 'string' ? external.asset_url : output.asset_url,
        thumbnail_url:
          typeof external?.output?.thumbnail_url === 'string'
            ? external.output.thumbnail_url
            : typeof external?.thumbnail_url === 'string'
              ? external.thumbnail_url
              : output.thumbnail_url,
        duration_sec: Number(external?.output?.duration_sec ?? external?.duration_sec ?? output.duration_sec) || output.duration_sec,
        subtitles_included: external?.output?.subtitles_included ?? external?.subtitles_included ?? output.subtitles_included,
        render_provider: typeof external?.output?.render_provider === 'string' ? external.output.render_provider : typeof external?.render_provider === 'string' ? external.render_provider : output.render_provider,
        executed_at: typeof external?.output?.executed_at === 'string' ? external.output.executed_at : typeof external?.executed_at === 'string' ? external.executed_at : output.executed_at,
      }
      qcStatus = external?.qc_status === 'passed' || external?.auto_pass_qc === true ? 'passed' : qcStatus
      execution = {
        ...execution,
        provider: output.render_provider,
        external_job_id: typeof external?.external_job_id === 'string' ? external.external_job_id : null,
      }

        execution = appendExecutionTrace(execution, {
          at: executedAt,
          kind: 'render',
          adapter: 'webhook',
          duration_ms: Number(webhookResult?.meta?.duration_ms ?? 0) || null,
          http_status: null,
          status: typeof external?.status === 'string' ? external.status : 'rendered',
          error_code: typeof external?.error_code === 'string' ? normalizeExecutorErrorCode(external.error_code, typeof external?.error_message === 'string' ? external.error_message : '') : null,
          error_message: typeof external?.error_message === 'string' ? external.error_message : null,
          external_job_id: execution.external_job_id ?? null,
        })

        const executorStatus = typeof external?.status === 'string' ? external.status : ''
        if (executorStatus && executorStatus !== 'failed' && !isNonEmptyString(output.asset_url)) {
          const errorCode = 'INVALID_PAYLOAD'
          const retryPolicy = computeRetryPolicy(errorCode, attemptCount, body)
          await ref.set(
            {
              status: 'failed',
              error_message: 'External render executor returned invalid output',
              execution: {
                ...execution,
                last_error_code: errorCode,
                next_retry_at: retryPolicy.next_retry_at,
                max_attempts: retryPolicy.max_attempts,
                dead_lettered_at: retryPolicy.dead_lettered_at,
                dead_letter_reason: retryPolicy.dead_letter_reason,
              },
              updated_at: FieldValue.serverTimestamp(),
            },
            { merge: true }
          )
          await addAuditLog('render_job.execution_failed', 'render_job', renderJobId, actorType)
          return { id: renderJobId, status: 'failed', qc_status: renderJob.qc_status ?? 'pending', error_message: 'External render executor returned invalid output' }
        }

      if (external?.status === 'failed') {
        const errorCode = normalizeExecutorErrorCode(external?.error_code, typeof external?.error_message === 'string' ? external.error_message : '')
        const retryPolicy = computeRetryPolicy(errorCode, attemptCount, body)
        await ref.set(
          {
            status: 'failed',
            error_message: typeof external?.error_message === 'string' ? external.error_message : 'External render executor failed',
            execution: {
              ...execution,
              last_error_code: errorCode,
              next_retry_at: typeof external?.next_retry_at === 'string' ? external.next_retry_at : retryPolicy.next_retry_at,
              max_attempts: retryPolicy.max_attempts,
              dead_lettered_at: retryPolicy.dead_lettered_at,
              dead_letter_reason: retryPolicy.dead_letter_reason,
            },
            updated_at: FieldValue.serverTimestamp(),
          },
          { merge: true }
        )
        await addAuditLog('render_job.execution_failed', 'render_job', renderJobId, actorType)
        return {
          id: renderJobId,
          status: 'failed',
          qc_status: renderJob.qc_status ?? 'pending',
          error_message: typeof external?.error_message === 'string' ? external.error_message : 'External render executor failed',
        }
      }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'External render executor failed'
        const errorCode = resolveExecutionErrorCode(error, 'WEBHOOK_ERROR')
        const retryPolicy = computeRetryPolicy(errorCode, attemptCount, body)
        const durationMs = Number(error?.details?.duration_ms ?? 0) || null
        const httpStatus = Number(error?.details?.http_status ?? 0) || null
        await ref.set(
          {
            status: 'failed',
            error_message: message,
            execution: {
              ...appendExecutionTrace(execution, {
                at: executedAt,
                kind: 'render',
                adapter: 'webhook',
                duration_ms: durationMs,
                http_status: httpStatus,
                status: 'failed',
                error_code: errorCode,
                error_message: message,
                external_job_id: execution.external_job_id ?? null,
              }),
              last_error_code: errorCode,
              next_retry_at: retryPolicy.next_retry_at,
              max_attempts: retryPolicy.max_attempts,
              dead_lettered_at: retryPolicy.dead_lettered_at,
              dead_letter_reason: retryPolicy.dead_letter_reason,
            },
            updated_at: FieldValue.serverTimestamp(),
          },
          { merge: true }
        )
        await addAuditLog('render_job.execution_failed', 'render_job', renderJobId, actorType)
        return { id: renderJobId, status: 'failed', qc_status: renderJob.qc_status ?? 'pending', error_message: message }
      }
    }

    if (!webhook.url) {
      execution = appendExecutionTrace(execution, {
        at: executedAt,
        kind: 'render',
        adapter: 'local',
        duration_ms: null,
        http_status: null,
        status: 'rendered',
        error_code: null,
        error_message: null,
        external_job_id: null,
      })
    }

    await ref.set(
      {
        status: 'rendered',
        qc_status: qcStatus,
        output,
        execution,
        error_message: null,
        updated_at: FieldValue.serverTimestamp(),
      },
      { merge: true }
    )
    await addAuditLog('render_job.executed', 'render_job', renderJobId, actorType)
    if (autoPassQc && renderJob.qc_status !== 'passed') {
      await addApprovalRecord('render_job', renderJobId, 'render_review', 'approved', 'AI execution auto approval')
      await addAuditLog('render_job.auto_approved', 'render_job', renderJobId, actorType)
    }

    return { id: renderJobId, status: 'rendered', qc_status: qcStatus, output }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'render execution failed'
    const errorCode = error instanceof Error && error.message === 'script_not_found' ? 'NOT_FOUND' : resolveExecutionErrorCode(error, 'TEMPORARY')
    const retryPolicy = computeRetryPolicy(errorCode, attemptCount, body)
    await ref.set(
      {
        status: 'failed',
        error_message: message,
        execution: {
          ...(renderJob.execution ?? {}),
          adapter: webhook.url ? 'webhook' : 'local',
          provider: typeof body.render_provider === 'string' ? body.render_provider : 'ai-renderer',
          attempt_count: attemptCount,
          last_attempt_at: lastAttemptAt,
          last_error_code: errorCode,
          next_retry_at: retryPolicy.next_retry_at,
          max_attempts: retryPolicy.max_attempts,
          dead_lettered_at: retryPolicy.dead_lettered_at,
          dead_letter_reason: retryPolicy.dead_letter_reason,
          locked_at: null,
          lock_expires_at: null,
          locked_by: null,
        },
        updated_at: FieldValue.serverTimestamp(),
      },
      { merge: true }
    )
    await addAuditLog('render_job.execution_failed', 'render_job', renderJobId, actorType)
    return { id: renderJobId, status: 'failed', qc_status: renderJob.qc_status ?? 'pending', error_message: message }
  }
}

async function executePublishJobById(publishJobId, body = {}, actorType = 'ai') {
  const ref = db.collection('publish_jobs').doc(publishJobId)
  const snap = await ref.get()
  if (!snap.exists) throw new Error('publish_job_not_found')
  let publishJob = { id: snap.id, ...snap.data() }
  if (publishJob.status === 'cancelled') throw new Error('publish_job_cancelled')

  const renderJobId = publishJob.render_job_id
  const renderSnap = await db.collection('render_jobs').doc(renderJobId).get()
  if (!renderSnap.exists) throw new Error('render_job_not_found')
  let renderJob = { id: renderSnap.id, ...renderSnap.data() }

  if (renderJob.status !== 'rendered') {
    if (body.execute_render_first === false) throw new Error('render_not_executed')
    const renderResult = await executeRenderJobById(renderJobId, body.render ?? body, actorType)
    const nextRenderSnap = await db.collection('render_jobs').doc(renderJobId).get()
    renderJob = { id: nextRenderSnap.id, ...nextRenderSnap.data() }
    if (renderResult.status === 'failed') throw new Error('render_execution_failed')
  }

  if (publishJob.status === 'awaiting_approval') {
    if (body.approve_publish === false) throw new Error('publish_not_approved')
    await ref.set({ status: 'queued', updated_at: FieldValue.serverTimestamp() }, { merge: true })
    await addApprovalRecord('publish_job', publishJobId, 'publish_review', 'approved', 'AI execution auto approval')
    await addAuditLog('publish_job.auto_approved', 'publish_job', publishJobId, actorType)
  }

  const accountId = publishJob.platform_account_id
  const accountSnap = accountId ? await db.collection('platform_accounts').doc(accountId).get() : null
  if (!accountSnap?.exists) throw new Error('platform_account_not_found')
  if (accountSnap.data()?.status !== 'connected') throw new Error('platform_account_not_connected')
  const webhook = buildWebhookConfig('publish', body)
  const locked = await acquireJobExecutionLock(ref, 'uploading', actorType, 20, ['queued', 'failed', 'uploading'])
  if (!locked.acquired) throw new Error(locked.reason === 'locked' ? 'job_locked' : locked.reason === 'dead_lettered' ? 'job_dead_lettered' : 'job_not_runnable')
  publishJob = locked.job
  const attemptCount = locked.attemptCount
  const lastAttemptAt = locked.lastAttemptAt
  const accountExpiresAt = accountSnap.data()?.access_token_expires_at
  if (isNonEmptyString(accountExpiresAt)) {
    const ts = Date.parse(accountExpiresAt)
    if (!Number.isNaN(ts) && ts <= Date.now()) {
      const errorCode = 'PLATFORM_ACCOUNT_NOT_CONNECTED'
      const retryPolicy = computeRetryPolicy(errorCode, attemptCount, body)
      await ref.set(
        {
          status: 'failed',
          error_message: 'platform account token expired',
          execution: {
            ...(publishJob.execution ?? {}),
            adapter: webhook.url ? 'webhook' : 'local',
            provider: typeof body.publish_provider === 'string' ? body.publish_provider : 'ai-uploader',
            attempt_count: attemptCount,
            last_attempt_at: lastAttemptAt,
            last_error_code: errorCode,
            next_retry_at: retryPolicy.next_retry_at,
            max_attempts: retryPolicy.max_attempts,
            dead_lettered_at: retryPolicy.dead_lettered_at,
            dead_letter_reason: retryPolicy.dead_letter_reason,
            locked_at: null,
            lock_expires_at: null,
            locked_by: null,
          },
          updated_at: FieldValue.serverTimestamp(),
        },
        { merge: true }
      )
      await addAuditLog('publish_job.execution_failed', 'publish_job', publishJobId, actorType)
      return { id: publishJobId, status: 'failed', error_message: 'platform account token expired', render_job_id: renderJobId }
    }
  }

  if (body.simulate_failure === true) {
    const retryPolicy = computeRetryPolicy('SIMULATED_FAILURE', attemptCount, body)
    await ref.set(
      {
        status: 'failed',
        error_message: typeof body.error_message === 'string' ? body.error_message : 'AI publish execution failed',
        execution: {
          ...(publishJob.execution ?? {}),
          adapter: 'local',
          provider: typeof body.publish_provider === 'string' ? body.publish_provider : 'ai-uploader',
          attempt_count: attemptCount,
          last_attempt_at: lastAttemptAt,
          last_error_code: 'SIMULATED_FAILURE',
          next_retry_at: retryPolicy.next_retry_at,
          max_attempts: retryPolicy.max_attempts,
          dead_lettered_at: retryPolicy.dead_lettered_at,
          dead_letter_reason: retryPolicy.dead_letter_reason,
          locked_at: null,
          lock_expires_at: null,
          locked_by: null,
        },
        updated_at: FieldValue.serverTimestamp(),
      },
      { merge: true }
    )
    await addAuditLog('publish_job.execution_failed', 'publish_job', publishJobId, actorType)
    return { id: publishJobId, status: 'failed', error_message: typeof body.error_message === 'string' ? body.error_message : 'AI publish execution failed', render_job_id: renderJobId }
  }

  const executedAt = new Date().toISOString()
  const platform = publishJob.platform || accountSnap.data()?.platform || 'youtube'
  const mediaId = typeof body.platform_media_id === 'string' && body.platform_media_id.trim() ? body.platform_media_id.trim() : newId()
  const finalStatus =
    typeof body.final_status === 'string' ? body.final_status : publishJob.payload?.visibility === 'public' ? 'published' : 'uploaded'
  let result = {
    platform_media_id: mediaId,
    permalink:
      typeof body.permalink === 'string' && body.permalink.trim() ? body.permalink.trim() : defaultPublishPermalink(platform, mediaId),
    uploaded_at: executedAt,
    publish_provider: typeof body.publish_provider === 'string' ? body.publish_provider : 'ai-uploader',
    render_asset_url: renderJob.output?.asset_url ?? null,
  }
  let execution = {
    ...(publishJob.execution ?? {}),
    adapter: webhook.url ? 'webhook' : 'local',
    provider: typeof body.publish_provider === 'string' ? body.publish_provider : 'ai-uploader',
    attempt_count: attemptCount,
    last_attempt_at: lastAttemptAt,
    last_error_code: null,
    next_retry_at: null,
    external_job_id: null,
    locked_at: null,
    lock_expires_at: null,
    locked_by: null,
  }
  let nextStatus = finalStatus

  if (webhook.url) {
    try {
      const webhookResult = await callWebhookExecutorWithMeta(webhook, {
        kind: 'publish',
        publish_job_id: publishJobId,
        platform,
        publish_job: publishJob,
        render_job: renderJob,
        account: { id: accountSnap.id, ...accountSnap.data() },
        options: body,
      })
      const external = webhookResult?.data

      result = {
        platform_media_id:
          typeof external?.result?.platform_media_id === 'string'
            ? external.result.platform_media_id
            : typeof external?.platform_media_id === 'string'
              ? external.platform_media_id
              : result.platform_media_id,
        permalink:
          typeof external?.result?.permalink === 'string'
            ? external.result.permalink
            : typeof external?.permalink === 'string'
              ? external.permalink
              : result.permalink,
        uploaded_at:
          typeof external?.result?.uploaded_at === 'string'
            ? external.result.uploaded_at
            : typeof external?.uploaded_at === 'string'
              ? external.uploaded_at
              : result.uploaded_at,
        publish_provider:
          typeof external?.result?.publish_provider === 'string'
            ? external.result.publish_provider
            : typeof external?.publish_provider === 'string'
              ? external.publish_provider
              : result.publish_provider,
        render_asset_url:
          typeof external?.result?.render_asset_url === 'string'
            ? external.result.render_asset_url
            : result.render_asset_url,
      }
      execution = {
        ...execution,
        provider: result.publish_provider,
        external_job_id: typeof external?.external_job_id === 'string' ? external.external_job_id : null,
      }
      nextStatus = normalizePublishStatus(external?.status, nextStatus)

      execution = appendExecutionTrace(execution, {
        at: executedAt,
        kind: 'publish',
        adapter: 'webhook',
        duration_ms: Number(webhookResult?.meta?.duration_ms ?? 0) || null,
        http_status: null,
        status: typeof external?.status === 'string' ? external.status : nextStatus,
        error_code: typeof external?.error_code === 'string' ? normalizeExecutorErrorCode(external.error_code, typeof external?.error_message === 'string' ? external.error_message : '') : null,
        error_message: typeof external?.error_message === 'string' ? external.error_message : null,
        external_job_id: execution.external_job_id ?? null,
      })

      if (nextStatus !== 'failed') {
        const hasMediaId = isNonEmptyString(result.platform_media_id)
        const hasPermalink = isNonEmptyString(result.permalink)
        if (!hasMediaId && !hasPermalink) {
          const errorCode = 'INVALID_PAYLOAD'
          const retryPolicy = computeRetryPolicy(errorCode, attemptCount, body)
          await ref.set(
            {
              status: 'failed',
              error_message: 'External publish executor returned invalid result',
              execution: {
                ...execution,
                last_error_code: errorCode,
                next_retry_at: retryPolicy.next_retry_at,
                max_attempts: retryPolicy.max_attempts,
                dead_lettered_at: retryPolicy.dead_lettered_at,
                dead_letter_reason: retryPolicy.dead_letter_reason,
              },
              updated_at: FieldValue.serverTimestamp(),
            },
            { merge: true }
          )
          await addAuditLog('publish_job.execution_failed', 'publish_job', publishJobId, actorType)
          return { id: publishJobId, status: 'failed', error_message: 'External publish executor returned invalid result', render_job_id: renderJobId }
        }
      }

      if (external?.status === 'failed') {
        const errorCode = normalizeExecutorErrorCode(external?.error_code, typeof external?.error_message === 'string' ? external.error_message : '')
        const retryPolicy = computeRetryPolicy(errorCode, attemptCount, body)
        await ref.set(
          {
            status: 'failed',
            error_message: typeof external?.error_message === 'string' ? external.error_message : 'External publish executor failed',
            execution: {
              ...execution,
              last_error_code: errorCode,
              next_retry_at: typeof external?.next_retry_at === 'string' ? external.next_retry_at : retryPolicy.next_retry_at,
              max_attempts: retryPolicy.max_attempts,
              dead_lettered_at: retryPolicy.dead_lettered_at,
              dead_letter_reason: retryPolicy.dead_letter_reason,
            },
            updated_at: FieldValue.serverTimestamp(),
          },
          { merge: true }
        )
        await addAuditLog('publish_job.execution_failed', 'publish_job', publishJobId, actorType)
        return {
          id: publishJobId,
          status: 'failed',
          error_message: typeof external?.error_message === 'string' ? external.error_message : 'External publish executor failed',
          render_job_id: renderJobId,
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'External publish executor failed'
      const errorCode = resolveExecutionErrorCode(error, 'WEBHOOK_ERROR')
      const retryPolicy = computeRetryPolicy(errorCode, attemptCount, body)
      const durationMs = Number(error?.details?.duration_ms ?? 0) || null
      const httpStatus = Number(error?.details?.http_status ?? 0) || null
      await ref.set(
        {
          status: 'failed',
          error_message: message,
          execution: {
            ...appendExecutionTrace(execution, {
              at: executedAt,
              kind: 'publish',
              adapter: 'webhook',
              duration_ms: durationMs,
              http_status: httpStatus,
              status: 'failed',
              error_code: errorCode,
              error_message: message,
              external_job_id: execution.external_job_id ?? null,
            }),
            last_error_code: errorCode,
            next_retry_at: retryPolicy.next_retry_at,
            max_attempts: retryPolicy.max_attempts,
            dead_lettered_at: retryPolicy.dead_lettered_at,
            dead_letter_reason: retryPolicy.dead_letter_reason,
          },
          updated_at: FieldValue.serverTimestamp(),
        },
        { merge: true }
      )
      await addAuditLog('publish_job.execution_failed', 'publish_job', publishJobId, actorType)
      return { id: publishJobId, status: 'failed', error_message: message, render_job_id: renderJobId }
    }
  }

  if (!webhook.url) {
    execution = appendExecutionTrace(execution, {
      at: executedAt,
      kind: 'publish',
      adapter: 'local',
      duration_ms: null,
      http_status: null,
      status: nextStatus,
      error_code: null,
      error_message: null,
      external_job_id: null,
    })
  }

  await ref.set(
    {
      status: nextStatus,
      result,
      execution,
      error_message: null,
      updated_at: FieldValue.serverTimestamp(),
    },
    { merge: true }
  )
  await addAuditLog('publish_job.executed', 'publish_job', publishJobId, actorType)

  return { id: publishJobId, status: nextStatus, result, render_job_id: renderJobId }
}

function parseLimit(req, fallback = 20) {
  const v = Number(req.query.limit ?? fallback) || fallback
  return Math.min(Math.max(v, 1), 100)
}

function parseOffset(req) {
  const v = Number(req.query.offset ?? 0) || 0
  return Math.max(v, 0)
}

async function listCollection(name, limit, offset, whereClauses = []) {
  let q = db.collection(name).orderBy('created_at', 'desc')
  for (const c of whereClauses) {
    q = q.where(c.field, c.op, c.value)
  }
  const totalSnap = await q.get()
  const total = totalSnap.size
  const pageSnap = await q.offset(offset).limit(limit).get()
  const items = pageSnap.docs.map((d) => ({ id: d.id, ...d.data() }))
  return { items, total, limit, offset }
}

app.get('/api/health', (req, res) => {
  ok(res, { ok: true })
})

app.get('/api/test-ai-key', async (req, res) => {
  const provider = typeof req.query.provider === 'string' ? req.query.provider : ''
  const apiKey = typeof req.query.apiKey === 'string' ? req.query.apiKey : ''
  const endpoint = typeof req.query.endpoint === 'string' ? req.query.endpoint : ''
  const model = typeof req.query.model === 'string' ? req.query.model : ''
  const result = await validateApiKey(provider, apiKey, endpoint, model)
  res.json(result)
})

app.post('/api/test-ai-key', async (req, res) => {
  const provider = typeof req.body?.provider === 'string' ? req.body.provider : typeof req.query.provider === 'string' ? req.query.provider : ''
  const apiKey = typeof req.body?.apiKey === 'string' ? req.body.apiKey : typeof req.query.apiKey === 'string' ? req.query.apiKey : ''
  const endpoint =
    typeof req.body?.endpoint === 'string' ? req.body.endpoint : typeof req.query.endpoint === 'string' ? req.query.endpoint : ''
  const model = typeof req.body?.model === 'string' ? req.body.model : typeof req.query.model === 'string' ? req.query.model : ''
  const result = await validateApiKey(provider, apiKey, endpoint, model)
  res.json(result)
})

app.get('/api/ai-provider-defaults', async (req, res) => {
  const stored = await getAiProviderDefaults({ force: true })
  ok(res, {
    provider: stored?.provider ?? '',
    model: stored?.model ?? '',
    endpoint: stored?.endpoint ?? '',
    has_api_key: Boolean(stored?.apiKey),
    updated_at: stored?.updated_at ?? null,
  })
})

app.put('/api/ai-provider-defaults', async (req, res) => {
  const body = req.body ?? {}

  const provider = typeof body.provider === 'string' ? body.provider.trim() : ''
  const model = typeof body.model === 'string' ? body.model.trim() : ''
  const endpoint = typeof body.endpoint === 'string' ? body.endpoint.trim() : ''
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''

  if (!provider) return fail(res, 400, 'VALIDATION_ERROR', 'provider is required', {})

  const ref = db.collection('settings').doc('ai_provider_defaults')
  const current = await ref.get()
  const currentData = current.data() ?? {}

  const next = {
    provider,
    model: model || currentData.model || defaultModelForProvider(provider),
    endpoint: endpoint || currentData.endpoint || '',
    api_key: apiKey || currentData.api_key || '',
    updated_at: FieldValue.serverTimestamp(),
    updated_by: req.user?.uid ?? null,
  }

  await ref.set(next, { merge: true })
  aiProviderDefaultsCache.fetched_at_ms = 0
  aiProviderDefaultsCache.value = null

  await addAuditLog('ai_provider_defaults.updated', 'settings', 'ai_provider_defaults', 'user')

  ok(res, {
    provider: next.provider,
    model: next.model,
    endpoint: next.endpoint,
    has_api_key: Boolean(next.api_key),
    updated_at: null,
  })
})

app.get('/api/dashboard', (req, res) => {
  res.redirect('/api/pipeline/stats')
})

app.post('/api/pipeline/commands', async (req, res) => {
  let normalized
  try {
    normalized = normalizePipelineCommandRequest(req.body ?? {})
  } catch (e) {
    return fail(res, e.status || 400, e.code || 'VALIDATION_ERROR', e.message, e.details || {})
  }

  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 500) : ''
  const requestedBy = req.user?.email ?? req.user?.uid ?? 'api-key'
  const batchId = randomUUID()
  const nowMs = Date.now()
  const created = []
  const batch = db.batch()
  normalized.tasks.forEach((task, index) => {
    const ref = db.collection('pipeline_commands').doc()
    created.push(ref.id)
    batch.set(ref, {
      task,
      runbook: normalized.runbook,
      batch_id: batchId,
      sequence: index,
      status: 'pending',
      active: true,
      attempts: 0,
      reason,
      requested_by: requestedBy,
      created_at: new Date(nowMs + index),
      updated_at: FieldValue.serverTimestamp(),
    })
  })
  await batch.commit()
  ok(res, {
    batch_id: batchId,
    command_ids: created,
    tasks: normalized.tasks,
    status: 'pending',
  })
})

app.get('/api/pipeline/commands', async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status.trim() : ''
  const limit = Math.min(Math.max(Number(req.query.limit || 20), 1), 100)
  const query = status
    ? db.collection('pipeline_commands').where('status', '==', status).limit(100)
    : db.collection('pipeline_commands').orderBy('created_at', 'desc').limit(limit)
  const snap = await query.get()
  ok(res, {
    commands: snap.docs
      .map((doc) => ({ id: doc.id, ...doc.data() }))
      .sort((a, b) => pipelineCommandTimeMs(b) - pipelineCommandTimeMs(a))
      .slice(0, limit),
  })
})

app.post('/api/pipeline/commands/claim', async (req, res) => {
  const workerId = typeof req.body?.worker_id === 'string' && req.body.worker_id.trim()
    ? req.body.worker_id.trim().slice(0, 120)
    : 'windows-worker'
  const leaseMs = Math.min(Math.max(Number(req.body?.lease_ms || 30 * 60 * 1000), 60_000), 2 * 60 * 60 * 1000)
  const now = new Date()
  const leaseUntil = new Date(now.getTime() + leaseMs)

  const claimed = await db.runTransaction(async (tx) => {
    const activeQuery = db.collection('pipeline_commands')
      .where('active', '==', true)
      .limit(100)
    const activeSnap = await tx.get(activeQuery)
    const activeCommands = activeSnap.docs.map((doc) => ({ id: doc.id, ref: doc.ref, ...doc.data() }))
    const candidates = activeCommands
      .filter((command) => isRunnablePipelineCommand(command, now))
      .sort((a, b) => pipelineCommandTimeMs(a) - pipelineCommandTimeMs(b))
    let command = null
    for (const candidate of candidates) {
      let commandScope = activeCommands
      if (candidate.batch_id) {
        const batchSnap = await tx.get(
          db.collection('pipeline_commands')
            .where('batch_id', '==', candidate.batch_id)
            .limit(100),
        )
        commandScope = batchSnap.docs.map((doc) => ({ id: doc.id, ref: doc.ref, ...doc.data() }))
      }
      const claimable = selectClaimablePipelineCommand(commandScope, now)
      if (claimable?.id === candidate.id) {
        command = candidate
        break
      }
    }
    if (!command) return null

    const { id, ref, ...data } = command
    tx.update(ref, {
      status: 'running',
      active: true,
      worker_id: workerId,
      attempts: Number(data.attempts || 0) + 1,
      started_at: data.started_at || FieldValue.serverTimestamp(),
      lease_until: leaseUntil,
      updated_at: FieldValue.serverTimestamp(),
    })
    return { id, ...data, status: 'running', worker_id: workerId, lease_until: leaseUntil.toISOString() }
  })

  ok(res, { command: claimed })
})

app.post('/api/pipeline/commands/:id/complete', async (req, res) => {
  const id = String(req.params.id ?? '').trim()
  if (!id) return fail(res, 400, 'VALIDATION_ERROR', 'command id is required', {})

  const okFlag = Boolean(req.body?.ok)
  const exitCode = Number.isFinite(Number(req.body?.exit_code)) ? Number(req.body.exit_code) : null
  const output = typeof req.body?.output === 'string' ? req.body.output.slice(-20000) : ''
  const error = typeof req.body?.error === 'string' ? req.body.error.slice(-4000) : ''
  const workerId = typeof req.body?.worker_id === 'string' ? req.body.worker_id.slice(0, 120) : null
  const ref = db.collection('pipeline_commands').doc(id)
  const snap = await ref.get()
  if (!snap.exists) return fail(res, 404, 'NOT_FOUND', 'pipeline command not found', { id })

  await ref.set({
    status: okFlag ? 'succeeded' : 'failed',
    active: false,
    ok: okFlag,
    exit_code: exitCode,
    output,
    error,
    worker_id: workerId || snap.data()?.worker_id || null,
    finished_at: FieldValue.serverTimestamp(),
    updated_at: FieldValue.serverTimestamp(),
  }, { merge: true })
  ok(res, { id, status: okFlag ? 'succeeded' : 'failed', ok: okFlag, exit_code: exitCode })
})

app.get('/api/pipeline/stats', async (req, res) => {
  const ALL_STATUSES = ['draft', 'generating', 'factchecking', 'reviewing', 'reviewed', 'queued', 'publishing', 'published', 'needs_human', 'failed', 'archived']
  const CHANNELS = ['naver', 'tistory', 'selfhosted']
  const by_status = Object.fromEntries(ALL_STATUSES.map((status) => [status, 0]))
  const by_channel = Object.fromEntries(
    CHANNELS.map((channel) => [channel, { published: 0, queued: 0, needs_human: 0 }])
  )
  const now = new Date()
  const todayStart = new Date(now)
  todayStart.setHours(0, 0, 0, 0)
  const weekStart = new Date(todayStart)
  weekStart.setDate(weekStart.getDate() - 6)

  const snap = await db.collection('blog_posts').orderBy('updated_at', 'desc').limit(300).get()
  const posts = snap.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter((post) => !post.deleted_at)

  let published_today = 0
  let published_this_week = 0
  const needs_human_posts = []
  const recent = []
  const quality_items = []
  const quality = {
    measured_posts: 0,
    avg_chars: 0,
    with_images: 0,
    weak_posts: 0,
    avg_grounding: null,
  }
  let qualityChars = 0
  let groundingSum = 0
  let groundingCount = 0
  const publicQualityCandidates = []
  const reviewedTarget = Number(process.env.DAILY_PUBLISH_TARGET || 5) * Number(process.env.STOCK_BUFFER_DAYS || 3)
  const stuckThresholdMin = Number(process.env.STUCK_THRESHOLD_MIN || 35)
  const staleCutoff = new Date(now.getTime() - stuckThresholdMin * 60_000)
  const ops = {
    reviewed_target: reviewedTarget,
    inventory_target: reviewedTarget,
    inventory: 0,
    reviewed: 0,
    queued: 0,
    queued_due: 0,
    next_queued_at: null,
    publishing: 0,
    stale: { generating: 0, factchecking: 0, reviewing: 0, publishing: 0 },
    stuck_threshold_min: stuckThresholdMin,
  }

  for (const post of posts) {
    const status = typeof post.status === 'string' ? post.status : 'draft'
    const channel = typeof post.channel === 'string' ? post.channel : 'selfhosted'
    if (status in by_status) by_status[status] += 1
    if (channel in by_channel && status in by_channel[channel]) {
      by_channel[channel][status] += 1
    }
    const nextRunAtRaw = serializeValue(post.next_run_at ?? post.scheduled_at ?? null)
    const nextRunAt = nextRunAtRaw ? new Date(nextRunAtRaw) : null
    const updatedRaw = serializeValue(post.updated_at ?? post.created_at ?? null)
    const updatedDate = updatedRaw ? new Date(updatedRaw) : null
    if (status === 'reviewed') ops.reviewed += 1
    if (['draft', 'generating', 'factchecking', 'reviewing', 'reviewed'].includes(status)) {
      ops.inventory += 1
    }
    if (status === 'queued') {
      ops.queued += 1
      if (nextRunAt && !Number.isNaN(nextRunAt.getTime())) {
        if (nextRunAt <= now) ops.queued_due += 1
        if (!ops.next_queued_at || nextRunAt < new Date(ops.next_queued_at)) {
          ops.next_queued_at = nextRunAtRaw
        }
      }
    }
    if (status === 'publishing') ops.publishing += 1
    if (status in ops.stale && updatedDate && !Number.isNaN(updatedDate.getTime()) && updatedDate < staleCutoff) {
      ops.stale[status] += 1
    }

    const content = String(post.content ?? post.body ?? post.html ?? '')
    const plain = content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    if (status === 'published' || status === 'reviewed' || status === 'queued') {
      quality.measured_posts += 1
      qualityChars += plain.length
      if (/<img\b/i.test(content) || typeof post.featured_image === 'string') quality.with_images += 1
      if (plain.length > 0 && plain.length < 1800) quality.weak_posts += 1
      const grounding = Number(post.grounding_ratio)
      if (Number.isFinite(grounding)) {
        groundingSum += grounding
        groundingCount += 1
      }
      if (quality_items.length < 12) {
        const itemQuality = pipelineQuality(content, post.grounding_ratio)
        const issues = qualityIssueLabels(itemQuality)
        if (issues.length > 0) {
          quality_items.push({
            id: post.pipeline_id ?? post.id,
            topic: post.title ?? post.topic ?? '',
            title: post.title ?? post.topic ?? '',
            channel,
            status,
            published_url: post.public_url ?? post.url ?? (status === 'published' ? blogPostAbsoluteUrl(post, spaBaseUrl(req)) : null),
            quality: itemQuality,
            issues,
            action: qualityActionFor(issues, status),
            updated_at: serializeValue(post.updated_at ?? post.published_at ?? post.created_at) ?? '',
          })
        }
      }
    }

    const updatedAt = serializeValue(post.updated_at ?? post.published_at ?? post.created_at) ?? null
    const publishedAt = serializeValue(post.published_at ?? post.updated_at) ?? null
    const publishedDate = publishedAt ? new Date(publishedAt) : null
    if (status === 'published' && publishedDate && !Number.isNaN(publishedDate.getTime())) {
      if (publishedDate >= todayStart) published_today += 1
      if (publishedDate >= weekStart) published_this_week += 1
    }
    if (status === 'published') {
      publicQualityCandidates.push({
        id: post.pipeline_id ?? post.id,
        channel,
        title: post.title ?? post.topic ?? '',
        url: post.public_url ?? post.url ?? blogPostAbsoluteUrl(post, spaBaseUrl(req)),
        updated_at: updatedAt ?? '',
      })
    }

    const external = post.external_publish && typeof post.external_publish === 'object'
      ? post.external_publish
      : {}
    for (const [platform, result] of Object.entries(external)) {
      if (!result || typeof result !== 'object') continue
      if (!(platform in by_channel)) continue
      if (result.status === 'success') by_channel[platform].published += 1
      if (result.status === 'failed') {
        by_channel[platform].needs_human += 1
        if (needs_human_posts.length < 10) {
          const content = String(post.content ?? post.body ?? post.html ?? '')
          needs_human_posts.push({
            id: post.pipeline_id ?? post.id,
            topic: post.title ?? post.topic ?? '',
            title: post.title ?? post.topic ?? '',
            channel: platform,
            status: 'failed',
            last_error: result.error ?? null,
            published_url: result.url ?? null,
            action: actionForExternalIssue(platform, result.error ?? ''),
            quality: pipelineQuality(content, post.grounding_ratio),
            ...cloudRequeuePolicy('외부 발행 실패 로그입니다. 로컬 파이프라인 DB에서 처리하세요.'),
            updated_at: serializeValue(result.updated_at ?? post.updated_at ?? post.created_at) ?? '',
          })
        }
      }
    }

    if (status === 'needs_human' && needs_human_posts.length < 10) {
      const content = String(post.content ?? post.body ?? post.html ?? '')
      needs_human_posts.push({
        id: post.pipeline_id ?? post.id,
        topic: post.title ?? post.topic ?? '',
        title: post.title ?? post.topic ?? '',
        channel,
        status,
        last_error: post.last_error ?? null,
        published_url: post.public_url ?? post.url ?? null,
        action: actionForExternalIssue(channel, post.last_error ?? ''),
        quality: pipelineQuality(content, post.grounding_ratio),
        ...cloudRequeuePolicy(),
        updated_at: updatedAt ?? '',
      })
    }

    recent.push({
      id: post.pipeline_id ?? post.id,
      topic: post.title ?? post.topic ?? '',
      channel,
      status,
      published_url: post.public_url ?? post.url ?? (status === 'published' ? blogPostAbsoluteUrl(post, spaBaseUrl(req)) : null),
      updated_at: updatedAt ?? '',
    })
  }

  const externalSnap = await db.collection('external_publish_results')
    .orderBy('updated_at', 'desc')
    .limit(100)
    .get()
    .catch(() => null)
  const externalResults = externalSnap
    ? externalSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }))
    : []
  for (const result of externalResults) {
    if (result.archived_at) continue
    const platform = result.platform
    if (!(platform in by_channel)) continue
    const status = result.status === 'success' ? 'published' : result.status === 'failed' ? 'needs_human' : null
    if (status && status in by_channel[platform]) by_channel[platform][status] += 1

    const updatedAt = serializeValue(result.updated_at ?? result.published_at ?? result.created_at) ?? ''
    const publishedAt = serializeValue(result.published_at ?? result.updated_at) ?? null
    const publishedDate = publishedAt ? new Date(publishedAt) : null
    if (result.status === 'success' && publishedDate && !Number.isNaN(publishedDate.getTime())) {
      if (publishedDate >= todayStart) published_today += 1
      if (publishedDate >= weekStart) published_this_week += 1
    }
    if (result.status === 'success' && result.url) {
      publicQualityCandidates.push({
        id: result.source_id ?? result.id,
        channel: platform,
        title: result.title ?? result.topic ?? '',
        url: result.url,
        updated_at: updatedAt,
      })
    }

    if (result.status === 'failed' && needs_human_posts.length < 10) {
      needs_human_posts.push({
        id: result.source_id ?? result.id,
        topic: result.title ?? result.topic ?? '',
        title: result.title ?? result.topic ?? '',
        channel: platform,
        status: 'failed',
        last_error: result.error ?? null,
        published_url: result.url ?? null,
        action: actionForExternalIssue(platform, result.error ?? ''),
        quality: pipelineQuality(''),
        ...cloudRequeuePolicy('외부 발행 결과 로그입니다. 로컬 파이프라인 DB에서 재큐잉하세요.'),
        external_doc_id: result.id,
        can_archive: true,
        updated_at: updatedAt,
      })
    }
    recent.push({
      id: result.source_id ?? result.id,
      topic: result.title ?? result.topic ?? '',
      channel: platform,
      status: result.status === 'success' ? 'published' : result.status ?? 'failed',
      published_url: result.url ?? null,
      updated_at: updatedAt,
    })
  }

  quality.avg_chars = quality.measured_posts ? Math.round(qualityChars / quality.measured_posts) : 0
  quality.avg_grounding = groundingCount ? Math.round((groundingSum / groundingCount) * 100) / 100 : null
  const public_quality = await publicQualitySnapshot(
    publicQualityCandidates
      .sort((a, b) => new Date(b.updated_at || 0).getTime() - new Date(a.updated_at || 0).getTime())
  )
  const localSnapshotDoc = await db.collection('pipeline_snapshots').doc('local').get().catch(() => null)
  const localSnapshot = localSnapshotDoc?.exists ? localSnapshotDoc.data() : null
  const snapshotGeneratedAt = serializeValue(localSnapshot?.generated_at ?? null)
  const snapshotSyncedAt = serializeValue(localSnapshot?.synced_at ?? null)
  const snapshotTime = snapshotGeneratedAt || snapshotSyncedAt
  const snapshotDate = snapshotTime ? new Date(snapshotTime) : null
  const snapshotAgeSec = snapshotDate && !Number.isNaN(snapshotDate.getTime())
    ? Math.max(0, Math.round((Date.now() - snapshotDate.getTime()) / 1000))
    : null
  const snapshotStale = snapshotAgeSec == null || snapshotAgeSec > 15 * 60
  const useLocalSnapshot = Boolean(localSnapshot && !snapshotStale)
  const snapshotOps = localSnapshot?.ops && typeof localSnapshot.ops === 'object'
    ? {
        ...localSnapshot.ops,
        snapshot_source: 'local_sqlite',
        snapshot_generated_at: snapshotGeneratedAt,
        snapshot_synced_at: snapshotSyncedAt,
        snapshot_age_sec: snapshotAgeSec,
        snapshot_stale: snapshotStale,
      }
    : null
  const staleSnapshotOps = snapshotStale ? {
    snapshot_source: localSnapshot ? 'cloud_firestore_fallback_stale_local_sqlite' : 'cloud_firestore_no_local_snapshot',
    snapshot_generated_at: snapshotGeneratedAt,
    snapshot_synced_at: snapshotSyncedAt,
    snapshot_age_sec: snapshotAgeSec,
    snapshot_stale: true,
    issue: 'LOCAL_SNAPSHOT_STALE',
    action: 'Windows 운영 PC에서 BEOK Blog Sync Snapshot/Generate/Review/Schedule/Publish 태스크와 C:\\beokmkt\\logs\\blog-*.log를 확인하세요.',
  } : {}
  const responseOps = useLocalSnapshot && snapshotOps
    ? snapshotOps
    : { ...ops, ...staleSnapshotOps }
  const responseByStatus = useLocalSnapshot && localSnapshot?.by_status && typeof localSnapshot.by_status === 'object'
    ? localSnapshot.by_status
    : by_status
  const responseByChannel = useLocalSnapshot && localSnapshot?.by_channel && typeof localSnapshot.by_channel === 'object'
    ? localSnapshot.by_channel
    : by_channel
  const responseQuality = useLocalSnapshot && localSnapshot?.quality && typeof localSnapshot.quality === 'object'
    ? localSnapshot.quality
    : quality
  const responseQualityItems = useLocalSnapshot && Array.isArray(localSnapshot?.quality_items) ? localSnapshot.quality_items : quality_items
  const responseRecent = useLocalSnapshot && Array.isArray(localSnapshot?.recent) ? localSnapshot.recent : recent
  const responseNeedsHuman = useLocalSnapshot && Array.isArray(localSnapshot?.needs_human_posts) ? localSnapshot.needs_human_posts : needs_human_posts
  const responsePublicQuality = useLocalSnapshot && localSnapshot?.public_quality && typeof localSnapshot.public_quality === 'object'
    ? localSnapshot.public_quality
    : public_quality
  const commandSnap = await db.collection('pipeline_commands')
    .orderBy('created_at', 'desc')
    .limit(8)
    .get()
    .catch(() => null)
  const activeCommandSnap = await db.collection('pipeline_commands')
    .where('active', '==', true)
    .limit(100)
    .get()
    .catch(() => null)
  const recentCommands = commandSnap
    ? commandSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }))
    : []
  const activeCommands = activeCommandSnap
    ? activeCommandSnap.docs.map((doc) => doc.data())
    : []
  const control = {
    pending: activeCommands.filter((cmd) => cmd.status === 'pending').length,
    running: activeCommands.filter((cmd) => cmd.status === 'running').length,
    recent: recentCommands,
  }

  ok(res, {
    by_status: responseByStatus,
    by_channel: responseByChannel,
    published_today: useLocalSnapshot && Number.isFinite(Number(localSnapshot?.published_today)) ? Number(localSnapshot.published_today) : published_today,
    published_this_week: useLocalSnapshot && Number.isFinite(Number(localSnapshot?.published_this_week)) ? Number(localSnapshot.published_this_week) : published_this_week,
    quality: responseQuality,
    quality_items: responseQualityItems,
    ops: { ...responseOps, control },
    public_quality: responsePublicQuality,
    needs_human_posts: responseNeedsHuman,
    local_snapshot: localSnapshot ? {
      generated_at: snapshotGeneratedAt,
      synced_at: snapshotSyncedAt,
      age_sec: snapshotAgeSec,
      stale: snapshotStale,
    } : null,
    recent: responseRecent
      .sort((a, b) => new Date(b.updated_at || 0).getTime() - new Date(a.updated_at || 0).getTime())
      .slice(0, 10),
  })
})

app.get('/api/pipeline/posts/:id', async (req, res) => {
  const id = String(req.params.id ?? '').trim()
  if (!id) return fail(res, 400, 'VALIDATION_ERROR', 'pipeline post id is required', {})

  const blogSnap = await db.collection('blog_posts').doc(id).get().catch(() => null)
  if (blogSnap?.exists) {
    const post = { id: blogSnap.id, ...blogSnap.data() }
    const content = String(post.content ?? post.body ?? post.html ?? '')
    return ok(res, {
      id: post.pipeline_id ?? post.id,
      cloud_id: post.id,
      channel: typeof post.channel === 'string' ? post.channel : 'selfhosted',
      status: typeof post.status === 'string' ? post.status : 'draft',
      title: post.title ?? post.topic ?? '',
      topic: post.topic ?? '',
      meta_desc: post.seo_description ?? post.meta_desc ?? '',
      tags: Array.isArray(post.tags) ? post.tags : [],
      published_url: post.public_url ?? post.url ?? (post.status === 'published' ? blogPostAbsoluteUrl(post, spaBaseUrl(req)) : null),
      last_error: post.last_error ?? null,
      action: actionForExternalIssue(post.channel ?? 'selfhosted', post.last_error ?? ''),
      can_requeue: false,
      requeue_block_reason: '클라우드 대시보드에서는 로컬 SQLite 큐 재등록을 수행하지 않습니다.',
      body_available: Boolean(content),
      body: content,
      preview_html: sanitizePreviewHtml(content),
      quality: pipelineQuality(content, post.grounding_ratio),
      updated_at: serializeValue(post.updated_at ?? post.published_at ?? post.created_at) ?? '',
    })
  }

  const candidates = [id]
  for (const platform of ['naver', 'tistory']) {
    if (!id.startsWith(`${platform}:`)) candidates.push(`${platform}:${id}`)
  }
  for (const docId of candidates) {
    const snap = await db.collection('external_publish_results').doc(docId).get().catch(() => null)
    if (!snap?.exists) continue
    const result = { id: snap.id, ...snap.data() }
    if (result.archived_at) continue
    return ok(res, {
      id: result.source_id ?? result.id,
      cloud_id: result.id,
      channel: result.platform ?? String(result.id).split(':')[0] ?? 'external',
      status: result.status === 'success' ? 'published' : result.status ?? 'failed',
      title: result.title ?? result.topic ?? '',
      topic: result.topic ?? '',
      published_url: result.url ?? null,
      last_error: result.error ?? null,
      action: actionForExternalIssue(result.platform ?? '', result.error ?? ''),
      can_requeue: false,
      requeue_block_reason: '외부 발행 결과 로그입니다. 로컬 파이프라인 DB에서 재큐잉하세요.',
      external_doc_id: result.id,
      can_archive: true,
      body_available: false,
      body: '',
      preview_html: '',
      quality: pipelineQuality(''),
      updated_at: serializeValue(result.updated_at ?? result.published_at ?? result.created_at) ?? '',
    })
  }

  const localSnapshotDoc = await db.collection('pipeline_snapshots').doc('local').get().catch(() => null)
  const localSnapshot = localSnapshotDoc?.exists ? localSnapshotDoc.data() : null
  const snapshotDetail = findSnapshotPostDetail(localSnapshot, id)
  if (snapshotDetail) return ok(res, snapshotDetail)

  return fail(res, 404, 'NOT_FOUND', 'pipeline post not found', { id })
})

app.post('/api/pipeline/external-results/:id/archive', async (req, res) => {
  const id = String(req.params.id ?? '').trim()
  if (!id) return fail(res, 400, 'VALIDATION_ERROR', 'external result id is required', {})

  const ref = db.collection('external_publish_results').doc(id)
  const snap = await ref.get().catch(() => null)
  if (!snap?.exists) return fail(res, 404, 'NOT_FOUND', 'external publish result not found', { id })

  await ref.set(
    {
      archived_at: nowIso(),
      archived_by: req.user?.uid ?? req.user?.email ?? 'api',
      archive_reason: typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 300) : 'operator_archived',
      updated_at: nowIso(),
    },
    { merge: true }
  )
  await addAuditLog('external_publish.archived', 'external_publish_result', id, req.user?.uid ?? 'admin')
  const updated = await ref.get()
  ok(res, { id: updated.id, ...updated.data() })
})

app.post('/api/source-items/import', async (req, res) => {
  await withIdempotency(req, res, async () => {
    const body = req.body ?? {}
    const title = typeof body.title === 'string' ? body.title.trim() : ''
    const content = typeof body.body === 'string' ? body.body.trim() : ''
    const source_type = typeof body.source_type === 'string' ? body.source_type : 'manual'
    if (!title || !content) throw new Error('validation')

    const id = newId()

    await db.collection('source_items').doc(id).set({
      source_type,
      source_ref_id: body.source_ref_id ?? null,
      title,
      body: content,
      summary: body.summary ?? null,
      category: body.category ?? null,
      tags: Array.isArray(body.tags) ? body.tags : [],
      origin_url: body.origin_url ?? null,
      published_at: body.published_at ?? null,
      performance_snapshot: body.performance_snapshot ?? null,
      status: source_type === 'blog' ? 'received' : 'eligible',
      created_at: FieldValue.serverTimestamp(),
      updated_at: FieldValue.serverTimestamp(),
      deleted_at: null,
    })

    await addAuditLog('source_item.import', 'source_item', id)
    return { data: { id }, meta: {} }
  }).catch(() => fail(res, 400, 'VALIDATION_ERROR', 'invalid input', {}))
})

app.get('/api/source-items', async (req, res) => {
  const limit = parseLimit(req, 20)
  const offset = parseOffset(req)
  const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : ''
  const status = typeof req.query.status === 'string' ? req.query.status : ''
  const source_type = typeof req.query.source_type === 'string' ? req.query.source_type : ''

  const clauses = []
  if (status) clauses.push({ field: 'status', op: '==', value: status })
  if (source_type) clauses.push({ field: 'source_type', op: '==', value: source_type })

  const page = await listCollection('source_items', limit, offset, clauses)
  const items = q ? page.items.filter((it) => String(it.title ?? '').toLowerCase().includes(q)) : page.items
  ok(res, { ...page, items, total: q ? items.length : page.total })
})

app.get('/api/source-items/:id', async (req, res) => {
  const id = req.params.id
  const snap = await db.collection('source_items').doc(id).get()
  if (!snap.exists) return fail(res, 404, 'NOT_FOUND', 'source item not found', {})

  const ideaSnap = await db.collection('short_ideas').where('source_item_id', '==', id).get()
  const ideas = ideaSnap.docs.map((d) => d.data())
  const summary = {
    total: ideas.length,
    awaiting_review: ideas.filter((x) => x.status === 'awaiting_review').length,
    approved: ideas.filter((x) => x.status === 'approved').length,
    rejected: ideas.filter((x) => x.status === 'rejected').length,
  }

  ok(res, { id: snap.id, ...snap.data(), short_ideas_summary: summary })
})

app.post('/api/source-items/:id/generate-ideas', async (req, res) => {
  const id = req.params.id
  const itemSnap = await db.collection('source_items').doc(id).get()
  if (!itemSnap.exists) return fail(res, 404, 'NOT_FOUND', 'source item not found', {})

  const item = itemSnap.data()
  if (item?.status !== 'eligible') return fail(res, 422, 'WORKFLOW_NOT_READY', 'source item is not eligible', {})

  await withIdempotency(req, res, async () => {
    const count = Math.max(1, Math.min(Number(req.body?.count ?? 5) || 5, 10))
    const batch = db.batch()

    for (let i = 0; i < count; i += 1) {
      const ideaId = newId()
      const ref = db.collection('short_ideas').doc(ideaId)
      batch.set(ref, {
        source_item_id: id,
        title: `${item.title} - 아이디어 ${i + 1}`,
        hook: '첫 3초 훅(데모)',
        angle: '핵심 요약(데모)',
        cta: null,
        platform_targets: ['youtube'],
        target_duration_sec: 30,
        priority_score: null,
        risk_score: null,
        risk_tags: [],
        status: 'awaiting_review',
        rejection_reason: null,
        created_at: FieldValue.serverTimestamp(),
        updated_at: FieldValue.serverTimestamp(),
        deleted_at: null,
      })
    }

    await batch.commit()
    await addAuditLog('short_idea.generated_batch', 'source_item', id, 'user')
    return { data: { status: 'processing' }, meta: {} }
  }).catch(() => fail(res, 400, 'VALIDATION_ERROR', 'invalid input', {}))
})

app.post('/api/source-items/:id/run-ai-pipeline', async (req, res) => {
  const id = req.params.id
  const itemSnap = await db.collection('source_items').doc(id).get()
  if (!itemSnap.exists) return fail(res, 404, 'NOT_FOUND', 'source item not found', {})

  const item = itemSnap.data()
  if (item?.status !== 'eligible') return fail(res, 422, 'WORKFLOW_NOT_READY', 'source item is not eligible', {})

  await withIdempotency(req, res, async () => {
    const body = req.body ?? {}
    const ideaCount = Math.max(1, Math.min(Number(body.idea_count ?? 3) || 3, 10))
    const durationSec = Math.max(10, Math.min(Number(body.duration_sec ?? 30) || 30, 180))
    const platform = typeof body.platform === 'string' ? body.platform : 'youtube'
    const platformAccountId = typeof body.platform_account_id === 'string' && body.platform_account_id.trim() ? body.platform_account_id.trim() : null
    const visibility = typeof body.visibility === 'string' ? body.visibility : 'private'
    const autoApproveRender = body.auto_approve_render !== false
    const autoApprovePublish = body.auto_approve_publish !== false
    const aiConfig = await resolveAiConfig(body)
    const hashtags = Array.isArray(body.hashtags) ? body.hashtags.filter((tag) => typeof tag === 'string' && tag.trim()).map((tag) => tag.trim()) : []
    const publishTitle = typeof body.publish_title === 'string' && body.publish_title.trim() ? body.publish_title.trim() : `${item.title} | AI Shorts`
    const publishDescription =
      typeof body.publish_description === 'string' && body.publish_description.trim()
        ? body.publish_description.trim()
        : `${item.summary ?? item.title}\n\n#ai-generated`

    if (!platformAccountId) {
      throw new Error('missing_platform_account')
    }

    const accountSnap = await db.collection('platform_accounts').doc(platformAccountId).get()
    if (!accountSnap.exists) throw new Error('platform_account_not_found')

    const ideaIds = []
    let leadIdeaId = null
    const aiIdeas = await generateIdeasWithAi(aiConfig, item, { ideaCount, durationSec, platform }).catch(() => null)

    for (let i = 0; i < ideaCount; i += 1) {
      const ideaId = newId()
      const approvedLead = i === 0
      const aiIdea = aiIdeas?.[i]
      await db.collection('short_ideas').doc(ideaId).set({
        source_item_id: id,
        title: typeof aiIdea?.title === 'string' ? aiIdea.title : `${item.title} - AI 아이디어 ${i + 1}`,
        hook: typeof aiIdea?.hook === 'string' ? aiIdea.hook : approvedLead ? 'AI 자동 선정 훅(데모)' : 'AI 후보 훅(데모)',
        angle: typeof aiIdea?.angle === 'string' ? aiIdea.angle : item.summary ?? '원천 콘텐츠 핵심 요약(데모)',
        cta: typeof aiIdea?.cta === 'string' ? aiIdea.cta : '자세한 내용은 설명란 참고',
        platform_targets: [platform],
        target_duration_sec: durationSec,
        priority_score: approvedLead ? 100 : 70 - i,
        risk_score: null,
        risk_tags: Array.isArray(aiIdea?.hashtags) ? aiIdea.hashtags.filter((tag) => typeof tag === 'string') : [],
        status: approvedLead ? 'approved' : 'awaiting_review',
        rejection_reason: null,
        created_at: FieldValue.serverTimestamp(),
        updated_at: FieldValue.serverTimestamp(),
        deleted_at: null,
      })
      ideaIds.push(ideaId)
      if (approvedLead) {
        leadIdeaId = ideaId
        await addApprovalRecord('short_idea', ideaId, 'idea_review', 'approved', 'AI 자동 파이프라인 승인')
        await addAuditLog('short_idea.auto_approved', 'short_idea', ideaId, 'user')
      } else {
        await addAuditLog('short_idea.generated', 'short_idea', ideaId, 'user')
      }
    }

    const scriptVersionSnap = await db.collection('scripts').where('short_idea_id', '==', leadIdeaId).get()
    const nextVersion = scriptVersionSnap.docs.reduce((max, doc) => Math.max(max, Number(doc.data()?.version ?? 0)), 0) + 1
    const scriptId = newId()
    const leadIdea = { title: aiIdeas?.[0]?.title ?? `${item.title} - AI 아이디어 1`, hook: aiIdeas?.[0]?.hook ?? 'AI 자동 선정 훅(데모)', angle: aiIdeas?.[0]?.angle ?? item.summary ?? '', cta: aiIdeas?.[0]?.cta ?? '자세한 내용은 설명란 참고' }
    const aiScript = await generateScriptWithAi(aiConfig, item, leadIdea, { durationSec }).catch(() => null)
    const aiPublishMeta = await generatePublishMetadataWithAi(
      aiConfig,
      item,
      {
        script_text: typeof aiScript?.script_text === 'string' ? aiScript.script_text : `AI 자동 생성 대본(데모) - ${item.title}`,
        subtitle_text: typeof aiScript?.subtitle_text === 'string' ? aiScript.subtitle_text : `AI 자막 초안(데모) - ${item.summary ?? item.title}`,
      },
      { platform }
    ).catch(() => null)

    await db.collection('scripts').doc(scriptId).set({
      short_idea_id: leadIdeaId,
      version: nextVersion,
      duration_sec: durationSec,
      script_text: typeof aiScript?.script_text === 'string' ? aiScript.script_text : `AI 자동 생성 대본(데모) - ${item.title}`,
      subtitle_text: typeof aiScript?.subtitle_text === 'string' ? aiScript.subtitle_text : `AI 자막 초안(데모) - ${item.summary ?? item.title}`,
      caption_text: typeof aiScript?.caption_text === 'string' ? aiScript.caption_text : publishDescription,
      hashtags: Array.isArray(aiScript?.hashtags) ? aiScript.hashtags.filter((tag) => typeof tag === 'string') : hashtags,
      language: typeof aiScript?.language === 'string' ? aiScript.language : 'ko',
      tone: typeof aiScript?.tone === 'string' ? aiScript.tone : 'direct-response',
      fact_check_status: 'passed',
      status: 'approved',
      revision_reason: null,
      created_at: FieldValue.serverTimestamp(),
      updated_at: FieldValue.serverTimestamp(),
      deleted_at: null,
    })
    await addAuditLog('script.generated', 'script', scriptId, 'user')
    await addApprovalRecord('script', scriptId, 'script_review', 'approved', 'AI 자동 파이프라인 승인')
    await addAuditLog('script.auto_approved', 'script', scriptId, 'user')

    const renderJobId = newId()
    await db.collection('render_jobs').doc(renderJobId).set({
      script_id: scriptId,
      short_idea_id: leadIdeaId,
      template_id: typeof body.template_id === 'string' ? body.template_id : null,
      render_profile: typeof body.render_profile === 'string' ? body.render_profile : 'shorts_1080x1920',
      status: 'queued',
      qc_status: autoApproveRender ? 'passed' : 'pending',
      retry_count: 0,
      error_message: null,
      output: null,
      created_at: FieldValue.serverTimestamp(),
      updated_at: FieldValue.serverTimestamp(),
      deleted_at: null,
    })
    await addAuditLog('render_job.created', 'render_job', renderJobId, 'user')
    if (autoApproveRender) {
      await addApprovalRecord('render_job', renderJobId, 'render_review', 'approved', 'AI 자동 파이프라인 승인')
      await addAuditLog('render_job.auto_approved', 'render_job', renderJobId, 'user')
    }

    const publishJobId = newId()
    const publishStatus = autoApprovePublish ? 'queued' : 'awaiting_approval'
    await db.collection('publish_jobs').doc(publishJobId).set({
      render_job_id: renderJobId,
      platform,
      platform_account_id: platformAccountId,
      status: publishStatus,
      retry_count: 0,
      error_message: null,
      payload: {
        title: typeof aiPublishMeta?.title === 'string' ? aiPublishMeta.title : publishTitle,
        description: typeof aiPublishMeta?.description === 'string' ? aiPublishMeta.description : publishDescription,
        hashtags: Array.isArray(aiPublishMeta?.hashtags) ? aiPublishMeta.hashtags.filter((tag) => typeof tag === 'string') : hashtags,
        visibility,
      },
      result: null,
      created_at: FieldValue.serverTimestamp(),
      updated_at: FieldValue.serverTimestamp(),
      deleted_at: null,
    })
    await addAuditLog('publish_job.created', 'publish_job', publishJobId, 'user')
    if (autoApprovePublish) {
      await addApprovalRecord('publish_job', publishJobId, 'publish_review', 'approved', 'AI 자동 파이프라인 승인')
      await addAuditLog('publish_job.auto_approved', 'publish_job', publishJobId, 'user')
    }

    await addAuditLog('source_item.ai_pipeline_run', 'source_item', id, 'user')

    return {
      data: {
        source_item_id: id,
        idea_ids: ideaIds,
        lead_idea_id: leadIdeaId,
        script_id: scriptId,
        render_job_id: renderJobId,
        publish_job_id: publishJobId,
        statuses: {
          lead_idea: 'approved',
          script: 'approved',
          render_job: autoApproveRender ? 'passed' : 'pending',
          publish_job: publishStatus,
        },
      },
      meta: {},
    }
  }).catch((e) => {
    if (e instanceof Error && e.message === 'missing_platform_account') {
      return fail(res, 400, 'VALIDATION_ERROR', 'platform account is required', {})
    }
    if (e instanceof Error && e.message === 'platform_account_not_found') {
      return fail(res, 404, 'NOT_FOUND', 'platform account not found', {})
    }
    return fail(res, 400, 'VALIDATION_ERROR', 'invalid input', {})
  })
})

app.post('/api/ai/generate-ideas', async (req, res) => {
  await withIdempotency(req, res, async () => {
    const body = req.body ?? {}
    const sourceItemId = typeof body.source_item_id === 'string' ? body.source_item_id.trim() : ''
    if (!sourceItemId) throw new Error('missing_source_item_id')

    const itemSnap = await db.collection('source_items').doc(sourceItemId).get()
    if (!itemSnap.exists) throw new Error('source_item_not_found')
    const item = itemSnap.data()
    if (item?.status !== 'eligible') throw new Error('source_item_not_ready')

    const count = Math.max(1, Math.min(Number(body.count ?? 3) || 3, 10))
    const targetDurationSec = Math.max(10, Math.min(Number(body.target_duration_sec ?? 30) || 30, 180))
    const platformTargets = Array.isArray(body.platform_targets) && body.platform_targets.length ? body.platform_targets : ['youtube']
    const autoApproveLead = body.auto_approve_lead !== false
    const aiConfig = await resolveAiConfig(body)
    const aiTrace = aiTraceFromConfig(aiConfig)
    const aiIdeas = await generateIdeasWithAi(aiConfig, item, {
      ideaCount: count,
      durationSec: targetDurationSec,
      platform: platformTargets[0] ?? 'youtube',
    }).catch(() => null)

    const ideaIds = []
    let leadIdeaId = null

    for (let i = 0; i < count; i += 1) {
      const ideaId = newId()
      const approvedLead = autoApproveLead && i === 0
      const aiIdea = aiIdeas?.[i]
      await db.collection('short_ideas').doc(ideaId).set({
        source_item_id: sourceItemId,
        title: typeof aiIdea?.title === 'string' ? aiIdea.title : `${item.title} - AI 아이디어 ${i + 1}`,
        hook: typeof aiIdea?.hook === 'string' ? aiIdea.hook : approvedLead ? 'AI 리드 훅(데모)' : 'AI 후보 훅(데모)',
        angle: typeof aiIdea?.angle === 'string' ? aiIdea.angle : item.summary ?? '원천 핵심 요약(데모)',
        cta: typeof aiIdea?.cta === 'string' ? aiIdea.cta : typeof body.cta === 'string' ? body.cta : '설명란 참고',
        platform_targets: platformTargets,
        target_duration_sec: targetDurationSec,
        priority_score: approvedLead ? 100 : 80 - i,
        risk_score: null,
        risk_tags: [],
        status: approvedLead ? 'approved' : 'awaiting_review',
        rejection_reason: null,
        created_at: FieldValue.serverTimestamp(),
        updated_at: FieldValue.serverTimestamp(),
        deleted_at: null,
      })
      ideaIds.push(ideaId)
      if (approvedLead) {
        leadIdeaId = ideaId
        await addApprovalRecord('short_idea', ideaId, 'idea_review', 'approved', 'AI lead auto approval')
        await addAuditLog('short_idea.auto_approved', 'short_idea', ideaId, 'ai')
      } else {
        await addAuditLog('short_idea.generated', 'short_idea', ideaId, 'ai')
      }
    }

    await addAuditLog('source_item.ai_generated_ideas', 'source_item', sourceItemId, 'ai', { ai_trace: aiTrace })
    return { data: { source_item_id: sourceItemId, idea_ids: ideaIds, lead_idea_id: leadIdeaId }, meta: { ai_trace: aiTrace } }
  }).catch((e) => {
    if (e instanceof Error && e.message === 'missing_source_item_id') return fail(res, 400, 'VALIDATION_ERROR', 'source_item_id is required', {})
    if (e instanceof Error && e.message === 'source_item_not_found') return fail(res, 404, 'NOT_FOUND', 'source item not found', {})
    if (e instanceof Error && e.message === 'source_item_not_ready') return fail(res, 422, 'WORKFLOW_NOT_READY', 'source item is not eligible', {})
    return fail(res, 400, 'VALIDATION_ERROR', 'invalid input', {})
  })
})

app.post('/api/ai/generate-script', async (req, res) => {
  await withIdempotency(req, res, async () => {
    const body = req.body ?? {}
    const shortIdeaId = typeof body.short_idea_id === 'string' ? body.short_idea_id.trim() : ''
    if (!shortIdeaId) throw new Error('missing_short_idea_id')

    const ideaRef = db.collection('short_ideas').doc(shortIdeaId)
    const ideaSnap = await ideaRef.get()
    if (!ideaSnap.exists) throw new Error('short_idea_not_found')
    const idea = ideaSnap.data()
    const aiConfig = await resolveAiConfig(body)
    const aiTrace = aiTraceFromConfig(aiConfig)

    if (idea?.status !== 'approved') {
      if (idea?.status === 'awaiting_review' && body.approve_idea !== false) {
        await ideaRef.set({ status: 'approved', updated_at: FieldValue.serverTimestamp() }, { merge: true })
        await addApprovalRecord('short_idea', shortIdeaId, 'idea_review', 'approved', 'AI auto approval before script generation')
        await addAuditLog('short_idea.auto_approved', 'short_idea', shortIdeaId, 'ai')
      } else {
        throw new Error('idea_not_ready')
      }
    }

    const durationSec = Math.max(10, Math.min(Number(body.duration_sec ?? idea.target_duration_sec ?? 30) || 30, 180))
    const autoApprove = body.auto_approve !== false
    const versionSnap = await db.collection('scripts').where('short_idea_id', '==', shortIdeaId).get()
    const nextVersion = versionSnap.docs.reduce((max, doc) => Math.max(max, Number(doc.data()?.version ?? 0)), 0) + 1
    const scriptId = newId()
    const sourceSnap = await db.collection('source_items').doc(idea.source_item_id).get()
    const sourceItem = sourceSnap.data() ?? { title: idea.title, summary: idea.angle, body: idea.angle }
    const aiScript = await generateScriptWithAi(aiConfig, sourceItem, idea, { durationSec }).catch(() => null)

    await db.collection('scripts').doc(scriptId).set({
      short_idea_id: shortIdeaId,
      version: nextVersion,
      duration_sec: durationSec,
      script_text:
        typeof body.script_text === 'string' && body.script_text.trim()
          ? body.script_text.trim()
          : typeof aiScript?.script_text === 'string'
            ? aiScript.script_text
            : `AI 자동 생성 대본(데모) - ${idea.title}`,
      subtitle_text:
        typeof body.subtitle_text === 'string' && body.subtitle_text.trim()
          ? body.subtitle_text.trim()
          : typeof aiScript?.subtitle_text === 'string'
            ? aiScript.subtitle_text
            : `AI 자막 초안(데모) - ${idea.hook}`,
      caption_text: typeof body.caption_text === 'string' ? body.caption_text : typeof aiScript?.caption_text === 'string' ? aiScript.caption_text : null,
      hashtags: Array.isArray(body.hashtags)
        ? body.hashtags.filter((tag) => typeof tag === 'string')
        : Array.isArray(aiScript?.hashtags)
          ? aiScript.hashtags.filter((tag) => typeof tag === 'string')
          : [],
      language: typeof body.language === 'string' ? body.language : typeof aiScript?.language === 'string' ? aiScript.language : 'ko',
      tone: typeof body.tone === 'string' ? body.tone : typeof aiScript?.tone === 'string' ? aiScript.tone : 'direct-response',
      fact_check_status: typeof body.fact_check_status === 'string' ? body.fact_check_status : autoApprove ? 'passed' : 'pending',
      status: autoApprove ? 'approved' : 'awaiting_review',
      revision_reason: null,
      created_at: FieldValue.serverTimestamp(),
      updated_at: FieldValue.serverTimestamp(),
      deleted_at: null,
    })
    await addAuditLog('script.generated', 'script', scriptId, 'ai', { ai_trace: aiTrace })
    if (autoApprove) {
      await addApprovalRecord('script', scriptId, 'script_review', 'approved', 'AI auto approval')
      await addAuditLog('script.auto_approved', 'script', scriptId, 'ai')
    }

    return {
      data: { short_idea_id: shortIdeaId, script_id: scriptId, status: autoApprove ? 'approved' : 'awaiting_review' },
      meta: { ai_trace: aiTrace },
    }
  }).catch((e) => {
    if (e instanceof Error && e.message === 'missing_short_idea_id') return fail(res, 400, 'VALIDATION_ERROR', 'short_idea_id is required', {})
    if (e instanceof Error && e.message === 'short_idea_not_found') return fail(res, 404, 'NOT_FOUND', 'short idea not found', {})
    if (e instanceof Error && e.message === 'idea_not_ready') return fail(res, 422, 'WORKFLOW_NOT_READY', 'short idea is not approved', {})
    return fail(res, 400, 'VALIDATION_ERROR', 'invalid input', {})
  })
})

app.post('/api/ai/create-render-job', async (req, res) => {
  await withIdempotency(req, res, async () => {
    const body = req.body ?? {}
    const scriptId = typeof body.script_id === 'string' ? body.script_id.trim() : ''
    if (!scriptId) throw new Error('missing_script_id')

    const scriptRef = db.collection('scripts').doc(scriptId)
    const scriptSnap = await scriptRef.get()
    if (!scriptSnap.exists) throw new Error('script_not_found')
    const script = scriptSnap.data()

    if (script?.status !== 'approved') {
      if (script?.status === 'awaiting_review' && body.approve_script !== false) {
        await scriptRef.set(
          {
            status: 'approved',
            fact_check_status: typeof body.fact_check_status === 'string' ? body.fact_check_status : 'passed',
            updated_at: FieldValue.serverTimestamp(),
          },
          { merge: true }
        )
        await addApprovalRecord('script', scriptId, 'script_review', 'approved', 'AI auto approval before render creation')
        await addAuditLog('script.auto_approved', 'script', scriptId, 'ai')
      } else {
        throw new Error('script_not_ready')
      }
    }

    const autoApprove = body.auto_approve !== false
    const renderJobId = newId()
    await db.collection('render_jobs').doc(renderJobId).set({
      script_id: scriptId,
      short_idea_id: script.short_idea_id,
      template_id: typeof body.template_id === 'string' ? body.template_id : null,
      render_profile: typeof body.render_profile === 'string' ? body.render_profile : 'shorts_1080x1920',
      status: typeof body.status === 'string' ? body.status : 'queued',
      qc_status: autoApprove ? 'passed' : 'pending',
      retry_count: 0,
      error_message: null,
      output: null,
      created_at: FieldValue.serverTimestamp(),
      updated_at: FieldValue.serverTimestamp(),
      deleted_at: null,
    })
    await addAuditLog('render_job.created', 'render_job', renderJobId, 'ai')
    if (autoApprove) {
      await addApprovalRecord('render_job', renderJobId, 'render_review', 'approved', 'AI auto approval')
      await addAuditLog('render_job.auto_approved', 'render_job', renderJobId, 'ai')
    }

    return { data: { script_id: scriptId, render_job_id: renderJobId, qc_status: autoApprove ? 'passed' : 'pending' }, meta: {} }
  }).catch((e) => {
    if (e instanceof Error && e.message === 'missing_script_id') return fail(res, 400, 'VALIDATION_ERROR', 'script_id is required', {})
    if (e instanceof Error && e.message === 'script_not_found') return fail(res, 404, 'NOT_FOUND', 'script not found', {})
    if (e instanceof Error && e.message === 'script_not_ready') return fail(res, 422, 'WORKFLOW_NOT_READY', 'script is not approved', {})
    return fail(res, 400, 'VALIDATION_ERROR', 'invalid input', {})
  })
})

app.post('/api/ai/create-publish-job', async (req, res) => {
  await withIdempotency(req, res, async () => {
    const body = req.body ?? {}
    const renderJobId = typeof body.render_job_id === 'string' ? body.render_job_id.trim() : ''
    const platformAccountId = typeof body.platform_account_id === 'string' ? body.platform_account_id.trim() : ''
    if (!renderJobId) throw new Error('missing_render_job_id')
    if (!platformAccountId) throw new Error('missing_platform_account')

    const renderRef = db.collection('render_jobs').doc(renderJobId)
    const renderSnap = await renderRef.get()
    if (!renderSnap.exists) throw new Error('render_job_not_found')
    const renderJob = renderSnap.data()

    const accountSnap = await db.collection('platform_accounts').doc(platformAccountId).get()
    if (!accountSnap.exists) throw new Error('platform_account_not_found')
    const aiConfig = await resolveAiConfig(body)
    const aiTrace = aiTraceFromConfig(aiConfig)

    if (renderJob?.qc_status !== 'passed') {
      if (body.approve_render !== false) {
        await renderRef.set({ qc_status: 'passed', updated_at: FieldValue.serverTimestamp() }, { merge: true })
        await addApprovalRecord('render_job', renderJobId, 'render_review', 'approved', 'AI auto approval before publish creation')
        await addAuditLog('render_job.auto_approved', 'render_job', renderJobId, 'ai')
      } else {
        throw new Error('render_not_ready')
      }
    }

    const autoApprove = body.auto_approve !== false
    const publishJobId = newId()
    const publishStatus = autoApprove ? 'queued' : 'awaiting_approval'
    const scriptSnap = renderJob?.script_id ? await db.collection('scripts').doc(renderJob.script_id).get() : null
    const script = scriptSnap?.exists ? scriptSnap.data() : null
    const sourceSnap = script?.short_idea_id
      ? await db.collection('short_ideas').doc(script.short_idea_id).get().then(async (ideaSnap) => {
          if (!ideaSnap.exists) return null
          const idea = ideaSnap.data()
          if (!idea?.source_item_id) return null
          const itemSnap = await db.collection('source_items').doc(idea.source_item_id).get()
          return itemSnap.exists ? itemSnap.data() : null
        })
      : null
    const aiPublishMeta =
      script && sourceSnap
        ? await generatePublishMetadataWithAi(aiConfig, sourceSnap, script, {
            platform: typeof body.platform === 'string' ? body.platform : accountSnap.data()?.platform ?? 'youtube',
          }).catch(() => null)
        : null
    await db.collection('publish_jobs').doc(publishJobId).set({
      render_job_id: renderJobId,
      platform: typeof body.platform === 'string' ? body.platform : accountSnap.data()?.platform ?? 'youtube',
      platform_account_id: platformAccountId,
      status: publishStatus,
      retry_count: 0,
      error_message: null,
      payload: {
        title:
          typeof body.title === 'string' && body.title.trim()
            ? body.title
            : typeof aiPublishMeta?.title === 'string'
              ? aiPublishMeta.title
              : null,
        description:
          typeof body.description === 'string' && body.description.trim()
            ? body.description
            : typeof aiPublishMeta?.description === 'string'
              ? aiPublishMeta.description
              : null,
        hashtags: Array.isArray(body.hashtags)
          ? body.hashtags.filter((tag) => typeof tag === 'string')
          : Array.isArray(aiPublishMeta?.hashtags)
            ? aiPublishMeta.hashtags.filter((tag) => typeof tag === 'string')
            : [],
        visibility: typeof body.visibility === 'string' ? body.visibility : 'private',
      },
      result: null,
      created_at: FieldValue.serverTimestamp(),
      updated_at: FieldValue.serverTimestamp(),
      deleted_at: null,
    })
    await addAuditLog('publish_job.created', 'publish_job', publishJobId, 'ai', { ai_trace: aiTrace })
    if (autoApprove) {
      await addApprovalRecord('publish_job', publishJobId, 'publish_review', 'approved', 'AI auto approval')
      await addAuditLog('publish_job.auto_approved', 'publish_job', publishJobId, 'ai')
    }

    return { data: { render_job_id: renderJobId, publish_job_id: publishJobId, status: publishStatus }, meta: { ai_trace: aiTrace } }
  }).catch((e) => {
    if (e instanceof Error && e.message === 'missing_render_job_id') return fail(res, 400, 'VALIDATION_ERROR', 'render_job_id is required', {})
    if (e instanceof Error && e.message === 'missing_platform_account') return fail(res, 400, 'VALIDATION_ERROR', 'platform_account_id is required', {})
    if (e instanceof Error && e.message === 'render_job_not_found') return fail(res, 404, 'NOT_FOUND', 'render job not found', {})
    if (e instanceof Error && e.message === 'platform_account_not_found') return fail(res, 404, 'NOT_FOUND', 'platform account not found', {})
    if (e instanceof Error && e.message === 'render_not_ready') return fail(res, 422, 'WORKFLOW_NOT_READY', 'render job is not approved', {})
    return fail(res, 400, 'VALIDATION_ERROR', 'invalid input', {})
  })
})

app.post('/api/ai/run-pipeline', async (req, res) => {
  await withIdempotency(req, res, async () => {
    const body = req.body ?? {}
    const sourceItemId = typeof body.source_item_id === 'string' ? body.source_item_id.trim() : ''
    if (!sourceItemId) throw new Error('missing_source_item_id')

    const itemSnap = await db.collection('source_items').doc(sourceItemId).get()
    if (!itemSnap.exists) throw new Error('source_item_not_found')
    const item = itemSnap.data()
    if (item?.status !== 'eligible') throw new Error('source_item_not_ready')

    const ideaCount = Math.max(1, Math.min(Number(body.idea_count ?? 3) || 3, 10))
    const durationSec = Math.max(10, Math.min(Number(body.duration_sec ?? 30) || 30, 180))
    const platform = typeof body.platform === 'string' ? body.platform : 'youtube'
    const platformAccountId = typeof body.platform_account_id === 'string' ? body.platform_account_id.trim() : ''
    if (!platformAccountId) throw new Error('missing_platform_account')

    const accountSnap = await db.collection('platform_accounts').doc(platformAccountId).get()
    if (!accountSnap.exists) throw new Error('platform_account_not_found')

    const autoApproveRender = body.auto_approve_render !== false
    const autoApprovePublish = body.auto_approve_publish !== false
    const aiConfig = await resolveAiConfig(body)
    const aiTrace = aiTraceFromConfig(aiConfig)
    const hashtags = Array.isArray(body.hashtags) ? body.hashtags.filter((tag) => typeof tag === 'string' && tag.trim()).map((tag) => tag.trim()) : []
    const visibility = typeof body.visibility === 'string' ? body.visibility : 'private'

    const ideaIds = []
    let leadIdeaId = null
    const aiIdeas = await generateIdeasWithAi(aiConfig, item, { ideaCount, durationSec, platform }).catch(() => null)
    for (let i = 0; i < ideaCount; i += 1) {
      const ideaId = newId()
      const approvedLead = i === 0
      const aiIdea = aiIdeas?.[i]
      await db.collection('short_ideas').doc(ideaId).set({
        source_item_id: sourceItemId,
        title: typeof aiIdea?.title === 'string' ? aiIdea.title : `${item.title} - AI 아이디어 ${i + 1}`,
        hook: typeof aiIdea?.hook === 'string' ? aiIdea.hook : approvedLead ? 'AI 리드 훅(데모)' : 'AI 후보 훅(데모)',
        angle: typeof aiIdea?.angle === 'string' ? aiIdea.angle : item.summary ?? '원천 핵심 요약(데모)',
        cta: typeof aiIdea?.cta === 'string' ? aiIdea.cta : typeof body.cta === 'string' ? body.cta : '설명란 참고',
        platform_targets: [platform],
        target_duration_sec: durationSec,
        priority_score: approvedLead ? 100 : 80 - i,
        risk_score: null,
        risk_tags: [],
        status: approvedLead ? 'approved' : 'awaiting_review',
        rejection_reason: null,
        created_at: FieldValue.serverTimestamp(),
        updated_at: FieldValue.serverTimestamp(),
        deleted_at: null,
      })
      ideaIds.push(ideaId)
      if (approvedLead) {
        leadIdeaId = ideaId
        await addApprovalRecord('short_idea', ideaId, 'idea_review', 'approved', 'AI pipeline lead approval')
        await addAuditLog('short_idea.auto_approved', 'short_idea', ideaId, 'ai')
      } else {
        await addAuditLog('short_idea.generated', 'short_idea', ideaId, 'ai')
      }
    }

    const scriptVersionSnap = await db.collection('scripts').where('short_idea_id', '==', leadIdeaId).get()
    const nextVersion = scriptVersionSnap.docs.reduce((max, doc) => Math.max(max, Number(doc.data()?.version ?? 0)), 0) + 1
    const scriptId = newId()
    const leadIdea = { title: aiIdeas?.[0]?.title ?? `${item.title} - AI 아이디어 1`, hook: aiIdeas?.[0]?.hook ?? 'AI 리드 훅(데모)', angle: aiIdeas?.[0]?.angle ?? item.summary ?? '', cta: aiIdeas?.[0]?.cta ?? '설명란 참고' }
    const aiScript = await generateScriptWithAi(aiConfig, item, leadIdea, { durationSec }).catch(() => null)
    const aiPublishMeta = await generatePublishMetadataWithAi(
      aiConfig,
      item,
      {
        script_text:
          typeof body.script_text === 'string' && body.script_text.trim()
            ? body.script_text.trim()
            : typeof aiScript?.script_text === 'string'
              ? aiScript.script_text
              : `AI 자동 생성 대본(데모) - ${item.title}`,
        subtitle_text:
          typeof body.subtitle_text === 'string' && body.subtitle_text.trim()
            ? body.subtitle_text.trim()
            : typeof aiScript?.subtitle_text === 'string'
              ? aiScript.subtitle_text
              : `AI 자막 초안(데모) - ${item.summary ?? item.title}`,
      },
      { platform }
    ).catch(() => null)
    await db.collection('scripts').doc(scriptId).set({
      short_idea_id: leadIdeaId,
      version: nextVersion,
      duration_sec: durationSec,
      script_text:
        typeof body.script_text === 'string' && body.script_text.trim()
          ? body.script_text.trim()
          : typeof aiScript?.script_text === 'string'
            ? aiScript.script_text
            : `AI 자동 생성 대본(데모) - ${item.title}`,
      subtitle_text:
        typeof body.subtitle_text === 'string' && body.subtitle_text.trim()
          ? body.subtitle_text.trim()
          : typeof aiScript?.subtitle_text === 'string'
            ? aiScript.subtitle_text
            : `AI 자막 초안(데모) - ${item.summary ?? item.title}`,
      caption_text:
        typeof body.publish_description === 'string'
          ? body.publish_description
          : typeof aiScript?.caption_text === 'string'
            ? aiScript.caption_text
            : null,
      hashtags: Array.isArray(aiScript?.hashtags) ? aiScript.hashtags.filter((tag) => typeof tag === 'string') : hashtags,
      language: typeof body.language === 'string' ? body.language : typeof aiScript?.language === 'string' ? aiScript.language : 'ko',
      tone: typeof body.tone === 'string' ? body.tone : typeof aiScript?.tone === 'string' ? aiScript.tone : 'direct-response',
      fact_check_status: 'passed',
      status: 'approved',
      revision_reason: null,
      created_at: FieldValue.serverTimestamp(),
      updated_at: FieldValue.serverTimestamp(),
      deleted_at: null,
    })
    await addApprovalRecord('script', scriptId, 'script_review', 'approved', 'AI pipeline script approval')
    await addAuditLog('script.auto_approved', 'script', scriptId, 'ai')

    const renderJobId = newId()
    await db.collection('render_jobs').doc(renderJobId).set({
      script_id: scriptId,
      short_idea_id: leadIdeaId,
      template_id: typeof body.template_id === 'string' ? body.template_id : null,
      render_profile: typeof body.render_profile === 'string' ? body.render_profile : 'shorts_1080x1920',
      status: 'queued',
      qc_status: autoApproveRender ? 'passed' : 'pending',
      retry_count: 0,
      error_message: null,
      output: null,
      created_at: FieldValue.serverTimestamp(),
      updated_at: FieldValue.serverTimestamp(),
      deleted_at: null,
    })
    await addAuditLog('render_job.created', 'render_job', renderJobId, 'ai')
    if (autoApproveRender) {
      await addApprovalRecord('render_job', renderJobId, 'render_review', 'approved', 'AI pipeline render approval')
      await addAuditLog('render_job.auto_approved', 'render_job', renderJobId, 'ai')
    }

    const publishJobId = newId()
    const publishStatus = autoApprovePublish ? 'queued' : 'awaiting_approval'
    await db.collection('publish_jobs').doc(publishJobId).set({
      render_job_id: renderJobId,
      platform,
      platform_account_id: platformAccountId,
      status: publishStatus,
      retry_count: 0,
      error_message: null,
      payload: {
        title:
          typeof body.publish_title === 'string' && body.publish_title.trim()
            ? body.publish_title.trim()
            : typeof aiPublishMeta?.title === 'string'
              ? aiPublishMeta.title
              : `${item.title} | AI Shorts`,
        description:
          typeof body.publish_description === 'string' && body.publish_description.trim()
            ? body.publish_description.trim()
            : typeof aiPublishMeta?.description === 'string'
              ? aiPublishMeta.description
              : `${item.summary ?? item.title}\n\n#ai-generated`,
        hashtags: Array.isArray(aiPublishMeta?.hashtags) ? aiPublishMeta.hashtags.filter((tag) => typeof tag === 'string') : hashtags,
        visibility,
      },
      result: null,
      created_at: FieldValue.serverTimestamp(),
      updated_at: FieldValue.serverTimestamp(),
      deleted_at: null,
    })
    await addAuditLog('publish_job.created', 'publish_job', publishJobId, 'ai')
    if (autoApprovePublish) {
      await addApprovalRecord('publish_job', publishJobId, 'publish_review', 'approved', 'AI pipeline publish approval')
      await addAuditLog('publish_job.auto_approved', 'publish_job', publishJobId, 'ai')
    }

    await addAuditLog('source_item.ai_pipeline_run', 'source_item', sourceItemId, 'ai', { ai_trace: aiTrace })
    return {
      data: {
        source_item_id: sourceItemId,
        idea_ids: ideaIds,
        lead_idea_id: leadIdeaId,
        script_id: scriptId,
        render_job_id: renderJobId,
        publish_job_id: publishJobId,
        statuses: {
          lead_idea: 'approved',
          script: 'approved',
          render_job: autoApproveRender ? 'passed' : 'pending',
          publish_job: publishStatus,
        },
      },
      meta: { ai_trace: aiTrace },
    }
  }).catch((e) => {
    if (e instanceof Error && e.message === 'missing_source_item_id') return fail(res, 400, 'VALIDATION_ERROR', 'source_item_id is required', {})
    if (e instanceof Error && e.message === 'missing_platform_account') return fail(res, 400, 'VALIDATION_ERROR', 'platform_account_id is required', {})
    if (e instanceof Error && e.message === 'source_item_not_found') return fail(res, 404, 'NOT_FOUND', 'source item not found', {})
    if (e instanceof Error && e.message === 'platform_account_not_found') return fail(res, 404, 'NOT_FOUND', 'platform account not found', {})
    if (e instanceof Error && e.message === 'source_item_not_ready') return fail(res, 422, 'WORKFLOW_NOT_READY', 'source item is not eligible', {})
    return fail(res, 400, 'VALIDATION_ERROR', 'invalid input', {})
  })
})

app.post('/api/ai/execute-render-job', async (req, res) => {
  await withIdempotency(req, res, async () => {
    const renderJobId = typeof req.body?.render_job_id === 'string' ? req.body.render_job_id.trim() : ''
    if (!renderJobId) throw new Error('missing_render_job_id')
    const result = await executeRenderJobById(renderJobId, req.body ?? {}, 'ai')
    return { data: result, meta: {} }
  }).catch((e) => {
    if (e instanceof Error && e.message === 'missing_render_job_id') return fail(res, 400, 'VALIDATION_ERROR', 'render_job_id is required', {})
    if (e instanceof Error && e.message === 'render_job_not_found') return fail(res, 404, 'NOT_FOUND', 'render job not found', {})
    if (e instanceof Error && e.message === 'job_locked') return fail(res, 409, 'CONFLICT', 'render job is locked', {})
    if (e instanceof Error && e.message === 'job_dead_lettered') return fail(res, 409, 'CONFLICT', 'render job is dead-lettered', {})
    if (e instanceof Error && e.message === 'job_not_runnable') return fail(res, 422, 'WORKFLOW_NOT_READY', 'render job is not runnable', {})
    if (e instanceof Error && e.message === 'script_not_found') return fail(res, 404, 'NOT_FOUND', 'script not found', {})
    return fail(res, 400, 'VALIDATION_ERROR', 'invalid input', {})
  })
})

app.post('/api/ai/execute-publish-job', async (req, res) => {
  await withIdempotency(req, res, async () => {
    const publishJobId = typeof req.body?.publish_job_id === 'string' ? req.body.publish_job_id.trim() : ''
    if (!publishJobId) throw new Error('missing_publish_job_id')
    const result = await executePublishJobById(publishJobId, req.body ?? {}, 'ai')
    return { data: result, meta: {} }
  }).catch((e) => {
    if (e instanceof Error && e.message === 'missing_publish_job_id') return fail(res, 400, 'VALIDATION_ERROR', 'publish_job_id is required', {})
    if (e instanceof Error && e.message === 'publish_job_not_found') return fail(res, 404, 'NOT_FOUND', 'publish job not found', {})
    if (e instanceof Error && e.message === 'publish_job_cancelled') return fail(res, 409, 'CONFLICT', 'publish job is cancelled', {})
    if (e instanceof Error && e.message === 'job_locked') return fail(res, 409, 'CONFLICT', 'publish job is locked', {})
    if (e instanceof Error && e.message === 'job_dead_lettered') return fail(res, 409, 'CONFLICT', 'publish job is dead-lettered', {})
    if (e instanceof Error && e.message === 'job_not_runnable') return fail(res, 422, 'WORKFLOW_NOT_READY', 'publish job is not runnable', {})
    if (e instanceof Error && e.message === 'publish_not_approved') return fail(res, 422, 'WORKFLOW_NOT_READY', 'publish job is awaiting approval', {})
    if (e instanceof Error && e.message === 'render_not_executed') return fail(res, 422, 'WORKFLOW_NOT_READY', 'render job is not executed', {})
    if (e instanceof Error && e.message === 'render_execution_failed') return fail(res, 422, 'WORKFLOW_FAILED', 'render execution failed', {})
    if (e instanceof Error && e.message === 'render_job_not_found') return fail(res, 404, 'NOT_FOUND', 'render job not found', {})
    if (e instanceof Error && e.message === 'platform_account_not_found') return fail(res, 404, 'NOT_FOUND', 'platform account not found', {})
    if (e instanceof Error && e.message === 'platform_account_not_connected') return fail(res, 422, 'WORKFLOW_NOT_READY', 'platform account is not connected', {})
    if (e instanceof Error && e.message === 'script_not_found') return fail(res, 404, 'NOT_FOUND', 'script not found', {})
    return fail(res, 400, 'VALIDATION_ERROR', 'invalid input', {})
  })
})

app.post('/api/ai/execute-pipeline', async (req, res) => {
  await withIdempotency(req, res, async () => {
    const body = req.body ?? {}
    const pipelineResult = await (async () => {
        const sourceItemId = typeof body.source_item_id === 'string' ? body.source_item_id.trim() : ''
        if (!sourceItemId) throw new Error('missing_source_item_id')

        const itemSnap = await db.collection('source_items').doc(sourceItemId).get()
        if (!itemSnap.exists) throw new Error('source_item_not_found')
        const item = itemSnap.data()
        if (item?.status !== 'eligible') throw new Error('source_item_not_ready')

        const platformAccountId = typeof body.platform_account_id === 'string' ? body.platform_account_id.trim() : ''
        if (!platformAccountId) throw new Error('missing_platform_account')
        const accountSnap = await db.collection('platform_accounts').doc(platformAccountId).get()
        if (!accountSnap.exists) throw new Error('platform_account_not_found')

        const ideaCount = Math.max(1, Math.min(Number(body.idea_count ?? 3) || 3, 10))
        const durationSec = Math.max(10, Math.min(Number(body.duration_sec ?? 30) || 30, 180))
        const platform = typeof body.platform === 'string' ? body.platform : 'youtube'
        const autoApproveRender = body.auto_approve_render !== false
        const autoApprovePublish = body.auto_approve_publish !== false
        const aiConfig = await resolveAiConfig(body)
        const aiTrace = aiTraceFromConfig(aiConfig)
        const hashtags = Array.isArray(body.hashtags)
          ? body.hashtags.filter((tag) => typeof tag === 'string' && tag.trim()).map((tag) => tag.trim())
          : []

        const ideaIds = []
        let leadIdeaId = null
        const aiIdeas = await generateIdeasWithAi(aiConfig, item, { ideaCount, durationSec, platform }).catch(() => null)

        for (let i = 0; i < ideaCount; i += 1) {
          const ideaId = newId()
          const approvedLead = i === 0
          const aiIdea = aiIdeas?.[i]
          await db.collection('short_ideas').doc(ideaId).set({
            source_item_id: sourceItemId,
            title: typeof aiIdea?.title === 'string' ? aiIdea.title : `${item.title} - AI 아이디어 ${i + 1}`,
            hook: typeof aiIdea?.hook === 'string' ? aiIdea.hook : approvedLead ? 'AI 리드 훅(데모)' : 'AI 후보 훅(데모)',
            angle: typeof aiIdea?.angle === 'string' ? aiIdea.angle : item.summary ?? '원천 핵심 요약(데모)',
            cta: typeof aiIdea?.cta === 'string' ? aiIdea.cta : typeof body.cta === 'string' ? body.cta : '설명란 참고',
            platform_targets: [platform],
            target_duration_sec: durationSec,
            priority_score: approvedLead ? 100 : 80 - i,
            risk_score: null,
            risk_tags: Array.isArray(aiIdea?.hashtags) ? aiIdea.hashtags.filter((tag) => typeof tag === 'string') : [],
            status: approvedLead ? 'approved' : 'awaiting_review',
            rejection_reason: null,
            created_at: FieldValue.serverTimestamp(),
            updated_at: FieldValue.serverTimestamp(),
            deleted_at: null,
          })
          ideaIds.push(ideaId)
          if (approvedLead) {
            leadIdeaId = ideaId
            await addApprovalRecord('short_idea', ideaId, 'idea_review', 'approved', 'AI pipeline lead approval')
            await addAuditLog('short_idea.auto_approved', 'short_idea', ideaId, 'ai')
          } else {
            await addAuditLog('short_idea.generated', 'short_idea', ideaId, 'ai')
          }
        }

        const versionSnap = await db.collection('scripts').where('short_idea_id', '==', leadIdeaId).get()
        const nextVersion = versionSnap.docs.reduce((max, doc) => Math.max(max, Number(doc.data()?.version ?? 0)), 0) + 1
        const scriptId = newId()
        const leadIdea = {
          title: aiIdeas?.[0]?.title ?? `${item.title} - AI 아이디어 1`,
          hook: aiIdeas?.[0]?.hook ?? 'AI 리드 훅(데모)',
          angle: aiIdeas?.[0]?.angle ?? item.summary ?? '',
          cta: aiIdeas?.[0]?.cta ?? '설명란 참고',
        }
        const aiScript = await generateScriptWithAi(aiConfig, item, leadIdea, { durationSec }).catch(() => null)
        const aiPublishMeta = await generatePublishMetadataWithAi(
          aiConfig,
          item,
          {
            script_text:
              typeof body.script_text === 'string' && body.script_text.trim()
                ? body.script_text.trim()
                : typeof aiScript?.script_text === 'string'
                  ? aiScript.script_text
                  : `AI 자동 생성 대본(데모) - ${item.title}`,
            subtitle_text:
              typeof body.subtitle_text === 'string' && body.subtitle_text.trim()
                ? body.subtitle_text.trim()
                : typeof aiScript?.subtitle_text === 'string'
                  ? aiScript.subtitle_text
                  : `AI 자막 초안(데모) - ${item.summary ?? item.title}`,
          },
          { platform }
        ).catch(() => null)

        await db.collection('scripts').doc(scriptId).set({
          short_idea_id: leadIdeaId,
          version: nextVersion,
          duration_sec: durationSec,
          script_text:
            typeof body.script_text === 'string' && body.script_text.trim()
              ? body.script_text.trim()
              : typeof aiScript?.script_text === 'string'
                ? aiScript.script_text
                : `AI 자동 생성 대본(데모) - ${item.title}`,
          subtitle_text:
            typeof body.subtitle_text === 'string' && body.subtitle_text.trim()
              ? body.subtitle_text.trim()
              : typeof aiScript?.subtitle_text === 'string'
                ? aiScript.subtitle_text
                : `AI 자막 초안(데모) - ${item.summary ?? item.title}`,
          caption_text:
            typeof body.publish_description === 'string'
              ? body.publish_description
              : typeof aiScript?.caption_text === 'string'
                ? aiScript.caption_text
                : null,
          hashtags: Array.isArray(aiScript?.hashtags) ? aiScript.hashtags.filter((tag) => typeof tag === 'string') : hashtags,
          language: typeof body.language === 'string' ? body.language : typeof aiScript?.language === 'string' ? aiScript.language : 'ko',
          tone: typeof body.tone === 'string' ? body.tone : typeof aiScript?.tone === 'string' ? aiScript.tone : 'direct-response',
          fact_check_status: 'passed',
          status: 'approved',
          revision_reason: null,
          created_at: FieldValue.serverTimestamp(),
          updated_at: FieldValue.serverTimestamp(),
          deleted_at: null,
        })
        await addApprovalRecord('script', scriptId, 'script_review', 'approved', 'AI pipeline script approval')
        await addAuditLog('script.auto_approved', 'script', scriptId, 'ai')

        const renderJobId = newId()
        await db.collection('render_jobs').doc(renderJobId).set({
          script_id: scriptId,
          short_idea_id: leadIdeaId,
          template_id: typeof body.template_id === 'string' ? body.template_id : null,
          render_profile: typeof body.render_profile === 'string' ? body.render_profile : 'shorts_1080x1920',
          status: 'queued',
          qc_status: autoApproveRender ? 'passed' : 'pending',
          retry_count: 0,
          error_message: null,
          output: null,
          created_at: FieldValue.serverTimestamp(),
          updated_at: FieldValue.serverTimestamp(),
          deleted_at: null,
        })
        await addAuditLog('render_job.created', 'render_job', renderJobId, 'ai')
        if (autoApproveRender) {
          await addApprovalRecord('render_job', renderJobId, 'render_review', 'approved', 'AI pipeline render approval')
          await addAuditLog('render_job.auto_approved', 'render_job', renderJobId, 'ai')
        }

        const publishJobId = newId()
        const publishStatus = autoApprovePublish ? 'queued' : 'awaiting_approval'
        await db.collection('publish_jobs').doc(publishJobId).set({
          render_job_id: renderJobId,
          platform,
          platform_account_id: platformAccountId,
          status: publishStatus,
          retry_count: 0,
          error_message: null,
          payload: {
            title:
              typeof body.publish_title === 'string' && body.publish_title.trim()
                ? body.publish_title.trim()
                : typeof aiPublishMeta?.title === 'string'
                  ? aiPublishMeta.title
                  : `${item.title} | AI Shorts`,
            description:
              typeof body.publish_description === 'string' && body.publish_description.trim()
                ? body.publish_description.trim()
                : typeof aiPublishMeta?.description === 'string'
                  ? aiPublishMeta.description
                  : `${item.summary ?? item.title}\n\n#ai-generated`,
            hashtags: Array.isArray(aiPublishMeta?.hashtags) ? aiPublishMeta.hashtags.filter((tag) => typeof tag === 'string') : hashtags,
            visibility: typeof body.visibility === 'string' ? body.visibility : 'private',
          },
          result: null,
          created_at: FieldValue.serverTimestamp(),
          updated_at: FieldValue.serverTimestamp(),
          deleted_at: null,
        })
        await addAuditLog('publish_job.created', 'publish_job', publishJobId, 'ai')
        if (autoApprovePublish) {
          await addApprovalRecord('publish_job', publishJobId, 'publish_review', 'approved', 'AI pipeline publish approval')
          await addAuditLog('publish_job.auto_approved', 'publish_job', publishJobId, 'ai')
        }

        await addAuditLog('source_item.ai_pipeline_run', 'source_item', sourceItemId, 'ai', { ai_trace: aiTrace })
        return {
          source_item_id: sourceItemId,
          idea_ids: ideaIds,
          lead_idea_id: leadIdeaId,
          script_id: scriptId,
          render_job_id: renderJobId,
          publish_job_id: publishJobId,
          statuses: {
            lead_idea: 'approved',
            script: 'approved',
            render_job: autoApproveRender ? 'passed' : 'pending',
            publish_job: publishStatus,
          },
        }
      })()

    const publishExecution = await executePublishJobById(pipelineResult.publish_job_id, body, 'ai')
    return { data: { ...pipelineResult, execution: publishExecution }, meta: {} }
  }).catch((e) => {
    if (e instanceof Error && e.message === 'missing_source_item_id') return fail(res, 400, 'VALIDATION_ERROR', 'source_item_id is required', {})
    if (e instanceof Error && e.message === 'missing_platform_account') return fail(res, 400, 'VALIDATION_ERROR', 'platform_account_id is required', {})
    if (e instanceof Error && e.message === 'source_item_not_found') return fail(res, 404, 'NOT_FOUND', 'source item not found', {})
    if (e instanceof Error && e.message === 'platform_account_not_found') return fail(res, 404, 'NOT_FOUND', 'platform account not found', {})
    if (e instanceof Error && e.message === 'source_item_not_ready') return fail(res, 422, 'WORKFLOW_NOT_READY', 'source item is not eligible', {})
    if (e instanceof Error && e.message === 'render_execution_failed') return fail(res, 422, 'WORKFLOW_FAILED', 'render execution failed', {})
    return fail(res, 400, 'VALIDATION_ERROR', 'invalid input', {})
  })
})

app.get('/api/ai/failed-jobs', async (req, res) => {
  const limit = Math.min(parseLimit(req, 20), 100)
  const jobType = typeof req.query.job_type === 'string' ? req.query.job_type : 'all'
  const onlyDue = parseBooleanLike(req.query.only_due, false)
  const provider = typeof req.query.provider === 'string' ? req.query.provider.trim() : ''
  const platform = typeof req.query.platform === 'string' ? req.query.platform.trim() : ''
  const now = Date.now()

  const items = []
  if (jobType === 'all' || jobType === 'render') {
    const snap = await db.collection('render_jobs').where('status', '==', 'failed').limit(200).get()
    items.push(...snap.docs.map((doc) => mapFailedJobSummary('render', { id: doc.id, ...doc.data() })))
  }
  if (jobType === 'all' || jobType === 'publish') {
    const snap = await db.collection('publish_jobs').where('status', '==', 'failed').limit(200).get()
    items.push(...snap.docs.map((doc) => mapFailedJobSummary('publish', { id: doc.id, ...doc.data() })))
  }

  let filtered = items
  filtered = filtered.filter((item) => !isDeadLettered(item))
  filtered = filtered.filter((item) => !isExecutionLocked(item, now))
  if (onlyDue) filtered = filtered.filter((item) => isRetryDue(item.next_retry_at, now))
  if (provider) filtered = filtered.filter((item) => item.provider === provider)
  if (platform) filtered = filtered.filter((item) => item.platform === platform)
  filtered = filtered.sort(sortByUpdatedDesc)

  ok(res, {
    items: filtered.slice(0, limit),
    total: filtered.length,
    limit,
    only_due: onlyDue,
    dead_lettered_only: false,
  })
})

app.get('/api/ai/dead-letter-jobs', async (req, res) => {
  const limit = Math.min(parseLimit(req, 20), 100)
  const jobType = typeof req.query.job_type === 'string' ? req.query.job_type : 'all'
  const provider = typeof req.query.provider === 'string' ? req.query.provider.trim() : ''
  const platform = typeof req.query.platform === 'string' ? req.query.platform.trim() : ''

  const items = []
  if (jobType === 'all' || jobType === 'render') {
    const snap = await db.collection('render_jobs').where('status', '==', 'failed').limit(200).get()
    items.push(...snap.docs.map((doc) => mapFailedJobSummary('render', { id: doc.id, ...doc.data() })))
  }
  if (jobType === 'all' || jobType === 'publish') {
    const snap = await db.collection('publish_jobs').where('status', '==', 'failed').limit(200).get()
    items.push(...snap.docs.map((doc) => mapFailedJobSummary('publish', { id: doc.id, ...doc.data() })))
  }

  let filtered = items.filter((item) => isDeadLettered(item))
  if (provider) filtered = filtered.filter((item) => item.provider === provider)
  if (platform) filtered = filtered.filter((item) => item.platform === platform)
  filtered = filtered.sort(sortByUpdatedDesc)

  ok(res, {
    items: filtered.slice(0, limit),
    total: filtered.length,
    limit,
    dead_lettered_only: true,
  })
})

app.post('/api/ai/retry-failed-jobs', async (req, res) => {
  await withIdempotency(req, res, async () => {
    const body = req.body ?? {}
    const jobType = typeof body.job_type === 'string' ? body.job_type : 'all'
    const limit = Math.min(Math.max(Number(body.limit ?? 10) || 10, 1), 100)
    const onlyDue = parseBooleanLike(body.only_due, true)
    const provider = typeof body.provider === 'string' ? body.provider.trim() : ''
    const platform = typeof body.platform === 'string' ? body.platform.trim() : ''
    const now = Date.now()

    const candidates = []
    if (jobType === 'all' || jobType === 'render') {
      const snap = await db.collection('render_jobs').where('status', '==', 'failed').limit(200).get()
      candidates.push(...snap.docs.map((doc) => mapFailedJobSummary('render', { id: doc.id, ...doc.data() })))
    }
    if (jobType === 'all' || jobType === 'publish') {
      const snap = await db.collection('publish_jobs').where('status', '==', 'failed').limit(200).get()
      candidates.push(...snap.docs.map((doc) => mapFailedJobSummary('publish', { id: doc.id, ...doc.data() })))
    }

    let selected = candidates.filter((item) => !isDeadLettered(item)).filter((item) => !isExecutionLocked(item, now))
    if (onlyDue) selected = selected.filter((item) => isRetryDue(item.next_retry_at, now))
    if (provider) selected = selected.filter((item) => item.provider === provider)
    if (platform) selected = selected.filter((item) => item.platform === platform)
    selected = selected.sort(sortByUpdatedDesc).slice(0, limit)

    const results = []
    for (const item of selected) {
      try {
        if (item.job_type === 'render') {
          const ref = db.collection('render_jobs').doc(item.id)
          const snap = await ref.get()
          if (!snap.exists) throw new Error('render_job_not_found')
          const retryCount = Number(snap.data()?.retry_count ?? 0) + 1
          await ref.set({ retry_count: retryCount, error_message: null, updated_at: FieldValue.serverTimestamp() }, { merge: true })
          const result = await executeRenderJobById(item.id, body.render ?? body, 'ai')
          results.push({ job_type: 'render', id: item.id, ok: result.status !== 'failed', result })
        } else {
          const ref = db.collection('publish_jobs').doc(item.id)
          const snap = await ref.get()
          if (!snap.exists) throw new Error('publish_job_not_found')
          const retryCount = Number(snap.data()?.retry_count ?? 0) + 1
          await ref.set({ retry_count: retryCount, error_message: null, updated_at: FieldValue.serverTimestamp() }, { merge: true })
          const result = await executePublishJobById(item.id, body.publish ?? body, 'ai')
          results.push({ job_type: 'publish', id: item.id, ok: result.status !== 'failed', result })
        }
      } catch (error) {
        results.push({
          job_type: item.job_type,
          id: item.id,
          ok: false,
          error_message: error instanceof Error ? error.message : 'retry failed',
        })
      }
    }

    return {
      data: {
        requested_limit: limit,
        retried_count: results.length,
        success_count: results.filter((item) => item.ok).length,
        failed_count: results.filter((item) => !item.ok).length,
        items: results,
      },
          meta: { ai_trace: aiTrace },
    }
  }).catch(() => fail(res, 400, 'VALIDATION_ERROR', 'invalid input', {}))
})

app.post('/api/ai/restore-dead-letter-jobs', async (req, res) => {
  await withIdempotency(req, res, async () => {
    const body = req.body ?? {}
    const jobType = typeof body.job_type === 'string' ? body.job_type : 'all'
    const limit = Math.min(Math.max(Number(body.limit ?? 10) || 10, 1), 100)
    const provider = typeof body.provider === 'string' ? body.provider.trim() : ''
    const platform = typeof body.platform === 'string' ? body.platform.trim() : ''
    const requestedIds = Array.isArray(body.job_ids)
      ? body.job_ids.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim())
      : []

    const candidates = []
    if (jobType === 'all' || jobType === 'render') {
      const snap = await db.collection('render_jobs').where('status', '==', 'failed').limit(200).get()
      candidates.push(...snap.docs.map((doc) => mapFailedJobSummary('render', { id: doc.id, ...doc.data() })))
    }
    if (jobType === 'all' || jobType === 'publish') {
      const snap = await db.collection('publish_jobs').where('status', '==', 'failed').limit(200).get()
      candidates.push(...snap.docs.map((doc) => mapFailedJobSummary('publish', { id: doc.id, ...doc.data() })))
    }

    let selected = candidates.filter((item) => isDeadLettered(item))
    if (requestedIds.length) selected = selected.filter((item) => requestedIds.includes(item.id))
    if (provider) selected = selected.filter((item) => item.provider === provider)
    if (platform) selected = selected.filter((item) => item.platform === platform)
    selected = selected.sort(sortByUpdatedDesc).slice(0, limit)

    const results = []
    for (const item of selected) {
      try {
        const result = await restoreDeadLetterJob(
          item.job_type,
          item.id,
          item.job_type === 'render' ? body.render ?? body : body.publish ?? body,
          'ai'
        )
        results.push({ job_type: item.job_type, id: item.id, ok: true, result })
      } catch (error) {
        results.push({
          job_type: item.job_type,
          id: item.id,
          ok: false,
          error_message: error instanceof Error ? error.message : 'restore failed',
        })
      }
    }

    return {
      data: {
        requested_limit: limit,
        restored_count: results.filter((item) => item.ok).length,
        failed_count: results.filter((item) => !item.ok).length,
        items: results,
      },
      meta: {},
    }
  }).catch(() => fail(res, 400, 'VALIDATION_ERROR', 'invalid input', {}))
})

app.post('/api/ai/restore-and-retry-dead-letter-jobs', async (req, res) => {
  await withIdempotency(req, res, async () => {
    const body = req.body ?? {}
    const jobType = typeof body.job_type === 'string' ? body.job_type : 'all'
    const limit = Math.min(Math.max(Number(body.limit ?? 10) || 10, 1), 100)
    const provider = typeof body.provider === 'string' ? body.provider.trim() : ''
    const platform = typeof body.platform === 'string' ? body.platform.trim() : ''
    const requestedIds = Array.isArray(body.job_ids)
      ? body.job_ids.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim())
      : []

    const candidates = []
    if (jobType === 'all' || jobType === 'render') {
      const snap = await db.collection('render_jobs').where('status', '==', 'failed').limit(200).get()
      candidates.push(...snap.docs.map((doc) => mapFailedJobSummary('render', { id: doc.id, ...doc.data() })))
    }
    if (jobType === 'all' || jobType === 'publish') {
      const snap = await db.collection('publish_jobs').where('status', '==', 'failed').limit(200).get()
      candidates.push(...snap.docs.map((doc) => mapFailedJobSummary('publish', { id: doc.id, ...doc.data() })))
    }

    let selected = candidates.filter((item) => isDeadLettered(item))
    if (requestedIds.length) selected = selected.filter((item) => requestedIds.includes(item.id))
    if (provider) selected = selected.filter((item) => item.provider === provider)
    if (platform) selected = selected.filter((item) => item.platform === platform)
    selected = selected.sort(sortByUpdatedDesc).slice(0, limit)

    const results = []
    for (const item of selected) {
      try {
        const executionBody = item.job_type === 'render' ? body.render ?? body : body.publish ?? body
        const restored = await restoreDeadLetterJob(item.job_type, item.id, executionBody, 'ai')

        if (item.job_type === 'render') {
          const ref = db.collection('render_jobs').doc(item.id)
          const snap = await ref.get()
          if (!snap.exists) throw new Error('render_job_not_found')
          const retryCount = Number(snap.data()?.retry_count ?? 0) + 1
          await ref.set({ retry_count: retryCount, error_message: null, updated_at: FieldValue.serverTimestamp() }, { merge: true })
          const result = await executeRenderJobById(item.id, executionBody, 'ai')
          results.push({ job_type: 'render', id: item.id, ok: result.status !== 'failed', restored, result })
        } else {
          const ref = db.collection('publish_jobs').doc(item.id)
          const snap = await ref.get()
          if (!snap.exists) throw new Error('publish_job_not_found')
          const retryCount = Number(snap.data()?.retry_count ?? 0) + 1
          await ref.set({ retry_count: retryCount, error_message: null, updated_at: FieldValue.serverTimestamp() }, { merge: true })
          const result = await executePublishJobById(item.id, executionBody, 'ai')
          results.push({ job_type: 'publish', id: item.id, ok: result.status !== 'failed', restored, result })
        }
      } catch (error) {
        results.push({
          job_type: item.job_type,
          id: item.id,
          ok: false,
          error_message: error instanceof Error ? error.message : 'restore and retry failed',
        })
      }
    }

    return {
      data: {
        requested_limit: limit,
        processed_count: results.length,
        success_count: results.filter((item) => item.ok).length,
        failed_count: results.filter((item) => !item.ok).length,
        items: results,
      },
      meta: {},
    }
  }).catch(() => fail(res, 400, 'VALIDATION_ERROR', 'invalid input', {}))
})

app.get('/api/short-ideas', async (req, res) => {
  const limit = parseLimit(req, 20)
  const offset = parseOffset(req)
  const status = typeof req.query.status === 'string' ? req.query.status : ''
  const source_item_id = typeof req.query.source_item_id === 'string' ? req.query.source_item_id : ''

  const clauses = []
  if (status) clauses.push({ field: 'status', op: '==', value: status })
  if (source_item_id) clauses.push({ field: 'source_item_id', op: '==', value: source_item_id })

  const page = await listCollection('short_ideas', limit, offset, clauses)
  ok(res, page)
})

app.get('/api/short-ideas/:id', async (req, res) => {
  const id = req.params.id
  const snap = await db.collection('short_ideas').doc(id).get()
  if (!snap.exists) return fail(res, 404, 'NOT_FOUND', 'short idea not found', {})
  ok(res, { id: snap.id, ...snap.data() })
})

app.post('/api/short-ideas/:id/approve', async (req, res) => {
  const id = req.params.id
  const ref = db.collection('short_ideas').doc(id)
  const snap = await ref.get()
  if (!snap.exists) return fail(res, 404, 'NOT_FOUND', 'short idea not found', {})
  if (snap.data()?.status !== 'awaiting_review') return fail(res, 409, 'CONFLICT', 'not in awaiting_review', {})

  await ref.set({ status: 'approved', updated_at: FieldValue.serverTimestamp() }, { merge: true })
  await db.collection('approvals').add({
    entity_type: 'short_idea',
    entity_id: id,
    approval_stage: 'idea_review',
    decision: 'approved',
    reviewer_id: null,
    reviewer_name: null,
    comment: req.body?.comment ?? null,
    requested_at: FieldValue.serverTimestamp(),
    decided_at: FieldValue.serverTimestamp(),
    created_at: FieldValue.serverTimestamp(),
    updated_at: FieldValue.serverTimestamp(),
  })
  await addAuditLog('short_idea.approved', 'short_idea', id, 'user')
  ok(res, { id, status: 'approved' })
})

app.post('/api/short-ideas/:id/reject', async (req, res) => {
  const id = req.params.id
  const ref = db.collection('short_ideas').doc(id)
  const snap = await ref.get()
  if (!snap.exists) return fail(res, 404, 'NOT_FOUND', 'short idea not found', {})
  if (snap.data()?.status !== 'awaiting_review') return fail(res, 409, 'CONFLICT', 'not in awaiting_review', {})

  await ref.set(
    { status: 'rejected', rejection_reason: typeof req.body?.reason === 'string' ? req.body.reason : 'rejected', updated_at: FieldValue.serverTimestamp() },
    { merge: true }
  )
  await db.collection('approvals').add({
    entity_type: 'short_idea',
    entity_id: id,
    approval_stage: 'idea_review',
    decision: 'rejected',
    reviewer_id: null,
    reviewer_name: null,
    comment: req.body?.comment ?? null,
    requested_at: FieldValue.serverTimestamp(),
    decided_at: FieldValue.serverTimestamp(),
    created_at: FieldValue.serverTimestamp(),
    updated_at: FieldValue.serverTimestamp(),
  })
  await addAuditLog('short_idea.rejected', 'short_idea', id, 'user')
  ok(res, { id, status: 'rejected' })
})

app.post('/api/short-ideas/:id/generate-script', async (req, res) => {
  const id = req.params.id
  const ideaSnap = await db.collection('short_ideas').doc(id).get()
  if (!ideaSnap.exists) return fail(res, 404, 'NOT_FOUND', 'short idea not found', {})
  const idea = ideaSnap.data()
  if (idea?.status !== 'approved') return fail(res, 422, 'WORKFLOW_NOT_READY', 'idea is not approved', {})

  await withIdempotency(req, res, async () => {
    const duration_sec = Number(req.body?.duration_sec ?? idea.target_duration_sec) || 30
    const versionSnap = await db.collection('scripts').where('short_idea_id', '==', id).get()
    const versions = versionSnap.docs.map((d) => Number(d.data()?.version ?? 0))
    const nextVersion = (versions.length ? Math.max(...versions) : 0) + 1
    const scriptId = newId()

    await db.collection('scripts').doc(scriptId).set({
      short_idea_id: id,
      version: nextVersion,
      duration_sec,
      script_text: `대본(데모) - ${idea.title}`,
      subtitle_text: `자막(데모) - ${idea.hook}`,
      caption_text: null,
      hashtags: [],
      language: 'ko',
      tone: null,
      fact_check_status: 'pending',
      status: 'awaiting_review',
      revision_reason: null,
      created_at: FieldValue.serverTimestamp(),
      updated_at: FieldValue.serverTimestamp(),
      deleted_at: null,
    })

    await addAuditLog('script.generated', 'script', scriptId, 'user')
    return { data: { id: scriptId, status: 'processing' }, meta: {} }
  }).catch(() => fail(res, 400, 'VALIDATION_ERROR', 'invalid input', {}))
})

app.get('/api/scripts', async (req, res) => {
  const limit = parseLimit(req, 20)
  const offset = parseOffset(req)
  const status = typeof req.query.status === 'string' ? req.query.status : ''
  const short_idea_id = typeof req.query.short_idea_id === 'string' ? req.query.short_idea_id : ''

  const clauses = []
  if (status) clauses.push({ field: 'status', op: '==', value: status })
  if (short_idea_id) clauses.push({ field: 'short_idea_id', op: '==', value: short_idea_id })

  const page = await listCollection('scripts', limit, offset, clauses)
  ok(res, page)
})

app.get('/api/scripts/:id', async (req, res) => {
  const id = req.params.id
  const snap = await db.collection('scripts').doc(id).get()
  if (!snap.exists) return fail(res, 404, 'NOT_FOUND', 'script not found', {})
  ok(res, { id: snap.id, ...snap.data() })
})

app.post('/api/scripts/:id/approve', async (req, res) => {
  const id = req.params.id
  const ref = db.collection('scripts').doc(id)
  const snap = await ref.get()
  if (!snap.exists) return fail(res, 404, 'NOT_FOUND', 'script not found', {})
  if (snap.data()?.status !== 'awaiting_review') return fail(res, 409, 'CONFLICT', 'not in awaiting_review', {})

  await ref.set(
    {
      status: 'approved',
      fact_check_status: typeof req.body?.fact_check_status === 'string' ? req.body.fact_check_status : snap.data()?.fact_check_status,
      updated_at: FieldValue.serverTimestamp(),
    },
    { merge: true }
  )

  await db.collection('approvals').add({
    entity_type: 'script',
    entity_id: id,
    approval_stage: 'script_review',
    decision: 'approved',
    reviewer_id: null,
    reviewer_name: null,
    comment: req.body?.comment ?? null,
    requested_at: FieldValue.serverTimestamp(),
    decided_at: FieldValue.serverTimestamp(),
    created_at: FieldValue.serverTimestamp(),
    updated_at: FieldValue.serverTimestamp(),
  })

  await addAuditLog('script.approved', 'script', id, 'user')
  ok(res, { id, status: 'approved' })
})

app.post('/api/scripts/:id/request-revision', async (req, res) => {
  const id = req.params.id
  const ref = db.collection('scripts').doc(id)
  const snap = await ref.get()
  if (!snap.exists) return fail(res, 404, 'NOT_FOUND', 'script not found', {})
  if (snap.data()?.status !== 'awaiting_review') return fail(res, 409, 'CONFLICT', 'not in awaiting_review', {})

  await withIdempotency(req, res, async () => {
    const data = snap.data()
    const shortIdeaId = data.short_idea_id

    await ref.set(
      {
        status: 'revision_required',
        revision_reason: typeof req.body?.reason === 'string' ? req.body.reason : 'revision_required',
        updated_at: FieldValue.serverTimestamp(),
      },
      { merge: true }
    )

    const versionSnap = await db.collection('scripts').where('short_idea_id', '==', shortIdeaId).get()
    const versions = versionSnap.docs.map((d) => Number(d.data()?.version ?? 0))
    const nextVersion = (versions.length ? Math.max(...versions) : 0) + 1
    const newScriptId = newId()

    await db.collection('scripts').doc(newScriptId).set({
      ...data,
      version: nextVersion,
      status: 'awaiting_review',
      revision_reason: typeof req.body?.instructions === 'string' ? req.body.instructions : null,
      created_at: FieldValue.serverTimestamp(),
      updated_at: FieldValue.serverTimestamp(),
      deleted_at: null,
    })

    await db.collection('approvals').add({
      entity_type: 'script',
      entity_id: id,
      approval_stage: 'script_review',
      decision: 'changes_requested',
      reviewer_id: null,
      reviewer_name: null,
      comment: req.body?.comment ?? null,
      requested_at: FieldValue.serverTimestamp(),
      decided_at: FieldValue.serverTimestamp(),
      created_at: FieldValue.serverTimestamp(),
      updated_at: FieldValue.serverTimestamp(),
    })

    await addAuditLog('script.revision_requested', 'script', id, 'user')
    return { data: { id, status: 'revision_required', new_script_id: newScriptId }, meta: {} }
  }).catch(() => fail(res, 400, 'VALIDATION_ERROR', 'invalid input', {}))
})

app.post('/api/render-jobs', async (req, res) => {
  await withIdempotency(req, res, async () => {
    const body = req.body ?? {}
    const script_id = typeof body.script_id === 'string' ? body.script_id : ''
    const scriptSnap = await db.collection('scripts').doc(script_id).get()
    if (!scriptSnap.exists) throw new Error('validation')
    const script = scriptSnap.data()

    const id = newId()
    await db.collection('render_jobs').doc(id).set({
      script_id,
      short_idea_id: script.short_idea_id,
      template_id: typeof body.template_id === 'string' ? body.template_id : null,
      render_profile: typeof body.render_profile === 'string' ? body.render_profile : 'shorts_1080x1920',
      status: 'queued',
      qc_status: 'pending',
      retry_count: 0,
      error_message: null,
      output: null,
      created_at: FieldValue.serverTimestamp(),
      updated_at: FieldValue.serverTimestamp(),
      deleted_at: null,
    })
    await addAuditLog('render_job.created', 'render_job', id, 'user')
    return { data: { id, status: 'queued' }, meta: {} }
  }).catch(() => fail(res, 400, 'VALIDATION_ERROR', 'invalid input', {}))
})

app.get('/api/render-jobs', async (req, res) => {
  const limit = parseLimit(req, 20)
  const offset = parseOffset(req)
  const status = typeof req.query.status === 'string' ? req.query.status : ''
  const script_id = typeof req.query.script_id === 'string' ? req.query.script_id : ''
  const clauses = []
  if (status) clauses.push({ field: 'status', op: '==', value: status })
  if (script_id) clauses.push({ field: 'script_id', op: '==', value: script_id })
  const page = await listCollection('render_jobs', limit, offset, clauses)
  ok(res, page)
})

app.get('/api/render-jobs/:id', async (req, res) => {
  const id = req.params.id
  const snap = await db.collection('render_jobs').doc(id).get()
  if (!snap.exists) return fail(res, 404, 'NOT_FOUND', 'render job not found', {})
  ok(res, { id: snap.id, ...snap.data() })
})

app.post('/api/render-jobs/:id/retry', async (req, res) => {
  const id = req.params.id
  const ref = db.collection('render_jobs').doc(id)
  const snap = await ref.get()
  if (!snap.exists) return fail(res, 404, 'NOT_FOUND', 'render job not found', {})

  const retry_count = Number(snap.data()?.retry_count ?? 0) + 1
  await ref.set({ status: 'queued', retry_count, error_message: null, updated_at: FieldValue.serverTimestamp() }, { merge: true })
  await addAuditLog('render_job.retry', 'render_job', id, 'user')
  ok(res, { id, status: 'queued', retry_count })
})

app.post('/api/render-jobs/:id/approve-for-publish', async (req, res) => {
  const id = req.params.id
  const ref = db.collection('render_jobs').doc(id)
  const snap = await ref.get()
  if (!snap.exists) return fail(res, 404, 'NOT_FOUND', 'render job not found', {})

  await ref.set({ qc_status: 'passed', updated_at: FieldValue.serverTimestamp() }, { merge: true })
  await db.collection('approvals').add({
    entity_type: 'render_job',
    entity_id: id,
    approval_stage: 'render_review',
    decision: 'approved',
    reviewer_id: null,
    reviewer_name: null,
    comment: req.body?.comment ?? null,
    requested_at: FieldValue.serverTimestamp(),
    decided_at: FieldValue.serverTimestamp(),
    created_at: FieldValue.serverTimestamp(),
    updated_at: FieldValue.serverTimestamp(),
  })
  await addAuditLog('render_job.approved_for_publish', 'render_job', id, 'user')
  ok(res, { id, qc_status: 'passed' })
})

app.post('/api/publish-jobs', async (req, res) => {
  await withIdempotency(req, res, async () => {
    const body = req.body ?? {}
    const render_job_id = typeof body.render_job_id === 'string' ? body.render_job_id : ''
    const renderSnap = await db.collection('render_jobs').doc(render_job_id).get()
    if (!renderSnap.exists) throw new Error('validation')
    if (renderSnap.data()?.qc_status !== 'passed') throw new Error('not_ready')

    const id = newId()
    await db.collection('publish_jobs').doc(id).set({
      render_job_id,
      platform: typeof body.platform === 'string' ? body.platform : 'youtube',
      platform_account_id: typeof body.platform_account_id === 'string' ? body.platform_account_id : null,
      status: 'awaiting_approval',
      retry_count: 0,
      error_message: null,
      payload: {
        title: body.title ?? null,
        description: body.description ?? null,
        hashtags: Array.isArray(body.hashtags) ? body.hashtags : [],
        visibility: body.visibility ?? 'private',
      },
      result: null,
      created_at: FieldValue.serverTimestamp(),
      updated_at: FieldValue.serverTimestamp(),
      deleted_at: null,
    })
    await addAuditLog('publish_job.created', 'publish_job', id, 'user')
    return { data: { id, status: 'awaiting_approval' }, meta: {} }
  }).catch((e) => {
    if (e instanceof Error && e.message === 'not_ready') return fail(res, 422, 'WORKFLOW_NOT_READY', 'render job not approved', {})
    return fail(res, 400, 'VALIDATION_ERROR', 'invalid input', {})
  })
})

app.get('/api/publish-jobs', async (req, res) => {
  const limit = parseLimit(req, 20)
  const offset = parseOffset(req)
  const status = typeof req.query.status === 'string' ? req.query.status : ''
  const platform = typeof req.query.platform === 'string' ? req.query.platform : ''
  const clauses = []
  if (status) clauses.push({ field: 'status', op: '==', value: status })
  if (platform) clauses.push({ field: 'platform', op: '==', value: platform })
  const page = await listCollection('publish_jobs', limit, offset, clauses)
  ok(res, page)
})

app.get('/api/publish-jobs/:id', async (req, res) => {
  const id = req.params.id
  const snap = await db.collection('publish_jobs').doc(id).get()
  if (!snap.exists) return fail(res, 404, 'NOT_FOUND', 'publish job not found', {})
  ok(res, { id: snap.id, ...snap.data() })
})

app.post('/api/publish-jobs/:id/approve', async (req, res) => {
  const id = req.params.id
  const ref = db.collection('publish_jobs').doc(id)
  const snap = await ref.get()
  if (!snap.exists) return fail(res, 404, 'NOT_FOUND', 'publish job not found', {})
  if (snap.data()?.status !== 'awaiting_approval') return fail(res, 409, 'CONFLICT', 'not in awaiting_approval', {})

  await ref.set({ status: 'queued', updated_at: FieldValue.serverTimestamp() }, { merge: true })
  await db.collection('approvals').add({
    entity_type: 'publish_job',
    entity_id: id,
    approval_stage: 'publish_review',
    decision: 'approved',
    reviewer_id: null,
    reviewer_name: null,
    comment: req.body?.comment ?? null,
    requested_at: FieldValue.serverTimestamp(),
    decided_at: FieldValue.serverTimestamp(),
    created_at: FieldValue.serverTimestamp(),
    updated_at: FieldValue.serverTimestamp(),
  })
  await addAuditLog('publish_job.approved', 'publish_job', id, 'user')
  ok(res, { id, status: 'queued' })
})

app.post('/api/publish-jobs/:id/retry', async (req, res) => {
  const id = req.params.id
  const ref = db.collection('publish_jobs').doc(id)
  const snap = await ref.get()
  if (!snap.exists) return fail(res, 404, 'NOT_FOUND', 'publish job not found', {})
  const retry_count = Number(snap.data()?.retry_count ?? 0) + 1

  await ref.set({ status: 'queued', retry_count, error_message: null, updated_at: FieldValue.serverTimestamp() }, { merge: true })
  await addAuditLog('publish_job.retry', 'publish_job', id, 'user')
  ok(res, { id, status: 'queued', retry_count })
})

app.post('/api/publish-jobs/:id/cancel', async (req, res) => {
  const id = req.params.id
  const ref = db.collection('publish_jobs').doc(id)
  const snap = await ref.get()
  if (!snap.exists) return fail(res, 404, 'NOT_FOUND', 'publish job not found', {})
  await ref.set({ status: 'cancelled', updated_at: FieldValue.serverTimestamp() }, { merge: true })
  await addAuditLog('publish_job.cancelled', 'publish_job', id, 'user')
  ok(res, { id, status: 'cancelled' })
})

app.get('/api/platform-accounts', async (req, res) => {
  const limit = parseLimit(req, 20)
  const offset = parseOffset(req)
  const page = await listCollection('platform_accounts', limit, offset, [])
  ok(res, page)
})

app.post('/api/platform-accounts/mock-connect', async (req, res) => {
  const body = req.body ?? {}
  const platform = typeof body.platform === 'string' ? body.platform : 'youtube'
  const account_name = typeof body.account_name === 'string' ? body.account_name : `${platform}-demo`

  const id = newId()
  await db.collection('platform_accounts').doc(id).set({
    platform,
    account_name,
    status: 'connected',
    access_token_expires_at: null,
    created_at: FieldValue.serverTimestamp(),
    updated_at: FieldValue.serverTimestamp(),
    deleted_at: null,
  })
  await addAuditLog('platform_account.connected', 'platform_account', id, 'user')
  ok(res, { id, platform, account_name, status: 'connected' })
})

app.post('/api/ai/platform-accounts/:id/set-status', async (req, res) => {
  await withIdempotency(req, res, async () => {
    const id = req.params.id
    const body = req.body ?? {}
    const status = typeof body.status === 'string' ? body.status : ''
    if (!['connected', 'disconnected'].includes(status)) throw new Error('invalid_status')

    const expiresAt =
      body.access_token_expires_at === null
        ? null
        : typeof body.access_token_expires_at === 'string' && body.access_token_expires_at.trim()
          ? body.access_token_expires_at.trim()
          : null

    const ref = db.collection('platform_accounts').doc(id)
    const snap = await ref.get()
    if (!snap.exists) throw new Error('platform_account_not_found')

    await ref.set(
      {
        status,
        access_token_expires_at: expiresAt,
        updated_at: FieldValue.serverTimestamp(),
      },
      { merge: true }
    )
    await addAuditLog(`platform_account.status_set.${status}`, 'platform_account', id, 'ai')
    return { data: { id, status, access_token_expires_at: expiresAt }, meta: {} }
  }).catch((e) => {
    if (e instanceof Error && e.message === 'platform_account_not_found') return fail(res, 404, 'NOT_FOUND', 'platform account not found', {})
    return fail(res, 400, 'VALIDATION_ERROR', 'invalid input', {})
  })
})

async function runPlatformAccountSweep(body = {}, actorType = 'system') {
  const limit = Math.min(Math.max(Number(body.limit ?? 50) || 50, 1), 200)
  const warningWindowMinutes = Math.min(Math.max(Number(body.warning_window_minutes ?? 60) || 60, 5), 60 * 24 * 7)
  const now = Date.now()
  const warningBefore = now + warningWindowMinutes * 60 * 1000

  const snap = await db.collection('platform_accounts').limit(500).get()
  const accounts = snap.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter((item) => !item.deleted_at)

  const expired = []
  const expiringSoon = []

  for (const account of accounts) {
    const rawExpiresAt = account.access_token_expires_at
    if (!isNonEmptyString(rawExpiresAt)) continue
    const ts = Date.parse(rawExpiresAt)
    if (Number.isNaN(ts)) continue

    if (ts <= now) {
      if (account.status !== 'disconnected') {
        await db.collection('platform_accounts').doc(account.id).set(
          {
            status: 'disconnected',
            updated_at: FieldValue.serverTimestamp(),
          },
          { merge: true }
        )
        await addAuditLog('platform_account.auto_disconnected_expired', 'platform_account', account.id, actorType)
      }
      expired.push({
        id: account.id,
        platform: account.platform ?? null,
        account_name: account.account_name ?? null,
        status: 'disconnected',
        access_token_expires_at: rawExpiresAt,
      })
      continue
    }

    if (ts <= warningBefore) {
      expiringSoon.push({
        id: account.id,
        platform: account.platform ?? null,
        account_name: account.account_name ?? null,
        status: account.status ?? null,
        access_token_expires_at: rawExpiresAt,
        expires_in_minutes: Math.max(0, Math.round((ts - now) / 60000)),
      })
    }
  }

  return {
    warning_window_minutes: warningWindowMinutes,
    expired_count: expired.length,
    expiring_soon_count: expiringSoon.length,
    expired: expired.slice(0, limit),
    expiring_soon: expiringSoon.sort((a, b) => Date.parse(a.access_token_expires_at ?? '') - Date.parse(b.access_token_expires_at ?? '')).slice(0, limit),
  }
}

function summarizeJobMetrics(items) {
  const byStatus = {}
  const byErrorCode = {}

  for (const item of items) {
    const status = typeof item.status === 'string' && item.status ? item.status : 'unknown'
    byStatus[status] = (byStatus[status] ?? 0) + 1
    const errorCode = typeof item.execution?.last_error_code === 'string' && item.execution.last_error_code ? item.execution.last_error_code : null
    if (errorCode) byErrorCode[errorCode] = (byErrorCode[errorCode] ?? 0) + 1
  }

  return { total: items.length, by_status: byStatus, by_error_code: byErrorCode }
}

async function runRetrySweep(body = {}, actorType = 'system') {
  const jobType = typeof body.job_type === 'string' ? body.job_type : 'all'
  const limit = Math.min(Math.max(Number(body.limit ?? 20) || 20, 1), 100)
  const onlyDue = parseBooleanLike(body.only_due, true)
  const provider = typeof body.provider === 'string' ? body.provider.trim() : ''
  const platform = typeof body.platform === 'string' ? body.platform.trim() : ''
  const now = Date.now()

  const candidates = []
  if (jobType === 'all' || jobType === 'render') {
    const snap = await db.collection('render_jobs').where('status', '==', 'failed').limit(200).get()
    candidates.push(...snap.docs.map((doc) => mapFailedJobSummary('render', { id: doc.id, ...doc.data() })))
  }
  if (jobType === 'all' || jobType === 'publish') {
    const snap = await db.collection('publish_jobs').where('status', '==', 'failed').limit(200).get()
    candidates.push(...snap.docs.map((doc) => mapFailedJobSummary('publish', { id: doc.id, ...doc.data() })))
  }

  let selected = candidates
    .filter((item) => !isDeadLettered(item))
    .filter((item) => !isExecutionLocked(item, now))
  if (onlyDue) selected = selected.filter((item) => isRetryDue(item.next_retry_at, now))
  if (provider) selected = selected.filter((item) => item.provider === provider)
  if (platform) selected = selected.filter((item) => item.platform === platform)
  selected = selected.sort(sortByUpdatedDesc).slice(0, limit)

  const results = []
  for (const item of selected) {
    try {
      const executionBody = item.job_type === 'render' ? body.render ?? body : body.publish ?? body
      if (item.job_type === 'render') {
        await db
          .collection('render_jobs')
          .doc(item.id)
          .set({ retry_count: FieldValue.increment(1), error_message: null, updated_at: FieldValue.serverTimestamp() }, { merge: true })
        const result = await executeRenderJobById(item.id, executionBody, actorType)
        results.push({ job_type: 'render', id: item.id, ok: result.status !== 'failed', result })
      } else {
        await db
          .collection('publish_jobs')
          .doc(item.id)
          .set({ retry_count: FieldValue.increment(1), error_message: null, updated_at: FieldValue.serverTimestamp() }, { merge: true })
        const result = await executePublishJobById(item.id, executionBody, actorType)
        results.push({ job_type: 'publish', id: item.id, ok: result.status !== 'failed', result })
      }
    } catch (error) {
      results.push({
        job_type: item.job_type,
        id: item.id,
        ok: false,
        error_message: error instanceof Error ? error.message : 'retry sweep failed',
      })
    }
  }

  return {
    requested_limit: limit,
    processed_count: results.length,
    success_count: results.filter((x) => x.ok).length,
    failed_count: results.filter((x) => !x.ok).length,
    items: results,
  }
}

app.post('/api/ai/run-retry-sweep', async (req, res) => {
  await withIdempotency(req, res, async () => {
    const result = await runRetrySweep(req.body ?? {}, 'ai')
    return { data: result, meta: {} }
  }).catch(() => fail(res, 400, 'VALIDATION_ERROR', 'invalid input', {}))
})

app.post('/api/ai/run-platform-account-sweep', async (req, res) => {
  await withIdempotency(req, res, async () => {
    const result = await runPlatformAccountSweep(req.body ?? {}, 'ai')
    return { data: result, meta: {} }
  }).catch(() => fail(res, 400, 'VALIDATION_ERROR', 'invalid input', {}))
})

app.get('/api/ai/ops-metrics', async (req, res) => {
  const limit = Math.min(parseLimit(req, 200), 500)
  const warningWindowMinutes = Math.min(Math.max(Number(req.query.warning_window_minutes ?? 60) || 60, 5), 60 * 24 * 7)

  const [renderSnap, publishSnap, accountSweep] = await Promise.all([
    db.collection('render_jobs').limit(limit).get(),
    db.collection('publish_jobs').limit(limit).get(),
    runPlatformAccountSweep({ limit, warning_window_minutes: warningWindowMinutes }, 'system'),
  ])

  const renderItems = renderSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() })).filter((item) => !item.deleted_at)
  const publishItems = publishSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() })).filter((item) => !item.deleted_at)
  const deadLetters = [...renderItems, ...publishItems].filter((item) => isDeadLettered(item))

  ok(res, {
    render_jobs: summarizeJobMetrics(renderItems),
    publish_jobs: summarizeJobMetrics(publishItems),
    dead_letter_jobs: {
      total: deadLetters.length,
      render: deadLetters.filter((item) => item.script_id).length,
      publish: deadLetters.filter((item) => item.render_job_id && !item.script_id).length,
    },
    platform_accounts: {
      expired_count: accountSweep.expired_count,
      expiring_soon_count: accountSweep.expiring_soon_count,
      warning_window_minutes: accountSweep.warning_window_minutes,
    },
  })
})

app.get('/api/audit-logs', async (req, res) => {
  const limit = parseLimit(req, 20)
  const offset = parseOffset(req)
  const target_type = typeof req.query.target_type === 'string' ? req.query.target_type.trim() : ''
  const target_id = typeof req.query.target_id === 'string' ? req.query.target_id.trim() : ''
  const action = typeof req.query.action === 'string' ? req.query.action.trim() : ''

  if (!target_type && !target_id && !action) {
    const page = await listCollection('audit_logs', limit, offset, [])
    return ok(res, page)
  }

  const fetchSize = Math.min(Math.max(offset + limit * 5, 100), 300)
  const snap = await db.collection('audit_logs').orderBy('created_at', 'desc').limit(fetchSize).get()

  const filtered = snap.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter((item) => {
      if (target_type && item.target_type !== target_type) return false
      if (target_id && item.target_id !== target_id) return false
      if (action && item.action !== action) return false
      return true
    })

  ok(res, {
    items: filtered.slice(offset, offset + limit),
    total: filtered.length,
    limit,
    offset,
  })
})

app.get('/api/blog-posts', async (req, res) => {
  const adminUser = await getOptionalAdminUser(req)
  const limit = Math.min(parseLimit(req, 20), 100)
  const offset = parseOffset(req)
  const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : ''
  const requestedStatus = typeof req.query.status === 'string' ? req.query.status.trim() : ''
  const status = adminUser ? requestedStatus : 'published'
  const category = typeof req.query.category === 'string' ? req.query.category.trim() : ''

  const fetchSize = Math.min(Math.max(offset + limit * 5, 100), 300)
  const snap = await db.collection('blog_posts').orderBy('created_at', 'desc').limit(fetchSize).get()

  const filtered = snap.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter((item) => {
      if (item.deleted_at) return false
      if (q) {
        const title = typeof item.title === 'string' ? item.title.toLowerCase() : ''
        const content = typeof item.content === 'string' ? item.content.toLowerCase() : ''
        if (!title.includes(q) && !content.includes(q)) return false
      }
      if (status && item.status !== status) return false
      if (category && item.category !== category) return false
      return true
    })

  ok(res, {
    items: filtered.slice(offset, offset + limit),
    total: filtered.length,
    limit,
    offset,
  })
})

app.get('/api/blog-posts/slug/:slug', async (req, res) => {
  const adminUser = await getOptionalAdminUser(req)
  const slug = typeof req.params.slug === 'string' ? req.params.slug.trim() : ''
  if (!slug) return fail(res, 404, 'NOT_FOUND', 'blog post not found', {})
  const snap = await db.collection('blog_posts').where('slug', '==', slug).limit(1).get()
  if (snap.empty) return fail(res, 404, 'NOT_FOUND', 'blog post not found', {})
  const doc = snap.docs[0]
  const post = { id: doc.id, ...doc.data() }
  if (post.deleted_at) return fail(res, 404, 'NOT_FOUND', 'blog post not found', {})
  if (!adminUser && post.status !== 'published') return fail(res, 404, 'NOT_FOUND', 'blog post not found', {})
  ok(res, post)
})

app.get('/api/blog-posts/:id', async (req, res) => {
  const adminUser = await getOptionalAdminUser(req)
  const snap = await db.collection('blog_posts').doc(req.params.id).get()
  if (!snap.exists) return fail(res, 404, 'NOT_FOUND', 'blog post not found', {})
  const post = { id: snap.id, ...snap.data() }
  if (post.deleted_at) return fail(res, 404, 'NOT_FOUND', 'blog post not found', {})
  if (!adminUser && post.status !== 'published') return fail(res, 404, 'NOT_FOUND', 'blog post not found', {})
  ok(res, post)
})

app.post('/api/blog-posts', async (req, res) => {
  await withIdempotency(req, res, async () => {
    const body = req.body ?? {}
    const title = typeof body.title === 'string' ? body.title.trim() : ''
    if (!title) throw new Error('missing_title')

    const id = newId()
    const now = nowIso()
    const status = typeof body.status === 'string' ? body.status : 'draft'

    let htmlContent = typeof body.content === 'string' ? body.content : ''
    let aiTrace = null
    if (!htmlContent && body.ai_generate !== false) {
      const aiConfig = await resolveAiConfig(body)
      aiTrace = aiTraceFromConfig(aiConfig)
      const aiResult = await generateBlogPostWithAi(aiConfig, {
        title,
        topic: body.topic ?? title,
        category: body.category ?? 'marketing',
        tone: body.tone ?? 'professional',
        keywords: Array.isArray(body.keywords) ? body.keywords : [],
        source_text: body.source_text ?? '',
        language: body.language ?? 'ko',
        target_length: body.target_length ?? 'medium',
      }).catch(() => null)
      if (typeof aiResult?.html === 'string') htmlContent = aiResult.html
    }

    const slug = await ensureUniqueBlogSlug(
      typeof body.slug === 'string' && body.slug.trim() ? body.slug : title
    )

    const post = {
      title,
      content: htmlContent,
      excerpt: typeof body.excerpt === 'string' ? body.excerpt : '',
      category: typeof body.category === 'string' ? body.category : 'general',
      tags: Array.isArray(body.tags) ? body.tags : [],
      slug,
      featured_image: typeof body.featured_image === 'string' ? body.featured_image : null,
      status,
      language: typeof body.language === 'string' ? body.language : 'ko',
      tone: typeof body.tone === 'string' ? body.tone : 'professional',
      seo_title: typeof body.seo_title === 'string' ? body.seo_title : title,
      seo_description: typeof body.seo_description === 'string' ? body.seo_description : '',
      content_schema: body.content_schema && typeof body.content_schema === 'object' ? body.content_schema : null,
      published_at: status === 'published' ? now : null,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    }

    if (!post.excerpt && typeof htmlContent === 'string') {
      post.excerpt = htmlContent.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180)
    }

    await db.collection('blog_posts').doc(id).set(post)
    await addAuditLog(
      'blog_post.created',
      'blog_post',
      id,
      body.ai_generate !== false ? 'ai' : 'user',
      aiTrace ? { ai_trace: aiTrace } : null
    )
    return { data: { id, ...post }, meta: aiTrace ? { ai_trace: aiTrace } : {} }
  }).catch((error) => {
    if (error instanceof Error && error.message === 'missing_title') {
      return fail(res, 400, 'VALIDATION_ERROR', 'title is required', {})
    }
    return fail(res, 400, 'BLOG_POST_CREATE_FAILED', error instanceof Error ? error.message : 'blog post create failed', {})
  })
})

app.patch('/api/blog-posts/:id', async (req, res) => {
  const ref = db.collection('blog_posts').doc(req.params.id)
  const snap = await ref.get()
  if (!snap.exists) return fail(res, 404, 'NOT_FOUND', 'blog post not found', {})

  const post = snap.data() ?? {}
  if (post.deleted_at) return fail(res, 404, 'NOT_FOUND', 'blog post not found', {})

  const body = req.body ?? {}
  const updatable = [
    'title',
    'content',
    'excerpt',
    'category',
    'subcategory',
    'tags',
    'slug',
    'featured_image',
    'status',
    'language',
    'tone',
    'seo_title',
    'seo_description',
    'content_schema',
  ]
  const patch = {}

  for (const key of updatable) {
    if (key in body) patch[key] = body[key]
  }
  if ('slug' in body) {
    patch.slug = await ensureUniqueBlogSlug(body.slug, req.params.id)
  }
  if (body.status === 'published' && !post.published_at) patch.published_at = nowIso()
  patch.updated_at = nowIso()

  await ref.set(patch, { merge: true })
  await addAuditLog('blog_post.updated', 'blog_post', req.params.id, 'user')
  const updatedSnap = await ref.get()
  ok(res, { id: updatedSnap.id, ...updatedSnap.data() })
})

app.delete('/api/blog-posts/:id', async (req, res) => {
  const ref = db.collection('blog_posts').doc(req.params.id)
  const snap = await ref.get()
  if (!snap.exists) return fail(res, 404, 'NOT_FOUND', 'blog post not found', {})

  const post = snap.data() ?? {}
  if (post.deleted_at) return fail(res, 404, 'NOT_FOUND', 'blog post not found', {})

  await ref.set(
    {
      deleted_at: nowIso(),
      status: 'archived',
      updated_at: nowIso(),
    },
    { merge: true }
  )
  await addAuditLog('blog_post.deleted', 'blog_post', req.params.id, 'user')
  ok(res, { id: req.params.id, deleted: true })
})

app.post('/api/blog-posts/:id/publish', async (req, res) => {
  const ref = db.collection('blog_posts').doc(req.params.id)
  const snap = await ref.get()
  if (!snap.exists) return fail(res, 404, 'NOT_FOUND', 'blog post not found', {})

  const post = snap.data() ?? {}
  if (post.deleted_at) return fail(res, 404, 'NOT_FOUND', 'blog post not found', {})
  if (!post.content) return fail(res, 400, 'NO_CONTENT', 'Cannot publish without content', {})

  await ref.set(
    {
      status: 'published',
      published_at: nowIso(),
      updated_at: nowIso(),
    },
    { merge: true }
  )
  await addAuditLog('blog_post.published', 'blog_post', req.params.id, 'user')
  const updatedSnap = await ref.get()
  const updatedPost = { id: updatedSnap.id, ...updatedSnap.data() }
  pingIndexNow(blogPostAbsoluteUrl(updatedPost, spaBaseUrl(req)), spaBaseUrl(req))
  ok(res, updatedPost)
})

app.post('/api/blog-posts/:id/external-publish-result', async (req, res) => {
  const ref = db.collection('blog_posts').doc(req.params.id)
  const snap = await ref.get()

  const body = req.body ?? {}
  const platform = body.platform === 'tistory' ? 'tistory' : body.platform === 'naver' ? 'naver' : null
  if (!platform) return fail(res, 400, 'INVALID_PLATFORM', 'platform must be naver or tistory', {})

  const result = {
    status: body.status === 'success' ? 'success' : 'failed',
    platform,
    url: body.url ?? null,
    title: body.title ?? null,
    original_title: body.original_title ?? null,
    rewritten: body.rewritten === true,
    quality: body.quality && typeof body.quality === 'object' ? body.quality : null,
    published_at: body.published_at ?? nowIso(),
    error: body.error ?? null,
    updated_at: nowIso(),
  }

  if (!snap.exists) {
    const externalRef = db.collection('external_publish_results').doc(`${platform}:${req.params.id}`)
    const externalResult = {
      ...result,
      source_id: req.params.id,
      created_at: nowIso(),
    }
    await externalRef.set(externalResult, { merge: true })
    await addAuditLog(
      `external_publish.${result.status}`,
      'external_publish_result',
      externalRef.id,
      'worker',
      { platform, source_id: req.params.id, url: result.url, error: result.error }
    )
    return ok(res, externalResult)
  }

  await ref.set(
    {
      external_publish: { [platform]: result },
      updated_at: nowIso(),
    },
    { merge: true }
  )

  await addAuditLog(
    `blog_post.external_publish.${result.status}`,
    'blog_post',
    req.params.id,
    'worker',
    { platform, url: result.url, error: result.error }
  )
  ok(res, result)
})

app.post('/api/blog-posts/:id/generate-content', async (req, res) => {
  await withIdempotency(req, res, async () => {
    const ref = db.collection('blog_posts').doc(req.params.id)
    const snap = await ref.get()
    if (!snap.exists) throw new Error('blog_post_not_found')

    const post = snap.data() ?? {}
    if (post.deleted_at) throw new Error('blog_post_not_found')

    const body = req.body ?? {}
    const aiConfig = await resolveAiConfig(body)
    const aiTrace = aiTraceFromConfig(aiConfig)
    const aiResult = await generateBlogPostWithAi(aiConfig, {
      title: post.title,
      topic: body.topic ?? post.title,
      category: body.category ?? post.category ?? 'marketing',
      tone: body.tone ?? post.tone ?? 'professional',
      keywords: body.keywords ?? post.tags ?? [],
      source_text: body.source_text ?? '',
      language: body.language ?? post.language ?? 'ko',
      target_length: body.target_length ?? 'medium',
    }).catch(() => null)

    if (!aiResult?.html) throw new Error('ai_generation_failed')

    const patch = {
      content: aiResult.html,
      excerpt: aiResult.excerpt ?? post.excerpt ?? '',
      seo_title: aiResult.seo_title ?? post.seo_title ?? post.title ?? '',
      seo_description: aiResult.seo_description ?? post.seo_description ?? '',
      updated_at: nowIso(),
    }
    if (Array.isArray(aiResult.tags) && aiResult.tags.length) patch.tags = aiResult.tags

    await ref.set(patch, { merge: true })
    await addAuditLog('blog_post.ai_generated', 'blog_post', req.params.id, 'ai', { ai_trace: aiTrace })
    const updatedSnap = await ref.get()
    return { data: { id: updatedSnap.id, ...updatedSnap.data() }, meta: { ai_trace: aiTrace } }
  }).catch((error) => {
    if (error instanceof Error && error.message === 'blog_post_not_found') {
      return fail(res, 404, 'NOT_FOUND', 'blog post not found', {})
    }
    if (error instanceof Error && error.message === 'ai_generation_failed') {
      return fail(res, 400, 'AI_GENERATION_FAILED', 'blog post AI generation failed', {})
    }
    return fail(res, 400, 'BLOG_POST_GENERATE_FAILED', error instanceof Error ? error.message : 'blog post generate failed', {})
  })
})

app.get('/api/blog-schedule', async (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 20) || 20, 100)
  const offset = Number(req.query.offset ?? 0) || 0
  const status = typeof req.query.status === 'string' ? req.query.status : ''

  let query = db.collection('blog_schedule').where('deleted_at', '==', null)
  if (status) query = query.where('status', '==', status)
  query = query.orderBy('created_at', 'desc').offset(offset).limit(limit)

  const snap = await query.get()
  const items = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }))
  ok(res, { items, limit, offset })
})

app.post('/api/blog-schedule', async (req, res) => {
  await withIdempotency(req, res, async () => {
    const body = req.body ?? {}
    const title = typeof body.title === 'string' ? body.title.trim() : ''
    if (!title) throw new Error('missing_title')

    const id = newId()
    const now = nowIso()
    await db.collection('blog_schedule').doc(id).set({
      title,
      topic: body.topic ?? title,
      category: body.category ?? 'marketing',
      tone: body.tone ?? 'professional',
      keywords: Array.isArray(body.keywords) ? body.keywords : [],
      source_text: body.source_text ?? '',
      target_length: body.target_length ?? 'medium',
      language: body.language ?? 'ko',
      auto_publish: body.auto_publish !== false,
      featured_image: body.featured_image ?? null,
      status: 'pending',
      post_id: null,
      slug: null,
      published_at: null,
      error_message: null,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    })
    await addAuditLog('blog_schedule.created', 'blog_schedule', id)
    return { data: { id, status: 'pending' }, meta: {} }
  }).catch((error) => {
    if (error instanceof Error && error.message === 'missing_title') {
      return fail(res, 400, 'VALIDATION_ERROR', 'title is required', {})
    }
    return fail(res, 400, 'BLOG_SCHEDULE_CREATE_FAILED', error instanceof Error ? error.message : 'blog schedule create failed', {})
  })
})

app.patch('/api/blog-schedule/:id', async (req, res) => {
  const ref = db.collection('blog_schedule').doc(req.params.id)
  const snap = await ref.get()
  if (!snap.exists) return fail(res, 404, 'NOT_FOUND', 'blog schedule item not found', {})
  const item = snap.data() ?? {}
  if (item.deleted_at) return fail(res, 404, 'NOT_FOUND', 'blog schedule item not found', {})

  const body = req.body ?? {}
  const patch = { updated_at: nowIso() }
  const updatable = ['title', 'topic', 'category', 'tone', 'keywords', 'source_text', 'target_length', 'language', 'auto_publish', 'featured_image', 'status']
  for (const key of updatable) {
    if (key in body) patch[key] = body[key]
  }
  await ref.set(patch, { merge: true })
  await addAuditLog('blog_schedule.updated', 'blog_schedule', req.params.id)
  const updatedSnap = await ref.get()
  ok(res, { id: updatedSnap.id, ...updatedSnap.data() })
})

app.delete('/api/blog-schedule/:id', async (req, res) => {
  const ref = db.collection('blog_schedule').doc(req.params.id)
  const snap = await ref.get()
  if (!snap.exists) return fail(res, 404, 'NOT_FOUND', 'blog schedule item not found', {})
  const item = snap.data() ?? {}
  if (item.deleted_at) return fail(res, 404, 'NOT_FOUND', 'blog schedule item not found', {})

  await ref.set({ deleted_at: nowIso(), updated_at: nowIso() }, { merge: true })
  await addAuditLog('blog_schedule.deleted', 'blog_schedule', req.params.id)
  ok(res, { id: req.params.id, deleted: true })
})

// ─── 키워드 리서치 (네이버 검색광고 API + 자동완성) ──────────────────────────
app.post('/api/ai/keyword-research', async (req, res) => {
  try {
    const body = req.body ?? {}
    const seeds = Array.isArray(body.keywords) ? body.keywords : (body.keyword ? [body.keyword] : [])
    const result = await researchKeywords(seeds)
    ok(res, result)
  } catch (error) {
    if (error instanceof KeywordResearchError) {
      return fail(res, error.code === 'MISSING_KEYWORDS' ? 400 : 502, error.code, error.message, error.details ?? {})
    }
    return fail(res, 500, 'KEYWORD_RESEARCH_ERROR', error instanceof Error ? error.message : 'keyword research failed', {})
  }
})

app.post('/api/ai/execute-blog-pipeline', async (req, res) => {
  await withIdempotency(req, res, async () => {
    const body = req.body ?? {}

    const result = await executeBlogPipeline(
      {
        generateAiText,
        maybeParseJson,
        resolveAiConfig,
        newId,
        nowIso,
        ensureUniqueBlogSlug,
        addAuditLog,
        createPost: async (post) => {
          await db.collection('blog_posts').doc(post.id).set(post)
        },
        listPublishedPosts: listPublishedPostsForLinks,
      },
      {
        title: body.title,
        topic: body.topic,
        category: body.category ?? 'marketing',
        tone: body.tone ?? 'professional',
        keywords: Array.isArray(body.keywords) ? body.keywords : [],
        source_text: body.source_text ?? '',
        target_length: body.target_length ?? 'medium',
        language: body.language ?? 'ko',
        auto_publish: body.auto_publish !== false,
        featured_image: body.featured_image ?? null,
        cta_text: body.cta_text ?? null,
        cta_link: body.cta_link ?? null,
        cta_button_text: body.cta_button_text ?? null,
        structure: body.structure ?? null,
        ai_provider: body.ai_provider,
        ai_api_key: body.ai_api_key,
        ai_model: body.ai_model,
        ai_endpoint: body.ai_endpoint,
      }
    )

    if (result.status === 'published' && result.slug) {
      pingIndexNow(`${SITE_BASE_URL}/blog/${encodeURIComponent(result.slug)}`)
    }

    return { data: result, meta: {} }
  }).catch((error) => {
    if (error instanceof PipelineError) {
      const statusMap = {
        MISSING_TITLE: 400,
        AI_NOT_CONFIGURED: 400,
        AI_NO_RESPONSE: 502,
        AI_INVALID_FORMAT: 502,
        AI_NO_HTML: 502,
        CONTENT_VALIDATION_FAILED: 422,
        SEO_VALIDATION_FAILED: 422,
        FINAL_VALIDATION_FAILED: 422,
      }
      return fail(res, statusMap[error.code] ?? 400, error.code, error.message, error.details ?? {})
    }
    return fail(res, 500, 'PIPELINE_ERROR', error instanceof Error ? error.message : 'blog pipeline execution failed', {})
  })
})

// ─── SSR helpers ────────────────────────────────────────────────────────────────

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function buildSsrHtml({ title, description, canonicalUrl, ogType, ogImage, jsonLd, bodyHtml, publishedTime, modifiedTime }) {
  const template = ssrTemplate || '<!doctype html><html lang="ko"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/><title></title></head><body><div id="root"></div></body></html>'

  const siteName = '비오케이솔루션 · 홍커뮤니케이션 블로그'
  const safeTitle = escapeHtml(title || siteName)
  const safeDesc = escapeHtml(description || '비오케이솔루션의 개발 솔루션과 홍커뮤니케이션의 MICE·학술대회 운영 레퍼런스를 확인하세요.')
  const safeCanonical = escapeHtml(canonicalUrl || '')
  const safeOgImage = escapeHtml(ogImage || '')
  const safeOgType = escapeHtml(ogType || 'website')
  const safePublishedTime = escapeHtml(publishedTime || '')
  const safeModifiedTime = escapeHtml(modifiedTime || '')

  // Inject meta tags + JSON-LD into <head>, and content into <div id="root">
  const headInjection = [
    `<title>${safeTitle}</title>`,
    `<meta name="description" content="${safeDesc}" />`,
    `<meta name="author" content="비오케이솔루션" />`,
    `<meta name="language" content="ko-KR" />`,
    `<meta name="theme-color" content="#09090b" />`,
    `<link rel="canonical" href="${safeCanonical}" />`,
    `<link rel="sitemap" type="application/xml" href="/sitemap.xml" />`,
    `<link rel="alternate" type="application/rss+xml" title="비오케이솔루션 · 홍커뮤니케이션 블로그 RSS" href="/blog/rss.xml" />`,
    `<link rel="alternate" type="text/markdown" title="LLMs guide" href="/llms.txt" />`,
    process.env.NAVER_SITE_VERIFICATION
      ? `<meta name="naver-site-verification" content="${escapeHtml(process.env.NAVER_SITE_VERIFICATION)}" />`
      : '',
    `<meta property="og:title" content="${safeTitle}" />`,
    `<meta property="og:description" content="${safeDesc}" />`,
    `<meta property="og:type" content="${safeOgType}" />`,
    `<meta property="og:url" content="${safeCanonical}" />`,
    `<meta property="og:site_name" content="${escapeHtml(siteName)}" />`,
    safeOgImage ? `<meta property="og:image" content="${safeOgImage}" />` : '',
    safeOgImage ? `<meta name="twitter:image" content="${safeOgImage}" />` : '',
    safePublishedTime ? `<meta property="article:published_time" content="${safePublishedTime}" />` : '',
    safeModifiedTime ? `<meta property="article:modified_time" content="${safeModifiedTime}" />` : '',
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${safeTitle}" />`,
    `<meta name="twitter:description" content="${safeDesc}" />`,
    jsonLd || '',
  ].filter(Boolean).join('\n')

  const criticalCss = `<style>
html{background:#09090b;color:#fff}
body{margin:0;background:#09090b;color:#fff;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
*{box-sizing:border-box}
a{color:inherit}
img{max-width:100%;height:auto}
</style>`

  // Public SSR pages are complete HTML. Strip SPA assets to avoid unused JS/CSS on crawlable pages.
  let html = template
    .replace(/<title>[\s\S]*?<\/title>/i, '')
    .replace(/\s*<script\b[^>]*type="module"[^>]*><\/script>/gi, '')
    .replace(/\s*<script\b[^>]*src="\/assets\/[^"]+"[^>]*><\/script>/gi, '')
    .replace(/\s*<link\b[^>]*href="\/assets\/[^"]+\.css"[^>]*>/gi, '')
    .replace('</head>', `${criticalCss}\n${headInjection}\n</head>`)

  // Inject content into <div id="root">
  if (bodyHtml) {
    html = html.replace('<div id="root"></div>', `<div id="root">${bodyHtml}</div>`)
  }

  return html
}

function stripHtml(value) {
  return String(value ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function organizationSameAs() {
  const defaults = ['https://hongcomm.kr', 'https://beoksolution.com']
  const extra = String(process.env.ORG_SAME_AS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  return [...new Set([...defaults, ...extra])]
}

function organizationJsonLd(baseUrl) {
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: '비오케이솔루션',
    url: baseUrl,
    sameAs: organizationSameAs(),
    knowsAbout: [
      'MICE',
      '행사기획',
      '국제회의',
      '학술대회 등록 시스템',
      '동시통역',
      'AI 동시통역',
      '행사 IT 솔루션',
      '홈페이지 제작',
      '맞춤형 소프트웨어 개발',
    ],
  })
}

function webSiteJsonLd(baseUrl) {
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: '비오케이솔루션 · 홍커뮤니케이션 블로그',
    url: baseUrl,
    inLanguage: 'ko-KR',
    publisher: {
      '@type': 'Organization',
      name: '비오케이솔루션',
      url: baseUrl,
    },
  })
}


function renderBeoksolutionLandingSchema(schema = {}) {
  const hero = schema.hero || {}
  const preview = schema.preview || {}
  const benefits = Array.isArray(schema.benefits) ? schema.benefits : []
  const comparison = Array.isArray(schema.comparison) ? schema.comparison : []
  const process = Array.isArray(schema.process) ? schema.process : []
  const faqs = Array.isArray(schema.faq) ? schema.faq : []
  const finalCta = schema.final_cta || {}

  const benefitHtml = benefits.map((item, i) => `
    <div style="padding:22px;border-radius:22px;background:rgba(255,255,255,.055);border:1px solid rgba(255,255,255,.1);">
      <b style="display:block;color:${i === 0 ? '#6ee7b7' : i === 1 ? '#93c5fd' : '#c4b5fd'};font-size:14px;margin-bottom:8px;">${String(i + 1).padStart(2, '0')} ${escapeHtml(item.title || '')}</b>
      <p style="margin:0;color:#cbd5e1;line-height:1.75;">${escapeHtml(item.description || '')}</p>
    </div>`).join('')

  const comparisonHtml = comparison.map((row) => `
    <div style="display:grid;grid-template-columns:.8fr 1fr 1fr;gap:12px;align-items:center;padding:15px;border-radius:18px;background:rgba(255,255,255,.045);">
      <b style="color:#94a3b8;">${escapeHtml(row.item || '')}</b>
      <span style="color:#94a3b8;">${escapeHtml(row.old || '')}</span>
      <strong style="color:#6ee7b7;">${escapeHtml(row.new || '')}</strong>
    </div>`).join('')

  const processHtml = process.map((step, i) => `
    <div style="padding:18px;border-radius:20px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);color:#d1d5db;">
      <b style="color:#fff;">${i + 1}. ${escapeHtml(step.title || '')}</b><br>${escapeHtml(step.description || '')}
    </div>`).join('')

  const faqHtml = faqs.length ? `
    <section style="margin:46px 0;">
      <h2 style="margin:0 0 18px;color:#fff;font-size:30px;line-height:1.2;letter-spacing:-.04em;font-weight:1000;">자주 묻는 질문</h2>
      <div style="display:grid;gap:12px;">${faqs.map((f) => `
        <div style="padding:20px;border-radius:20px;background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.1);">
          <b style="display:block;color:#fff;margin-bottom:8px;">${escapeHtml(f.q || '')}</b>
          <p style="margin:0;color:#cbd5e1;line-height:1.75;">${escapeHtml(f.a || '')}</p>
        </div>`).join('')}</div>
    </section>` : ''

  return `
<section style="margin:36px 0;display:grid;grid-template-columns:1.05fr .95fr;gap:18px;align-items:stretch;">
  <div style="padding:28px;border-radius:28px;background:linear-gradient(135deg,rgba(15,23,42,.92),rgba(30,64,175,.28));border:1px solid rgba(148,163,184,.18);">
    <p style="margin:0 0 12px;color:#a7f3d0;font-size:12px;font-weight:1000;letter-spacing:.18em;">${escapeHtml(preview.eyebrow || 'SERVICE PREVIEW')}</p>
    <h2 style="margin:0;color:#fff;font-size:32px;line-height:1.18;letter-spacing:-.045em;font-weight:1000;">${escapeHtml(preview.title || hero.title || '')}</h2>
    <p style="margin:16px 0 0;color:#cbd5e1;line-height:1.85;font-size:16px;">${escapeHtml(preview.description || hero.subtitle || '')}</p>
  </div>
  <div style="padding:18px;border-radius:28px;background:#030712;border:1px solid rgba(255,255,255,.12);box-shadow:0 24px 80px rgba(0,0,0,.38);">
    <div style="display:flex;gap:7px;margin-bottom:14px;"><span style="width:10px;height:10px;border-radius:50%;background:#ef4444;"></span><span style="width:10px;height:10px;border-radius:50%;background:#f59e0b;"></span><span style="width:10px;height:10px;border-radius:50%;background:#10b981;"></span></div>
    <div style="border-radius:22px;background:linear-gradient(135deg,#111827,#0f172a);padding:18px;border:1px solid rgba(255,255,255,.08);">
      <div style="height:11px;width:45%;border-radius:99px;background:#e5e7eb;margin-bottom:18px;"></div>
      <div style="height:46px;border-radius:16px;background:linear-gradient(90deg,#60a5fa,#34d399);margin-bottom:12px;"></div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:9px;margin-bottom:14px;"><div style="height:54px;border-radius:14px;background:rgba(255,255,255,.08);"></div><div style="height:54px;border-radius:14px;background:rgba(255,255,255,.08);"></div><div style="height:54px;border-radius:14px;background:rgba(255,255,255,.08);"></div></div>
      <div style="height:11px;width:90%;border-radius:99px;background:rgba(255,255,255,.20);margin-bottom:8px;"></div><div style="height:11px;width:68%;border-radius:99px;background:rgba(255,255,255,.16);"></div>
    </div>
  </div>
</section>

<section style="margin:46px 0;"><h2 style="margin:0 0 18px;color:#fff;font-size:30px;line-height:1.2;letter-spacing:-.04em;font-weight:1000;">${escapeHtml(schema.benefits_title || '비오케이솔루션 운영 기준')}</h2><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;">${benefitHtml}</div></section>
<section style="margin:46px 0;padding:28px;border-radius:28px;background:rgba(2,6,23,.8);border:1px solid rgba(255,255,255,.1);"><h2 style="margin:0 0 20px;color:#fff;font-size:30px;line-height:1.2;letter-spacing:-.04em;font-weight:1000;">${escapeHtml(schema.comparison_title || '일반 외주와 무엇이 다른가요?')}</h2><div style="display:grid;gap:10px;">${comparisonHtml}</div></section>
<section style="margin:46px 0;"><h2 style="margin:0 0 18px;color:#fff;font-size:30px;line-height:1.2;letter-spacing:-.04em;font-weight:1000;">${escapeHtml(schema.process_title || '진행 방식')}</h2><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;">${processHtml}</div></section>
${faqHtml}
<section style="margin:52px 0 0;padding:32px;border-radius:30px;background:linear-gradient(135deg,rgba(59,130,246,.28),rgba(16,185,129,.14));border:1px solid rgba(147,197,253,.26);">
  <p style="margin:0 0 10px;color:#bfdbfe;font-size:12px;font-weight:1000;letter-spacing:.2em;">${escapeHtml(finalCta.eyebrow || 'START WITH BOK SOLUTION')}</p>
  <h2 style="margin:0;color:#fff;font-size:34px;line-height:1.16;letter-spacing:-.045em;font-weight:1000;">${escapeHtml(finalCta.title || '구독형으로 시작하세요.')}</h2>
  <p style="margin:16px 0 0;color:#dbeafe;line-height:1.8;">${escapeHtml(finalCta.description || '')}</p>
  <a href="${escapeHtml(finalCta.href || 'https://beoksolution.com')}" target="_blank" rel="noopener" style="margin-top:22px;display:inline-flex;padding:14px 20px;border-radius:16px;background:#fff;color:#020617;text-decoration:none;font-weight:1000;">${escapeHtml(finalCta.label || '무료 상담 신청하기')}</a>
</section>
<style>@media (max-width: 760px) { section[style*="grid-template-columns:1.05fr"] { grid-template-columns:1fr !important; } div[style*="grid-template-columns:.8fr"] { grid-template-columns:1fr !important; } }</style>`
}

function formatKoreanDate(value) {
  if (!value) return ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return String(value).slice(0, 10).replace(/-/g, '.')
  return d.toLocaleDateString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\. /g, '.').replace(/\.$/, '')
}

function normalizeRenderedBlogContent(html = '') {
  return String(html || '')
    .replace(/<article\b[^>]*>\s*<header\b[\s\S]*?<\/header>/i, '')
    .replace(/<\/article>\s*$/i, '')
    .replace(/<h1\b([^>]*)>/gi, '<h2$1>')
    .replace(/<\/h1>/gi, '</h2>')
    .trim()
}

function blogHeadingId(text = '', index = 0) {
  const normalized = stripHtml(text)
    .replace(/[^\w가-힣\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 46)
  return normalized ? `section-${normalized}-${index}` : `section-${index}`
}

function enhanceBlogContentForReading(html = '') {
  const toc = []
  let index = 0
  const body = String(html || '').replace(/<h([23])\b([^>]*)>([\s\S]*?)<\/h\1>/gi, (match, levelRaw, attrs, inner) => {
    const text = stripHtml(inner)
    if (!text) return match
    index += 1
    const existingId = String(attrs || '').match(/\sid=["']([^"']+)["']/i)?.[1]
    const id = existingId || blogHeadingId(text, index)
    toc.push({ id, text, level: Number(levelRaw) })
    if (existingId) return match
    return `<h${levelRaw}${attrs} id="${escapeHtml(id)}">${inner}</h${levelRaw}>`
  })
  const plain = stripHtml(body)
  return {
    html: body,
    toc,
    chars: plain.length,
    readingMinutes: Math.max(1, Math.ceil(plain.length / 650)),
    images: (body.match(/<img\b/gi) || []).length,
    tables: (body.match(/<table\b/gi) || []).length,
  }
}

const PUBLIC_TOPIC_AXES = [
  ['학회운영', ['학회', '학술대회', '명찰', '사무국', '참가자', '접수', '등록', '출력', '발행', '재발행', 'QR', '바코드', '체크인', '초록', '심사']],
  ['홈페이지', ['홈페이지', '웹사이트', '반응형', 'SEO', '서치콘솔', '신청폼', '문의폼', '예약', '결제', 'SSL']],
  ['시스템개발', ['시스템', '개발', '관리자', '대시보드', '백오피스', '자동화', '알림톡', 'DB', '데이터', '솔루션', '연동', '셀프호스팅']],
  ['MICE', ['홍커뮤니케이션', 'MICE', '국제회의', '컨퍼런스', '행사', '동시통역', '전시회', '세미나', '레퍼런스', '포트폴리오']],
]

function publicTopicAxis(post = {}) {
  const tags = Array.isArray(post.tags) ? post.tags.join(' ') : ''
  const haystack = `${post.title ?? ''} ${post.topic ?? ''} ${post.excerpt ?? ''} ${post.seo_description ?? ''} ${tags}`
  let best = null
  let bestHits = 0
  for (const [axis, terms] of PUBLIC_TOPIC_AXES) {
    const hits = terms.filter((term) => haystack.includes(term)).length
    if (hits > bestHits) {
      best = axis
      bestHits = hits
    }
  }
  return bestHits >= 1 ? best : null
}

function publicIsConferenceBadgePost(post = {}) {
  return publicTopicAxis(post) === '학회운영'
}

function publicVisibleBlogPosts(posts = []) {
  return posts
}

function publicDisplayCategory(post = {}) {
  const axis = publicTopicAxis(post)
  if (axis) return axis
  return post.category || '운영 글'
}

const CONFERENCE_IMAGES = [
  { url: 'https://hongcomm.kr/img/page/c1.jpg', alt: '학회 현장 지류 명찰 자동 출력 시스템' },
  { url: 'https://hongcomm.kr/img/page/2.jpg', alt: '고속 명찰 자동 출력 장비 운영 현장' },
  { url: 'https://hongcomm.kr/img/page/b2.png', alt: '모바일 디지털 명찰 시스템 화면' },
  { url: 'https://hongcomm.kr/img/page/a1.png', alt: '학술대회 등록 시스템 화면' },
  { url: 'https://hongcomm.kr/img/page/6.jpg', alt: '행사 마스터 컨트롤러 통합 운영 시스템' },
]

function stableIndex(value, length) {
  if (!length) return 0
  let hash = 0
  const source = String(value || '')
  for (let i = 0; i < source.length; i += 1) {
    hash = ((hash << 5) - hash + source.charCodeAt(i)) | 0
  }
  return Math.abs(hash) % length
}

function publicFallbackImage(post = {}) {
  if (publicIsConferenceBadgePost(post)) {
    const tags = Array.isArray(post.tags) ? post.tags.join(' ') : ''
    const haystack = `${post.title ?? ''} ${post.topic ?? ''} ${post.excerpt ?? ''} ${post.seo_description ?? ''} ${tags}`
    return CONFERENCE_IMAGES[stableIndex(`${post.id ?? ''} ${haystack}`, CONFERENCE_IMAGES.length)]
  }
  return null
}

function publicDisplayImage(post = {}) {
  const featured = typeof post.featured_image === 'string' ? post.featured_image.trim() : ''
  if (featured) {
    return {
      url: featured,
      alt: post.title || '비오케이솔루션 · 홍커뮤니케이션 블로그 대표 이미지',
    }
  }
  return publicFallbackImage(post)
}

function blogPostBodyHtml(post, extras = {}) {
  const title = escapeHtml(post.title || 'Untitled')
  const excerpt = escapeHtml(post.excerpt || '')
  const schema = post.content_schema && typeof post.content_schema === 'object' ? post.content_schema : null
  const content = schema?.template === 'beoksolution_landing_v1'
    ? renderBeoksolutionLandingSchema(schema)
    : normalizeRenderedBlogContent(post.content || '')
  const date = formatKoreanDate(post.published_at || post.created_at || '')
  const category = escapeHtml(publicDisplayCategory(post))
  const tags = Array.isArray(post.tags) ? post.tags : []
  const rawRenderedContent = content.includes('<') ? content : content.split(/\n{2,}/).map((p) => `<p>${escapeHtml(p)}</p>`).join('')
  const reading = enhanceBlogContentForReading(rawRenderedContent)
  const renderedContent = reading.html
  const displayImage = publicDisplayImage(post)
  const tocHtml = reading.toc.slice(0, 12).map((item) => `
              <a href="#${escapeHtml(item.id)}" style="display:block;margin:${item.level === 3 ? '0 0 8px 12px' : '0 0 8px'};padding:6px 8px;border-radius:6px;color:#a1a1aa;text-decoration:none;font-size:12px;line-height:1.55;">${escapeHtml(item.text)}</a>`).join('')

  return `
<div style="min-height:100vh;background:#09090b;color:#fff;font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;word-break:keep-all;overflow-wrap:break-word;">
  <div style="position:fixed;inset:0;pointer-events:none;background:linear-gradient(180deg,rgba(250,204,21,.08),transparent 220px),linear-gradient(90deg,rgba(39,39,42,.45) 1px,transparent 1px),linear-gradient(180deg,rgba(39,39,42,.35) 1px,transparent 1px);background-size:auto,48px 48px,48px 48px;"></div>
  <main style="position:relative;max-width:1180px;margin:0 auto;padding:34px 20px 72px;">
    <nav style="display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:30px;padding:12px 14px;border:1px solid #27272a;background:rgba(9,9,11,.86);border-radius:8px;backdrop-filter:blur(18px);">
      <a href="/blog/" style="color:#d4d4d8;text-decoration:none;font-size:14px;font-weight:700;">← 블로그</a>
      <a href="${KAKAO_CHAT_URL}" target="_blank" rel="noopener" style="display:inline-flex;padding:10px 15px;border-radius:6px;background:#fde047;color:#09090b;text-decoration:none;font-size:14px;font-weight:800;">상담 문의</a>
    </nav>

    <div style="display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:34px;align-items:start;">
      <article style="min-width:0;">
        <section style="padding:42px;border:1px solid #27272a;background:rgba(24,24,27,.72);border-radius:8px;box-shadow:0 24px 60px rgba(0,0,0,.28);backdrop-filter:blur(18px);">
          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:18px;">
            <span style="display:inline-flex;padding:7px 12px;border-radius:6px;background:rgba(250,204,21,.12);color:#fde68a;border:1px solid rgba(250,204,21,.3);font-size:12px;font-weight:800;">${category}</span>
            ${date ? `<time style="color:#a1a1aa;font-size:13px;font-weight:700;">${escapeHtml(date)}</time>` : ''}
            <span style="display:inline-flex;padding:7px 12px;border-radius:6px;border:1px solid #3f3f46;color:#d4d4d8;font-size:12px;font-weight:700;">읽기 ${reading.readingMinutes}분</span>
            <span style="display:inline-flex;padding:7px 12px;border-radius:6px;border:1px solid #3f3f46;color:#d4d4d8;font-size:12px;font-weight:700;">소제목 ${reading.toc.length}</span>
          </div>
          <h1 style="margin:0;max-width:900px;color:#fff;font-size:clamp(38px,5vw,60px);line-height:1.08;font-weight:1000;">${title}</h1>
          ${excerpt ? `<p style="margin:24px 0 0;max-width:760px;color:#d4d4d8;font-size:19px;line-height:1.85;">${excerpt}</p>` : ''}
          <div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:30px;">
            <a href="${KAKAO_CHAT_URL}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;justify-content:center;padding:14px 20px;border-radius:6px;background:#fde047;color:#09090b;text-decoration:none;font-weight:800;font-size:14px;">상담 문의</a>
            <a href="https://beoksolution.com" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;justify-content:center;padding:14px 20px;border-radius:6px;background:#09090b;color:#fff;text-decoration:none;font-weight:800;font-size:14px;border:1px solid #3f3f46;">비오케이솔루션 보기</a>
          </div>
        </section>

        ${displayImage ? `<img src="${escapeHtml(displayImage.url)}" alt="${escapeHtml(displayImage.alt)}" loading="eager" style="display:block;width:100%;height:auto;margin:30px 0 0;border:1px solid #27272a;border-radius:8px;object-fit:cover;">` : ''}

        <div style="margin-top:34px;">${renderedContent}</div>

        ${faqSectionHtml(post.faq)}
        ${tags.length > 0 ? `<footer style="margin-top:34px;padding:22px;border:1px solid rgba(255,255,255,.1);border-radius:24px;background:rgba(255,255,255,.035);">${tags.map((t) => `<span style="display:inline-flex;margin:4px;padding:7px 11px;border-radius:999px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.09);color:#a1a1aa;font-size:12px;font-weight:800;">#${escapeHtml(t)}</span>`).join('')}</footer>` : ''}
        ${extras.relatedHtml || ''}
      </article>

      <aside style="position:sticky;top:28px;display:block;">
        <div style="display:grid;gap:16px;">
        <div style="padding:26px;border:1px solid #27272a;border-radius:8px;background:rgba(24,24,27,.82);box-shadow:0 24px 60px rgba(0,0,0,.28);backdrop-filter:blur(18px);">
          <p style="margin:0;color:#fde68a;font-size:12px;font-weight:800;letter-spacing:.18em;">ARTICLE MAP</p>
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:16px;text-align:center;">
            <div style="padding:11px 8px;border-radius:6px;background:rgba(9,9,11,.72);border:1px solid #27272a;"><b style="display:block;color:#fff;font-size:18px;">${reading.readingMinutes}</b><span style="color:#71717a;font-size:11px;">분</span></div>
            <div style="padding:11px 8px;border-radius:6px;background:rgba(9,9,11,.72);border:1px solid #27272a;"><b style="display:block;color:#fff;font-size:18px;">${reading.images}</b><span style="color:#71717a;font-size:11px;">이미지</span></div>
            <div style="padding:11px 8px;border-radius:6px;background:rgba(9,9,11,.72);border:1px solid #27272a;"><b style="display:block;color:#fff;font-size:18px;">${reading.tables}</b><span style="color:#71717a;font-size:11px;">표</span></div>
          </div>
          ${tocHtml ? `<nav style="margin-top:18px;padding-top:16px;border-top:1px solid #27272a;"><p style="margin:0 0 12px;color:#71717a;font-size:12px;font-weight:800;">본문 목차</p><div style="max-height:280px;overflow:auto;">${tocHtml}</div></nav>` : ''}
        </div>
        <div style="padding:26px;border:1px solid #27272a;border-radius:8px;background:rgba(24,24,27,.82);box-shadow:0 24px 60px rgba(0,0,0,.28);backdrop-filter:blur(18px);">
          <p style="margin:0;color:#fde68a;font-size:12px;font-weight:800;letter-spacing:.18em;">BOK SOLUTION</p>
          <h2 style="margin:12px 0 0;color:#fff;font-size:28px;line-height:1.16;font-weight:1000;">비오케이솔루션 운영 상담</h2>
          <p style="margin:13px 0 0;color:#d4d4d8;font-size:14px;line-height:1.75;">홈페이지, 관리자 시스템, 학회 접수·명찰 운영, MICE 레퍼런스를 실제 운영 흐름에 맞춰 검토합니다.</p>
          <div style="display:grid;gap:9px;margin-top:20px;color:#e5e7eb;font-size:14px;font-weight:700;">
            <div style="padding:13px;border-radius:6px;background:rgba(9,9,11,.72);border:1px solid #27272a;">홈페이지 제작과 유지관리</div>
            <div style="padding:13px;border-radius:6px;background:rgba(9,9,11,.72);border:1px solid #27272a;">맞춤형 관리자 시스템</div>
            <div style="padding:13px;border-radius:6px;background:rgba(9,9,11,.72);border:1px solid #27272a;">학회 접수와 명찰 출력</div>
            <div style="padding:13px;border-radius:6px;background:rgba(9,9,11,.72);border:1px solid #27272a;">홍커뮤니케이션 MICE 레퍼런스</div>
          </div>
          <a href="${KAKAO_CHAT_URL}" target="_blank" rel="noopener" style="margin-top:20px;display:flex;width:100%;box-sizing:border-box;justify-content:center;padding:14px 18px;border-radius:6px;background:#fde047;color:#09090b;text-decoration:none;font-size:14px;font-weight:800;">운영 상담하기</a>
        </div>
        </div>
      </aside>
    </div>
  </main>
</div>
<style>
  @media (max-width: 960px) {
    main > div[style*="grid-template-columns"] { grid-template-columns: 1fr !important; }
    aside { position: static !important; }
    article > section { padding: 28px !important; border-radius: 26px !important; }
  }
</style>`
}

function blogListBodyHtml(posts, baseUrl) {
  const visiblePosts = publicVisibleBlogPosts(posts)
  const leadImage = publicDisplayImage(visiblePosts[0] || {})
  const items = visiblePosts
    .slice(0, 12)
    .map((post) => {
      const slug = post.slug || post.id
      const title = escapeHtml(post.title || 'Untitled')
      const excerpt = escapeHtml(post.seo_description || post.excerpt || '')
      const date = post.published_at || post.created_at || ''
      const href = `${baseUrl}/blog/${encodeURIComponent(slug)}`
      const sub = `<span style="display:inline-block;font-size:0.75rem;background:#27272a;color:#a1a1aa;padding:2px 10px;border-radius:999px;margin-right:6px;">${escapeHtml(post.subcategory || publicDisplayCategory(post))}</span>`
      const image = publicDisplayImage(post)
      return [
        `<li style="min-width:0;border:1px solid #27272a;border-radius:12px;background:rgba(24,24,27,.54);overflow:hidden;">`,
        image ? `<a href="${escapeHtml(href)}" style="display:block;aspect-ratio:16/10;background:#18181b;overflow:hidden;"><img src="${escapeHtml(image.url)}" alt="${escapeHtml(image.alt || title)}" loading="lazy" style="display:block;width:100%;height:100%;object-fit:cover;"></a>` : '',
        `<div style="padding:18px;">`,
        `<a href="${escapeHtml(href)}" style="color:#fafafa;text-decoration:none;">`,
        `<h2 style="font-size:1.08rem;font-weight:800;line-height:1.45;margin:0 0 8px;">${title}</h2>`,
        `</a>`,
        `<div style="margin:4px 0 6px;">${sub}${date ? `<time style="font-size:0.8rem;color:#71717a;">${escapeHtml(date)}</time>` : ''}</div>`,
        excerpt ? `<p style="font-size:0.9rem;color:#a1a1aa;margin:10px 0 0;line-height:1.65;">${excerpt.slice(0, 180)}${excerpt.length > 180 ? '…' : ''}</p>` : '',
        `</div>`,
        `</li>`,
      ].filter(Boolean).join('\n')
    })
    .join('\n')

  return [
    `<div style="max-width:1120px;margin:0 auto;padding:56px 16px;font-family:system-ui,-apple-system,sans-serif;color:#e4e4e7;word-break:keep-all;overflow-wrap:break-word;">`,
    `<section style="display:grid;grid-template-columns:minmax(0,1.05fr) minmax(280px,.95fr);gap:34px;align-items:center;">`,
    `<div>`,
    `<p style="font-size:0.9rem;color:#fde047;margin:0 0 12px;">비오케이솔루션 × 홍커뮤니케이션 공식 블로그</p>`,
    `<h1 style="font-size:clamp(2.25rem,5vw,3.6rem);font-weight:900;letter-spacing:-.04em;line-height:1.08;color:#fff;margin:0;max-width:820px;">홈페이지·업무 시스템 개발과 MICE·학술대회 운영을 함께 정리합니다.</h1>`,
    `<p style="font-size:1rem;color:#a1a1aa;line-height:1.75;margin:20px 0 0;max-width:760px;">비오케이솔루션의 개발 솔루션과 홍커뮤니케이션의 행사 운영 경험을 바탕으로, 의뢰 전에 확인해야 할 화면·데이터·권한·현장 동선을 사례와 체크리스트 중심으로 다룹니다.</p>`,
    `<div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:28px;">`,
    `<a href="#articles" style="display:inline-block;background:#fafafa;color:#09090b;font-weight:700;text-decoration:none;border-radius:6px;padding:12px 18px;">최신 글 보기</a>`,
    `<a href="https://beoksolution.com" style="display:inline-block;border:1px solid #fde047;color:#fde047;font-weight:700;text-decoration:none;border-radius:6px;padding:12px 18px;">비오케이솔루션</a>`,
    `<a href="https://hongcomm.kr" style="display:inline-block;border:1px solid #fdba74;color:#fdba74;font-weight:700;text-decoration:none;border-radius:6px;padding:12px 18px;">홍커뮤니케이션</a>`,
    `</div>`,
    `</div>`,
    leadImage ? `<div style="border:1px solid #27272a;border-radius:18px;overflow:hidden;background:#18181b;box-shadow:0 30px 80px rgba(0,0,0,.34);"><img src="${escapeHtml(leadImage.url)}" alt="${escapeHtml(leadImage.alt)}" loading="eager" style="display:block;width:100%;height:auto;max-height:440px;object-fit:cover;"></div>` : '',
    `</section>`,
    `<section id="articles" style="margin-top:56px;border-top:1px solid #27272a;padding-top:40px;">`,
    `<h2 style="font-size:1.7rem;color:#fff;margin:0 0 10px;">최신 발행 글</h2>`,
    `<p style="font-size:0.95rem;color:#a1a1aa;line-height:1.6;margin:0 0 24px;">비오케이솔루션과 홍커뮤니케이션의 서비스 맥락에서 홈페이지 제작, 시스템 개발, 학회·MICE 운영에 필요한 실무 글을 모았습니다.</p>`,
    `<ul style="list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px;">${items || '<li style="color:#71717a;">발행된 글이 없습니다.</li>'}</ul>`,
    `</section>`,
    `<section id="services" style="margin-top:56px;border-top:1px solid #27272a;padding-top:40px;">`,
    `<h2 style="font-size:1.7rem;color:#fff;margin:0 0 10px;">서비스 분야</h2>`,
    `<p style="font-size:0.95rem;color:#a1a1aa;line-height:1.6;margin:0 0 24px;">필요한 범위에 따라 제작 방식, 운영 기능, 현장 대응 기준을 나눠 확인할 수 있습니다.</p>`,
    `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px;">`,
    ...[
      { cat: '홈페이지 제작', title: '제작 방식과 유지관리', desc: '구독형 홈페이지, 반응형 구성, 신청폼, 검색 노출, 운영 비용을 함께 검토합니다.' },
      { cat: '시스템 개발', title: '관리자와 업무 자동화', desc: '대시보드, 권한 관리, 데이터 연동, 알림톡 자동화처럼 운영 시간을 줄이는 기능을 다룹니다.' },
      { cat: '학회 운영', title: '접수와 명찰 출력', desc: '참가자 데이터, QR 확인, 현장 접수, 명찰 재발행까지 행사 당일 흐름을 점검합니다.' },
      { cat: 'MICE 레퍼런스', title: '행사 운영 사례', desc: '국제회의, 컨퍼런스, 동시통역, 학술대회 IT 시스템 사례를 정리합니다.' },
    ].map((item) => `<div style="border:1px solid #27272a;border-radius:8px;padding:16px;background:rgba(24,24,27,0.4);"><span style="display:inline-block;background:#27272a;border-radius:4px;padding:2px 8px;font-size:0.75rem;color:#a1a1aa;">${item.cat}</span><h3 style="margin:10px 0 0;font-size:0.95rem;color:#f4f4f5;">${item.title}</h3><p style="margin:8px 0 0;font-size:0.82rem;color:#a1a1aa;line-height:1.6;">${item.desc}</p></div>`),
    `</div>`,
    `</section>`,
    `<style>@media (max-width: 760px) { section[style*="grid-template-columns:minmax"] { grid-template-columns:1fr !important; } }</style>`,
    `</div>`,
  ].join('\n')
}

function blogPostingJsonLd(post, baseUrl) {
  const url = `${baseUrl}/blog/${encodeURIComponent(post.slug || post.id)}`
  const articleText = stripHtml(post.content || '')
  const displayCategory = publicDisplayCategory(post)
  const displayImage = publicDisplayImage(post)
  const keywords = [displayCategory, ...(Array.isArray(post.tags) ? post.tags : [])].filter(Boolean)
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: post.title || '',
    description: post.excerpt || post.seo_description || '',
    url,
    inLanguage: 'ko-KR',
    datePublished: post.published_at || post.created_at || '',
    dateModified: post.updated_at || post.published_at || post.created_at || '',
    author: { '@type': 'Organization', name: '비오케이솔루션' },
    publisher: { '@type': 'Organization', name: '비오케이솔루션', url: baseUrl },
    isPartOf: { '@type': 'Blog', name: '비오케이솔루션 · 홍커뮤니케이션 블로그', url: `${baseUrl}/blog/` },
    mainEntityOfPage: { '@type': 'WebPage', '@id': url },
    wordCount: articleText ? articleText.split(/\s+/).length : undefined,
  }
  if (displayImage?.url) schema.image = displayImage.url
  schema.articleSection = displayCategory
  if (keywords.length > 0) {
    schema.keywords = keywords.join(', ')
    schema.about = keywords.map((name) => ({ '@type': 'Thing', name }))
  }

  return JSON.stringify(schema)
}

function faqJsonLd(faq) {
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faq.map((item) => ({
      '@type': 'Question',
      name: item.q,
      acceptedAnswer: { '@type': 'Answer', text: item.a },
    })),
  })
}

function selectRelatedPosts(post, allPosts, limit = 3) {
  const tags = new Set((Array.isArray(post.tags) ? post.tags : []).map((t) => String(t).toLowerCase()))
  const currentAxis = publicTopicAxis(post)
  return allPosts
    .filter((p) => p.id !== post.id && !p.deleted_at && p.status === 'published')
    .map((p) => {
      const pTags = (Array.isArray(p.tags) ? p.tags : []).map((t) => String(t).toLowerCase())
      const tagOverlap = pTags.filter((t) => tags.has(t)).length
      const categoryMatch = p.category && p.category === post.category ? 1 : 0
      const axisMatch = currentAxis && currentAxis === publicTopicAxis(p) ? 1 : 0
      return { post: p, score: tagOverlap * 2 + categoryMatch + axisMatch }
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      const da = a.post.published_at || a.post.created_at || ''
      const db2 = b.post.published_at || b.post.created_at || ''
      return db2.localeCompare(da)
    })
    .slice(0, limit)
    .map((entry) => entry.post)
}

function relatedPostsHtml(relatedPosts, baseUrl) {
  if (!relatedPosts.length) return ''
  const items = relatedPosts.map((p) => {
    const url = `${baseUrl}${publicBlogPath(p)}`
    return `<li style="margin-bottom:10px;"><a href="${escapeHtml(url)}" style="color:#93c5fd;text-decoration:none;font-weight:700;font-size:15px;line-height:1.6;">${escapeHtml(p.title || '')}</a>${p.excerpt ? `<p style="margin:4px 0 0;color:#a1a1aa;font-size:13px;line-height:1.6;">${escapeHtml(String(p.excerpt).slice(0, 90))}</p>` : ''}</li>`
  }).join('')
  return `
<section style="margin-top:34px;padding:24px;border:1px solid rgba(255,255,255,.1);border-radius:24px;background:rgba(255,255,255,.035);">
  <h2 style="margin:0 0 14px;color:#fff;font-size:20px;font-weight:900;letter-spacing:-.02em;">함께 읽으면 좋은 글</h2>
  <ul style="margin:0;padding-left:18px;list-style:disc;color:#71717a;">${items}</ul>
</section>`
}

function faqSectionHtml(faq) {
  if (!Array.isArray(faq) || !faq.length) return ''
  const items = faq.map((item) => `
    <div style="padding:18px 20px;border-radius:18px;background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.1);">
      <b style="display:block;color:#fff;margin-bottom:8px;font-size:15px;">${escapeHtml(item.q)}</b>
      <p style="margin:0;color:#cbd5e1;line-height:1.75;font-size:14px;">${escapeHtml(item.a)}</p>
    </div>`).join('')
  return `
<section style="margin-top:34px;">
  <h2 style="margin:0 0 14px;color:#fff;font-size:22px;font-weight:900;letter-spacing:-.02em;">자주 묻는 질문</h2>
  <div style="display:grid;gap:10px;">${items}</div>
</section>`
}

function breadcrumbJsonLd(items) {
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: item.name,
      item: item.url,
    })),
  })
}

function blogListJsonLd(posts, baseUrl) {
  const visiblePosts = publicVisibleBlogPosts(posts)
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'Blog',
    name: '비오케이솔루션 · 홍커뮤니케이션 블로그',
    url: `${baseUrl}/blog/`,
    description: '비오케이솔루션의 홈페이지·맞춤형 시스템 개발과 홍커뮤니케이션의 MICE·학술대회 운영 레퍼런스를 다루는 공식 실무 블로그',
    inLanguage: 'ko-KR',
    publisher: { '@type': 'Organization', name: '비오케이솔루션', url: baseUrl },
    about: [
      { '@type': 'Thing', name: '비오케이솔루션' },
      { '@type': 'Thing', name: '홍커뮤니케이션' },
      { '@type': 'Thing', name: '홈페이지 제작' },
      { '@type': 'Thing', name: '맞춤형 시스템 개발' },
      { '@type': 'Thing', name: 'MICE·학술대회 운영' },
    ],
    blogPost: visiblePosts.slice(0, 20).map((post) => ({
      '@type': 'BlogPosting',
      headline: post.title || '',
      url: `${baseUrl}/blog/${encodeURIComponent(post.slug || post.id)}`,
      datePublished: post.published_at || post.created_at || '',
    })),
  }
  return JSON.stringify(schema)
}

function serviceOfferJsonLd(baseUrl) {
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Service',
    name: '비오케이솔루션 · 홍커뮤니케이션 개발·MICE 운영 지원',
    description: '홈페이지 제작, 맞춤형 시스템 개발, 참가자 등록, 초록 접수, QR 체크인, 명찰 출력, MICE·학술대회 운영 데이터 정리를 지원합니다.',
    provider: { '@type': 'Organization', name: '비오케이솔루션', url: baseUrl },
    areaServed: 'KR',
    serviceType: '홈페이지·시스템 개발 및 MICE 운영 지원',
    audience: { '@type': 'Audience', audienceType: '기업, 학회 운영 사무국, 협회, PCO, 행사 운영팀' },
  })
}

// ─── SSR routes ─────────────────────────────────────────────────────────────────

app.get('/blog', (req, res, next) => {
  if (req.path === '/blog/') return next()
  res.redirect(301, `${spaBaseUrl(req)}/blog/`)
})

app.get('/blog/', async (req, res) => {
  try {
    const baseUrl = spaBaseUrl(req)
    const snap = await db.collection('blog_posts').where('status', '==', 'published').get()
    const posts = snap.docs
      .map((doc) => ({ id: doc.id, ...doc.data() }))
      .filter((post) => !post.deleted_at)
      .sort((a, b) => {
        const da = a.published_at || a.created_at || ''
        const db2 = b.published_at || b.created_at || ''
        return db2.localeCompare(da)
      })

    const jsonLd = [
      organizationJsonLd(baseUrl),
      webSiteJsonLd(baseUrl),
      serviceOfferJsonLd(baseUrl),
      blogListJsonLd(posts, baseUrl),
      breadcrumbJsonLd([
        { name: '홈', url: baseUrl },
        { name: '블로그', url: `${baseUrl}/blog/` },
      ]),
    ].map((s) => `<script type="application/ld+json">${s}</script>`).join('\n')

    const html = buildSsrHtml({
      title: '비오케이솔루션 · 홍커뮤니케이션 블로그',
      description: '비오케이솔루션의 홈페이지·맞춤형 시스템 개발과 홍커뮤니케이션의 MICE·학술대회 운영 레퍼런스를 다루는 공식 실무 블로그입니다.',
      canonicalUrl: `${baseUrl}/blog/`,
      ogType: 'website',
      ogImage: '',
      jsonLd,
      bodyHtml: blogListBodyHtml(posts, baseUrl),
    })

    res.set('Content-Type', 'text/html; charset=utf-8')
    res.set('Cache-Control', 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800')
    res.send(html)
  } catch (err) {
    console.error('[SSR /blog] Error:', err)
    res.set('Content-Type', 'text/html; charset=utf-8')
    res.status(500).send(ssrTemplate || '<html><body>Server Error</body></html>')
  }
})

app.get('/blog/:slug', async (req, res) => {
  try {
    const slug = req.params.slug
    if (!slug || slug.startsWith('assets') || slug.includes('.')) {
      // Likely a static asset request; skip
      return res.status(404).send('Not found')
    }

    const baseUrl = spaBaseUrl(req)
    const snap = await db.collection('blog_posts').where('slug', '==', slug).limit(1).get()

    if (snap.empty) {
      res.set('Content-Type', 'text/html; charset=utf-8')
      res.status(404).send(buildSsrHtml({
        title: '포스트를 찾을 수 없습니다 | 비오케이솔루션 · 홍커뮤니케이션 블로그',
        description: '요청하신 블로그 포스트를 찾을 수 없습니다.',
        canonicalUrl: `${baseUrl}/blog/${slug}`,
        ogType: 'website',
        ogImage: '',
        jsonLd: '',
        bodyHtml: '<div style="max-width:720px;margin:0 auto;padding:48px 16px;text-align:center;font-family:system-ui,sans-serif;color:#a1a1aa;"><h1 style="font-size:1.5rem;color:#fafafa;">404</h1><p>포스트를 찾을 수 없습니다.</p></div>',
      }))
      return
    }

    const doc = snap.docs[0]
    const post = { id: doc.id, ...doc.data() }

    if (post.status !== 'published' || post.deleted_at) {
      res.set('Content-Type', 'text/html; charset=utf-8')
      res.status(404).send(buildSsrHtml({
        title: '포스트를 찾을 수 없습니다 | 비오케이솔루션 · 홍커뮤니케이션 블로그',
        description: '요청하신 블로그 포스트를 찾을 수 없습니다.',
        canonicalUrl: `${baseUrl}/blog/${slug}`,
        ogType: 'website',
        ogImage: '',
        jsonLd: '',
        bodyHtml: '<div style="max-width:720px;margin:0 auto;padding:48px 16px;text-align:center;font-family:system-ui,sans-serif;color:#a1a1aa;"><h1 style="font-size:1.5rem;color:#fafafa;">404</h1><p>포스트를 찾을 수 없습니다.</p></div>',
      }))
      return
    }

    const canonicalUrl = `${baseUrl}/blog/${encodeURIComponent(post.slug)}`
    const seoTitle = post.seo_title || post.title || ''
    const seoDesc = post.seo_description || post.excerpt || ''

    // 관련 글 (내부 링크): 태그/카테고리 유사도 기반
    let relatedPosts = []
    try {
      const allSnap = await db.collection('blog_posts').where('status', '==', 'published').get()
      const allPosts = allSnap.docs.map((d) => ({ id: d.id, ...d.data() }))
      relatedPosts = selectRelatedPosts(post, allPosts, 3)
    } catch {
      relatedPosts = []
    }

    const jsonLdEntries = [
      organizationJsonLd(baseUrl),
      webSiteJsonLd(baseUrl),
      blogPostingJsonLd(post, baseUrl),
      breadcrumbJsonLd([
        { name: '홈', url: baseUrl },
        { name: '블로그', url: `${baseUrl}/blog` },
        { name: post.title || '', url: canonicalUrl },
      ]),
    ]
    if (Array.isArray(post.faq) && post.faq.length > 0) {
      jsonLdEntries.push(faqJsonLd(post.faq))
    }
    const jsonLd = jsonLdEntries.map((s) => `<script type="application/ld+json">${s}</script>`).join('\n')

    const html = buildSsrHtml({
      title: `${seoTitle} | 비오케이솔루션 · 홍커뮤니케이션 블로그`,
      description: seoDesc,
      canonicalUrl,
      ogType: 'article',
      ogImage: publicDisplayImage(post)?.url || '',
      jsonLd,
      bodyHtml: blogPostBodyHtml(post, { relatedHtml: relatedPostsHtml(relatedPosts, baseUrl) }),
      publishedTime: post.published_at || post.created_at || '',
      modifiedTime: post.updated_at || post.published_at || post.created_at || '',
    })

    res.set('Content-Type', 'text/html; charset=utf-8')
    res.set('Cache-Control', 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800')
    res.send(html)
  } catch (err) {
    console.error('[SSR /blog/:slug] Error:', err)
    res.set('Content-Type', 'text/html; charset=utf-8')
    res.status(500).send(ssrTemplate || '<html><body>Server Error</body></html>')
  }
})

// ─── KAID Newsletters CRUDL ───────────────────────────────────────────────────

app.get('/api/kaid-newsletters', async (req, res) => {
  try {
    const snap = await db.collection('kaid_newsletters').orderBy('updated_at', 'desc').get()
    const items = snap.docs.map(d => {
      const { els, ...meta } = d.data()
      return serializeValue({ id: d.id, ...meta, el_count: Array.isArray(els) ? els.length : 0 })
    })
    ok(res, items)
  } catch (e) {
    fail(res, 500, 'ERROR', e instanceof Error ? e.message : 'unknown', {})
  }
})

app.post('/api/kaid-newsletters', async (req, res) => {
  try {
    const { name, config, els } = req.body
    if (!name || typeof name !== 'string') return fail(res, 400, 'INVALID', 'name required', {})
    const id = randomUUID()
    const cleanEls = Array.isArray(els)
      ? els.map(el => el.type === 'image' ? { ...el, src: '' } : el)
      : []
    await db.collection('kaid_newsletters').doc(id).set({
      id, name: name.trim(), config: config ?? {}, els: cleanEls,
      created_at: FieldValue.serverTimestamp(),
      updated_at: FieldValue.serverTimestamp(),
    })
    ok(res, { id })
  } catch (e) {
    fail(res, 500, 'ERROR', e instanceof Error ? e.message : 'unknown', {})
  }
})

app.get('/api/kaid-newsletters/:id', async (req, res) => {
  try {
    const snap = await db.collection('kaid_newsletters').doc(req.params.id).get()
    if (!snap.exists) return fail(res, 404, 'NOT_FOUND', 'newsletter not found', {})
    ok(res, serializeValue({ id: snap.id, ...snap.data() }))
  } catch (e) {
    fail(res, 500, 'ERROR', e instanceof Error ? e.message : 'unknown', {})
  }
})

app.put('/api/kaid-newsletters/:id', async (req, res) => {
  try {
    const ref = db.collection('kaid_newsletters').doc(req.params.id)
    const snap = await ref.get()
    if (!snap.exists) return fail(res, 404, 'NOT_FOUND', 'newsletter not found', {})
    const { name, config, els } = req.body
    const cleanEls = Array.isArray(els)
      ? els.map(el => el.type === 'image' ? { ...el, src: '' } : el)
      : snap.data().els
    const patch = { updated_at: FieldValue.serverTimestamp(), els: cleanEls, config: config ?? snap.data().config }
    if (name && typeof name === 'string') patch.name = name.trim()
    await ref.update(patch)
    ok(res, { id: req.params.id })
  } catch (e) {
    fail(res, 500, 'ERROR', e instanceof Error ? e.message : 'unknown', {})
  }
})

app.delete('/api/kaid-newsletters/:id', async (req, res) => {
  try {
    await db.collection('kaid_newsletters').doc(req.params.id).delete()
    ok(res, { id: req.params.id })
  } catch (e) {
    fail(res, 500, 'ERROR', e instanceof Error ? e.message : 'unknown', {})
  }
})

app.post('/api/kaid-newsletters/translate', async (req, res) => {
  try {
    const { els, targetLang } = req.body
    if (!Array.isArray(els)) return fail(res, 400, 'INVALID', 'els required', {})
    const config = await resolveAiConfig(req.body)
    if (!config.provider || !config.apiKey) return fail(res, 400, 'NO_AI', 'AI provider not configured', {})

    const items = []
    for (let i = 0; i < els.length; i++) {
      if (els[i].type === 'text') items.push({ i, field: 'content', text: els[i].content })
      else if (els[i].type === 'button') items.push({ i, field: 'text', text: els[i].text })
    }
    if (items.length === 0) return ok(res, { els })

    const lang = targetLang === 'ENG' ? 'English' : 'Korean'
    const systemPrompt = `You are a professional translator. Translate each string to ${lang}. Preserve line breaks (\\n). Return ONLY a valid JSON array of translated strings, same count and order as input. No explanation.`
    const userPrompt = JSON.stringify(items.map(t => t.text))

    const raw = await generateAiText(config, systemPrompt, userPrompt, { max_tokens: 4096 })
    let translated
    try {
      const m = raw.match(/\[[\s\S]*\]/)
      translated = JSON.parse(m ? m[0] : raw.trim())
    } catch {
      return fail(res, 500, 'AI_PARSE', 'AI returned non-JSON', { raw })
    }
    if (!Array.isArray(translated) || translated.length !== items.length) {
      return fail(res, 500, 'AI_COUNT', 'Translation count mismatch', { expected: items.length, got: translated.length })
    }

    const updated = els.map(el => ({ ...el }))
    items.forEach((item, j) => { updated[item.i][item.field] = translated[j] })
    ok(res, { els: updated })
  } catch (e) {
    fail(res, 500, 'AI_ERROR', e instanceof Error ? e.message : 'unknown', {})
  }
})

export const api = onRequest({ timeoutSeconds: 300, memory: '512Mi' }, app)

// ─── 기존 스케줄드 펑션 ──────────────────────────────────────────

export const aiRetrySweep = onSchedule({ schedule: 'every 10 minutes' }, async () => {
  await runRetrySweep({ job_type: 'all', only_due: true, limit: 20 }, 'system')
})

export const aiPlatformAccountSweep = onSchedule({ schedule: 'every 30 minutes' }, async () => {
  await runPlatformAccountSweep({ limit: 50, warning_window_minutes: 60 }, 'system')
})

export const blogPipelineScheduler = onSchedule({ schedule: 'every monday 09:00', timeZone: 'Asia/Seoul' }, async () => {
  try {
    const snap = await db.collection('blog_schedule')
      .where('status', '==', 'pending')
      .orderBy('created_at', 'asc')
      .limit(1)
      .get()

    if (snap.empty) {
      console.log('[blogPipelineScheduler] No pending blog schedule items')
      return
    }

    const doc = snap.docs[0]
    const item = { id: doc.id, ...doc.data() }

    await doc.ref.set({ status: 'processing', updated_at: FieldValue.serverTimestamp() }, { merge: true })

    try {
      const result = await executeBlogPipeline(
        {
          generateAiText,
          maybeParseJson,
          resolveAiConfig,
          newId,
          nowIso,
          ensureUniqueBlogSlug,
          addAuditLog,
          createPost: async (post) => {
            await db.collection('blog_posts').doc(post.id).set(post)
          },
          listPublishedPosts: listPublishedPostsForLinks,
        },
        {
          title: item.title,
          topic: item.topic ?? item.title,
          category: item.category ?? 'marketing',
          tone: item.tone ?? 'professional',
          keywords: Array.isArray(item.keywords) ? item.keywords : [],
          source_text: item.source_text ?? '',
          target_length: item.target_length ?? 'medium',
          language: item.language ?? 'ko',
          auto_publish: item.auto_publish !== false,
          featured_image: item.featured_image ?? null,
          structure: item.structure ?? null,
        }
      )

      if (result.status === 'published' && result.slug) {
        await pingIndexNow(`${SITE_BASE_URL}/blog/${encodeURIComponent(result.slug)}`)
      }

      await doc.ref.set({
        status: 'completed',
        post_id: result.post_id,
        slug: result.slug,
        published_at: result.published_at,
        completed_at: FieldValue.serverTimestamp(),
        updated_at: FieldValue.serverTimestamp(),
      }, { merge: true })

      console.log(`[blogPipelineScheduler] Published: ${result.post_id} (${result.slug})`)
    } catch (pipelineError) {
      await doc.ref.set({
        status: 'failed',
        error_message: pipelineError instanceof Error ? pipelineError.message : 'pipeline execution failed',
        failed_at: FieldValue.serverTimestamp(),
        updated_at: FieldValue.serverTimestamp(),
      }, { merge: true })
      console.error('[blogPipelineScheduler] Pipeline failed:', pipelineError)
    }
  } catch (err) {
    console.error('[blogPipelineScheduler] Scheduler error:', err)
  }
})
