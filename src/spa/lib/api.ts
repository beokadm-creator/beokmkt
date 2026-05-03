export type ApiError = {
  code: string
  message: string
  details?: unknown
}

export class ApiRequestError extends Error {
  code: string
  details?: unknown

  constructor(error: ApiError) {
    super(error.message)
    this.code = error.code
    this.details = error.details
  }
}

export async function apiJson<T>(
  input: RequestInfo | URL,
  init?: RequestInit & { idempotencyKey?: string }
): Promise<T> {
  const token = localStorage.getItem('beokmkt_id_token')
  const headers = new Headers(init?.headers)
  headers.set('Content-Type', 'application/json; charset=utf-8')
  if (init?.idempotencyKey) headers.set('Idempotency-Key', init.idempotencyKey)
  if (token) headers.set('Authorization', `Bearer ${token}`)

  const res = await fetch(input, { ...init, headers })
  const data = await res.json().catch(() => null)

  if (!res.ok) {
    const err = (data?.error ?? {
      code: 'UNKNOWN_ERROR',
      message: typeof data?.message === 'string' ? data.message : `HTTP ${res.status}`,
      details: data,
    }) as ApiError
    throw new ApiRequestError(err)
  }

  return (data?.data ?? data) as T
}
