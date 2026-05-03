import express from 'express'
import { randomUUID } from 'crypto'

const port = Number(process.env.WEB_RENDER_EXECUTOR_PORT ?? 8791) || 8791
const publicBaseUrl = (process.env.WEB_RENDER_EXECUTOR_PUBLIC_BASE_URL ?? `http://localhost:${port}`).replace(/\/+$/, '')
const upstreamUrl = (process.env.WEB_RENDER_UPSTREAM_URL ?? '').trim()
const upstreamToken = (process.env.WEB_RENDER_UPSTREAM_TOKEN ?? '').trim()
const fallbackUrl = (process.env.WEB_RENDER_FALLBACK_URL ?? process.env.RENDER_EXECUTOR_URL ?? '').trim()
const fallbackToken = (process.env.WEB_RENDER_FALLBACK_TOKEN ?? process.env.RENDER_EXECUTOR_TOKEN ?? '').trim()
const providerName = (process.env.WEB_RENDER_PROVIDER ?? 'web-automation').trim() || 'web-automation'
const allowFallback = String(process.env.WEB_RENDER_ALLOW_FALLBACK ?? 'true').toLowerCase() !== 'false'
const requestTimeoutMs = Math.max(1_000, Number(process.env.WEB_RENDER_TIMEOUT_MS ?? 120_000) || 120_000)

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function normalizeErrorCode(rawCode, message = '') {
  const code = typeof rawCode === 'string' ? rawCode.trim().toUpperCase() : ''
  const supported = new Set([
    'AUTH_ERROR',
    'RATE_LIMIT',
    'UI_CHANGED',
    'DOWNLOAD_FAILED',
    'TIMEOUT',
    'TEMPORARY',
    'INVALID_PAYLOAD',
    'NOT_FOUND',
    'CONFIG_REQUIRED',
    'NETWORK_ERROR',
  ])
  if (supported.has(code)) return code

  const text = `${code} ${typeof message === 'string' ? message : ''}`.toLowerCase()
  if (text.includes('auth') || text.includes('login') || text.includes('unauthorized') || text.includes('forbidden')) return 'AUTH_ERROR'
  if (text.includes('rate limit') || text.includes('quota') || text.includes('too many requests')) return 'RATE_LIMIT'
  if (text.includes('download')) return 'DOWNLOAD_FAILED'
  if (text.includes('timeout') || text.includes('timed out')) return 'TIMEOUT'
  if (text.includes('ui') && text.includes('change')) return 'UI_CHANGED'
  if (text.includes('invalid payload') || text.includes('validation') || text.includes('bad request')) return 'INVALID_PAYLOAD'
  if (text.includes('config') || text.includes('missing url')) return 'CONFIG_REQUIRED'
  if (text.includes('network') || text.includes('fetch')) return 'NETWORK_ERROR'
  return 'TEMPORARY'
}

function buildFailureResponse(errorCode, errorMessage, meta = {}) {
  return {
    status: 'failed',
    error_code: normalizeErrorCode(errorCode, errorMessage),
    error_message: errorMessage,
    next_retry_at: null,
    output: {
      render_provider: providerName,
      ...meta,
    },
  }
}

function buildSuccessResponse(renderJobId, externalJobId, output = {}, meta = {}) {
  return {
    status: 'rendered',
    external_job_id: externalJobId || `web-${renderJobId}`,
    qc_status: typeof output.qc_status === 'string' && output.qc_status.trim() ? output.qc_status.trim() : 'passed',
    output: {
      asset_url: output.asset_url,
      thumbnail_url: isNonEmptyString(output.thumbnail_url) ? output.thumbnail_url.trim() : null,
      duration_sec: Number(output.duration_sec ?? 0) || 0,
      subtitles_included: output.subtitles_included !== false,
      render_provider: isNonEmptyString(output.render_provider) ? output.render_provider.trim() : providerName,
      executed_at: isNonEmptyString(output.executed_at) ? output.executed_at.trim() : new Date().toISOString(),
      meta,
    },
  }
}

function withTimeout(signal, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
  const abortHandler = () => controller.abort(signal?.reason ?? new Error('aborted'))
  signal?.addEventListener('abort', abortHandler, { once: true })
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', abortHandler)
    },
  }
}

async function postJson(url, payload, token, timeoutMs) {
  const { signal, cleanup } = withTimeout(null, timeoutMs)
  try {
    const headers = new Headers({ 'Content-Type': 'application/json' })
    if (isNonEmptyString(token)) headers.set('Authorization', `Bearer ${token}`)
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal,
    })
    const data = await res.json().catch(() => null)
    return { ok: res.ok, status: res.status, data }
  } finally {
    cleanup()
  }
}

function buildWebRequest(payload, requestId) {
  const script = payload?.script ?? {}
  const options = payload?.options ?? {}
  const generator = options.web_generator ?? {}
  return {
    request_id: requestId,
    kind: 'render',
    render_job_id: payload?.render_job_id ?? requestId,
    script_id: payload?.script_id ?? null,
    short_idea_id: payload?.short_idea_id ?? null,
    provider: isNonEmptyString(generator.provider) ? generator.provider.trim() : providerName,
    login_hint: generator.login_hint ?? null,
    prompt:
      isNonEmptyString(generator.prompt)
        ? generator.prompt.trim()
        : isNonEmptyString(options.tts_text)
          ? options.tts_text.trim()
          : isNonEmptyString(script.script_text)
            ? script.script_text.trim()
            : '',
    negative_prompt: isNonEmptyString(generator.negative_prompt) ? generator.negative_prompt.trim() : '',
    duration_sec: Number(script.duration_sec ?? options.duration_sec ?? generator.duration_sec ?? 30) || 30,
    aspect_ratio: isNonEmptyString(generator.aspect_ratio) ? generator.aspect_ratio.trim() : '9:16',
    style_preset: isNonEmptyString(generator.style_preset) ? generator.style_preset.trim() : '',
    source_payload: payload,
  }
}

async function callUpstreamWebGenerator(payload, requestId) {
  if (!isNonEmptyString(upstreamUrl)) {
    return {
      ok: false,
      status: 0,
      data: buildFailureResponse(
        'CONFIG_REQUIRED',
        'WEB_RENDER_UPSTREAM_URL is not configured',
        { request_id: requestId, mode: 'web_only' }
      ),
    }
  }

  try {
    return await postJson(upstreamUrl, buildWebRequest(payload, requestId), upstreamToken, requestTimeoutMs)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'web upstream request failed'
    return {
      ok: false,
      status: 0,
      data: buildFailureResponse(normalizeErrorCode('', message), message, {
        request_id: requestId,
        mode: 'web_only',
      }),
    }
  }
}

async function callFallbackRenderer(payload, requestId, failureInfo) {
  if (!allowFallback) {
    return buildFailureResponse(failureInfo.error_code, failureInfo.error_message, {
      request_id: requestId,
      mode: 'web_only',
      fallback_used: false,
    })
  }

  if (!isNonEmptyString(fallbackUrl)) {
    return buildFailureResponse('CONFIG_REQUIRED', 'WEB_RENDER_FALLBACK_URL is not configured', {
      request_id: requestId,
      mode: 'fallback_missing',
      fallback_used: false,
      upstream_error_code: failureInfo.error_code,
    })
  }

  try {
    const fallbackPayload = {
      ...payload,
      options: {
        ...(payload?.options ?? {}),
        web_failure_context: {
          error_code: failureInfo.error_code,
          error_message: failureInfo.error_message,
        },
      },
    }
    const fallback = await postJson(fallbackUrl, fallbackPayload, fallbackToken, requestTimeoutMs)
    if (!fallback.ok && fallback.status >= 400) {
      return buildFailureResponse('TEMPORARY', `fallback renderer HTTP ${fallback.status}`, {
        request_id: requestId,
        mode: 'fallback_failed',
        fallback_used: true,
        upstream_error_code: failureInfo.error_code,
      })
    }

    const data = fallback.data ?? {}
    if (data?.status === 'failed') {
      return buildFailureResponse(data?.error_code ?? 'TEMPORARY', data?.error_message ?? 'fallback renderer failed', {
        request_id: requestId,
        mode: 'fallback_failed',
        fallback_used: true,
        upstream_error_code: failureInfo.error_code,
      })
    }

    const assetUrl =
      isNonEmptyString(data?.output?.asset_url) ? data.output.asset_url.trim() : isNonEmptyString(data?.asset_url) ? data.asset_url.trim() : ''
    if (!assetUrl) {
      return buildFailureResponse('INVALID_PAYLOAD', 'fallback renderer returned no asset_url', {
        request_id: requestId,
        mode: 'fallback_invalid',
        fallback_used: true,
        upstream_error_code: failureInfo.error_code,
      })
    }

    return buildSuccessResponse(payload?.render_job_id ?? requestId, data?.external_job_id ?? `fallback-${requestId}`, {
      asset_url: assetUrl,
      thumbnail_url: data?.output?.thumbnail_url ?? data?.thumbnail_url ?? null,
      duration_sec: data?.output?.duration_sec ?? 0,
      subtitles_included: data?.output?.subtitles_included !== false,
      render_provider: data?.output?.render_provider ?? 'local-fallback',
      executed_at: data?.output?.executed_at ?? new Date().toISOString(),
      qc_status: data?.qc_status ?? 'passed',
    }, {
      request_id: requestId,
      mode: 'fallback_success',
      fallback_used: true,
      upstream_error_code: failureInfo.error_code,
      upstream_error_message: failureInfo.error_message,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'fallback renderer request failed'
    return buildFailureResponse(normalizeErrorCode('', message), message, {
      request_id: requestId,
      mode: 'fallback_error',
      fallback_used: true,
      upstream_error_code: failureInfo.error_code,
    })
  }
}

const app = express()
app.use(express.json({ limit: '10mb' }))

app.get('/health', async (req, res) => {
  res.json({
    ok: true,
    provider: providerName,
    public_base_url: publicBaseUrl,
    upstream_configured: isNonEmptyString(upstreamUrl),
    fallback_configured: isNonEmptyString(fallbackUrl),
    fallback_enabled: allowFallback,
    timeout_ms: requestTimeoutMs,
  })
})

app.post('/', async (req, res) => {
  const startedAt = Date.now()
  const payload = req.body ?? {}
  const renderJobId = isNonEmptyString(payload?.render_job_id) ? payload.render_job_id.trim() : randomUUID()
  const requestId = randomUUID()

  const upstream = await callUpstreamWebGenerator(payload, requestId)
  const upstreamData = upstream?.data ?? null
  const upstreamAssetUrl =
    isNonEmptyString(upstreamData?.output?.asset_url)
      ? upstreamData.output.asset_url.trim()
      : isNonEmptyString(upstreamData?.asset_url)
        ? upstreamData.asset_url.trim()
        : ''

  if (upstreamAssetUrl) {
    return res.json(
      buildSuccessResponse(
        renderJobId,
        upstreamData?.external_job_id ?? `web-${renderJobId}`,
        {
          asset_url: upstreamAssetUrl,
          thumbnail_url: upstreamData?.output?.thumbnail_url ?? upstreamData?.thumbnail_url ?? null,
          duration_sec: upstreamData?.output?.duration_sec ?? 0,
          subtitles_included: upstreamData?.output?.subtitles_included !== false,
          render_provider: upstreamData?.output?.render_provider ?? providerName,
          executed_at: upstreamData?.output?.executed_at ?? new Date().toISOString(),
          qc_status: upstreamData?.qc_status ?? 'passed',
        },
        {
          request_id: requestId,
          mode: 'web_success',
          fallback_used: false,
          duration_ms: Date.now() - startedAt,
          upstream_http_status: upstream.status ?? 200,
        }
      )
    )
  }

  const failureInfo = {
    error_code: normalizeErrorCode(upstreamData?.error_code, upstreamData?.error_message ?? ''),
    error_message:
      isNonEmptyString(upstreamData?.error_message)
        ? upstreamData.error_message.trim()
        : isNonEmptyString(upstreamData?.message)
          ? upstreamData.message.trim()
          : upstream.ok === false && upstream.status >= 400
            ? `web upstream HTTP ${upstream.status}`
            : 'web generator returned no asset_url',
  }

  const next = await callFallbackRenderer(payload, requestId, failureInfo)
  if (next?.output?.meta && typeof next.output.meta === 'object') {
    next.output.meta.duration_ms = Date.now() - startedAt
    next.output.meta.upstream_http_status = upstream.status ?? 0
  }
  return res.json(next)
})

app.listen(port, () => {
  process.stdout.write(`web render executor listening on ${publicBaseUrl}\n`)
})
