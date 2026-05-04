import { useEffect, useMemo, useState } from 'react'
import { apiJson } from '../../lib/api'

type Provider =
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'mistral'
  | 'cohere'
  | 'zhipu'
  | 'zai'

type ApiResult =
  | { ok: true; details: string; endpoint?: string; model?: string; httpStatus?: number | null }
  | { ok: false; details: string; endpoint?: string; model?: string; httpStatus?: number | null }

const DEFAULT_ENDPOINTS: Record<Provider, string> = {
  openai: 'https://api.openai.com/v1/models',
  anthropic: 'https://api.anthropic.com/v1/messages',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/models',
  mistral: 'https://api.mistral.ai/v1/chat/completions',
  cohere: 'https://api.cohere.ai/v1/chat',
  zhipu: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
  zai: 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions',
}

const DEFAULT_MODELS: Record<Provider, string> = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-3-5-sonnet-20241022',
  gemini: 'gemini-1.5-flash',
  mistral: 'mistral-small-latest',
  cohere: 'command-r',
  zhipu: 'glm-4-flash',
  zai: 'glm-4-flash',
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
  const [model, setModel] = useState(DEFAULT_MODELS.openai)
  const [isLoading, setIsLoading] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [result, setResult] = useState<ApiResult | null>(null)
  const [hasSavedApiKey, setHasSavedApiKey] = useState(false)
  const [savedInfo, setSavedInfo] = useState<string | null>(null)

  useEffect(() => {
    setEndpoint(DEFAULT_ENDPOINTS[provider])
    setModel(DEFAULT_MODELS[provider])
    setResult(null)
  }, [provider])

  useEffect(() => {
    apiJson<{ provider: string; model: string; endpoint: string; has_api_key: boolean; updated_at: string | null }>('/api/ai-provider-defaults')
      .then((data) => {
        if (data?.provider) setProvider(data.provider as Provider)
        if (data?.model) setModel(data.model)
        if (data?.endpoint) setEndpoint(data.endpoint)
        setHasSavedApiKey(Boolean(data?.has_api_key))
        setSavedInfo(data?.updated_at ? `업데이트: ${new Date(data.updated_at).toLocaleString('ko-KR')}` : null)
      })
      .catch(() => null)
  }, [])

  async function onTest() {
    if (!apiKey.trim()) {
      setResult({ ok: false, details: 'API key를 입력해 주세요.' })
      return
    }

    setIsLoading(true)
    setResult(null)

    try {
      const data = await apiJson<{
        valid: boolean
        details: unknown
        diagnostics?: { endpoint?: unknown; model?: unknown; http_status?: unknown }
      }>('/api/test-ai-key', {
        method: 'POST',
        body: JSON.stringify({
          provider,
          apiKey: apiKey.trim(),
          endpoint: endpoint.trim(),
          model: model.trim(),
        }),
      })

      setResult({
        ok: Boolean(data?.valid),
        details: toDisplayMessage(
          data?.details,
          data?.valid ? '성공' : '실패'
        ),
        endpoint:
          data?.diagnostics && typeof data.diagnostics === 'object' && typeof data.diagnostics.endpoint === 'string'
            ? data.diagnostics.endpoint
            : endpoint.trim() || undefined,
        model:
          data?.diagnostics && typeof data.diagnostics === 'object' && typeof data.diagnostics.model === 'string'
            ? data.diagnostics.model
            : model.trim() || undefined,
        httpStatus:
          data?.diagnostics && typeof data.diagnostics === 'object' && typeof data.diagnostics.http_status === 'number'
            ? data.diagnostics.http_status
            : null,
      })
    } catch (e) {
      setResult({ ok: false, details: e instanceof Error ? e.message : '요청 실패' })
    } finally {
      setIsLoading(false)
    }
  }

  async function onSaveDefaults() {
    setIsSaving(true)
    try {
      const data = await apiJson<{ provider: string; model: string; endpoint: string; has_api_key: boolean; updated_at: string | null }>(
        '/api/ai-provider-defaults',
        {
          method: 'PUT',
          body: JSON.stringify({
            provider,
            model: model.trim(),
            endpoint: endpoint.trim(),
            apiKey: apiKey.trim(),
          }),
        }
      )
      setHasSavedApiKey(Boolean(data?.has_api_key))
      setSavedInfo(data?.updated_at ? `업데이트: ${new Date(data.updated_at).toLocaleString('ko-KR')}` : '저장 완료')
      setApiKey('')
    } catch (e) {
      setSavedInfo(e instanceof Error ? e.message : '저장 실패')
    } finally {
      setIsSaving(false)
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
              placeholder={hasSavedApiKey ? '저장된 키가 있습니다 (변경하려면 새 키 입력)' : '키를 입력하고 테스트를 눌러 주세요'}
            />
          </label>
        </div>

        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
          <label className="flex flex-col gap-2">
            <span className="text-xs text-zinc-400">Model</span>
            <input
              className="h-10 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="기본 모델을 사용하거나 직접 입력하세요"
            />
          </label>

          <label className="flex flex-col gap-2">
            <span className="text-xs text-zinc-400">Endpoint URL</span>
            <input
              className="h-10 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              placeholder="기본 엔드포인트를 사용하거나 직접 입력하세요"
            />
          </label>
        </div>

        <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-xs text-zinc-400">
          기본값은 provider별 권장 모델과 엔드포인트로 자동 설정됩니다. 실패 시 모델이나 엔드포인트를 직접 바꿔서 재테스트할 수 있습니다.
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onSaveDefaults}
              disabled={isSaving}
              className="inline-flex h-10 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-950 px-4 text-sm font-medium text-zinc-200 disabled:opacity-60"
            >
              {isSaving ? '저장 중…' : '기본값 저장'}
            </button>
            <button
              type="button"
              onClick={onTest}
              disabled={isLoading}
              className="inline-flex h-10 items-center justify-center rounded-lg bg-white px-4 text-sm font-medium text-zinc-950 disabled:opacity-60"
            >
              {isLoading ? '테스트 중…' : '연결 테스트'}
            </button>
          </div>

          <div className="text-xs text-zinc-500">
            {savedInfo ?? (hasSavedApiKey ? '저장된 기본값이 있습니다.' : '기본값을 저장하면 생성 API의 기본 설정으로 사용됩니다.')}
          </div>

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
              {result.model ? <div className="mt-1 break-all text-xs opacity-80">model: {result.model}</div> : null}
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
