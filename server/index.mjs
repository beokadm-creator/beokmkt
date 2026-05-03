import express from 'express'
import path from 'path'
import { fileURLToPath } from 'url'
import { getIdempotency, loadStore, newId, nowIso, saveStore, setIdempotency } from './store.mjs'

const app = express()
app.use(express.json({ limit: '1mb' }))

const port = process.env.PORT ? Number(process.env.PORT) : 8787

let store = await loadStore()

function ok(res, data, meta) {
  res.json({ data, meta: meta ?? {} })
}

function fail(res, status, code, message, details) {
  res.status(status).json({ error: { code, message, details } })
}

function idempotencyKey(req) {
  const v = req.header('Idempotency-Key')
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

async function withIdempotency(req, res, handler) {
  const key = idempotencyKey(req)
  if (key) {
    const cached = getIdempotency(store, key)
    if (cached) return ok(res, cached.data, cached.meta)
  }

  const result = await handler()

  if (key) {
    setIdempotency(store, key, { data: result.data, meta: result.meta })
    await saveStore(store)
  }

  return ok(res, result.data, result.meta)
}

function paginate(items, limit, offset) {
  const total = items.length
  const sliced = items.slice(offset, offset + limit)
  return { items: sliced, total, limit, offset }
}

function addAuditLog(action, target_type, target_id, actor_type = 'system') {
  store.audit_logs.unshift({
    id: newId(),
    actor_type,
    action,
    target_type,
    target_id,
    created_at: nowIso(),
  })
}

function addWorkflowEvent(event_name, entity_type, entity_id, status = 'processed', payload = null, result = null) {
  const id = newId()
  store.workflow_events.unshift({
    id,
    event_name,
    entity_type,
    entity_id,
    workflow_name: event_name,
    status,
    payload,
    result,
    created_at: nowIso(),
    processed_at: status === 'processed' ? nowIso() : null,
  })
  return id
}

async function validateApiKey(provider, apiKey) {
  if (!provider || !apiKey) {
    return { valid: false, details: 'Provider and API key are required' }
  }

  let isValid = false
  let errorDetails = ''

  try {
    let response

    switch (provider) {
      case 'openai': {
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), 5000)

        try {
          response = await fetch('https://api.openai.com/v1/models', {
            method: 'GET',
            headers: { Authorization: `Bearer ${apiKey}` },
            signal: controller.signal,
          })

          if (response.ok) {
            const data = await response.json()
            isValid = true
            errorDetails = `API 연결 성공 - ${data.object || 'models'}`
          } else {
            const errorData = await response.json().catch(() => null)
            errorDetails = errorData?.error?.message || `HTTP ${response.status}`
          }
        } catch (e) {
          if (e instanceof Error && e.name === 'AbortError') errorDetails = 'OpenAI API 요청 시간 초과 (5초)'
          else errorDetails = e instanceof Error ? `OpenAI API 오류: ${e.message}` : 'OpenAI API 연결 실패'
        } finally {
          clearTimeout(timeoutId)
        }
        break
      }

      case 'gemini': {
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), 5000)

        try {
          const models = [
            'gemini-2.0-flash-exp',
            'gemini-1.5-flash-latest',
            'gemini-1.5-flash',
            'gemini-1.5-pro-latest',
            'gemini-1.5-pro-001',
            'gemini-pro',
            'gemini-flash',
          ]

          for (const model of models) {
            try {
              response = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
                {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ contents: [{ parts: [{ text: 'hi' }] }] }),
                  signal: controller.signal,
                }
              )

              if (response.ok) {
                isValid = true
                errorDetails = `Gemini API 연결 성공 (${model})`
                break
              }

              if (response.status === 404) continue
            } catch {
              continue
            }
          }

          if (!isValid) errorDetails = 'Gemini API: 모든 모델 시도 실패 (모델 이름이 변경되었을 수 있음)'
        } catch (e) {
          if (e instanceof Error && e.name === 'AbortError') errorDetails = 'Gemini API 요청 시간 초과 (5초)'
          else errorDetails = e instanceof Error ? `Gemini API 오류: ${e.message}` : 'Gemini API 연결 실패'
        } finally {
          clearTimeout(timeoutId)
        }
        break
      }

      case 'zhipu': {
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), 5000)

        try {
          const models = ['glm-4-flash', 'glm-4-air', 'glm-4-0520', 'glm-4', 'glm-3-turbo', 'chatglm3-6b']
          let lastError = ''

          for (const model of models) {
            try {
              response = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${apiKey}`,
                },
                body: JSON.stringify({
                  model,
                  messages: [{ role: 'user', content: 'hi' }],
                  max_tokens: 10,
                }),
                signal: controller.signal,
              })

              if (response.ok) {
                isValid = true
                errorDetails = `Zhipu API 연결 성공 (${model} 모델)`
                break
              }

              const errorData = await response.json().catch(() => null)
              lastError = errorData?.error?.message || `HTTP ${response.status}`
              if (errorData?.error?.code === '1211') continue
            } catch (e) {
              lastError = e instanceof Error ? e.message : 'Unknown error'
              continue
            }
          }

          if (!isValid) errorDetails = `Zhipu API 실패: ${lastError} (모든 모델 시도 실패)`
        } catch (e) {
          if (e instanceof Error && e.name === 'AbortError') errorDetails = 'Zhipu API 요청 시간 초과 (5초)'
          else errorDetails = e instanceof Error ? `Zhipu API 오류: ${e.message}` : 'Zhipu API 연결 실패'
        } finally {
          clearTimeout(timeoutId)
        }
        break
      }

      case 'zai': {
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), 5000)

        try {
          const endpoints = [
            {
              url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
              models: ['glm-4-flash', 'glm-4-air', 'glm-4-0520', 'glm-4', 'glm-3-turbo'],
            },
            {
              url: 'https://api.z.ai/v1/chat/completions',
              models: ['glm-4-flash', 'glm-4-air', 'glm-4'],
            },
          ]

          let lastError = ''

          for (const endpoint of endpoints) {
            for (const model of endpoint.models) {
              try {
                response = await fetch(endpoint.url, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${apiKey}`,
                  },
                  body: JSON.stringify({
                    model,
                    messages: [{ role: 'user', content: 'hi' }],
                    max_tokens: 10,
                  }),
                  signal: controller.signal,
                })

                if (response.ok) {
                  isValid = true
                  errorDetails = `Z.ai API 연결 성공 (${model} 모델 - ${endpoint.url})`
                  break
                }

                const errorData = await response.json().catch(() => null)
                lastError = errorData?.error?.message || `HTTP ${response.status}`
                if (errorData?.error?.code === '1211') continue
              } catch (e) {
                lastError = e instanceof Error ? e.message : 'Unknown error'
                continue
              }
            }

            if (isValid) break
          }

          if (!isValid) errorDetails = `Z.ai API 실패: ${lastError} (모든 엔드포인트와 모델 시도 실패)`
        } catch (e) {
          if (e instanceof Error && e.name === 'AbortError') errorDetails = 'Z.ai API 요청 시간 초과 (5초)'
          else errorDetails = e instanceof Error ? `Z.ai API 오류: ${e.message}` : 'Z.ai API 연결 실패'
        } finally {
          clearTimeout(timeoutId)
        }
        break
      }

      case 'anthropic': {
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), 10000)

        try {
          const models = [
            'claude-3-5-sonnet-20241022',
            'claude-3-5-haiku-20241022',
            'claude-3-haiku-20240307',
            'claude-3-sonnet-20240229',
          ]

          for (const model of models) {
            try {
              response = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'x-api-key': apiKey,
                  'anthropic-version': '2023-06-01',
                },
                body: JSON.stringify({
                  model,
                  max_tokens: 10,
                  messages: [{ role: 'user', content: 'hi' }],
                }),
                signal: controller.signal,
              })

              if (response.ok) {
                isValid = true
                errorDetails = `Anthropic Claude API 연결 성공 (${model})`
                break
              }
            } catch {
              continue
            }
          }

          if (!isValid) {
            const errorData = await response.json().catch(() => null)
            errorDetails = errorData?.error?.message || 'Anthropic API 연결 실패'
          }
        } catch (e) {
          if (e instanceof Error && e.name === 'AbortError') errorDetails = 'Anthropic API 요청 시간 초과 (10초)'
          else errorDetails = e instanceof Error ? `Anthropic API 오류: ${e.message}` : 'Anthropic API 연결 실패'
        } finally {
          clearTimeout(timeoutId)
        }
        break
      }

      case 'cohere': {
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), 10000)

        try {
          const models = ['command-r-plus-08-2024', 'command-r-08-2024', 'command', 'command-light']

          for (const model of models) {
            try {
              response = await fetch('https://api.cohere.ai/v1/chat', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${apiKey}`,
                },
                body: JSON.stringify({ model, message: 'hi', max_tokens: 10 }),
                signal: controller.signal,
              })

              if (response.ok) {
                isValid = true
                errorDetails = `Cohere API 연결 성공 (${model})`
                break
              }
            } catch {
              continue
            }
          }

          if (!isValid) {
            const errorData = await response.json().catch(() => null)
            errorDetails = errorData?.message || 'Cohere API 연결 실패'
          }
        } catch (e) {
          if (e instanceof Error && e.name === 'AbortError') errorDetails = 'Cohere API 요청 시간 초과 (10초)'
          else errorDetails = e instanceof Error ? `Cohere API 오류: ${e.message}` : 'Cohere API 연결 실패'
        } finally {
          clearTimeout(timeoutId)
        }
        break
      }

      case 'mistral': {
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), 10000)

        try {
          const models = [
            'mistral-large-latest',
            'mistral-medium-latest',
            'mistral-small-latest',
            'codestral-latest',
            'mixtral-8x7b-32768',
          ]

          for (const model of models) {
            try {
              response = await fetch('https://api.mistral.ai/v1/chat/completions', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${apiKey}`,
                },
                body: JSON.stringify({
                  model,
                  messages: [{ role: 'user', content: 'hi' }],
                  max_tokens: 10,
                }),
                signal: controller.signal,
              })

              if (response.ok) {
                isValid = true
                errorDetails = `Mistral AI API 연결 성공 (${model})`
                break
              }
            } catch {
              continue
            }
          }

          if (!isValid) {
            const errorData = await response.json().catch(() => null)
            errorDetails = errorData?.message || 'Mistral API 연결 실패'
          }
        } catch (e) {
          if (e instanceof Error && e.name === 'AbortError') errorDetails = 'Mistral API 요청 시간 초과 (10초)'
          else errorDetails = e instanceof Error ? `Mistral API 오류: ${e.message}` : 'Mistral API 연결 실패'
        } finally {
          clearTimeout(timeoutId)
        }
        break
      }

      default:
        return { valid: false, details: 'Unknown provider' }
    }
  } catch (e) {
    return { valid: false, details: e instanceof Error ? e.message : 'Network error' }
  }

  return { valid: isValid, details: isValid ? 'API 연결 성공' : errorDetails }
}

app.get('/api/health', (req, res) => {
  ok(res, { ok: true })
})

app.get('/api/dashboard', (req, res) => {
  const sourceTotal = store.source_items.length
  const sourceEligible = store.source_items.filter((s) => s.status === 'eligible').length
  const sourceIneligible = store.source_items.filter((s) => s.status === 'ineligible').length

  const ideaTotal = store.short_ideas.length
  const ideaAwaiting = store.short_ideas.filter((s) => s.status === 'awaiting_review').length
  const ideaApproved = store.short_ideas.filter((s) => s.status === 'approved').length
  const ideaRejected = store.short_ideas.filter((s) => s.status === 'rejected').length

  const scriptTotal = store.scripts.length
  const scriptAwaiting = store.scripts.filter((s) => s.status === 'awaiting_review').length
  const scriptApproved = store.scripts.filter((s) => s.status === 'approved').length
  const scriptRevision = store.scripts.filter((s) => s.status === 'revision_required').length

  ok(res, {
    source_items: { total: sourceTotal, eligible: sourceEligible, ineligible: sourceIneligible },
    short_ideas: { total: ideaTotal, awaiting_review: ideaAwaiting, approved: ideaApproved, rejected: ideaRejected },
    scripts: { total: scriptTotal, awaiting_review: scriptAwaiting, approved: scriptApproved, revision_required: scriptRevision },
  })
})

app.get('/api/test-ai-key', async (req, res) => {
  const provider = req.query.provider
  const apiKey = req.query.apiKey
  const result = await validateApiKey(provider, apiKey)
  res.status(result.valid ? 200 : 400).json(result)
})

app.post('/api/test-ai-key', async (req, res) => {
  const provider = req.body?.provider ?? req.query.provider
  const apiKey = req.body?.apiKey ?? req.query.apiKey
  const result = await validateApiKey(provider, apiKey)
  res.status(result.valid ? 200 : 400).json(result)
})

app.post('/api/source-items/import', async (req, res) => {
  await withIdempotency(req, res, async () => {
    const body = req.body ?? {}
    const title = typeof body.title === 'string' ? body.title.trim() : ''
    const content = typeof body.body === 'string' ? body.body.trim() : ''
    const source_type = typeof body.source_type === 'string' ? body.source_type : 'manual'

    if (!title || !content) throw new Error('validation')

    const id = newId()
    const created_at = nowIso()
    const status = source_type === 'blog' ? 'received' : 'eligible'

    store.source_items.unshift({
      id,
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
      status,
      created_at,
      updated_at: created_at,
      deleted_at: null,
    })

    addAuditLog('source_item.import', 'source_item', id)
    await saveStore(store)

    return { data: { id, status }, meta: {} }
  }).catch(() => fail(res, 400, 'VALIDATION_ERROR', 'invalid input', {}))
})

app.get('/api/source-items', (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 20) || 20, 100)
  const offset = Number(req.query.offset ?? 0) || 0
  const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : ''
  const status = typeof req.query.status === 'string' ? req.query.status : ''
  const source_type = typeof req.query.source_type === 'string' ? req.query.source_type : ''

  let items = store.source_items.filter((s) => !s.deleted_at)
  if (q) items = items.filter((s) => String(s.title).toLowerCase().includes(q))
  if (status) items = items.filter((s) => s.status === status)
  if (source_type) items = items.filter((s) => s.source_type === source_type)

  const page = paginate(items, limit, offset)
  ok(res, page)
})

app.get('/api/source-items/:id', (req, res) => {
  const id = req.params.id
  const item = store.source_items.find((s) => s.id === id && !s.deleted_at)
  if (!item) return fail(res, 404, 'NOT_FOUND', 'source item not found', {})

  const ideas = store.short_ideas.filter((x) => x.source_item_id === id && !x.deleted_at)
  const summary = {
    total: ideas.length,
    awaiting_review: ideas.filter((x) => x.status === 'awaiting_review').length,
    approved: ideas.filter((x) => x.status === 'approved').length,
    rejected: ideas.filter((x) => x.status === 'rejected').length,
  }

  ok(res, { ...item, short_ideas_summary: summary })
})

app.post('/api/source-items/:id/generate-ideas', async (req, res) => {
  const id = req.params.id
  const item = store.source_items.find((s) => s.id === id && !s.deleted_at)
  if (!item) return fail(res, 404, 'NOT_FOUND', 'source item not found', {})
  if (item.status !== 'eligible') return fail(res, 422, 'WORKFLOW_NOT_READY', 'source item is not eligible', {})

  await withIdempotency(req, res, async () => {
    const count = Math.max(1, Math.min(Number(req.body?.count ?? 5) || 5, 10))
    const workflow_event_id = addWorkflowEvent('source_items.generate_ideas', 'source_item', id, 'processed', {
      count,
    })

    for (let i = 0; i < count; i += 1) {
      const ideaId = newId()
      store.short_ideas.unshift({
        id: ideaId,
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
        created_at: nowIso(),
        updated_at: nowIso(),
        deleted_at: null,
      })

      addAuditLog('short_idea.generated', 'short_idea', ideaId)
    }

    await saveStore(store)
    return { data: { workflow_event_id, status: 'processing' }, meta: {} }
  }).catch(() => fail(res, 400, 'VALIDATION_ERROR', 'invalid input', {}))
})

app.get('/api/short-ideas', (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 20) || 20, 100)
  const offset = Number(req.query.offset ?? 0) || 0
  const status = typeof req.query.status === 'string' ? req.query.status : ''
  const source_item_id = typeof req.query.source_item_id === 'string' ? req.query.source_item_id : ''

  let items = store.short_ideas.filter((s) => !s.deleted_at)
  if (status) items = items.filter((s) => s.status === status)
  if (source_item_id) items = items.filter((s) => s.source_item_id === source_item_id)

  const page = paginate(items, limit, offset)
  ok(res, page)
})

app.get('/api/short-ideas/:id', (req, res) => {
  const id = req.params.id
  const idea = store.short_ideas.find((s) => s.id === id && !s.deleted_at)
  if (!idea) return fail(res, 404, 'NOT_FOUND', 'short idea not found', {})
  ok(res, idea)
})

app.post('/api/short-ideas/:id/approve', async (req, res) => {
  const id = req.params.id
  const idea = store.short_ideas.find((s) => s.id === id && !s.deleted_at)
  if (!idea) return fail(res, 404, 'NOT_FOUND', 'short idea not found', {})
  if (idea.status !== 'awaiting_review') return fail(res, 409, 'CONFLICT', 'not in awaiting_review', {})

  idea.status = 'approved'
  idea.updated_at = nowIso()

  store.approvals.unshift({
    id: newId(),
    entity_type: 'short_idea',
    entity_id: id,
    approval_stage: 'idea_review',
    decision: 'approved',
    reviewer_id: null,
    reviewer_name: null,
    comment: req.body?.comment ?? null,
    requested_at: nowIso(),
    decided_at: nowIso(),
    created_at: nowIso(),
    updated_at: nowIso(),
  })

  addAuditLog('short_idea.approved', 'short_idea', id, 'user')
  await saveStore(store)
  ok(res, { id, status: idea.status })
})

app.post('/api/short-ideas/:id/reject', async (req, res) => {
  const id = req.params.id
  const idea = store.short_ideas.find((s) => s.id === id && !s.deleted_at)
  if (!idea) return fail(res, 404, 'NOT_FOUND', 'short idea not found', {})
  if (idea.status !== 'awaiting_review') return fail(res, 409, 'CONFLICT', 'not in awaiting_review', {})

  idea.status = 'rejected'
  idea.rejection_reason = typeof req.body?.reason === 'string' ? req.body.reason : 'rejected'
  idea.updated_at = nowIso()

  store.approvals.unshift({
    id: newId(),
    entity_type: 'short_idea',
    entity_id: id,
    approval_stage: 'idea_review',
    decision: 'rejected',
    reviewer_id: null,
    reviewer_name: null,
    comment: req.body?.comment ?? null,
    requested_at: nowIso(),
    decided_at: nowIso(),
    created_at: nowIso(),
    updated_at: nowIso(),
  })

  addAuditLog('short_idea.rejected', 'short_idea', id, 'user')
  await saveStore(store)
  ok(res, { id, status: idea.status })
})

app.post('/api/short-ideas/:id/generate-script', async (req, res) => {
  const id = req.params.id
  const idea = store.short_ideas.find((s) => s.id === id && !s.deleted_at)
  if (!idea) return fail(res, 404, 'NOT_FOUND', 'short idea not found', {})
  if (idea.status !== 'approved') return fail(res, 422, 'WORKFLOW_NOT_READY', 'idea is not approved', {})

  await withIdempotency(req, res, async () => {
    const duration_sec = Number(req.body?.duration_sec ?? idea.target_duration_sec) || 30
    const workflow_event_id = addWorkflowEvent('short_ideas.generate_script', 'short_idea', id, 'processed', {
      duration_sec,
    })

    const nextVersion =
      store.scripts.filter((s) => s.short_idea_id === id).reduce((m, s) => Math.max(m, s.version), 0) + 1
    const scriptId = newId()

    store.scripts.unshift({
      id: scriptId,
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
      created_at: nowIso(),
      updated_at: nowIso(),
      deleted_at: null,
    })

    addAuditLog('script.generated', 'script', scriptId)
    await saveStore(store)
    return { data: { workflow_event_id, status: 'processing' }, meta: {} }
  }).catch(() => fail(res, 400, 'VALIDATION_ERROR', 'invalid input', {}))
})

app.get('/api/scripts', (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 20) || 20, 100)
  const offset = Number(req.query.offset ?? 0) || 0
  const status = typeof req.query.status === 'string' ? req.query.status : ''
  const short_idea_id = typeof req.query.short_idea_id === 'string' ? req.query.short_idea_id : ''

  let items = store.scripts.filter((s) => !s.deleted_at)
  if (status) items = items.filter((s) => s.status === status)
  if (short_idea_id) items = items.filter((s) => s.short_idea_id === short_idea_id)

  const page = paginate(items, limit, offset)
  ok(res, page)
})

app.get('/api/scripts/:id', (req, res) => {
  const id = req.params.id
  const script = store.scripts.find((s) => s.id === id && !s.deleted_at)
  if (!script) return fail(res, 404, 'NOT_FOUND', 'script not found', {})
  ok(res, script)
})

app.post('/api/scripts/:id/approve', async (req, res) => {
  const id = req.params.id
  const script = store.scripts.find((s) => s.id === id && !s.deleted_at)
  if (!script) return fail(res, 404, 'NOT_FOUND', 'script not found', {})
  if (script.status !== 'awaiting_review') return fail(res, 409, 'CONFLICT', 'not in awaiting_review', {})

  script.status = 'approved'
  script.fact_check_status =
    typeof req.body?.fact_check_status === 'string' ? req.body.fact_check_status : script.fact_check_status
  script.updated_at = nowIso()

  store.approvals.unshift({
    id: newId(),
    entity_type: 'script',
    entity_id: id,
    approval_stage: 'script_review',
    decision: 'approved',
    reviewer_id: null,
    reviewer_name: null,
    comment: req.body?.comment ?? null,
    requested_at: nowIso(),
    decided_at: nowIso(),
    created_at: nowIso(),
    updated_at: nowIso(),
  })

  addAuditLog('script.approved', 'script', id, 'user')
  await saveStore(store)
  ok(res, { id, status: script.status })
})

app.post('/api/scripts/:id/request-revision', async (req, res) => {
  const id = req.params.id
  const script = store.scripts.find((s) => s.id === id && !s.deleted_at)
  if (!script) return fail(res, 404, 'NOT_FOUND', 'script not found', {})
  if (script.status !== 'awaiting_review') return fail(res, 409, 'CONFLICT', 'not in awaiting_review', {})

  await withIdempotency(req, res, async () => {
    script.status = 'revision_required'
    script.revision_reason = typeof req.body?.reason === 'string' ? req.body.reason : 'revision_required'
    script.updated_at = nowIso()

    const nextVersion =
      store.scripts.filter((s) => s.short_idea_id === script.short_idea_id).reduce((m, s) => Math.max(m, s.version), 0) + 1
    const newScriptId = newId()

    store.scripts.unshift({
      ...script,
      id: newScriptId,
      version: nextVersion,
      status: 'awaiting_review',
      revision_reason: typeof req.body?.instructions === 'string' ? req.body.instructions : null,
      created_at: nowIso(),
      updated_at: nowIso(),
      deleted_at: null,
    })

    store.approvals.unshift({
      id: newId(),
      entity_type: 'script',
      entity_id: id,
      approval_stage: 'script_review',
      decision: 'changes_requested',
      reviewer_id: null,
      reviewer_name: null,
      comment: req.body?.comment ?? null,
      requested_at: nowIso(),
      decided_at: nowIso(),
      created_at: nowIso(),
      updated_at: nowIso(),
    })

    addAuditLog('script.revision_requested', 'script', id, 'user')
    await saveStore(store)
    return { data: { id, status: 'revision_required', new_script_id: newScriptId }, meta: {} }
  }).catch(() => fail(res, 400, 'VALIDATION_ERROR', 'invalid input', {}))
})

app.post('/api/render-jobs', async (req, res) => {
  await withIdempotency(req, res, async () => {
    const body = req.body ?? {}
    const script_id = typeof body.script_id === 'string' ? body.script_id : ''
    const template_id = typeof body.template_id === 'string' ? body.template_id : null
    const render_profile = typeof body.render_profile === 'string' ? body.render_profile : 'shorts_1080x1920'

    const script = store.scripts.find((s) => s.id === script_id && !s.deleted_at)
    if (!script) throw new Error('validation')

    const id = newId()
    const created_at = nowIso()

    store.render_jobs.unshift({
      id,
      script_id,
      short_idea_id: script.short_idea_id,
      template_id,
      render_profile,
      status: 'queued',
      qc_status: 'pending',
      retry_count: 0,
      error_message: null,
      output: null,
      created_at,
      updated_at: created_at,
      deleted_at: null,
    })

    addAuditLog('render_job.created', 'render_job', id, 'user')
    await saveStore(store)
    return { data: { id, status: 'queued' }, meta: {} }
  }).catch(() => fail(res, 400, 'VALIDATION_ERROR', 'invalid input', {}))
})

app.get('/api/render-jobs', (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 20) || 20, 100)
  const offset = Number(req.query.offset ?? 0) || 0
  const status = typeof req.query.status === 'string' ? req.query.status : ''
  const script_id = typeof req.query.script_id === 'string' ? req.query.script_id : ''

  let items = store.render_jobs.filter((s) => !s.deleted_at)
  if (status) items = items.filter((s) => s.status === status)
  if (script_id) items = items.filter((s) => s.script_id === script_id)

  const page = paginate(items, limit, offset)
  ok(res, page)
})

app.get('/api/render-jobs/:id', (req, res) => {
  const id = req.params.id
  const job = store.render_jobs.find((s) => s.id === id && !s.deleted_at)
  if (!job) return fail(res, 404, 'NOT_FOUND', 'render job not found', {})
  ok(res, job)
})

app.post('/api/render-jobs/:id/retry', async (req, res) => {
  const id = req.params.id
  const job = store.render_jobs.find((s) => s.id === id && !s.deleted_at)
  if (!job) return fail(res, 404, 'NOT_FOUND', 'render job not found', {})

  job.status = 'queued'
  job.retry_count = (job.retry_count ?? 0) + 1
  job.error_message = null
  job.updated_at = nowIso()

  addAuditLog('render_job.retry', 'render_job', id, 'user')
  await saveStore(store)
  ok(res, { id, status: job.status, retry_count: job.retry_count })
})

app.post('/api/render-jobs/:id/approve-for-publish', async (req, res) => {
  const id = req.params.id
  const job = store.render_jobs.find((s) => s.id === id && !s.deleted_at)
  if (!job) return fail(res, 404, 'NOT_FOUND', 'render job not found', {})

  job.qc_status = 'passed'
  job.updated_at = nowIso()

  store.approvals.unshift({
    id: newId(),
    entity_type: 'render_job',
    entity_id: id,
    approval_stage: 'render_review',
    decision: 'approved',
    reviewer_id: null,
    reviewer_name: null,
    comment: req.body?.comment ?? null,
    requested_at: nowIso(),
    decided_at: nowIso(),
    created_at: nowIso(),
    updated_at: nowIso(),
  })

  addAuditLog('render_job.approved_for_publish', 'render_job', id, 'user')
  await saveStore(store)
  ok(res, { id, qc_status: job.qc_status })
})

app.post('/api/publish-jobs', async (req, res) => {
  await withIdempotency(req, res, async () => {
    const body = req.body ?? {}
    const render_job_id = typeof body.render_job_id === 'string' ? body.render_job_id : ''
    const platform = typeof body.platform === 'string' ? body.platform : 'youtube'
    const platform_account_id = typeof body.platform_account_id === 'string' ? body.platform_account_id : null

    const renderJob = store.render_jobs.find((s) => s.id === render_job_id && !s.deleted_at)
    if (!renderJob) throw new Error('validation')
    if (renderJob.qc_status !== 'passed') throw new Error('not_ready')

    const id = newId()
    const created_at = nowIso()

    store.publish_jobs.unshift({
      id,
      render_job_id,
      platform,
      platform_account_id,
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
      created_at,
      updated_at: created_at,
      deleted_at: null,
    })

    addAuditLog('publish_job.created', 'publish_job', id, 'user')
    await saveStore(store)
    return { data: { id, status: 'awaiting_approval' }, meta: {} }
  }).catch((e) => {
    if (e instanceof Error && e.message === 'not_ready') return fail(res, 422, 'WORKFLOW_NOT_READY', 'render job not approved', {})
    return fail(res, 400, 'VALIDATION_ERROR', 'invalid input', {})
  })
})

app.get('/api/publish-jobs', (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 20) || 20, 100)
  const offset = Number(req.query.offset ?? 0) || 0
  const status = typeof req.query.status === 'string' ? req.query.status : ''
  const platform = typeof req.query.platform === 'string' ? req.query.platform : ''

  let items = store.publish_jobs.filter((s) => !s.deleted_at)
  if (status) items = items.filter((s) => s.status === status)
  if (platform) items = items.filter((s) => s.platform === platform)

  const page = paginate(items, limit, offset)
  ok(res, page)
})

app.get('/api/publish-jobs/:id', (req, res) => {
  const id = req.params.id
  const job = store.publish_jobs.find((s) => s.id === id && !s.deleted_at)
  if (!job) return fail(res, 404, 'NOT_FOUND', 'publish job not found', {})
  ok(res, job)
})

app.post('/api/publish-jobs/:id/approve', async (req, res) => {
  const id = req.params.id
  const job = store.publish_jobs.find((s) => s.id === id && !s.deleted_at)
  if (!job) return fail(res, 404, 'NOT_FOUND', 'publish job not found', {})
  if (job.status !== 'awaiting_approval') return fail(res, 409, 'CONFLICT', 'not in awaiting_approval', {})

  job.status = 'queued'
  job.updated_at = nowIso()

  store.approvals.unshift({
    id: newId(),
    entity_type: 'publish_job',
    entity_id: id,
    approval_stage: 'publish_review',
    decision: 'approved',
    reviewer_id: null,
    reviewer_name: null,
    comment: req.body?.comment ?? null,
    requested_at: nowIso(),
    decided_at: nowIso(),
    created_at: nowIso(),
    updated_at: nowIso(),
  })

  addAuditLog('publish_job.approved', 'publish_job', id, 'user')
  await saveStore(store)
  ok(res, { id, status: job.status })
})

app.post('/api/publish-jobs/:id/retry', async (req, res) => {
  const id = req.params.id
  const job = store.publish_jobs.find((s) => s.id === id && !s.deleted_at)
  if (!job) return fail(res, 404, 'NOT_FOUND', 'publish job not found', {})

  job.status = 'queued'
  job.retry_count = (job.retry_count ?? 0) + 1
  job.error_message = null
  job.updated_at = nowIso()

  addAuditLog('publish_job.retry', 'publish_job', id, 'user')
  await saveStore(store)
  ok(res, { id, status: job.status, retry_count: job.retry_count })
})

app.post('/api/publish-jobs/:id/cancel', async (req, res) => {
  const id = req.params.id
  const job = store.publish_jobs.find((s) => s.id === id && !s.deleted_at)
  if (!job) return fail(res, 404, 'NOT_FOUND', 'publish job not found', {})

  job.status = 'cancelled'
  job.updated_at = nowIso()

  addAuditLog('publish_job.cancelled', 'publish_job', id, 'user')
  await saveStore(store)
  ok(res, { id, status: job.status })
})

app.get('/api/platform-accounts', (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 20) || 20, 100)
  const offset = Number(req.query.offset ?? 0) || 0
  const page = paginate(store.platform_accounts.filter((x) => !x.deleted_at), limit, offset)
  ok(res, page)
})

app.post('/api/platform-accounts/mock-connect', async (req, res) => {
  const body = req.body ?? {}
  const platform = typeof body.platform === 'string' ? body.platform : 'youtube'
  const account_name = typeof body.account_name === 'string' ? body.account_name : `${platform}-demo`

  const id = newId()
  const created_at = nowIso()
  store.platform_accounts.unshift({
    id,
    platform,
    account_name,
    status: 'connected',
    access_token_expires_at: null,
    created_at,
    updated_at: created_at,
    deleted_at: null,
  })

  addAuditLog('platform_account.connected', 'platform_account', id, 'user')
  await saveStore(store)
  ok(res, { id, platform, account_name, status: 'connected' })
})

app.get('/api/audit-logs', (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 20) || 20, 100)
  const offset = Number(req.query.offset ?? 0) || 0
  const page = paginate(store.audit_logs, limit, offset)
  ok(res, page)
})

if (process.env.NODE_ENV === 'production') {
  const __filename = fileURLToPath(import.meta.url)
  const __dirname = path.dirname(__filename)
  const distDir = path.resolve(__dirname, '..', 'dist')

  app.use(express.static(distDir))
  app.get('*', (req, res) => {
    res.sendFile(path.join(distDir, 'index.html'))
  })
}

app.listen(port, () => {
  console.log(`API server listening on http://localhost:${port}`)
})
