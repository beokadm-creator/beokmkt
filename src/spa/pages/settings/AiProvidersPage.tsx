import { useEffect, useMemo, useState } from 'react'

type Provider =
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'mistral'
  | 'cohere'
  | 'zhipu'
  | 'zai'

type ApiResult =
  | { ok: true; details: string; endpoint?: string; httpStatus?: number | null }
  | { ok: false; details: string; endpoint?: string; httpStatus?: number | null }

const DEFAULT_ENDPOINTS: Record<Provider, string> = {
  openai: 'https://api.openai.com/v1/models',
  anthropic: 'https://api.anthropic.com/v1/messages',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/models',
  mistral: 'https://api.mistral.ai/v1/chat/completions',
  cohere: 'https://api.cohere.ai/v1/chat',
  zhipu: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
  zai: 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions',
}

function toDisplayMessage(value: unknown, fallback: string) {
  if (typeof value === 'string' && value.trim()) return value
  if (value && typeof value === 'object') {
    const error = value as { code?: unknown; message?: unknown; details?: unknown }
    if (typeof error.message === 'string' && error.message.trim()) return error.message
    if (typeof error.code === 'string' && error.code.trim()) return error.code
  }
  return fallback
}

export default function AiProvidersPage() {
  const providers: Provider[] = useMemo(
    () => ['openai', 'anthropic', 'gemini', 'mistral', 'cohere', 'zhipu', 'zai'],
    []
  )

  const [provider, setProvider] = useState<Provider>('openai')
  const [apiKey, setApiKey] = useState('')
  const [endpoint, setEndpoint] = useState(DEFAULT_ENDPOINTS.openai)
  const [isLoading, setIsLoading] = useState(false)
  const [result, setResult] = useState<ApiResult | null>(null)

  useEffect(() => {
    setEndpoint(DEFAULT_ENDPOINTS[provider])
    setResult(null)
  }, [provider])

  async function onTest() {
    if (!apiKey.trim()) {
      setResult({ ok: false, details: 'API key를 입력해 주세요.' })
      return
    }

    setIsLoading(true)
    setResult(null)

    try {
      const token = localStorage.getItem('beokmkt_id_token')
      const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8' })
      if (token) headers.set('Authorization', `Bearer ${token}`)

      const res = await fetch('/api/test-ai-key', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          provider,
          apiKey: apiKey.trim(),
          endpoint: endpoint.trim(),
        }),
      })

      const data = (await res.json().catch(() => null)) as
        | { valid?: boolean; details?: unknown; error?: unknown; diagnostics?: { endpoint?: unknown; http_status?: unknown } }
        | { error?: { code?: unknown; message?: unknown; details?: unknown } }
        | null

      setResult({
        ok: Boolean(data && 'valid' in data ? data.valid : false) && res.ok,
        details: toDisplayMessage(
          data && 'details' in data ? data.details : undefined,
          data && 'valid' in data && data.valid ? '성공' : '실패'
        ),
        endpoint:
          data && 'diagnostics' in data && data.diagnostics && typeof data.diagnostics === 'object' && typeof data.diagnostics.endpoint === 'string'
            ? data.diagnostics.endpoint
            : endpoint.trim() || undefined,
        httpStatus:
          data && 'diagnostics' in data && data.diagnostics && typeof data.diagnostics === 'object' && typeof data.diagnostics.http_status === 'number'
            ? data.diagnostics.http_status
            : res.status,
      })
    } catch (e) {
      setResult({ ok: false, details: e instanceof Error ? e.message : '요청 실패' })
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <div className="text-sm font-semibold">AI 공급자 연결 테스트</div>

      <section className="rounded-xl border border-zinc-900 bg-zinc-900/30 p-4">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <label className="flex flex-col gap-2">
            <span className="text-xs text-zinc-400">Provider</span>
            <select
              className="h-10 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm"
              value={provider}
              onChange={(e) => setProvider(e.target.value as Provider)}
            >
              {providers.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-2 md:col-span-2">
            <span className="text-xs text-zinc-400">API Key</span>
            <input
              className="h-10 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="키를 입력하고 테스트를 눌러 주세요"
            />
          </label>
        </div>

        <label className="mt-3 flex flex-col gap-2">
          <span className="text-xs text-zinc-400">Endpoint URL</span>
          <input
            className="h-10 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm"
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder="기본 엔드포인트를 사용하거나 직접 입력하세요"
          />
        </label>

        <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-xs text-zinc-400">
          기본값은 provider별 권장 엔드포인트로 자동 설정됩니다. 실패 시 엔드포인트를 직접 바꿔서 재테스트할 수 있습니다.
        </div>

        <div className="mt-4 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={onTest}
            disabled={isLoading}
            className="inline-flex h-10 items-center justify-center rounded-lg bg-white px-4 text-sm font-medium text-zinc-950 disabled:opacity-60"
          >
            {isLoading ? '테스트 중…' : '연결 테스트'}
          </button>

          {result ? (
            <div
              className={[
                'max-w-[70%] rounded-lg border px-3 py-2 text-sm',
                result.ok
                  ? 'border-emerald-900/60 bg-emerald-950/30 text-emerald-200'
                  : 'border-rose-900/60 bg-rose-950/30 text-rose-200',
              ].join(' ')}
            >
              <div>{result.details}</div>
              {result.endpoint ? <div className="mt-1 break-all text-xs opacity-80">endpoint: {result.endpoint}</div> : null}
              {typeof result.httpStatus === 'number' ? <div className="mt-1 text-xs opacity-80">http_status: {result.httpStatus}</div> : null}
            </div>
          ) : (
            <div className="text-sm text-zinc-500">결과가 여기에 표시됩니다.</div>
          )}
        </div>
      </section>
    </div>
  )
}
