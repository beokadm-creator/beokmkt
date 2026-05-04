import 'dotenv/config'
import express from 'express'
import { initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import path from 'path'
import { fileURLToPath } from 'url'
import crypto from 'crypto'
import { getIdempotency, loadStore, newId, nowIso, saveStore, setIdempotency } from './store.mjs'

initializeApp()

const app = express()
app.use(express.json({ limit: '1mb' }))

const port = process.env.PORT ? Number(process.env.PORT) : 8787
const adminEmailAllowlist = String(process.env.ADMIN_EMAILS ?? process.env.ALLOWED_ADMIN_EMAILS ?? '')
  .split(',')
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean)
const adminUidAllowlist = String(process.env.ADMIN_UIDS ?? process.env.ALLOWED_ADMIN_UIDS ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)

let store = await loadStore()

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

function ok(res, data, meta) {
  res.json({ data, meta: meta ?? {} })
}

function fail(res, status, code, message, details) {
  res.status(status).json({ error: { code, message, details } })
}

app.use(async (req, res, next) => {
  if (!req.path.startsWith('/api/')) return next()
  if (req.path === '/api/health') return next()

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

function addAuditLog(action, target_type, target_id, actor_type = 'system', details = null) {
  const entry = {
    id: newId(),
    actor_type,
    action,
    target_type,
    target_id,
    created_at: nowIso(),
  }
  if (details && typeof details === 'object') entry.details = details
  store.audit_logs.unshift(entry)
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

function addApprovalRecord(entity_type, entity_id, approval_stage, decision, comment = null) {
  store.approvals.unshift({
    id: newId(),
    entity_type,
    entity_id,
    approval_stage,
    decision,
    reviewer_id: null,
    reviewer_name: null,
    comment,
    requested_at: nowIso(),
    decided_at: nowIso(),
    created_at: nowIso(),
    updated_at: nowIso(),
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

async function resolveAiConfig(body = {}) {
  const stored = store.ai_provider_defaults

  const bodyProvider = typeof body.ai_provider === 'string' ? body.ai_provider.trim() : ''
  const envProvider = process.env.AI_PROVIDER ?? ''
  const provider = bodyProvider || stored?.provider || envProvider

  const bodyApiKey = typeof body.ai_api_key === 'string' ? body.ai_api_key.trim() : ''
  const storedApiKey = stored?.provider && stored.provider === provider ? stored.api_key : ''
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

const GOOGLE_OAUTH_SCOPE = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
]

function envValue(name) {
  return typeof process.env[name] === 'string' ? process.env[name].trim() : ''
}

function appBaseUrl(req) {
  const explicit = envValue('APP_BASE_URL')
  if (explicit) return explicit.replace(/\/+$/, '')
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http'
  const host = req.headers['x-forwarded-host'] || req.get('host')
  return `${proto}://${host}`.replace(/\/+$/, '')
}

function spaBaseUrl(req) {
  const explicit = envValue('SPA_BASE_URL')
  if (explicit) return explicit.replace(/\/+$/, '')
  const referer = typeof req.get('referer') === 'string' ? req.get('referer') : ''
  if (referer) {
    try {
      const parsed = new URL(referer)
      return parsed.origin
    } catch {}
  }
  const fallback = envValue('VITE_API_TARGET')
  if (fallback) {
    try {
      const parsed = new URL(fallback)
      if (parsed.port === '8787') return 'http://localhost:5173'
    } catch {}
  }
  return 'http://localhost:5173'
}

function googleOauthConfig(req) {
  const clientId = envValue('GOOGLE_CLIENT_ID')
  const clientSecret = envValue('GOOGLE_CLIENT_SECRET')
  const redirectUri = envValue('GOOGLE_REDIRECT_URI') || `${appBaseUrl(req)}/api/auth/google/callback`
  return { clientId, clientSecret, redirectUri }
}

function createStateToken() {
  return crypto.randomBytes(24).toString('hex')
}

function minutesFromNowIso(minutes) {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString()
}

function sanitizePlatformAccount(account) {
  if (!account) return null
  return {
    id: account.id,
    platform: account.platform,
    account_name: account.account_name,
    status: account.status,
    access_token_expires_at: account.access_token_expires_at ?? null,
    channel_id: account.channel_id ?? null,
    channel_title: account.channel_title ?? null,
    token_last_refreshed_at: account.token_last_refreshed_at ?? null,
    last_error_code: account.last_error_code ?? null,
    last_error_message: account.last_error_message ?? null,
    created_at: account.created_at ?? null,
    updated_at: account.updated_at ?? null,
    deleted_at: account.deleted_at ?? null,
  }
}

function defaultPlatformAccountsReturnUrl(req) {
  return `${spaBaseUrl(req)}/settings/platform-accounts`
}

function resolveReturnToUrl(req, rawValue) {
  const allowedOrigin = spaBaseUrl(req)
  if (isNonEmptyString(rawValue)) {
    try {
      const parsed = new URL(rawValue)
      if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.origin === allowedOrigin) {
        return parsed.toString()
      }
    } catch {}
  }
  const envDefault = envValue('GOOGLE_OAUTH_DEFAULT_RETURN_TO')
  if (envDefault) {
    try {
      const parsed = new URL(envDefault)
      if (parsed.origin === allowedOrigin) return parsed.toString()
    } catch {}
  }
  return defaultPlatformAccountsReturnUrl(req)
}

function withQueryParams(url, params) {
  const next = new URL(url)
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return
    next.searchParams.set(key, String(value))
  })
  return next.toString()
}

function createHttpError(status, errorCode, message, details = undefined) {
  const error = new Error(message)
  error.statusCode = status
  error.errorCode = errorCode
  error.details = details
  return error
}

async function googleTokenRequest(params) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  })
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    throw createHttpError(
      res.status,
      'AUTH_ERROR',
      data?.error_description || data?.error || `Google token HTTP ${res.status}`,
      { response: data }
    )
  }
  return data
}

async function fetchGoogleChannelProfile(accessToken) {
  const res = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    throw createHttpError(
      res.status,
      res.status === 401 ? 'AUTH_ERROR' : 'NETWORK_ERROR',
      data?.error?.message || `YouTube channels HTTP ${res.status}`,
      { response: data }
    )
  }
  const item = Array.isArray(data?.items) ? data.items[0] : null
  if (!item?.id) throw createHttpError(404, 'NOT_FOUND', 'YouTube channel not found')
  return {
    channel_id: item.id,
    channel_title: item?.snippet?.title ?? 'YouTube channel',
  }
}

function consumeOauthState(stateToken) {
  const index = store.oauth_states.findIndex((item) => item?.state === stateToken)
  if (index < 0) return null
  const [entry] = store.oauth_states.splice(index, 1)
  return entry
}

function cleanupOauthStates(now = Date.now()) {
  store.oauth_states = store.oauth_states.filter((item) => {
    const expiresAt = typeof item?.expires_at === 'string' ? Date.parse(item.expires_at) : NaN
    return Number.isNaN(expiresAt) || expiresAt > now
  })
}

async function refreshGooglePlatformAccountTokens(account, actorType = 'system') {
  if (!account) throw createHttpError(404, 'NOT_FOUND', 'platform account not found')
  if (!isNonEmptyString(account.refresh_token)) {
    account.status = 'disconnected'
    account.last_error_code = 'AUTH_ERROR'
    account.last_error_message = 'Missing refresh token'
    account.updated_at = nowIso()
    await saveStore(store)
    throw createHttpError(401, 'AUTH_ERROR', 'Missing refresh token')
  }

  const config = googleOauthConfig({ headers: {}, protocol: 'http', get() { return '' } })
  if (!config.clientId || !config.clientSecret) {
    throw createHttpError(500, 'CONFIG_REQUIRED', 'Google OAuth is not configured')
  }

  const tokenData = await googleTokenRequest({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: account.refresh_token,
    grant_type: 'refresh_token',
  })

  const expiresInSec = Math.max(60, Number(tokenData?.expires_in ?? 3600) || 3600)
  account.access_token = tokenData.access_token
  if (isNonEmptyString(tokenData.refresh_token)) account.refresh_token = tokenData.refresh_token
  account.access_token_expires_at = new Date(Date.now() + expiresInSec * 1000).toISOString()
  account.token_last_refreshed_at = nowIso()
  account.status = 'connected'
  account.last_error_code = null
  account.last_error_message = null
  account.updated_at = nowIso()
  addAuditLog('platform_account.tokens_refreshed', 'platform_account', account.id, actorType)
  await saveStore(store)
  return account
}

async function ensureGoogleAccessToken(account, actorType = 'system') {
  const rawExpiresAt = account?.access_token_expires_at
  const accessToken = typeof account?.access_token === 'string' ? account.access_token.trim() : ''
  if (!accessToken) return refreshGooglePlatformAccountTokens(account, actorType)
  if (!isNonEmptyString(rawExpiresAt)) return account
  const ts = Date.parse(rawExpiresAt)
  if (Number.isNaN(ts)) return account
  if (ts <= Date.now() + 60_000) return refreshGooglePlatformAccountTokens(account, actorType)
  return account
}

async function uploadYouTubeShort(account, publishJob, renderJob) {
  const assetUrl = renderJob?.output?.asset_url
  if (!isNonEmptyString(assetUrl)) {
    throw createHttpError(422, 'INVALID_PAYLOAD', 'render asset_url is required for YouTube upload')
  }

  const refreshed = await ensureGoogleAccessToken(account, 'ai')
  const mediaResponse = await fetch(assetUrl)
  if (!mediaResponse.ok) {
    throw createHttpError(mediaResponse.status, 'NETWORK_ERROR', `Failed to fetch render asset HTTP ${mediaResponse.status}`)
  }
  const mediaBuffer = Buffer.from(await mediaResponse.arrayBuffer())
  const title = isNonEmptyString(publishJob?.payload?.title) ? publishJob.payload.title.trim() : 'BeokMKT Shorts'
  const description = [
    isNonEmptyString(publishJob?.payload?.description) ? publishJob.payload.description.trim() : '',
    Array.isArray(publishJob?.payload?.hashtags) ? publishJob.payload.hashtags.join(' ') : '',
  ]
    .filter(Boolean)
    .join('\n\n')
  const privacyStatus = isNonEmptyString(publishJob?.payload?.visibility) ? publishJob.payload.visibility.trim() : 'private'

  const metadata = {
    snippet: {
      title: title.slice(0, 100),
      description: description.slice(0, 5000),
    },
    status: {
      privacyStatus,
      selfDeclaredMadeForKids: false,
    },
  }

  const boundary = `beokmkt-${crypto.randomBytes(12).toString('hex')}`
  const metadataPart = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
    'utf8'
  )
  const mediaHeader = Buffer.from(
    `--${boundary}\r\nContent-Type: video/mp4\r\nContent-Transfer-Encoding: binary\r\n\r\n`,
    'utf8'
  )
  const closing = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
  const requestBody = Buffer.concat([metadataPart, mediaHeader, mediaBuffer, closing])

  const uploadRes = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?part=snippet,status&uploadType=multipart', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${refreshed.access_token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
      'Content-Length': String(requestBody.length),
    },
    body: requestBody,
  })
  const uploadData = await uploadRes.json().catch(() => null)
  if (!uploadRes.ok) {
    throw createHttpError(
      uploadRes.status,
      uploadRes.status === 401 ? 'AUTH_ERROR' : 'NETWORK_ERROR',
      uploadData?.error?.message || `YouTube upload HTTP ${uploadRes.status}`,
      { response: uploadData }
    )
  }

  const mediaId = typeof uploadData?.id === 'string' ? uploadData.id : newId()
  return {
    platform_media_id: mediaId,
    permalink: `https://www.youtube.com/shorts/${mediaId}`,
    uploaded_at: nowIso(),
    publish_provider: 'youtube-data-api',
    render_asset_url: assetUrl,
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
  const systemPrompt = 'You generate short-form content ideas for marketing automation. Return strict JSON only.'
  const userPrompt = [
    `Source title: ${item.title}`,
    `Source summary: ${item.summary ?? ''}`,
    `Source body: ${item.body ?? ''}`,
    `Target platform: ${options.platform}`,
    `Target duration seconds: ${options.durationSec}`,
    `Generate ${options.ideaCount} short-form ideas.`,
    'Return JSON object with key "ideas".',
    'Each idea must have: title, hook, angle, cta, hashtags.',
  ].join('\n')

  const text = await generateAiText(config, systemPrompt, userPrompt)
  const parsed = maybeParseJson(text)
  const ideas = Array.isArray(parsed?.ideas) ? parsed.ideas : null
  if (!ideas?.length) return null
  return ideas.slice(0, options.ideaCount)
}

async function generateScriptWithAi(config, item, idea, options) {
  const systemPrompt = 'You generate short-form marketing scripts. Return strict JSON only.'
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
  const systemPrompt = 'You generate YouTube Shorts or TikTok upload metadata. Return strict JSON only.'
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
    const error = new Error(data?.error?.message || data?.message || `Webhook HTTP ${response.status}`)
    error.details = { http_status: response.status, duration_ms: Date.now() - startedAt, data }
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
      dead_lettered_at: nowIso(),
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
      dead_lettered_at: nowIso(),
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

async function restoreDeadLetterJob(jobType, jobId, body = {}, actorType = 'ai') {
  const isRender = jobType === 'render'
  const jobs = isRender ? store.render_jobs : store.publish_jobs
  const targetType = isRender ? 'render_job' : 'publish_job'
  const job = jobs.find((entry) => entry.id === jobId && !entry.deleted_at)
  if (!job) throw new Error(`${targetType}_not_found`)
  if (job.status !== 'failed') throw new Error('job_not_failed')
  if (!isDeadLettered(job)) throw new Error('job_not_dead_lettered')

  const resetAttempts = body.reset_attempts === true
  const nextRetryAt =
    typeof body.next_retry_at === 'string' && body.next_retry_at.trim() ? body.next_retry_at.trim() : null
  const currentMaxAttempts = Number(job.execution?.max_attempts ?? 0) || null
  const requestedMaxAttempts = Number(body.max_attempts ?? 0) || currentMaxAttempts

  job.retry_count = resetAttempts ? 0 : Number(job.retry_count ?? 0)
  job.execution = {
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
  }
  job.updated_at = nowIso()
  addAuditLog(`${targetType}.dead_letter_restored`, targetType, jobId, actorType)
  await saveStore(store)

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
  const renderJob = store.render_jobs.find((entry) => entry.id === renderJobId && !entry.deleted_at)
  if (!renderJob) throw new Error('render_job_not_found')
  const script = store.scripts.find((entry) => entry.id === renderJob.script_id && !entry.deleted_at)
  if (!script) throw new Error('script_not_found')
  if (isDeadLettered(renderJob)) throw new Error('job_dead_lettered')
  if (!['queued', 'failed', 'rendering'].includes(renderJob.status)) throw new Error('job_not_runnable')
  if (isExecutionLocked(renderJob)) throw new Error('job_locked')

  const attemptCount = Number(renderJob.execution?.attempt_count ?? 0) + 1
  const lastAttemptAt = nowIso()
  renderJob.status = 'rendering'
  renderJob.error_message = null
  renderJob.execution = {
    ...(renderJob.execution ?? {}),
    attempt_count: attemptCount,
    last_attempt_at: lastAttemptAt,
    last_error_code: null,
    next_retry_at: null,
    locked_at: lastAttemptAt,
    lock_expires_at: minutesFromNow(15),
    locked_by: actorType,
  }
  renderJob.updated_at = nowIso()
  await saveStore(store)

  const webhook = buildWebhookConfig('render', body)

  if (body.simulate_failure === true) {
    const retryPolicy = computeRetryPolicy('SIMULATED_FAILURE', attemptCount, body)
    renderJob.status = 'failed'
    renderJob.error_message = typeof body.error_message === 'string' ? body.error_message : 'AI render execution failed'
    renderJob.execution = {
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
    }
    renderJob.updated_at = nowIso()
    addAuditLog('render_job.execution_failed', 'render_job', renderJobId, actorType)
    await saveStore(store)
    return { id: renderJobId, status: 'failed', qc_status: renderJob.qc_status ?? 'pending', error_message: renderJob.error_message }
  }

  const autoPassQc = body.auto_pass_qc !== false
  let output = {
    asset_url: typeof body.output_url === 'string' && body.output_url.trim() ? body.output_url.trim() : defaultRenderAssetUrl(renderJobId),
    thumbnail_url: typeof body.thumbnail_url === 'string' && body.thumbnail_url.trim() ? body.thumbnail_url.trim() : defaultThumbnailUrl(renderJobId),
    duration_sec: Number(body.duration_sec ?? script.duration_sec ?? 0) || 0,
    subtitles_included: body.subtitles_included !== false,
    render_provider: typeof body.render_provider === 'string' ? body.render_provider : 'ai-renderer',
    executed_at: nowIso(),
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
        at: output.executed_at,
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
        renderJob.status = 'failed'
        renderJob.error_message = 'External render executor returned invalid output'
        renderJob.execution = {
          ...execution,
          last_error_code: errorCode,
          next_retry_at: retryPolicy.next_retry_at,
          max_attempts: retryPolicy.max_attempts,
          dead_lettered_at: retryPolicy.dead_lettered_at,
          dead_letter_reason: retryPolicy.dead_letter_reason,
        }
        renderJob.updated_at = nowIso()
        addAuditLog('render_job.execution_failed', 'render_job', renderJobId, actorType)
        await saveStore(store)
        return { id: renderJobId, status: 'failed', qc_status: renderJob.qc_status ?? 'pending', error_message: renderJob.error_message }
      }

      if (external?.status === 'failed') {
        const errorCode = normalizeExecutorErrorCode(external?.error_code, typeof external?.error_message === 'string' ? external.error_message : '')
        const retryPolicy = computeRetryPolicy(errorCode, attemptCount, body)
        renderJob.status = 'failed'
        renderJob.error_message = typeof external?.error_message === 'string' ? external.error_message : 'External render executor failed'
        renderJob.execution = {
          ...execution,
          last_error_code: errorCode,
          next_retry_at: typeof external?.next_retry_at === 'string' ? external.next_retry_at : retryPolicy.next_retry_at,
          max_attempts: retryPolicy.max_attempts,
          dead_lettered_at: retryPolicy.dead_lettered_at,
          dead_letter_reason: retryPolicy.dead_letter_reason,
        }
        renderJob.updated_at = nowIso()
        addAuditLog('render_job.execution_failed', 'render_job', renderJobId, actorType)
        await saveStore(store)
        return { id: renderJobId, status: 'failed', qc_status: renderJob.qc_status ?? 'pending', error_message: renderJob.error_message }
      }
    } catch (error) {
      const errorCode = resolveExecutionErrorCode(error, 'WEBHOOK_ERROR')
      const retryPolicy = computeRetryPolicy(errorCode, attemptCount, body)
      const durationMs = Number(error?.details?.duration_ms ?? 0) || null
      const httpStatus = Number(error?.details?.http_status ?? 0) || null
      renderJob.status = 'failed'
      renderJob.error_message = error instanceof Error ? error.message : 'External render executor failed'
      renderJob.execution = {
        ...appendExecutionTrace(execution, {
          at: output.executed_at,
          kind: 'render',
          adapter: 'webhook',
          duration_ms: durationMs,
          http_status: httpStatus,
          status: 'failed',
          error_code: errorCode,
          error_message: renderJob.error_message,
          external_job_id: execution.external_job_id ?? null,
        }),
        last_error_code: errorCode,
        next_retry_at: retryPolicy.next_retry_at,
        max_attempts: retryPolicy.max_attempts,
        dead_lettered_at: retryPolicy.dead_lettered_at,
        dead_letter_reason: retryPolicy.dead_letter_reason,
      }
      renderJob.updated_at = nowIso()
      addAuditLog('render_job.execution_failed', 'render_job', renderJobId, actorType)
      await saveStore(store)
      return { id: renderJobId, status: 'failed', qc_status: renderJob.qc_status ?? 'pending', error_message: renderJob.error_message }
    }
  }

  if (!webhook.url) {
    execution = appendExecutionTrace(execution, {
      at: output.executed_at,
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

  renderJob.status = 'rendered'
  renderJob.qc_status = qcStatus
  renderJob.output = output
  renderJob.execution = execution
  renderJob.error_message = null
  renderJob.updated_at = nowIso()

  addAuditLog('render_job.executed', 'render_job', renderJobId, actorType)
  if (autoPassQc) {
    addApprovalRecord('render_job', renderJobId, 'render_review', 'approved', 'AI execution auto approval')
    addAuditLog('render_job.auto_approved', 'render_job', renderJobId, actorType)
  }
  await saveStore(store)
  return { id: renderJobId, status: renderJob.status, qc_status: renderJob.qc_status, output }
}

async function executePublishJobById(publishJobId, body = {}, actorType = 'ai') {
  const publishJob = store.publish_jobs.find((entry) => entry.id === publishJobId && !entry.deleted_at)
  if (!publishJob) throw new Error('publish_job_not_found')
  if (publishJob.status === 'cancelled') throw new Error('publish_job_cancelled')

  const renderJob = store.render_jobs.find((entry) => entry.id === publishJob.render_job_id && !entry.deleted_at)
  if (!renderJob) throw new Error('render_job_not_found')

  if (renderJob.status !== 'rendered') {
    if (body.execute_render_first === false) throw new Error('render_not_executed')
    const renderResult = await executeRenderJobById(renderJob.id, body.render ?? body, actorType)
    if (renderResult.status === 'failed') throw new Error('render_execution_failed')
  }

  if (publishJob.status === 'awaiting_approval') {
    if (body.approve_publish === false) throw new Error('publish_not_approved')
    publishJob.status = 'queued'
    publishJob.updated_at = nowIso()
    addApprovalRecord('publish_job', publishJobId, 'publish_review', 'approved', 'AI execution auto approval')
    addAuditLog('publish_job.auto_approved', 'publish_job', publishJobId, actorType)
  }

  const account = publishJob.platform_account_id
    ? store.platform_accounts.find((entry) => entry.id === publishJob.platform_account_id && !entry.deleted_at)
    : null
  if (!account) throw new Error('platform_account_not_found')
  if (account.status !== 'connected') throw new Error('platform_account_not_connected')
  const targetPlatform = publishJob.platform || account.platform || 'youtube'
  if (isDeadLettered(publishJob)) throw new Error('job_dead_lettered')
  if (!['queued', 'failed', 'uploading'].includes(publishJob.status)) throw new Error('job_not_runnable')
  if (isExecutionLocked(publishJob)) throw new Error('job_locked')

  const attemptCount = Number(publishJob.execution?.attempt_count ?? 0) + 1
  const lastAttemptAt = nowIso()
  publishJob.status = 'uploading'
  publishJob.error_message = null
  publishJob.execution = {
    ...(publishJob.execution ?? {}),
    attempt_count: attemptCount,
    last_attempt_at: lastAttemptAt,
    last_error_code: null,
    next_retry_at: null,
    locked_at: lastAttemptAt,
    lock_expires_at: minutesFromNow(20),
    locked_by: actorType,
  }
  publishJob.updated_at = nowIso()
  await saveStore(store)

  const webhook = buildWebhookConfig('publish', body)
  if (targetPlatform === 'youtube') {
    try {
      await ensureGoogleAccessToken(account, actorType)
    } catch (error) {
      const errorCode = resolveExecutionErrorCode(error, 'AUTH_ERROR')
      const retryPolicy = computeRetryPolicy(errorCode, attemptCount, body)
      publishJob.status = 'failed'
      publishJob.error_message = error instanceof Error ? error.message : 'platform account token refresh failed'
      publishJob.execution = {
        ...(publishJob.execution ?? {}),
        adapter: webhook.url ? 'webhook' : 'youtube-api',
        provider: typeof body.publish_provider === 'string' ? body.publish_provider : 'youtube-data-api',
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
      }
      publishJob.updated_at = nowIso()
      addAuditLog('publish_job.execution_failed', 'publish_job', publishJobId, actorType)
      await saveStore(store)
      return { id: publishJobId, status: 'failed', error_message: publishJob.error_message, render_job_id: renderJob.id }
    }
  }

  if (body.simulate_failure === true) {
    const retryPolicy = computeRetryPolicy('SIMULATED_FAILURE', attemptCount, body)
    publishJob.status = 'failed'
    publishJob.error_message = typeof body.error_message === 'string' ? body.error_message : 'AI publish execution failed'
    publishJob.execution = {
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
    }
    publishJob.updated_at = nowIso()
    addAuditLog('publish_job.execution_failed', 'publish_job', publishJobId, actorType)
    await saveStore(store)
    return { id: publishJobId, status: 'failed', error_message: publishJob.error_message, render_job_id: renderJob.id }
  }

  const mediaId = typeof body.platform_media_id === 'string' && body.platform_media_id.trim() ? body.platform_media_id.trim() : newId()
  let finalStatus =
    typeof body.final_status === 'string' ? body.final_status : publishJob.payload?.visibility === 'public' ? 'published' : 'uploaded'
  let result = {
    platform_media_id: mediaId,
    permalink:
      typeof body.permalink === 'string' && body.permalink.trim() ? body.permalink.trim() : defaultPublishPermalink(targetPlatform, mediaId),
    uploaded_at: nowIso(),
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

  if (webhook.url) {
    try {
      const webhookResult = await callWebhookExecutorWithMeta(webhook, {
        kind: 'publish',
        publish_job_id: publishJobId,
        platform: targetPlatform,
        publish_job: publishJob,
        render_job: renderJob,
        account: sanitizePlatformAccount(account),
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
      finalStatus = typeof external?.status === 'string' ? external.status : finalStatus
      execution = {
        ...execution,
        provider: result.publish_provider,
        external_job_id: typeof external?.external_job_id === 'string' ? external.external_job_id : null,
      }
      finalStatus = normalizePublishStatus(finalStatus, publishJob.payload?.visibility === 'public' ? 'published' : 'uploaded')

      execution = appendExecutionTrace(execution, {
        at: result.uploaded_at,
        kind: 'publish',
        adapter: 'webhook',
        duration_ms: Number(webhookResult?.meta?.duration_ms ?? 0) || null,
        http_status: null,
        status: typeof external?.status === 'string' ? external.status : finalStatus,
        error_code: typeof external?.error_code === 'string' ? normalizeExecutorErrorCode(external.error_code, typeof external?.error_message === 'string' ? external.error_message : '') : null,
        error_message: typeof external?.error_message === 'string' ? external.error_message : null,
        external_job_id: execution.external_job_id ?? null,
      })

      if (finalStatus !== 'failed') {
        const hasMediaId = isNonEmptyString(result.platform_media_id)
        const hasPermalink = isNonEmptyString(result.permalink)
        if (!hasMediaId && !hasPermalink) {
          const errorCode = 'INVALID_PAYLOAD'
          const retryPolicy = computeRetryPolicy(errorCode, attemptCount, body)
          publishJob.status = 'failed'
          publishJob.error_message = 'External publish executor returned invalid result'
          publishJob.execution = {
            ...execution,
            last_error_code: errorCode,
            next_retry_at: retryPolicy.next_retry_at,
            max_attempts: retryPolicy.max_attempts,
            dead_lettered_at: retryPolicy.dead_lettered_at,
            dead_letter_reason: retryPolicy.dead_letter_reason,
          }
          publishJob.updated_at = nowIso()
          addAuditLog('publish_job.execution_failed', 'publish_job', publishJobId, actorType)
          await saveStore(store)
          return { id: publishJobId, status: 'failed', error_message: publishJob.error_message, render_job_id: renderJob.id }
        }
      }

      if (external?.status === 'failed') {
        const errorCode = normalizeExecutorErrorCode(external?.error_code, typeof external?.error_message === 'string' ? external.error_message : '')
        const retryPolicy = computeRetryPolicy(errorCode, attemptCount, body)
        publishJob.status = 'failed'
        publishJob.error_message = typeof external?.error_message === 'string' ? external.error_message : 'External publish executor failed'
        publishJob.execution = {
          ...execution,
          last_error_code: errorCode,
          next_retry_at: typeof external?.next_retry_at === 'string' ? external.next_retry_at : retryPolicy.next_retry_at,
          max_attempts: retryPolicy.max_attempts,
          dead_lettered_at: retryPolicy.dead_lettered_at,
          dead_letter_reason: retryPolicy.dead_letter_reason,
        }
        publishJob.updated_at = nowIso()
        addAuditLog('publish_job.execution_failed', 'publish_job', publishJobId, actorType)
        await saveStore(store)
        return { id: publishJobId, status: 'failed', error_message: publishJob.error_message, render_job_id: renderJob.id }
      }
    } catch (error) {
      const errorCode = resolveExecutionErrorCode(error, 'WEBHOOK_ERROR')
      const retryPolicy = computeRetryPolicy(errorCode, attemptCount, body)
      const durationMs = Number(error?.details?.duration_ms ?? 0) || null
      const httpStatus = Number(error?.details?.http_status ?? 0) || null
      publishJob.status = 'failed'
      publishJob.error_message = error instanceof Error ? error.message : 'External publish executor failed'
      publishJob.execution = {
        ...appendExecutionTrace(execution, {
          at: result.uploaded_at,
          kind: 'publish',
          adapter: 'webhook',
          duration_ms: durationMs,
          http_status: httpStatus,
          status: 'failed',
          error_code: errorCode,
          error_message: publishJob.error_message,
          external_job_id: execution.external_job_id ?? null,
        }),
        last_error_code: errorCode,
        next_retry_at: retryPolicy.next_retry_at,
        max_attempts: retryPolicy.max_attempts,
        dead_lettered_at: retryPolicy.dead_lettered_at,
        dead_letter_reason: retryPolicy.dead_letter_reason,
      }
      publishJob.updated_at = nowIso()
      addAuditLog('publish_job.execution_failed', 'publish_job', publishJobId, actorType)
      await saveStore(store)
      return { id: publishJobId, status: 'failed', error_message: publishJob.error_message, render_job_id: renderJob.id }
    }
  }

  if (!webhook.url && targetPlatform === 'youtube') {
    try {
      result = await uploadYouTubeShort(account, publishJob, renderJob)
      finalStatus = publishJob.payload?.visibility === 'public' ? 'published' : 'uploaded'
      execution = {
        ...execution,
        adapter: 'youtube-api',
        provider: result.publish_provider,
      }
      execution = appendExecutionTrace(execution, {
        at: result.uploaded_at,
        kind: 'publish',
        adapter: 'youtube-api',
        duration_ms: null,
        http_status: 200,
        status: finalStatus,
        error_code: null,
        error_message: null,
        external_job_id: result.platform_media_id ?? null,
      })
    } catch (error) {
      const errorCode = resolveExecutionErrorCode(error, 'NETWORK_ERROR')
      const retryPolicy = computeRetryPolicy(errorCode, attemptCount, body)
      publishJob.status = 'failed'
      publishJob.error_message = error instanceof Error ? error.message : 'YouTube upload failed'
      publishJob.execution = {
        ...appendExecutionTrace(execution, {
          at: nowIso(),
          kind: 'publish',
          adapter: 'youtube-api',
          duration_ms: null,
          http_status: Number(error?.statusCode ?? error?.details?.http_status ?? 0) || null,
          status: 'failed',
          error_code: errorCode,
          error_message: publishJob.error_message,
          external_job_id: null,
        }),
        adapter: 'youtube-api',
        provider: 'youtube-data-api',
        last_error_code: errorCode,
        next_retry_at: retryPolicy.next_retry_at,
        max_attempts: retryPolicy.max_attempts,
        dead_lettered_at: retryPolicy.dead_lettered_at,
        dead_letter_reason: retryPolicy.dead_letter_reason,
      }
      publishJob.updated_at = nowIso()
      addAuditLog('publish_job.execution_failed', 'publish_job', publishJobId, actorType)
      await saveStore(store)
      return { id: publishJobId, status: 'failed', error_message: publishJob.error_message, render_job_id: renderJob.id }
    }
  }

  if (!webhook.url && targetPlatform !== 'youtube') {
    execution = appendExecutionTrace(execution, {
      at: result.uploaded_at,
      kind: 'publish',
      adapter: 'local',
      duration_ms: null,
      http_status: null,
      status: finalStatus,
      error_code: null,
      error_message: null,
      external_job_id: null,
    })
  }

  publishJob.status = finalStatus
  publishJob.result = result
  publishJob.execution = execution
  publishJob.error_message = null
  publishJob.updated_at = nowIso()

  addAuditLog('publish_job.executed', 'publish_job', publishJobId, actorType)
  await saveStore(store)
  return { id: publishJobId, status: publishJob.status, result: publishJob.result, render_job_id: renderJob.id }
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

async function validateApiKey(provider, apiKey, endpointOverride = '', modelOverride = '') {
  if (!provider || !apiKey) {
    return {
      valid: false,
      details: 'Provider and API key are required',
      diagnostics: {
        provider,
        endpoint: endpointOverride || defaultTestEndpointForProvider(provider),
        model: modelOverride || defaultModelForProvider(provider),
        http_status: null,
      },
    }
  }

  let isValid = false
  let errorDetails = ''
  let httpStatus = null
  let usedEndpoint = endpointOverride || defaultTestEndpointForProvider(provider)
  let usedModel = modelOverride || defaultModelForProvider(provider)

  try {
    let response

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
          response = await fetch(usedEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: 'hi' }] }] }),
          }).catch(() => null)
          httpStatus = response?.status ?? null

          if (response?.ok) {
            isValid = true
            errorDetails = `Gemini API 연결 성공 (${model})`
            break
          }
        }

        if (!isValid) {
          const errorData = response ? await response.json().catch(() => null) : null
          errorDetails = errorData?.error?.message || 'Gemini API 연결 실패'
        }
        break
      }

      case 'zhipu': {
        const models = modelOverride ? [modelOverride] : ['glm-4-flash', 'glm-4-air', 'glm-4-0520', 'glm-4', 'glm-3-turbo', 'chatglm3-6b']
        let lastError = ''
        usedEndpoint = endpointOverride || defaultTestEndpointForProvider(provider)

        for (const model of models) {
          usedModel = model
          try {
            response = await fetch(usedEndpoint, {
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
            })
            httpStatus = response.status

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
        break
      }

      case 'zai': {
        const endpoints = endpointOverride
          ? [{ url: endpointOverride, models: modelOverride ? [modelOverride] : ['glm-4-flash', 'glm-4-air', 'glm-4-0520', 'glm-4', 'glm-3-turbo'] }]
          : [
              {
                url: 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions',
                models: modelOverride ? [modelOverride] : ['glm-4-flash', 'glm-4-air', 'glm-4-0520', 'glm-4', 'glm-3-turbo'],
              },
              {
                url: 'https://api.z.ai/v1/chat/completions',
                models: modelOverride ? [modelOverride] : ['glm-4-flash', 'glm-4-air', 'glm-4'],
              },
            ]

        let lastError = ''

        for (const endpoint of endpoints) {
          for (const model of endpoint.models) {
            usedModel = model
            try {
              usedEndpoint = endpoint.url
              response = await fetch(usedEndpoint, {
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
              })
              httpStatus = response.status

              if (response.ok) {
                isValid = true
                errorDetails = `Z.ai API 연결 성공 (${model} 모델 - ${usedEndpoint})`
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
        break
      }

      case 'anthropic': {
        const models = modelOverride ? [modelOverride] : ['claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022', 'claude-3-haiku-20240307', 'claude-3-sonnet-20240229']
        usedEndpoint = endpointOverride || defaultTestEndpointForProvider(provider)

        for (const model of models) {
          usedModel = model
          try {
            response = await fetch(usedEndpoint, {
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
            })
            httpStatus = response.status

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
          const errorData = response ? await response.json().catch(() => null) : null
          errorDetails = errorData?.error?.message || 'Anthropic API 연결 실패'
        }
        break
      }

      case 'cohere': {
        const models = modelOverride ? [modelOverride] : ['command-r-plus-08-2024', 'command-r-08-2024', 'command', 'command-light']
        usedEndpoint = endpointOverride || defaultTestEndpointForProvider(provider)

        for (const model of models) {
          usedModel = model
          try {
            response = await fetch(usedEndpoint, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
              },
              body: JSON.stringify({ model, message: 'hi', max_tokens: 10 }),
            })
            httpStatus = response.status

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
          const errorData = response ? await response.json().catch(() => null) : null
          errorDetails = errorData?.message || 'Cohere API 연결 실패'
        }
        break
      }

      case 'mistral': {
        const models = modelOverride ? [modelOverride] : ['mistral-large-latest', 'mistral-medium-latest', 'mistral-small-latest', 'codestral-latest', 'mixtral-8x7b-32768']
        usedEndpoint = endpointOverride || defaultTestEndpointForProvider(provider)

        for (const model of models) {
          usedModel = model
          try {
            response = await fetch(usedEndpoint, {
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
            })
            httpStatus = response.status

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
          const errorData = response ? await response.json().catch(() => null) : null
          errorDetails = errorData?.message || 'Mistral API 연결 실패'
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
  const endpoint = req.query.endpoint
  const model = req.query.model
  const result = await validateApiKey(provider, apiKey, endpoint, model)
  res.json(result)
})

app.post('/api/test-ai-key', async (req, res) => {
  const provider = req.body?.provider ?? req.query.provider
  const apiKey = req.body?.apiKey ?? req.query.apiKey
  const endpoint = req.body?.endpoint ?? req.query.endpoint
  const model = req.body?.model ?? req.query.model
  const result = await validateApiKey(provider, apiKey, endpoint, model)
  res.json(result)
})

app.get('/api/ai-provider-defaults', async (req, res) => {
  const stored = store.ai_provider_defaults
  ok(res, {
    provider: stored?.provider ?? '',
    model: stored?.model ?? '',
    endpoint: stored?.endpoint ?? '',
    has_api_key: Boolean(stored?.api_key),
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

  const current = store.ai_provider_defaults ?? {}
  const next = {
    provider,
    model: model || current.model || defaultModelForProvider(provider),
    endpoint: endpoint || current.endpoint || '',
    api_key: apiKey || current.api_key || '',
    updated_at: nowIso(),
  }

  store.ai_provider_defaults = next
  addAuditLog('ai_provider_defaults.updated', 'settings', 'ai_provider_defaults')
  await saveStore(store)

  ok(res, {
    provider: next.provider,
    model: next.model,
    endpoint: next.endpoint,
    has_api_key: Boolean(next.api_key),
    updated_at: next.updated_at,
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

app.post('/api/source-items/:id/run-ai-pipeline', async (req, res) => {
  const id = req.params.id
  const item = store.source_items.find((s) => s.id === id && !s.deleted_at)
  if (!item) return fail(res, 404, 'NOT_FOUND', 'source item not found', {})
  if (item.status !== 'eligible') return fail(res, 422, 'WORKFLOW_NOT_READY', 'source item is not eligible', {})

  await withIdempotency(req, res, async () => {
    const body = req.body ?? {}
    const ideaCount = Math.max(1, Math.min(Number(body.idea_count ?? 3) || 3, 10))
    const durationSec = Math.max(10, Math.min(Number(body.duration_sec ?? 30) || 30, 180))
    const platform = typeof body.platform === 'string' ? body.platform : 'youtube'
    const platformAccountId =
      typeof body.platform_account_id === 'string' && body.platform_account_id.trim() ? body.platform_account_id.trim() : null
    const visibility = typeof body.visibility === 'string' ? body.visibility : 'private'
    const autoApproveRender = body.auto_approve_render !== false
    const autoApprovePublish = body.auto_approve_publish !== false
    const aiConfig = await resolveAiConfig(body)
    const hashtags = Array.isArray(body.hashtags)
      ? body.hashtags.filter((tag) => typeof tag === 'string' && tag.trim()).map((tag) => tag.trim())
      : []
    const publishTitle =
      typeof body.publish_title === 'string' && body.publish_title.trim() ? body.publish_title.trim() : `${item.title} | AI Shorts`
    const publishDescription =
      typeof body.publish_description === 'string' && body.publish_description.trim()
        ? body.publish_description.trim()
        : `${item.summary ?? item.title}\n\n#ai-generated`

    if (!platformAccountId) throw new Error('missing_platform_account')

    const account = store.platform_accounts.find((entry) => entry.id === platformAccountId && !entry.deleted_at)
    if (!account) throw new Error('platform_account_not_found')

    const workflowEventId = addWorkflowEvent('source_item.run_ai_pipeline', 'source_item', id, 'processed', {
      idea_count: ideaCount,
      duration_sec: durationSec,
      platform,
    })

    const ideaIds = []
    let leadIdeaId = null
    const aiIdeas = await generateIdeasWithAi(aiConfig, item, { ideaCount, durationSec, platform }).catch(() => null)

    for (let i = 0; i < ideaCount; i += 1) {
      const ideaId = newId()
      const approvedLead = i === 0
      const aiIdea = aiIdeas?.[i]
      store.short_ideas.unshift({
        id: ideaId,
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
        created_at: nowIso(),
        updated_at: nowIso(),
        deleted_at: null,
      })
      ideaIds.push(ideaId)
      if (approvedLead) {
        leadIdeaId = ideaId
        addApprovalRecord('short_idea', ideaId, 'idea_review', 'approved', 'AI 자동 파이프라인 승인')
        addAuditLog('short_idea.auto_approved', 'short_idea', ideaId, 'user')
      } else {
        addAuditLog('short_idea.generated', 'short_idea', ideaId, 'user')
      }
    }

    const nextVersion =
      store.scripts.filter((entry) => entry.short_idea_id === leadIdeaId).reduce((max, entry) => Math.max(max, entry.version), 0) + 1
    const scriptId = newId()
    const leadIdea = {
      title: aiIdeas?.[0]?.title ?? `${item.title} - AI 아이디어 1`,
      hook: aiIdeas?.[0]?.hook ?? 'AI 자동 선정 훅(데모)',
      angle: aiIdeas?.[0]?.angle ?? item.summary ?? '',
      cta: aiIdeas?.[0]?.cta ?? '자세한 내용은 설명란 참고',
    }
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
    store.scripts.unshift({
      id: scriptId,
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
      created_at: nowIso(),
      updated_at: nowIso(),
      deleted_at: null,
    })
    addAuditLog('script.generated', 'script', scriptId, 'user')
    addApprovalRecord('script', scriptId, 'script_review', 'approved', 'AI 자동 파이프라인 승인')
    addAuditLog('script.auto_approved', 'script', scriptId, 'user')

    const renderJobId = newId()
    store.render_jobs.unshift({
      id: renderJobId,
      script_id: scriptId,
      short_idea_id: leadIdeaId,
      template_id: typeof body.template_id === 'string' ? body.template_id : null,
      render_profile: typeof body.render_profile === 'string' ? body.render_profile : 'shorts_1080x1920',
      status: 'queued',
      qc_status: autoApproveRender ? 'passed' : 'pending',
      retry_count: 0,
      error_message: null,
      output: null,
      created_at: nowIso(),
      updated_at: nowIso(),
      deleted_at: null,
    })
    addAuditLog('render_job.created', 'render_job', renderJobId, 'user')
    if (autoApproveRender) {
      addApprovalRecord('render_job', renderJobId, 'render_review', 'approved', 'AI 자동 파이프라인 승인')
      addAuditLog('render_job.auto_approved', 'render_job', renderJobId, 'user')
    }

    const publishJobId = newId()
    const publishStatus = autoApprovePublish ? 'queued' : 'awaiting_approval'
    store.publish_jobs.unshift({
      id: publishJobId,
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
      created_at: nowIso(),
      updated_at: nowIso(),
      deleted_at: null,
    })
    addAuditLog('publish_job.created', 'publish_job', publishJobId, 'user')
    if (autoApprovePublish) {
      addApprovalRecord('publish_job', publishJobId, 'publish_review', 'approved', 'AI 자동 파이프라인 승인')
      addAuditLog('publish_job.auto_approved', 'publish_job', publishJobId, 'user')
    }

    addAuditLog('source_item.ai_pipeline_run', 'source_item', id, 'user')
    await saveStore(store)

    return {
      data: {
        workflow_event_id: workflowEventId,
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

    const item = store.source_items.find((entry) => entry.id === sourceItemId && !entry.deleted_at)
    if (!item) throw new Error('source_item_not_found')
    if (item.status !== 'eligible') throw new Error('source_item_not_ready')

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
      store.short_ideas.unshift({
        id: ideaId,
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
        created_at: nowIso(),
        updated_at: nowIso(),
        deleted_at: null,
      })
      ideaIds.push(ideaId)
      if (approvedLead) {
        leadIdeaId = ideaId
        addApprovalRecord('short_idea', ideaId, 'idea_review', 'approved', 'AI lead auto approval')
        addAuditLog('short_idea.auto_approved', 'short_idea', ideaId, 'ai')
      } else {
        addAuditLog('short_idea.generated', 'short_idea', ideaId, 'ai')
      }
    }

    addAuditLog('source_item.ai_generated_ideas', 'source_item', sourceItemId, 'ai', { ai_trace: aiTrace })
    await saveStore(store)
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

    const idea = store.short_ideas.find((entry) => entry.id === shortIdeaId && !entry.deleted_at)
    if (!idea) throw new Error('short_idea_not_found')
    const aiConfig = await resolveAiConfig(body)
    const aiTrace = aiTraceFromConfig(aiConfig)

    if (idea.status !== 'approved') {
      if (idea.status === 'awaiting_review' && body.approve_idea !== false) {
        idea.status = 'approved'
        idea.updated_at = nowIso()
        addApprovalRecord('short_idea', shortIdeaId, 'idea_review', 'approved', 'AI auto approval before script generation')
        addAuditLog('short_idea.auto_approved', 'short_idea', shortIdeaId, 'ai')
      } else {
        throw new Error('idea_not_ready')
      }
    }

    const durationSec = Math.max(10, Math.min(Number(body.duration_sec ?? idea.target_duration_sec ?? 30) || 30, 180))
    const autoApprove = body.auto_approve !== false
    const nextVersion =
      store.scripts.filter((entry) => entry.short_idea_id === shortIdeaId).reduce((max, entry) => Math.max(max, entry.version), 0) + 1
    const scriptId = newId()
    const sourceItem = store.source_items.find((entry) => entry.id === idea.source_item_id && !entry.deleted_at) ?? {
      title: idea.title,
      summary: idea.angle,
      body: idea.angle,
    }
    const aiScript = await generateScriptWithAi(aiConfig, sourceItem, idea, { durationSec }).catch(() => null)

    store.scripts.unshift({
      id: scriptId,
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
      created_at: nowIso(),
      updated_at: nowIso(),
      deleted_at: null,
    })
    addAuditLog('script.generated', 'script', scriptId, 'ai', { ai_trace: aiTrace })
    if (autoApprove) {
      addApprovalRecord('script', scriptId, 'script_review', 'approved', 'AI auto approval')
      addAuditLog('script.auto_approved', 'script', scriptId, 'ai')
    }

    await saveStore(store)
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

    const script = store.scripts.find((entry) => entry.id === scriptId && !entry.deleted_at)
    if (!script) throw new Error('script_not_found')

    if (script.status !== 'approved') {
      if (script.status === 'awaiting_review' && body.approve_script !== false) {
        script.status = 'approved'
        script.fact_check_status = typeof body.fact_check_status === 'string' ? body.fact_check_status : 'passed'
        script.updated_at = nowIso()
        addApprovalRecord('script', scriptId, 'script_review', 'approved', 'AI auto approval before render creation')
        addAuditLog('script.auto_approved', 'script', scriptId, 'ai')
      } else {
        throw new Error('script_not_ready')
      }
    }

    const autoApprove = body.auto_approve !== false
    const renderJobId = newId()
    store.render_jobs.unshift({
      id: renderJobId,
      script_id: scriptId,
      short_idea_id: script.short_idea_id,
      template_id: typeof body.template_id === 'string' ? body.template_id : null,
      render_profile: typeof body.render_profile === 'string' ? body.render_profile : 'shorts_1080x1920',
      status: typeof body.status === 'string' ? body.status : 'queued',
      qc_status: autoApprove ? 'passed' : 'pending',
      retry_count: 0,
      error_message: null,
      output: null,
      created_at: nowIso(),
      updated_at: nowIso(),
      deleted_at: null,
    })
    addAuditLog('render_job.created', 'render_job', renderJobId, 'ai')
    if (autoApprove) {
      addApprovalRecord('render_job', renderJobId, 'render_review', 'approved', 'AI auto approval')
      addAuditLog('render_job.auto_approved', 'render_job', renderJobId, 'ai')
    }

    await saveStore(store)
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

    const renderJob = store.render_jobs.find((entry) => entry.id === renderJobId && !entry.deleted_at)
    if (!renderJob) throw new Error('render_job_not_found')

    const account = store.platform_accounts.find((entry) => entry.id === platformAccountId && !entry.deleted_at)
    if (!account) throw new Error('platform_account_not_found')
    const aiConfig = await resolveAiConfig(body)
    const aiTrace = aiTraceFromConfig(aiConfig)

    if (renderJob.qc_status !== 'passed') {
      if (body.approve_render !== false) {
        renderJob.qc_status = 'passed'
        renderJob.updated_at = nowIso()
        addApprovalRecord('render_job', renderJobId, 'render_review', 'approved', 'AI auto approval before publish creation')
        addAuditLog('render_job.auto_approved', 'render_job', renderJobId, 'ai')
      } else {
        throw new Error('render_not_ready')
      }
    }

    const autoApprove = body.auto_approve !== false
    const publishJobId = newId()
    const publishStatus = autoApprove ? 'queued' : 'awaiting_approval'
    const script = renderJob?.script_id ? store.scripts.find((entry) => entry.id === renderJob.script_id && !entry.deleted_at) : null
    const idea = script?.short_idea_id ? store.short_ideas.find((entry) => entry.id === script.short_idea_id && !entry.deleted_at) : null
    const sourceItem = idea?.source_item_id ? store.source_items.find((entry) => entry.id === idea.source_item_id && !entry.deleted_at) : null
    const aiPublishMeta =
      script && sourceItem
        ? await generatePublishMetadataWithAi(aiConfig, sourceItem, script, {
            platform: typeof body.platform === 'string' ? body.platform : account.platform ?? 'youtube',
          }).catch(() => null)
        : null
    store.publish_jobs.unshift({
      id: publishJobId,
      render_job_id: renderJobId,
      platform: typeof body.platform === 'string' ? body.platform : account.platform ?? 'youtube',
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
      created_at: nowIso(),
      updated_at: nowIso(),
      deleted_at: null,
    })
    addAuditLog('publish_job.created', 'publish_job', publishJobId, 'ai', { ai_trace: aiTrace })
    if (autoApprove) {
      addApprovalRecord('publish_job', publishJobId, 'publish_review', 'approved', 'AI auto approval')
      addAuditLog('publish_job.auto_approved', 'publish_job', publishJobId, 'ai')
    }

    await saveStore(store)
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

    const item = store.source_items.find((entry) => entry.id === sourceItemId && !entry.deleted_at)
    if (!item) throw new Error('source_item_not_found')
    if (item.status !== 'eligible') throw new Error('source_item_not_ready')

    const platformAccountId = typeof body.platform_account_id === 'string' ? body.platform_account_id.trim() : ''
    if (!platformAccountId) throw new Error('missing_platform_account')
    const account = store.platform_accounts.find((entry) => entry.id === platformAccountId && !entry.deleted_at)
    if (!account) throw new Error('platform_account_not_found')

    const ideaCount = Math.max(1, Math.min(Number(body.idea_count ?? 3) || 3, 10))
    const durationSec = Math.max(10, Math.min(Number(body.duration_sec ?? 30) || 30, 180))
    const platform = typeof body.platform === 'string' ? body.platform : account.platform ?? 'youtube'
    const autoApproveRender = body.auto_approve_render !== false
    const autoApprovePublish = body.auto_approve_publish !== false
    const aiConfig = await resolveAiConfig(body)
    const aiTrace = aiTraceFromConfig(aiConfig)
    const hashtags = Array.isArray(body.hashtags)
      ? body.hashtags.filter((tag) => typeof tag === 'string' && tag.trim()).map((tag) => tag.trim())
      : []
    const visibility = typeof body.visibility === 'string' ? body.visibility : 'private'

    const workflowEventId = addWorkflowEvent('ai.run_pipeline', 'source_item', sourceItemId, 'processed', {
      idea_count: ideaCount,
      duration_sec: durationSec,
      platform,
    })

    const ideaIds = []
    let leadIdeaId = null
    const aiIdeas = await generateIdeasWithAi(aiConfig, item, { ideaCount, durationSec, platform }).catch(() => null)
    for (let i = 0; i < ideaCount; i += 1) {
      const ideaId = newId()
      const approvedLead = i === 0
      const aiIdea = aiIdeas?.[i]
      store.short_ideas.unshift({
        id: ideaId,
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
        created_at: nowIso(),
        updated_at: nowIso(),
        deleted_at: null,
      })
      ideaIds.push(ideaId)
      if (approvedLead) {
        leadIdeaId = ideaId
        addApprovalRecord('short_idea', ideaId, 'idea_review', 'approved', 'AI pipeline lead approval')
        addAuditLog('short_idea.auto_approved', 'short_idea', ideaId, 'ai')
      } else {
        addAuditLog('short_idea.generated', 'short_idea', ideaId, 'ai')
      }
    }

    const nextVersion =
      store.scripts.filter((entry) => entry.short_idea_id === leadIdeaId).reduce((max, entry) => Math.max(max, entry.version), 0) + 1
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
    store.scripts.unshift({
      id: scriptId,
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
      created_at: nowIso(),
      updated_at: nowIso(),
      deleted_at: null,
    })
    addApprovalRecord('script', scriptId, 'script_review', 'approved', 'AI pipeline script approval')
    addAuditLog('script.auto_approved', 'script', scriptId, 'ai')

    const renderJobId = newId()
    store.render_jobs.unshift({
      id: renderJobId,
      script_id: scriptId,
      short_idea_id: leadIdeaId,
      template_id: typeof body.template_id === 'string' ? body.template_id : null,
      render_profile: typeof body.render_profile === 'string' ? body.render_profile : 'shorts_1080x1920',
      status: 'queued',
      qc_status: autoApproveRender ? 'passed' : 'pending',
      retry_count: 0,
      error_message: null,
      output: null,
      created_at: nowIso(),
      updated_at: nowIso(),
      deleted_at: null,
    })
    addAuditLog('render_job.created', 'render_job', renderJobId, 'ai')
    if (autoApproveRender) {
      addApprovalRecord('render_job', renderJobId, 'render_review', 'approved', 'AI pipeline render approval')
      addAuditLog('render_job.auto_approved', 'render_job', renderJobId, 'ai')
    }

    const publishJobId = newId()
    const publishStatus = autoApprovePublish ? 'queued' : 'awaiting_approval'
    store.publish_jobs.unshift({
      id: publishJobId,
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
      created_at: nowIso(),
      updated_at: nowIso(),
      deleted_at: null,
    })
    addAuditLog('publish_job.created', 'publish_job', publishJobId, 'ai')
    if (autoApprovePublish) {
      addApprovalRecord('publish_job', publishJobId, 'publish_review', 'approved', 'AI pipeline publish approval')
      addAuditLog('publish_job.auto_approved', 'publish_job', publishJobId, 'ai')
    }

    addAuditLog('source_item.ai_pipeline_run', 'source_item', sourceItemId, 'ai', { ai_trace: aiTrace })
    await saveStore(store)
    return {
      data: {
        workflow_event_id: workflowEventId,
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
    const sourceItemId = typeof body.source_item_id === 'string' ? body.source_item_id.trim() : ''
    if (!sourceItemId) throw new Error('missing_source_item_id')

    const item = store.source_items.find((entry) => entry.id === sourceItemId && !entry.deleted_at)
    if (!item) throw new Error('source_item_not_found')
    if (item.status !== 'eligible') throw new Error('source_item_not_ready')

    const platformAccountId = typeof body.platform_account_id === 'string' ? body.platform_account_id.trim() : ''
    if (!platformAccountId) throw new Error('missing_platform_account')
    const account = store.platform_accounts.find((entry) => entry.id === platformAccountId && !entry.deleted_at)
    if (!account) throw new Error('platform_account_not_found')

    const ideaCount = Math.max(1, Math.min(Number(body.idea_count ?? 3) || 3, 10))
    const durationSec = Math.max(10, Math.min(Number(body.duration_sec ?? 30) || 30, 180))
    const platform = typeof body.platform === 'string' ? body.platform : account.platform ?? 'youtube'
    const autoApproveRender = body.auto_approve_render !== false
    const autoApprovePublish = body.auto_approve_publish !== false
    const aiConfig = await resolveAiConfig(body)
    const aiTrace = aiTraceFromConfig(aiConfig)
    const hashtags = Array.isArray(body.hashtags)
      ? body.hashtags.filter((tag) => typeof tag === 'string' && tag.trim()).map((tag) => tag.trim())
      : []
    const visibility = typeof body.visibility === 'string' ? body.visibility : 'private'

    const workflowEventId = addWorkflowEvent('ai.execute_pipeline', 'source_item', sourceItemId, 'processed', {
      idea_count: ideaCount,
      duration_sec: durationSec,
      platform,
    })

    const ideaIds = []
    let leadIdeaId = null
    const aiIdeas = await generateIdeasWithAi(aiConfig, item, { ideaCount, durationSec, platform }).catch(() => null)
    for (let i = 0; i < ideaCount; i += 1) {
      const ideaId = newId()
      const approvedLead = i === 0
      const aiIdea = aiIdeas?.[i]
      store.short_ideas.unshift({
        id: ideaId,
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
        created_at: nowIso(),
        updated_at: nowIso(),
        deleted_at: null,
      })
      ideaIds.push(ideaId)
      if (approvedLead) {
        leadIdeaId = ideaId
        addApprovalRecord('short_idea', ideaId, 'idea_review', 'approved', 'AI execute pipeline lead approval')
        addAuditLog('short_idea.auto_approved', 'short_idea', ideaId, 'ai')
      } else {
        addAuditLog('short_idea.generated', 'short_idea', ideaId, 'ai')
      }
    }

    const nextVersion =
      store.scripts.filter((entry) => entry.short_idea_id === leadIdeaId).reduce((max, entry) => Math.max(max, entry.version), 0) + 1
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

    store.scripts.unshift({
      id: scriptId,
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
      created_at: nowIso(),
      updated_at: nowIso(),
      deleted_at: null,
    })
    addApprovalRecord('script', scriptId, 'script_review', 'approved', 'AI execute pipeline script approval')
    addAuditLog('script.auto_approved', 'script', scriptId, 'ai')

    const renderJobId = newId()
    store.render_jobs.unshift({
      id: renderJobId,
      script_id: scriptId,
      short_idea_id: leadIdeaId,
      template_id: typeof body.template_id === 'string' ? body.template_id : null,
      render_profile: typeof body.render_profile === 'string' ? body.render_profile : 'shorts_1080x1920',
      status: 'queued',
      qc_status: autoApproveRender ? 'passed' : 'pending',
      retry_count: 0,
      error_message: null,
      output: null,
      created_at: nowIso(),
      updated_at: nowIso(),
      deleted_at: null,
    })
    addAuditLog('render_job.created', 'render_job', renderJobId, 'ai')
    if (autoApproveRender) {
      addApprovalRecord('render_job', renderJobId, 'render_review', 'approved', 'AI execute pipeline render approval')
      addAuditLog('render_job.auto_approved', 'render_job', renderJobId, 'ai')
    }

    const publishJobId = newId()
    const publishStatus = autoApprovePublish ? 'queued' : 'awaiting_approval'
    store.publish_jobs.unshift({
      id: publishJobId,
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
      created_at: nowIso(),
      updated_at: nowIso(),
      deleted_at: null,
    })
    addAuditLog('publish_job.created', 'publish_job', publishJobId, 'ai')
    if (autoApprovePublish) {
      addApprovalRecord('publish_job', publishJobId, 'publish_review', 'approved', 'AI execute pipeline publish approval')
      addAuditLog('publish_job.auto_approved', 'publish_job', publishJobId, 'ai')
    }

    addAuditLog('source_item.ai_pipeline_run', 'source_item', sourceItemId, 'ai', { ai_trace: aiTrace })
    await saveStore(store)

    const execution = await executePublishJobById(publishJobId, body, 'ai')
    return {
      data: {
        workflow_event_id: workflowEventId,
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
        execution,
      },
      meta: { ai_trace: aiTrace },
    }
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

app.get('/api/ai/failed-jobs', (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit ?? 20) || 20, 1), 100)
  const jobType = typeof req.query.job_type === 'string' ? req.query.job_type : 'all'
  const onlyDue = parseBooleanLike(req.query.only_due, false)
  const provider = typeof req.query.provider === 'string' ? req.query.provider.trim() : ''
  const platform = typeof req.query.platform === 'string' ? req.query.platform.trim() : ''
  const now = Date.now()

  let items = []
  if (jobType === 'all' || jobType === 'render') {
    items.push(...store.render_jobs.filter((job) => !job.deleted_at && job.status === 'failed').map((job) => mapFailedJobSummary('render', job)))
  }
  if (jobType === 'all' || jobType === 'publish') {
    items.push(...store.publish_jobs.filter((job) => !job.deleted_at && job.status === 'failed').map((job) => mapFailedJobSummary('publish', job)))
  }

  items = items.filter((item) => !isDeadLettered(item))
  items = items.filter((item) => !isExecutionLocked(item, now))
  if (onlyDue) items = items.filter((item) => isRetryDue(item.next_retry_at, now))
  if (provider) items = items.filter((item) => item.provider === provider)
  if (platform) items = items.filter((item) => item.platform === platform)
  items = items.sort(sortByUpdatedDesc)

  ok(res, { items: items.slice(0, limit), total: items.length, limit, only_due: onlyDue, dead_lettered_only: false })
})

app.get('/api/ai/dead-letter-jobs', (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit ?? 20) || 20, 1), 100)
  const jobType = typeof req.query.job_type === 'string' ? req.query.job_type : 'all'
  const provider = typeof req.query.provider === 'string' ? req.query.provider.trim() : ''
  const platform = typeof req.query.platform === 'string' ? req.query.platform.trim() : ''

  let items = []
  if (jobType === 'all' || jobType === 'render') {
    items.push(...store.render_jobs.filter((job) => !job.deleted_at && job.status === 'failed').map((job) => mapFailedJobSummary('render', job)))
  }
  if (jobType === 'all' || jobType === 'publish') {
    items.push(...store.publish_jobs.filter((job) => !job.deleted_at && job.status === 'failed').map((job) => mapFailedJobSummary('publish', job)))
  }

  items = items.filter((item) => isDeadLettered(item))
  if (provider) items = items.filter((item) => item.provider === provider)
  if (platform) items = items.filter((item) => item.platform === platform)
  items = items.sort(sortByUpdatedDesc)

  ok(res, { items: items.slice(0, limit), total: items.length, limit, dead_lettered_only: true })
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

    let candidates = []
    if (jobType === 'all' || jobType === 'render') {
      candidates.push(...store.render_jobs.filter((job) => !job.deleted_at && job.status === 'failed').map((job) => mapFailedJobSummary('render', job)))
    }
    if (jobType === 'all' || jobType === 'publish') {
      candidates.push(...store.publish_jobs.filter((job) => !job.deleted_at && job.status === 'failed').map((job) => mapFailedJobSummary('publish', job)))
    }

    candidates = candidates.filter((item) => !isDeadLettered(item)).filter((item) => !isExecutionLocked(item, now))
    if (onlyDue) candidates = candidates.filter((item) => isRetryDue(item.next_retry_at, now))
    if (provider) candidates = candidates.filter((item) => item.provider === provider)
    if (platform) candidates = candidates.filter((item) => item.platform === platform)
    candidates = candidates.sort(sortByUpdatedDesc).slice(0, limit)

    const results = []
    for (const item of candidates) {
      try {
        if (item.job_type === 'render') {
          const job = store.render_jobs.find((entry) => entry.id === item.id && !entry.deleted_at)
          if (!job) throw new Error('render_job_not_found')
          job.retry_count = Number(job.retry_count ?? 0) + 1
          job.error_message = null
          job.updated_at = nowIso()
          const result = await executeRenderJobById(item.id, body.render ?? body, 'ai')
          results.push({ job_type: 'render', id: item.id, ok: result.status !== 'failed', result })
        } else {
          const job = store.publish_jobs.find((entry) => entry.id === item.id && !entry.deleted_at)
          if (!job) throw new Error('publish_job_not_found')
          job.retry_count = Number(job.retry_count ?? 0) + 1
          job.error_message = null
          job.updated_at = nowIso()
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

    await saveStore(store)
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

    let candidates = []
    if (jobType === 'all' || jobType === 'render') {
      candidates.push(...store.render_jobs.filter((job) => !job.deleted_at && job.status === 'failed').map((job) => mapFailedJobSummary('render', job)))
    }
    if (jobType === 'all' || jobType === 'publish') {
      candidates.push(...store.publish_jobs.filter((job) => !job.deleted_at && job.status === 'failed').map((job) => mapFailedJobSummary('publish', job)))
    }

    candidates = candidates.filter((item) => isDeadLettered(item))
    if (requestedIds.length) candidates = candidates.filter((item) => requestedIds.includes(item.id))
    if (provider) candidates = candidates.filter((item) => item.provider === provider)
    if (platform) candidates = candidates.filter((item) => item.platform === platform)
    candidates = candidates.sort(sortByUpdatedDesc).slice(0, limit)

    const results = []
    for (const item of candidates) {
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

    let candidates = []
    if (jobType === 'all' || jobType === 'render') {
      candidates.push(...store.render_jobs.filter((job) => !job.deleted_at && job.status === 'failed').map((job) => mapFailedJobSummary('render', job)))
    }
    if (jobType === 'all' || jobType === 'publish') {
      candidates.push(...store.publish_jobs.filter((job) => !job.deleted_at && job.status === 'failed').map((job) => mapFailedJobSummary('publish', job)))
    }

    candidates = candidates.filter((item) => isDeadLettered(item))
    if (requestedIds.length) candidates = candidates.filter((item) => requestedIds.includes(item.id))
    if (provider) candidates = candidates.filter((item) => item.provider === provider)
    if (platform) candidates = candidates.filter((item) => item.platform === platform)
    candidates = candidates.sort(sortByUpdatedDesc).slice(0, limit)

    const results = []
    for (const item of candidates) {
      try {
        const executionBody = item.job_type === 'render' ? body.render ?? body : body.publish ?? body
        const restored = await restoreDeadLetterJob(item.job_type, item.id, executionBody, 'ai')

        if (item.job_type === 'render') {
          const job = store.render_jobs.find((entry) => entry.id === item.id && !entry.deleted_at)
          if (!job) throw new Error('render_job_not_found')
          job.retry_count = Number(job.retry_count ?? 0) + 1
          job.error_message = null
          job.updated_at = nowIso()
          const result = await executeRenderJobById(item.id, executionBody, 'ai')
          results.push({ job_type: 'render', id: item.id, ok: result.status !== 'failed', restored, result })
        } else {
          const job = store.publish_jobs.find((entry) => entry.id === item.id && !entry.deleted_at)
          if (!job) throw new Error('publish_job_not_found')
          job.retry_count = Number(job.retry_count ?? 0) + 1
          job.error_message = null
          job.updated_at = nowIso()
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

    await saveStore(store)
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

app.post('/api/ai/run-retry-sweep', async (req, res) => {
  await withIdempotency(req, res, async () => {
    const body = req.body ?? {}
    const jobType = typeof body.job_type === 'string' ? body.job_type : 'all'
    const limit = Math.min(Math.max(Number(body.limit ?? 20) || 20, 1), 100)
    const onlyDue = parseBooleanLike(body.only_due, true)
    const provider = typeof body.provider === 'string' ? body.provider.trim() : ''
    const platform = typeof body.platform === 'string' ? body.platform.trim() : ''
    const now = Date.now()

    let candidates = []
    if (jobType === 'all' || jobType === 'render') {
      candidates.push(...store.render_jobs.filter((job) => !job.deleted_at && job.status === 'failed').map((job) => mapFailedJobSummary('render', job)))
    }
    if (jobType === 'all' || jobType === 'publish') {
      candidates.push(...store.publish_jobs.filter((job) => !job.deleted_at && job.status === 'failed').map((job) => mapFailedJobSummary('publish', job)))
    }

    candidates = candidates.filter((item) => !isDeadLettered(item)).filter((item) => !isExecutionLocked(item, now))
    if (onlyDue) candidates = candidates.filter((item) => isRetryDue(item.next_retry_at, now))
    if (provider) candidates = candidates.filter((item) => item.provider === provider)
    if (platform) candidates = candidates.filter((item) => item.platform === platform)
    candidates = candidates.sort(sortByUpdatedDesc).slice(0, limit)

    const results = []
    for (const item of candidates) {
      try {
        const executionBody = item.job_type === 'render' ? body.render ?? body : body.publish ?? body
        if (item.job_type === 'render') {
          const job = store.render_jobs.find((entry) => entry.id === item.id && !entry.deleted_at)
          if (!job) throw new Error('render_job_not_found')
          job.retry_count = Number(job.retry_count ?? 0) + 1
          job.error_message = null
          job.updated_at = nowIso()
          const result = await executeRenderJobById(item.id, executionBody, 'ai')
          results.push({ job_type: 'render', id: item.id, ok: result.status !== 'failed', result })
        } else {
          const job = store.publish_jobs.find((entry) => entry.id === item.id && !entry.deleted_at)
          if (!job) throw new Error('publish_job_not_found')
          job.retry_count = Number(job.retry_count ?? 0) + 1
          job.error_message = null
          job.updated_at = nowIso()
          const result = await executePublishJobById(item.id, executionBody, 'ai')
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

    await saveStore(store)
    return {
      data: {
        requested_limit: limit,
        processed_count: results.length,
        success_count: results.filter((x) => x.ok).length,
        failed_count: results.filter((x) => !x.ok).length,
        items: results,
      },
      meta: {},
    }
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

app.get('/api/auth/google', async (req, res) => {
  const config = googleOauthConfig(req)
  if (!config.clientId || !config.clientSecret) {
    return fail(res, 500, 'CONFIG_REQUIRED', 'Google OAuth is not configured', {})
  }

  cleanupOauthStates()
  const returnTo = resolveReturnToUrl(req, typeof req.query.return_to === 'string' ? req.query.return_to : '')
  const state = createStateToken()
  store.oauth_states.unshift({
    state,
    return_to: returnTo,
    created_at: nowIso(),
    expires_at: minutesFromNowIso(15),
  })
  await saveStore(store)

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  authUrl.searchParams.set('client_id', config.clientId)
  authUrl.searchParams.set('redirect_uri', config.redirectUri)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('scope', GOOGLE_OAUTH_SCOPE.join(' '))
  authUrl.searchParams.set('access_type', 'offline')
  authUrl.searchParams.set('prompt', 'consent')
  authUrl.searchParams.set('include_granted_scopes', 'true')
  authUrl.searchParams.set('state', state)

  ok(res, { auth_url: authUrl.toString(), redirect_uri: config.redirectUri, return_to: returnTo })
})

app.get('/api/auth/google/callback', async (req, res) => {
  const stateToken = typeof req.query.state === 'string' ? req.query.state : ''
  const code = typeof req.query.code === 'string' ? req.query.code : ''
  const fallbackReturnTo = resolveReturnToUrl(req, '')

  if (!stateToken || !code) {
    return res.redirect(withQueryParams(fallbackReturnTo, { google_oauth: 'error', message: 'missing_state_or_code' }))
  }

  cleanupOauthStates()
  const stateEntry = consumeOauthState(stateToken)
  await saveStore(store)
  if (!stateEntry) {
    return res.redirect(withQueryParams(fallbackReturnTo, { google_oauth: 'error', message: 'invalid_or_expired_state' }))
  }

  const returnTo = resolveReturnToUrl(req, stateEntry.return_to)
  const config = googleOauthConfig(req)
  if (!config.clientId || !config.clientSecret) {
    return res.redirect(withQueryParams(returnTo, { google_oauth: 'error', message: 'google_oauth_not_configured' }))
  }

  try {
    const tokenData = await googleTokenRequest({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: config.redirectUri,
    })
    const channel = await fetchGoogleChannelProfile(tokenData.access_token)
    const expiresInSec = Math.max(60, Number(tokenData?.expires_in ?? 3600) || 3600)
    const now = nowIso()
    const existing = store.platform_accounts.find(
      (item) => !item.deleted_at && item.platform === 'youtube' && item.channel_id === channel.channel_id
    )

    const target = existing ?? {
      id: newId(),
      platform: 'youtube',
      created_at: now,
      deleted_at: null,
    }

    Object.assign(target, {
      account_name: channel.channel_title,
      status: 'connected',
      access_token: tokenData.access_token,
      refresh_token: isNonEmptyString(tokenData.refresh_token) ? tokenData.refresh_token : target.refresh_token ?? null,
      access_token_expires_at: new Date(Date.now() + expiresInSec * 1000).toISOString(),
      scope: typeof tokenData.scope === 'string' ? tokenData.scope : GOOGLE_OAUTH_SCOPE.join(' '),
      token_type: typeof tokenData.token_type === 'string' ? tokenData.token_type : 'Bearer',
      oauth_provider: 'google',
      channel_id: channel.channel_id,
      channel_title: channel.channel_title,
      token_last_refreshed_at: now,
      last_error_code: null,
      last_error_message: null,
      updated_at: now,
    })

    if (!existing) store.platform_accounts.unshift(target)
    addAuditLog('platform_account.google_connected', 'platform_account', target.id, 'user')
    await saveStore(store)

    return res.redirect(
      withQueryParams(returnTo, {
        google_oauth: 'success',
        account_id: target.id,
        account_name: target.account_name,
      })
    )
  } catch (error) {
    return res.redirect(
      withQueryParams(returnTo, {
        google_oauth: 'error',
        message: error instanceof Error ? error.message : 'google_oauth_failed',
      })
    )
  }
})

app.post('/api/auth/google/refresh/:account_id', async (req, res) => {
  await withIdempotency(req, res, async () => {
    const accountId = req.params.account_id
    const account = store.platform_accounts.find((item) => item.id === accountId && !item.deleted_at)
    if (!account) throw new Error('platform_account_not_found')
    if (account.platform !== 'youtube') throw new Error('unsupported_platform')
    const refreshed = await refreshGooglePlatformAccountTokens(account, 'user')
    return { data: sanitizePlatformAccount(refreshed), meta: {} }
  }).catch((error) => {
    if (error instanceof Error && error.message === 'platform_account_not_found') {
      return fail(res, 404, 'NOT_FOUND', 'platform account not found', {})
    }
    if (error instanceof Error && error.message === 'unsupported_platform') {
      return fail(res, 422, 'UNSUPPORTED_PLATFORM', 'only youtube accounts support google refresh', {})
    }
    return fail(res, 400, 'AUTH_ERROR', error instanceof Error ? error.message : 'token refresh failed', {})
  })
})

app.get('/api/platform-accounts', (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 20) || 20, 100)
  const offset = Number(req.query.offset ?? 0) || 0
  const sanitized = store.platform_accounts.filter((x) => !x.deleted_at).map(sanitizePlatformAccount)
  const page = paginate(sanitized, limit, offset)
  ok(res, page)
})

app.post('/api/platform-accounts/mock-connect', (req, res) => {
  fail(res, 410, 'GONE', 'mock platform account connect has been disabled', {})
})

app.post('/api/platform-accounts/:id/disconnect', async (req, res) => {
  const id = req.params.id
  const account = store.platform_accounts.find((item) => item.id === id && !item.deleted_at)
  if (!account) return fail(res, 404, 'NOT_FOUND', 'platform account not found', {})

  account.status = 'disconnected'
  account.access_token = null
  account.refresh_token = null
  account.access_token_expires_at = null
  account.updated_at = nowIso()
  account.last_error_code = null
  account.last_error_message = null
  addAuditLog('platform_account.disconnected', 'platform_account', id, 'user')
  await saveStore(store)
  ok(res, sanitizePlatformAccount(account))
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

    const account = store.platform_accounts.find((x) => x.id === id && !x.deleted_at)
    if (!account) throw new Error('platform_account_not_found')

    account.status = status
    account.access_token_expires_at = expiresAt
    account.updated_at = nowIso()
    addAuditLog(`platform_account.status_set.${status}`, 'platform_account', id, 'ai')
    await saveStore(store)
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

  const expired = []
  const expiringSoon = []

  for (const account of store.platform_accounts.filter((item) => !item.deleted_at)) {
    const rawExpiresAt = account.access_token_expires_at
    if (!isNonEmptyString(rawExpiresAt)) continue
    const ts = Date.parse(rawExpiresAt)
    if (Number.isNaN(ts)) continue

    if (ts <= now) {
      const refreshable = isNonEmptyString(account.refresh_token)
      if (!refreshable && account.status !== 'disconnected') {
        account.status = 'disconnected'
        account.updated_at = nowIso()
        addAuditLog('platform_account.auto_disconnected_expired', 'platform_account', account.id, actorType)
      }
      expired.push({
        id: account.id,
        platform: account.platform ?? null,
        account_name: account.account_name ?? null,
        status: refreshable ? account.status ?? 'connected' : 'disconnected',
        access_token_expires_at: rawExpiresAt,
        refreshable,
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

  await saveStore(store)
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

app.post('/api/ai/run-platform-account-sweep', async (req, res) => {
  await withIdempotency(req, res, async () => {
    const result = await runPlatformAccountSweep(req.body ?? {}, 'ai')
    return { data: result, meta: {} }
  }).catch(() => fail(res, 400, 'VALIDATION_ERROR', 'invalid input', {}))
})

app.get('/api/ai/ops-metrics', async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit ?? 200) || 200, 1), 500)
  const warningWindowMinutes = Math.min(Math.max(Number(req.query.warning_window_minutes ?? 60) || 60, 5), 60 * 24 * 7)

  const renderItems = store.render_jobs.filter((item) => !item.deleted_at).slice(0, limit)
  const publishItems = store.publish_jobs.filter((item) => !item.deleted_at).slice(0, limit)
  const accountSweep = await runPlatformAccountSweep({ limit, warning_window_minutes: warningWindowMinutes }, 'system')
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

// Blog Posts
app.get('/api/blog-posts', (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 20) || 20, 100)
  const offset = Number(req.query.offset ?? 0) || 0
  const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : ''
  const status = typeof req.query.status === 'string' ? req.query.status : ''
  const category = typeof req.query.category === 'string' ? req.query.category : ''

  let items = store.blog_posts.filter((p) => !p.deleted_at)
  if (q) {
    items = items.filter((p) => {
      const title = typeof p.title === 'string' ? p.title.toLowerCase() : ''
      const content = typeof p.content === 'string' ? p.content.toLowerCase() : ''
      return title.includes(q) || content.includes(q)
    })
  }
  if (status) items = items.filter((p) => p.status === status)
  if (category) items = items.filter((p) => p.category === category)

  const page = paginate(items, limit, offset)
  ok(res, page)
})

app.get('/api/blog-posts/:id', (req, res) => {
  const post = store.blog_posts.find((p) => p.id === req.params.id && !p.deleted_at)
  if (!post) return fail(res, 404, 'NOT_FOUND', 'blog post not found', {})
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
        tone: body.tone ?? 'professional',
        keywords: Array.isArray(body.keywords) ? body.keywords : [],
        source_text: body.source_text ?? '',
        language: body.language ?? 'ko',
        target_length: body.target_length ?? 'medium',
      }).catch(() => null)
      if (typeof aiResult?.html === 'string') htmlContent = aiResult.html
    }

    const post = {
      id,
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

    store.blog_posts.unshift(post)
    addAuditLog(
      'blog_post.created',
      'blog_post',
      id,
      body.ai_generate !== false ? 'ai' : 'user',
      aiTrace ? { ai_trace: aiTrace } : null
    )
    await saveStore(store)
    return { data: post, meta: aiTrace ? { ai_trace: aiTrace } : {} }
  }).catch((error) => {
    if (error instanceof Error && error.message === 'missing_title') {
      return fail(res, 400, 'VALIDATION_ERROR', 'title is required', {})
    }
    return fail(res, 400, 'BLOG_POST_CREATE_FAILED', error instanceof Error ? error.message : 'blog post create failed', {})
  })
})

app.patch('/api/blog-posts/:id', async (req, res) => {
  const post = store.blog_posts.find((p) => p.id === req.params.id && !p.deleted_at)
  if (!post) return fail(res, 404, 'NOT_FOUND', 'blog post not found', {})

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

  for (const key of updatable) {
    if (key in body) post[key] = body[key]
  }
  if (body.status === 'published' && !post.published_at) post.published_at = nowIso()
  post.updated_at = nowIso()

  addAuditLog('blog_post.updated', 'blog_post', post.id, 'user')
  await saveStore(store)
  ok(res, post)
})

app.delete('/api/blog-posts/:id', async (req, res) => {
  const post = store.blog_posts.find((p) => p.id === req.params.id && !p.deleted_at)
  if (!post) return fail(res, 404, 'NOT_FOUND', 'blog post not found', {})

  post.deleted_at = nowIso()
  post.status = 'archived'
  addAuditLog('blog_post.deleted', 'blog_post', post.id, 'user')
  await saveStore(store)
  ok(res, { id: post.id, deleted: true })
})

app.post('/api/blog-posts/:id/publish', async (req, res) => {
  const post = store.blog_posts.find((p) => p.id === req.params.id && !p.deleted_at)
  if (!post) return fail(res, 404, 'NOT_FOUND', 'blog post not found', {})
  if (!post.content) return fail(res, 400, 'NO_CONTENT', 'Cannot publish without content', {})

  post.status = 'published'
  post.published_at = nowIso()
  post.updated_at = nowIso()

  addAuditLog('blog_post.published', 'blog_post', post.id, 'user')
  await saveStore(store)
  ok(res, post)
})

app.post('/api/blog-posts/:id/generate-content', async (req, res) => {
  await withIdempotency(req, res, async () => {
    const post = store.blog_posts.find((p) => p.id === req.params.id && !p.deleted_at)
    if (!post) throw new Error('blog_post_not_found')

    const body = req.body ?? {}
    const aiConfig = await resolveAiConfig(body)
    const aiTrace = aiTraceFromConfig(aiConfig)
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

    post.content = aiResult.html
    post.excerpt = aiResult.excerpt ?? post.excerpt
    post.seo_title = aiResult.seo_title ?? post.seo_title
    post.seo_description = aiResult.seo_description ?? post.seo_description
    if (Array.isArray(aiResult.tags) && aiResult.tags.length) post.tags = aiResult.tags
    post.updated_at = nowIso()

    addAuditLog('blog_post.ai_generated', 'blog_post', post.id, 'ai', { ai_trace: aiTrace })
    await saveStore(store)
    return { data: post, meta: { ai_trace: aiTrace } }
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
