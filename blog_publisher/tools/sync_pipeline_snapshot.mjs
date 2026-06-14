import 'dotenv/config'
import path from 'path'
import os from 'os'
import { fileURLToPath } from 'url'
import Database from 'better-sqlite3'
import { initializeApp } from 'firebase-admin/app'
import { FieldValue, getFirestore } from 'firebase-admin/firestore'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DB_PATH = path.resolve(__dirname, '../db/blog.db')
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'beokmkt'
const ALL_STATUSES = ['draft', 'generating', 'factchecking', 'reviewing', 'reviewed', 'queued', 'publishing', 'published', 'needs_human', 'failed', 'archived']
const CHANNELS = ['naver', 'tistory', 'selfhosted']

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

function collectSnapshot() {
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
    ).all().map((post) => ({
      id: post.id,
      topic: post.title || post.topic || '',
      title: post.title || post.topic || '',
      channel: post.channel,
      status: post.status,
      last_error: post.last_error || null,
      published_url: post.published_url || null,
      quality: pipelineQuality(post.body, post.grounding_ratio),
      updated_at: post.updated_at,
    }))
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
      ops: {
        reviewed_target: reviewedTarget,
        reviewed: by_status.reviewed,
        queued: by_status.queued,
        queued_due: dueRow?.n ?? 0,
        next_queued_at: nextQueuedRow?.next_queued_at ?? null,
        publishing: by_status.publishing,
        stale,
        stuck_threshold_min: stuckThresholdMin,
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
const snapshot = collectSnapshot()
await firestore.collection('pipeline_snapshots').doc('local').set({
  ...snapshot,
  synced_at: FieldValue.serverTimestamp(),
}, { merge: true })

console.log(JSON.stringify({
  ok: true,
  project_id: FIREBASE_PROJECT_ID,
  generated_at: snapshot.generated_at,
  by_status: snapshot.by_status,
  ops: snapshot.ops,
}, null, 2))
