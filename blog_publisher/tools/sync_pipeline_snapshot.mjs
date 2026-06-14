import 'dotenv/config'
import path from 'path'
import os from 'os'
import { fileURLToPath } from 'url'
import Database from 'better-sqlite3'
import { readFileSync, statSync } from 'fs'
import { initializeApp } from 'firebase-admin/app'
import { FieldValue, getFirestore } from 'firebase-admin/firestore'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DB_PATH = path.resolve(__dirname, '../db/blog.db')
const ENV_PATH = path.resolve(__dirname, '../.env')
const WORKER_DIR = path.resolve(__dirname, '../../executors/naver-blog-worker')
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'beokmkt'
const ALL_STATUSES = ['draft', 'generating', 'factchecking', 'reviewing', 'reviewed', 'queued', 'publishing', 'published', 'needs_human', 'failed', 'archived']
const CHANNELS = ['naver', 'tistory', 'selfhosted']
const INVENTORY_STATUSES = ['draft', 'generating', 'factchecking', 'reviewing', 'reviewed']

function readEnvNumber(key, fallback) {
  try {
    const text = readFileSync(ENV_PATH, 'utf8')
    const match = text.match(new RegExp(`^${key}=([^\\n#]+)`, 'm'))
    if (!match) return fallback
    const value = Number(String(match[1]).trim().replace(/^["']|["']$/g, ''))
    return Number.isFinite(value) ? value : fallback
  } catch {
    const value = Number(process.env[key])
    return Number.isFinite(value) ? value : fallback
  }
}

function qualityGateStatus() {
  const minGrounding = readEnvNumber('MIN_GROUNDING_RATIO', 0.9)
  const minReviewScore = readEnvNumber('MIN_REVIEW_SCORE', 80)
  return {
    min_grounding_ratio: minGrounding,
    min_review_score: minReviewScore,
    enforced: minGrounding > 0 && minReviewScore > 0,
    ok: minGrounding >= 0.9 && minReviewScore >= 80,
  }
}

function sessionFileHealth(channel, relativePath) {
  const sessionPath = path.resolve(WORKER_DIR, relativePath)
  try {
    const stat = statSync(sessionPath)
    const ageHours = Math.round(((Date.now() - stat.mtimeMs) / 36_000) / 10)
    return {
      channel,
      exists: true,
      ok: ageHours <= 72,
      path: relativePath,
      updated_at: stat.mtime.toISOString(),
      age_hours: ageHours,
      size: stat.size,
    }
  } catch {
    return {
      channel,
      exists: false,
      ok: false,
      path: relativePath,
      updated_at: null,
      age_hours: null,
      size: 0,
    }
  }
}

function channelSessionHealth() {
  return [
    sessionFileHealth('naver', './.session/naver-session.json'),
    sessionFileHealth('tistory', './.session/tistory-session.json'),
  ]
}

function pipelineQuality(body = '', groundingRatio = null) {
  const value = String(body ?? '')
  const text = value
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return {
    chars: text.length,
    images: (value.match(/<img\b/gi) || []).length + (value.match(/!\[[^\]]*]\([^)\s]+\)/g) || []).length,
    headings: (value.match(/<h[23]\b/gi) || []).length + (value.match(/^#{2,3}\s+/gm) || []).length,
    grounding_ratio: Number.isFinite(Number(groundingRatio)) ? Number(groundingRatio) : null,
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

function collectQualityItems(db, limit = 12) {
  return db.prepare(
    `SELECT id, topic, title, channel, status, body, grounding_ratio, published_url, updated_at
     FROM posts
     WHERE status IN ('published','reviewed','queued')
       AND (
         LENGTH(COALESCE(body, '')) < 1800
         OR grounding_ratio IS NULL
         OR grounding_ratio < 0.9
         OR (body NOT LIKE '%<img%' AND body NOT LIKE '%![%')
       )
     ORDER BY
       CASE WHEN LENGTH(COALESCE(body, '')) < 1000 THEN 0 ELSE 1 END,
       LENGTH(COALESCE(body, '')) ASC,
       updated_at DESC
     LIMIT ?`
  ).all(limit)
    .map((post) => {
      const quality = pipelineQuality(post.body, post.grounding_ratio)
      const issues = qualityIssueLabels(quality)
      return {
        id: post.id,
        topic: post.title || post.topic || '',
        title: post.title || post.topic || '',
        channel: post.channel,
        status: post.status,
        published_url: post.published_url || null,
        quality,
        issues,
        action: qualityActionFor(issues, post.status),
        updated_at: post.updated_at,
        ...snapshotBodyPreview(post.body),
      }
    })
    .filter((post) => post.issues.length > 0)
}

function actionForExternalIssue(channel, error = '') {
  const msg = String(error ?? '')
  if (channel === 'tistory' && /세션|login|auth|TISTORY/i.test(msg)) return '티스토리 재인증 후 워커 재시작'
  if (channel === 'naver' && /404|삭제|품질|구조|PASTE|SmartEditor/i.test(msg)) return '네이버 공개상태·본문 품질 확인 후 재발행 판단'
  if (/세션|login|auth/i.test(msg)) return '채널 세션 재인증'
  if (/품질|review|grounding|구조/i.test(msg)) return '본문 품질 재검토'
  return '원인 확인'
}

function pipelineRequeuePolicy(post) {
  const error = String(post?.last_error ?? '')
  if (!post) return { can_requeue: false, reason: 'post not found' }
  if (!['needs_human', 'failed'].includes(post.status)) {
    return { can_requeue: false, reason: 'needs_human/failed 상태만 재큐잉 가능' }
  }
  if (/세션|login|auth|LOGIN_REQUIRED|AUTH_REQUIRED|NOT_AUTHED|TISTORY/i.test(error)) {
    return { can_requeue: false, reason: '채널 세션/인증 문제는 재인증 후 수동 재큐잉' }
  }
  if (post.channel === 'naver' && /404|삭제|품질|구조|PASTE|SmartEditor|RICH_CONTENT|NAVER_RICH/i.test(error)) {
    return { can_requeue: false, reason: '네이버 구조 손실/품질 실패 글은 자동 재발행 금지' }
  }
  if (!post.body || String(post.body).trim().length < 500) {
    return { can_requeue: false, reason: '본문이 없거나 너무 짧아 재발행 불가' }
  }
  return { can_requeue: true, reason: null }
}

const PUBLIC_FORBIDDEN_TONE = ['꿀팁', '환장', '대박', '지옥', '끝판왕', '충격', '실화', 'ㅋㅋ', 'ㅎㅎ', '[이미지:']

function stripPublicNonContent(html = '') {
  return String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
}

function publicPlainText(html = '') {
  return stripPublicNonContent(html)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

function escapePreviewHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function sanitizeSnapshotPreviewHtml(html = '') {
  return String(html)
    .slice(0, 6000)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/\s+on\w+="[^"]*"/gi, '')
    .replace(/\s+on\w+='[^']*'/gi, '')
    .replace(/\s+on\w+=\S+/gi, '')
    .replace(/javascript:/gi, '')
}

function markdownToSnapshotPreviewHtml(markdown = '') {
  const lines = String(markdown ?? '').slice(0, 8000).split(/\r?\n/)
  const out = []
  let listOpen = false
  let paragraph = []
  const closeParagraph = () => {
    if (!paragraph.length) return
    out.push(`<p>${escapePreviewHtml(paragraph.join(' '))}</p>`)
    paragraph = []
  }
  const closeList = () => {
    if (!listOpen) return
    out.push('</ul>')
    listOpen = false
  }
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) {
      closeParagraph()
      closeList()
      continue
    }
    const image = line.match(/^!\[([^\]]*)]\(([^)\s]+)\)$/)
    if (image) {
      closeParagraph()
      closeList()
      out.push(`<figure><img src="${escapePreviewHtml(image[2])}" alt="${escapePreviewHtml(image[1])}"></figure>`)
      continue
    }
    const heading = line.match(/^(#{2,3})\s+(.+)$/)
    if (heading) {
      closeParagraph()
      closeList()
      const tag = heading[1].length === 2 ? 'h2' : 'h3'
      out.push(`<${tag}>${escapePreviewHtml(heading[2])}</${tag}>`)
      continue
    }
    const bullet = line.match(/^[-*]\s+(.+)$/)
    if (bullet) {
      closeParagraph()
      if (!listOpen) {
        out.push('<ul>')
        listOpen = true
      }
      out.push(`<li>${escapePreviewHtml(bullet[1])}</li>`)
      continue
    }
    paragraph.push(line)
  }
  closeParagraph()
  closeList()
  return sanitizeSnapshotPreviewHtml(out.join('\n'))
}

function snapshotPreviewHtml(body = '') {
  const value = String(body ?? '').trim()
  if (!value) return ''
  return /<(h[1-6]|p|ul|ol|li|blockquote|img|figure|table)\b/i.test(value)
    ? sanitizeSnapshotPreviewHtml(value)
    : markdownToSnapshotPreviewHtml(value)
}

function snapshotBodyPreview(body = '') {
  const value = String(body ?? '')
  return {
    body_available: Boolean(value.trim()),
    body_excerpt: publicPlainText(value).slice(0, 1200),
    preview_html: snapshotPreviewHtml(value),
  }
}

function hasVisibleStrike(html = '') {
  const value = stripPublicNonContent(html)
  if (/text-decoration\s*:\s*line-through/i.test(value)) return true
  const matches = value.matchAll(/<(?:s|strike|del)\b[^>]*>([\s\S]*?)<\/(?:s|strike|del)>/gi)
  for (const match of matches) {
    if (publicPlainText(match[1]).replace(/[\u200b\ufeff]/g, '').trim()) return true
  }
  return false
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

async function inspectPublicPost(row) {
  const url = String(row.published_url || '')
  const channel = String(row.channel || '')
  const title = String(row.title || row.topic || '')
  const issues = []
  let status = null
  let html = ''
  if (!url) {
    issues.push('공개 URL 없음')
  } else {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': 'Mozilla/5.0 public-post-verifier/1.0' },
        signal: AbortSignal.timeout(15000),
      })
      status = res.status
      html = await res.text()
    } catch (e) {
      issues.push(`FETCH_ERROR: ${e instanceof Error ? e.message : String(e)}`.slice(0, 160))
    }
  }
  const contentHtml = stripPublicNonContent(html)
  const text = publicPlainText(html)
  const chars = text.length
  const images = (html.match(/<img\b/gi) || []).length
  const h1 = (html.match(/<h1\b/gi) || []).length
  const h2 = (html.match(/<h2\b/gi) || []).length
  if (status !== 200) issues.push(`HTTP 상태 비정상(${status})`)
  const matched = PUBLIC_FORBIDDEN_TONE.filter((word) => contentHtml.includes(word) || text.includes(word))
  if (matched.length) issues.push(`금칙/마커 문구 노출(${matched.slice(0, 5).join(', ')})`)
  if (hasVisibleStrike(contentHtml)) issues.push('취소선 서식 노출')
  if (channel === 'selfhosted') {
    if (chars < 1000) issues.push(`본문 짧음(${chars}자)`)
    if (h1 !== 1) issues.push(`h1 개수 비정상(${h1})`)
    if (/<article\b[^>]*>\s*<header\b/i.test(html)) issues.push('저장 본문 article/header 중복 노출')
  } else if (channel === 'tistory') {
    if (!/^https:\/\/[^/]+\.tistory\.com\/\d+(?:[/?#].*)?$/.test(url)) issues.push('티스토리 공개 URL 형식 아님')
    if (chars < 800) issues.push(`본문 짧음(${chars}자)`)
    if (h2 < 2) issues.push(`소제목 부족(${h2})`)
  } else if (channel === 'naver') {
    if (!/PostView\.naver|blog\.naver\.com\/[^/?#]+\/\d+/.test(url)) issues.push('네이버 공개 URL 형식 아님')
    if (status === 200 && chars < 500) issues.push(`본문 짧음(${chars}자)`)
  }
  let cache_bust_ok = false
  let cache_bust_url = null
  if (channel === 'selfhosted' && issues.length > 0 && url && !url.includes('?')) {
    cache_bust_url = `${url}?v=public-quality-${encodeURIComponent(String(row.id ?? Date.now()))}`
    try {
      const bust = await fetch(cache_bust_url, {
        headers: { 'user-agent': 'Mozilla/5.0 public-post-verifier/1.0' },
        signal: AbortSignal.timeout(15000),
      })
      const bustHtml = await bust.text()
      const bustContent = stripPublicNonContent(bustHtml)
      const bustText = publicPlainText(bustHtml)
      const bustForbidden = PUBLIC_FORBIDDEN_TONE.filter((word) => bustContent.includes(word) || bustText.includes(word))
      cache_bust_ok = bust.status === 200 && bustForbidden.length === 0
      if (cache_bust_ok) issues.push('캐시 우회 URL은 정상(Hosting/CDN 캐시 잔존 의심)')
    } catch {
      // 캐시 우회 확인은 보조 신호다. 실패해도 원래 공개 품질 이슈를 유지한다.
    }
  }
  return { id: row.id, channel, title, url, status, chars, images, h1, h2, issues, cache_bust_ok, cache_bust_url, action: issues.length ? publicQualityAction(channel, issues) : null }
}

async function collectPublicQuality(db, limit = 20) {
  const rows = db.prepare(
    `SELECT id, channel, topic, title, published_url
     FROM posts
     WHERE status = 'published'
     ORDER BY updated_at DESC, id DESC
     LIMIT ?`
  ).all(limit)
  const results = await Promise.all(rows.map((row) => inspectPublicPost(row)))
  const items = results.filter((item) => item.issues.length > 0)
  return { checked: results.length, ok: results.length - items.length, failed: items.length, items }
}

async function collectSnapshot() {
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true })
  try {
    const by_status = Object.fromEntries(ALL_STATUSES.map((status) => [status, 0]))
    for (const row of db.prepare('SELECT status, COUNT(*) AS n FROM posts GROUP BY status').all()) {
      if (row.status in by_status) by_status[row.status] = row.n
    }

    const by_channel = Object.fromEntries(CHANNELS.map((channel) => [channel, { published: 0, queued: 0, needs_human: 0 }]))
    for (const row of db.prepare(
      "SELECT channel, status, COUNT(*) AS n FROM posts WHERE status IN ('published','queued','needs_human') GROUP BY channel, status"
    ).all()) {
      if (row.channel in by_channel && row.status in by_channel[row.channel]) {
        by_channel[row.channel][row.status] = row.n
      }
    }

    const reviewedTarget = Number(process.env.DAILY_PUBLISH_TARGET || 5) * Number(process.env.STOCK_BUFFER_DAYS || 3)
    const inventory = INVENTORY_STATUSES.reduce((sum, status) => sum + (by_status[status] || 0), 0)
    const stuckThresholdMin = Number(process.env.STUCK_THRESHOLD_MIN || 35)
    const dueRow = db.prepare("SELECT COUNT(*) AS n FROM posts WHERE status='queued' AND next_run_at <= datetime('now')").get()
    const nextQueuedRow = db.prepare("SELECT MIN(next_run_at) AS next_queued_at FROM posts WHERE status='queued'").get()
    const stale = { generating: 0, factchecking: 0, reviewing: 0, publishing: 0 }
    for (const row of db.prepare(
      `SELECT status, COUNT(*) AS n
       FROM posts
       WHERE status IN ('generating','factchecking','reviewing','publishing')
         AND updated_at < datetime('now', ?)
       GROUP BY status`
    ).all(`-${stuckThresholdMin} minutes`)) {
      if (row.status in stale) stale[row.status] = row.n
    }

    const todayRow = db.prepare("SELECT COUNT(*) AS n FROM posts WHERE status='published' AND updated_at >= datetime('now','start of day')").get()
    const weekRow = db.prepare("SELECT COUNT(*) AS n FROM posts WHERE status='published' AND updated_at >= datetime('now','-6 days','start of day')").get()
    const qualityRow = db.prepare(
      `SELECT
        COUNT(*) AS measured_posts,
        AVG(LENGTH(COALESCE(body, ''))) AS avg_chars,
        SUM(CASE WHEN body LIKE '%<img%' OR body LIKE '%![%' THEN 1 ELSE 0 END) AS with_images,
        SUM(CASE WHEN LENGTH(COALESCE(body, '')) > 0 AND LENGTH(COALESCE(body, '')) < 1800 THEN 1 ELSE 0 END) AS weak_posts,
        AVG(grounding_ratio) AS avg_grounding
      FROM posts
      WHERE status IN ('published','reviewed','queued')`
    ).get()
    const needs_human_posts = db.prepare(
      "SELECT id, topic, title, channel, status, body, grounding_ratio, last_error, published_url, updated_at FROM posts WHERE status IN ('needs_human','failed') ORDER BY updated_at DESC LIMIT 12"
    ).all().map((post) => {
      const policy = pipelineRequeuePolicy(post)
      return {
        id: post.id,
        topic: post.title || post.topic || '',
        title: post.title || post.topic || '',
        channel: post.channel,
        status: post.status,
        last_error: post.last_error || null,
        published_url: post.published_url || null,
        quality: pipelineQuality(post.body, post.grounding_ratio),
        can_requeue: policy.can_requeue,
        reason: policy.reason,
        can_archive: false,
        action: actionForExternalIssue(post.channel, post.last_error || ''),
        updated_at: post.updated_at,
        ...snapshotBodyPreview(post.body),
      }
    })
    const recent = db.prepare(
      'SELECT id, topic, title, channel, status, published_url, updated_at FROM posts ORDER BY updated_at DESC LIMIT 10'
    ).all().map((post) => ({
      id: post.id,
      topic: post.title || post.topic || '',
      channel: post.channel,
      status: post.status,
      published_url: post.published_url || null,
      updated_at: post.updated_at,
    }))
    const quality_items = collectQualityItems(db, 12)
    let public_quality = { checked: 0, ok: 0, failed: 0, items: [] }
    try {
      public_quality = await collectPublicQuality(db, 20)
    } catch (e) {
      public_quality = {
        checked: 0,
        ok: 0,
        failed: 1,
        items: [{
          id: 'public-quality',
          channel: 'system',
          title: '공개 품질 검증 실패',
          url: '',
          status: null,
          chars: 0,
          images: 0,
          h1: 0,
          h2: 0,
          issues: [e instanceof Error ? e.message : String(e)],
          action: '맥에서 python3 blog_publisher/run.py verify_public 20 실행',
        }],
      }
    }

    return {
      source: 'local_sqlite',
      generated_at: new Date().toISOString(),
      host: os.hostname(),
      by_status,
      by_channel,
      published_today: todayRow?.n ?? 0,
      published_this_week: weekRow?.n ?? 0,
      quality: {
        measured_posts: qualityRow?.measured_posts ?? 0,
        avg_chars: Math.round(qualityRow?.avg_chars ?? 0),
        with_images: qualityRow?.with_images ?? 0,
        weak_posts: qualityRow?.weak_posts ?? 0,
        avg_grounding: qualityRow?.avg_grounding == null ? null : Math.round(qualityRow.avg_grounding * 100) / 100,
      },
      quality_items,
      public_quality,
      ops: {
        reviewed_target: reviewedTarget,
        inventory_target: reviewedTarget,
        inventory,
        reviewed: by_status.reviewed,
        queued: by_status.queued,
        queued_due: dueRow?.n ?? 0,
        next_queued_at: nextQueuedRow?.next_queued_at ?? null,
        publishing: by_status.publishing,
        stale,
        stuck_threshold_min: stuckThresholdMin,
        quality_gate: qualityGateStatus(),
        session_health: channelSessionHealth(),
      },
      needs_human_posts,
      recent,
    }
  } finally {
    db.close()
  }
}

initializeApp({ projectId: FIREBASE_PROJECT_ID })
const firestore = getFirestore()
const snapshot = await collectSnapshot()
await firestore.collection('pipeline_snapshots').doc('local').set({
  ...snapshot,
  synced_at: FieldValue.serverTimestamp(),
}, { merge: true })

console.log(JSON.stringify({
  ok: true,
  project_id: FIREBASE_PROJECT_ID,
  generated_at: snapshot.generated_at,
  by_status: snapshot.by_status,
  public_quality: snapshot.public_quality,
  ops: snapshot.ops,
}, null, 2))
