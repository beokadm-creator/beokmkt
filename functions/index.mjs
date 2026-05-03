import express from 'express'
import { onRequest } from 'firebase-functions/v2/https'
import { initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { FieldValue, getFirestore } from 'firebase-admin/firestore'
import { randomUUID } from 'crypto'

initializeApp()
const db = getFirestore()

const app = express()
app.use(express.json({ limit: '1mb' }))

app.use(async (req, res, next) => {
  if (req.path === '/api/health') return next()

  const header = req.header('Authorization') ?? ''
  const m = header.match(/^Bearer\s+(.+)$/)
  const token = m?.[1]
  if (!token) return fail(res, 401, 'UNAUTHENTICATED', 'missing token', {})

  try {
    const decoded = await getAuth().verifyIdToken(token)
    req.user = decoded
    return next()
  } catch {
    return fail(res, 401, 'UNAUTHENTICATED', 'invalid token', {})
  }
})

function ok(res, data, meta) {
  res.json({ data, meta: meta ?? {} })
}

function fail(res, status, code, message, details) {
  res.status(status).json({ error: { code, message, details } })
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

async function addAuditLog(action, target_type, target_id, actor_type = 'system') {
  await db.collection('audit_logs').add({
    actor_type,
    action,
    target_type,
    target_id,
    created_at: FieldValue.serverTimestamp(),
  })
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

app.get('/api/dashboard', async (req, res) => {
  const [sourceSnap, ideaSnap, scriptSnap] = await Promise.all([
    db.collection('source_items').get(),
    db.collection('short_ideas').get(),
    db.collection('scripts').get(),
  ])

  const source_items = sourceSnap.docs.map((d) => d.data())
  const short_ideas = ideaSnap.docs.map((d) => d.data())
  const scripts = scriptSnap.docs.map((d) => d.data())

  ok(res, {
    source_items: {
      total: source_items.length,
      eligible: source_items.filter((x) => x.status === 'eligible').length,
      ineligible: source_items.filter((x) => x.status === 'ineligible').length,
    },
    short_ideas: {
      total: short_ideas.length,
      awaiting_review: short_ideas.filter((x) => x.status === 'awaiting_review').length,
      approved: short_ideas.filter((x) => x.status === 'approved').length,
      rejected: short_ideas.filter((x) => x.status === 'rejected').length,
    },
    scripts: {
      total: scripts.length,
      awaiting_review: scripts.filter((x) => x.status === 'awaiting_review').length,
      approved: scripts.filter((x) => x.status === 'approved').length,
      revision_required: scripts.filter((x) => x.status === 'revision_required').length,
    },
  })
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

export const api = onRequest(app)
