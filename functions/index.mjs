import express from 'express'
import { onRequest } from 'firebase-functions/v2/https'
import { onSchedule } from 'firebase-functions/v2/scheduler'
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
    zai: 'glm-4-flash',
  }
  return table[provider] ?? 'gpt-4o-mini'
}

function resolveAiConfig(body = {}) {
  const provider = typeof body.ai_provider === 'string' ? body.ai_provider.trim() : process.env.AI_PROVIDER ?? ''
  const apiKey = typeof body.ai_api_key === 'string' ? body.ai_api_key.trim() : process.env.AI_API_KEY ?? ''
  const model = typeof body.ai_model === 'string' ? body.ai_model.trim() : process.env.AI_MODEL ?? defaultModelForProvider(provider)
  return { provider, apiKey, model }
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

  const content = data?.choices?.[0]?.message?.content
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) return content.map((item) => item?.text ?? '').filter(Boolean).join('\n').trim()
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
    zai: 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions',
  }
  return table[provider] ?? ''
}

async function validateApiKey(provider, apiKey, endpointOverride = '') {
  if (!provider || !apiKey) {
    return {
      valid: false,
      details: 'Provider and API key are required',
      diagnostics: { provider, endpoint: endpointOverride || defaultTestEndpointForProvider(provider), http_status: null },
    }
  }

  let isValid = false
  let errorDetails = ''
  let httpStatus = null
  let usedEndpoint = endpointOverride || defaultTestEndpointForProvider(provider)

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
        const models = ['gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-2.0-flash-exp']
        for (const model of models) {
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
            model: 'glm-4-flash',
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 10,
          }),
        })
        httpStatus = response.status

        if (response.ok) {
          isValid = true
          errorDetails = 'Zhipu API 연결 성공 (glm-4-flash)'
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
            model: 'glm-4-flash',
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 10,
          }),
        })
        httpStatus = response.status

        if (response.ok) {
          isValid = true
          errorDetails = 'Z.ai API 연결 성공 (glm-4-flash)'
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
            model: 'claude-3-5-sonnet-20241022',
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
            model: 'command-r',
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
            model: 'mistral-small-latest',
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
          diagnostics: { provider, endpoint: usedEndpoint, http_status: httpStatus },
        }
    }
  } catch (e) {
    return {
      valid: false,
      details: e instanceof Error ? e.message : 'Network error',
      diagnostics: { provider, endpoint: usedEndpoint, http_status: httpStatus },
    }
  }

  return {
    valid: isValid,
    details: isValid ? 'API 연결 성공' : errorDetails,
    diagnostics: { provider, endpoint: usedEndpoint, http_status: httpStatus },
  }
}

async function generateAiText(config, systemPrompt, userPrompt) {
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
    zai: 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions',
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
  const lengthGuide = {
    short: '300~500자, 2~3개 섹션',
    medium: '800~1500자, 4~6개 섹션',
    long: '2000~4000자, 6~10개 섹션',
  }
  const targetLen = lengthGuide[options.target_length] ?? lengthGuide.medium

  const systemPrompt = `You are a professional Korean content writer for a marketing company blog.
Generate engaging, SEO-optimized blog posts in Korean.
Return strict JSON only with keys: html, excerpt, seo_title, seo_description, tags.
The html must use semantic HTML (h2, h3, p, ul, li, strong, em, blockquote). Do NOT wrap in code blocks.`

  const userPrompt = [
    `Title: ${options.title}`,
    `Topic: ${options.topic}`,
    `Tone: ${options.tone}`,
    `Target length: ${targetLen}`,
    `Keywords: ${options.keywords?.join(', ') ?? ''}`,
    options.source_text ? `Reference material:\n${options.source_text}` : '',
    '',
    'Requirements:',
    '- Write in natural, professional Korean',
    '- Use semantic HTML (h2, h3, p, ul, li, strong, blockquote)',
    '- Include a compelling introduction',
    '- End with a clear conclusion or CTA',
    '- SEO-friendly structure with proper heading hierarchy',
    '- Do NOT use markdown, only HTML',
    '',
    'Return JSON: { "html": "...", "excerpt": "...", "seo_title": "...", "seo_description": "...", "tags": ["..."] }',
  ]
    .filter(Boolean)
    .join('\n')

  const text = await generateAiText(config, systemPrompt, userPrompt)
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
  const result = await validateApiKey(provider, apiKey, endpoint)
  res.json(result)
})

app.post('/api/test-ai-key', async (req, res) => {
  const provider = typeof req.body?.provider === 'string' ? req.body.provider : typeof req.query.provider === 'string' ? req.query.provider : ''
  const apiKey = typeof req.body?.apiKey === 'string' ? req.body.apiKey : typeof req.query.apiKey === 'string' ? req.query.apiKey : ''
  const endpoint =
    typeof req.body?.endpoint === 'string' ? req.body.endpoint : typeof req.query.endpoint === 'string' ? req.query.endpoint : ''
  const result = await validateApiKey(provider, apiKey, endpoint)
  res.json(result)
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
    const aiConfig = resolveAiConfig(body)
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
    const aiConfig = resolveAiConfig(body)
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

    await addAuditLog('source_item.ai_generated_ideas', 'source_item', sourceItemId, 'ai')
    return { data: { source_item_id: sourceItemId, idea_ids: ideaIds, lead_idea_id: leadIdeaId }, meta: {} }
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
    const aiConfig = resolveAiConfig(body)

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
    await addAuditLog('script.generated', 'script', scriptId, 'ai')
    if (autoApprove) {
      await addApprovalRecord('script', scriptId, 'script_review', 'approved', 'AI auto approval')
      await addAuditLog('script.auto_approved', 'script', scriptId, 'ai')
    }

    return { data: { short_idea_id: shortIdeaId, script_id: scriptId, status: autoApprove ? 'approved' : 'awaiting_review' }, meta: {} }
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
    const aiConfig = resolveAiConfig(body)

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
    await addAuditLog('publish_job.created', 'publish_job', publishJobId, 'ai')
    if (autoApprove) {
      await addApprovalRecord('publish_job', publishJobId, 'publish_review', 'approved', 'AI auto approval')
      await addAuditLog('publish_job.auto_approved', 'publish_job', publishJobId, 'ai')
    }

    return { data: { render_job_id: renderJobId, publish_job_id: publishJobId, status: publishStatus }, meta: {} }
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
    const aiConfig = resolveAiConfig(body)
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

    await addAuditLog('source_item.ai_pipeline_run', 'source_item', sourceItemId, 'ai')
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
      meta: {},
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
        const aiConfig = resolveAiConfig(body)
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

        await addAuditLog('source_item.ai_pipeline_run', 'source_item', sourceItemId, 'ai')
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
      meta: {},
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
  const limit = Math.min(parseLimit(req, 20), 100)
  const offset = parseOffset(req)
  const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : ''
  const status = typeof req.query.status === 'string' ? req.query.status.trim() : ''
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

app.get('/api/blog-posts/:id', async (req, res) => {
  const snap = await db.collection('blog_posts').doc(req.params.id).get()
  if (!snap.exists) return fail(res, 404, 'NOT_FOUND', 'blog post not found', {})

  const post = { id: snap.id, ...snap.data() }
  if (post.deleted_at) return fail(res, 404, 'NOT_FOUND', 'blog post not found', {})
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
    if (!htmlContent && body.ai_generate !== false) {
      const aiConfig = resolveAiConfig(body)
      const aiResult = await generateBlogPostWithAi(aiConfig, {
        title,
        topic: body.topic ?? title,
        tone: body.tone ?? 'professional',
        keywords: Array.isArray(body.keywords) ? body.keywords : [],
        source_text: body.source_text ?? '',
        language: body.language ?? 'ko',
        target_length: body.target_length ?? 'medium',
      }).catch(() => null)
      if (typeof aiResult?.html === 'string') htmlContent = aiResult.html
    }

    const post = {
      title,
      content: htmlContent,
      excerpt: typeof body.excerpt === 'string' ? body.excerpt : '',
      category: typeof body.category === 'string' ? body.category : 'general',
      tags: Array.isArray(body.tags) ? body.tags : [],
      slug:
        typeof body.slug === 'string' && body.slug.trim()
          ? body.slug
          : title
              .toLowerCase()
              .replace(/[^a-z0-9가-힣]+/g, '-')
              .replace(/^-|-$/g, '')
              .slice(0, 100),
      featured_image: typeof body.featured_image === 'string' ? body.featured_image : null,
      status,
      language: typeof body.language === 'string' ? body.language : 'ko',
      tone: typeof body.tone === 'string' ? body.tone : 'professional',
      seo_title: typeof body.seo_title === 'string' ? body.seo_title : title,
      seo_description: typeof body.seo_description === 'string' ? body.seo_description : '',
      published_at: status === 'published' ? now : null,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    }

    if (!post.excerpt && typeof htmlContent === 'string') {
      post.excerpt = htmlContent.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180)
    }

    await db.collection('blog_posts').doc(id).set(post)
    await addAuditLog('blog_post.created', 'blog_post', id, body.ai_generate !== false ? 'ai' : 'user')
    return { data: { id, ...post }, meta: {} }
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
    'tags',
    'slug',
    'featured_image',
    'status',
    'language',
    'tone',
    'seo_title',
    'seo_description',
  ]
  const patch = {}

  for (const key of updatable) {
    if (key in body) patch[key] = body[key]
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
  ok(res, { id: updatedSnap.id, ...updatedSnap.data() })
})

app.post('/api/blog-posts/:id/generate-content', async (req, res) => {
  await withIdempotency(req, res, async () => {
    const ref = db.collection('blog_posts').doc(req.params.id)
    const snap = await ref.get()
    if (!snap.exists) throw new Error('blog_post_not_found')

    const post = snap.data() ?? {}
    if (post.deleted_at) throw new Error('blog_post_not_found')

    const body = req.body ?? {}
    const aiConfig = resolveAiConfig(body)
    const aiResult = await generateBlogPostWithAi(aiConfig, {
      title: post.title,
      topic: body.topic ?? post.title,
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
    await addAuditLog('blog_post.ai_generated', 'blog_post', req.params.id, 'ai')
    const updatedSnap = await ref.get()
    return { data: { id: updatedSnap.id, ...updatedSnap.data() }, meta: {} }
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

export const api = onRequest(app)

export const aiRetrySweep = onSchedule({ schedule: 'every 10 minutes' }, async () => {
  await runRetrySweep({ job_type: 'all', only_due: true, limit: 20 }, 'system')
})

export const aiPlatformAccountSweep = onSchedule({ schedule: 'every 30 minutes' }, async () => {
  await runPlatformAccountSweep({ limit: 50, warning_window_minutes: 60 }, 'system')
})
