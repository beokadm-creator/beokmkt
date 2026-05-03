import { useEffect, useMemo, useState } from 'react'
import { apiJson } from '../../lib/api'

type PlatformAccount = {
  id: string
  platform: string
  account_name: string
  status: string
  created_at: string
  updated_at?: string | null
  access_token_expires_at?: string | null
  channel_id?: string | null
  channel_title?: string | null
  token_last_refreshed_at?: string | null
  last_error_code?: string | null
  last_error_message?: string | null
}

export default function PlatformAccountsPage() {
  const [items, setItems] = useState<PlatformAccount[]>([])
  const [error, setError] = useState<string | null>(null)
  const [isBusy, setIsBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  async function refresh() {
    const d = await apiJson<{ items: PlatformAccount[] }>('/api/platform-accounts?limit=50&offset=0')
    setItems(d.items)
  }

  useEffect(() => {
    refresh().catch((e) => setError(e instanceof Error ? e.message : '불러오기 실패'))
  }, [])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const oauth = params.get('google_oauth')
    if (!oauth) return
    if (oauth === 'success') {
      const accountName = params.get('account_name')
      setNotice(accountName ? `${accountName} 계정이 연결되었습니다.` : 'YouTube 계정 연동이 완료되었습니다.')
      refresh().catch((e) => setError(e instanceof Error ? e.message : '불러오기 실패'))
    } else {
      const message = params.get('message')
      setError(message || 'YouTube 연동에 실패했습니다.')
    }
    params.delete('google_oauth')
    params.delete('account_id')
    params.delete('account_name')
    params.delete('message')
    const nextQuery = params.toString()
    const nextUrl = `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ''}`
    window.history.replaceState({}, '', nextUrl)
  }, [])

  const youtubeAccounts = useMemo(() => items.filter((item) => item.platform === 'youtube'), [items])

  async function onConnectYoutube() {
    setIsBusy(true)
    try {
      const returnTo = `${window.location.origin}${window.location.pathname}`
      const data = await apiJson<{ auth_url: string }>('/api/auth/google?return_to=' + encodeURIComponent(returnTo))
      setError(null)
      setNotice('Google 로그인으로 이동합니다.')
      window.location.href = data.auth_url
    } catch (e) {
      setError(e instanceof Error ? e.message : 'YouTube 연결 실패')
    } finally {
      setIsBusy(false)
    }
  }

  async function onRefreshToken(accountId: string) {
    setIsBusy(true)
    try {
      await apiJson(`/api/auth/google/refresh/${accountId}`, {
        method: 'POST',
        idempotencyKey: `google-refresh-${accountId}-${Date.now()}`,
        body: JSON.stringify({}),
      })
      await refresh()
      setNotice('토큰을 갱신했습니다.')
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : '토큰 갱신 실패')
    } finally {
      setIsBusy(false)
    }
  }

  async function onDisconnect(accountId: string) {
    setIsBusy(true)
    try {
      await apiJson(`/api/platform-accounts/${accountId}/disconnect`, {
        method: 'POST',
        idempotencyKey: `platform-disconnect-${accountId}-${Date.now()}`,
        body: JSON.stringify({}),
      })
      await refresh()
      setNotice('계정 연결을 해제했습니다.')
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : '연결 해제 실패')
    } finally {
      setIsBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold">계정 연결</div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={isBusy}
            onClick={onConnectYoutube}
            className="h-9 rounded-lg bg-white px-3 text-sm font-medium text-zinc-950 disabled:opacity-60"
          >
            YouTube 연동
          </button>
        </div>
      </div>

      <div className="rounded-xl border border-zinc-900 bg-zinc-950/40 p-4 text-sm text-zinc-300">
        <div className="font-medium text-zinc-100">YouTube Shorts 발행용 Google OAuth</div>
        <div className="mt-2 text-zinc-400">
          YouTube 계정을 연결하면 업로드 토큰이 서버에 저장되고, 발행 직전에 만료 여부를 확인해 자동 갱신합니다.
        </div>
        <div className="mt-2 text-zinc-500">Redirect URI는 `/api/auth/google/callback` 을 사용합니다.</div>
      </div>

      {notice ? <div className="text-sm text-emerald-300">{notice}</div> : null}
      {error ? <div className="text-sm text-rose-200">{error}</div> : null}

      <div className="overflow-hidden rounded-xl border border-zinc-900">
        <table className="w-full table-fixed">
          <thead className="bg-zinc-950">
            <tr className="text-left text-xs text-zinc-400">
              <th className="w-[16%] px-4 py-3">platform</th>
              <th className="w-[24%] px-4 py-3">account</th>
              <th className="w-[16%] px-4 py-3">status</th>
              <th className="w-[18%] px-4 py-3">expires</th>
              <th className="w-[14%] px-4 py-3">updated</th>
              <th className="w-[12%] px-4 py-3">action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-900 bg-zinc-950/40">
            {youtubeAccounts.map((it) => (
              <tr key={it.id} className="text-sm text-zinc-300">
                <td className="px-4 py-3">{it.platform}</td>
                <td className="px-4 py-3">
                  <div className="font-medium text-zinc-100">{it.account_name}</div>
                  <div className="text-xs text-zinc-500">{it.channel_id ?? '-'}</div>
                </td>
                <td className="px-4 py-3">{it.status}</td>
                <td className="px-4 py-3 text-zinc-500">
                  {it.access_token_expires_at ? new Date(it.access_token_expires_at).toLocaleString() : '-'}
                </td>
                <td className="px-4 py-3 text-zinc-500">
                  {new Date(it.updated_at ?? it.created_at).toLocaleString()}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => onRefreshToken(it.id)}
                      className="rounded-md border border-zinc-800 px-2 py-1 text-xs text-zinc-200 disabled:opacity-60"
                    >
                      갱신
                    </button>
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => onDisconnect(it.id)}
                      className="rounded-md border border-rose-900/70 px-2 py-1 text-xs text-rose-200 disabled:opacity-60"
                    >
                      해제
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {!youtubeAccounts.length ? (
              <tr>
                <td className="px-4 py-8 text-sm text-zinc-500" colSpan={6}>
                  연결된 YouTube 계정이 없습니다. 위 버튼으로 Google OAuth 연동을 시작하세요.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  )
}
