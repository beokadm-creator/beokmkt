import { useEffect, useState } from 'react'
import { apiJson } from '../../lib/api'

type PlatformAccount = {
  id: string
  platform: string
  account_name: string
  status: string
  created_at: string
}

export default function PlatformAccountsPage() {
  const [items, setItems] = useState<PlatformAccount[]>([])
  const [error, setError] = useState<string | null>(null)
  const [isBusy, setIsBusy] = useState(false)

  async function refresh() {
    const d = await apiJson<{ items: PlatformAccount[] }>('/api/platform-accounts?limit=50&offset=0')
    setItems(d.items)
  }

  useEffect(() => {
    refresh().catch((e) => setError(e instanceof Error ? e.message : '불러오기 실패'))
  }, [])

  async function onMockConnect(platform: string) {
    setIsBusy(true)
    try {
      await apiJson('/api/platform-accounts/mock-connect', {
        method: 'POST',
        body: JSON.stringify({ platform, account_name: `${platform}-demo` }),
      })
      await refresh()
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : '연결 실패')
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
            onClick={() => onMockConnect('youtube')}
            className="h-9 rounded-lg bg-white px-3 text-sm font-medium text-zinc-950 disabled:opacity-60"
          >
            YouTube 데모 연결
          </button>
          <button
            type="button"
            disabled={isBusy}
            onClick={() => onMockConnect('tiktok')}
            className="h-9 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm text-zinc-200 disabled:opacity-60"
          >
            TikTok 데모 연결
          </button>
        </div>
      </div>

      {error ? <div className="text-sm text-rose-200">{error}</div> : null}

      <div className="overflow-hidden rounded-xl border border-zinc-900">
        <table className="w-full table-fixed">
          <thead className="bg-zinc-950">
            <tr className="text-left text-xs text-zinc-400">
              <th className="w-[22%] px-4 py-3">platform</th>
              <th className="w-[38%] px-4 py-3">account</th>
              <th className="w-[20%] px-4 py-3">status</th>
              <th className="w-[20%] px-4 py-3">created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-900 bg-zinc-950/40">
            {items.map((it) => (
              <tr key={it.id} className="text-sm text-zinc-300">
                <td className="px-4 py-3">{it.platform}</td>
                <td className="px-4 py-3">{it.account_name}</td>
                <td className="px-4 py-3">{it.status}</td>
                <td className="px-4 py-3 text-zinc-500">{new Date(it.created_at).toLocaleString()}</td>
              </tr>
            ))}
            {!items.length ? (
              <tr>
                <td className="px-4 py-8 text-sm text-zinc-500" colSpan={4}>
                  연결된 계정이 없습니다. 위 버튼으로 데모 계정을 연결해 보세요.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  )
}

