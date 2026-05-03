import { useMemo, useState } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../lib/auth'

export default function LoginPage() {
  const auth = useAuth()
  const location = useLocation()
  const [error, setError] = useState<string | null>(null)
  const [isBusy, setIsBusy] = useState(false)

  const from = useMemo(() => {
    const s = new URLSearchParams(location.search)
    return s.get('from') || '/dashboard'
  }, [location.search])

  async function onGoogle() {
    setIsBusy(true)
    setError(null)
    try {
      await auth.signInWithGoogle()
    } catch (e) {
      setError(e instanceof Error ? e.message : '로그인 실패')
    } finally {
      setIsBusy(false)
    }
  }

  if (auth.isReady && auth.user) return <Navigate to={from} replace />

  return (
    <div className="min-h-full bg-zinc-950 text-zinc-50">
      <div className="mx-auto flex min-h-full w-full max-w-md flex-col justify-center px-6 py-16">
        <div className="text-lg font-semibold">beokmkt 콘솔 로그인</div>
        <div className="mt-2 text-sm text-zinc-400">Firebase Auth로 로그인합니다.</div>

        {auth.configError ? (
          <div className="mt-6 rounded-xl border border-amber-900/60 bg-amber-950/30 p-4 text-sm text-amber-200">
            <div className="font-medium">Firebase 설정이 필요합니다.</div>
            <div className="mt-2 break-words text-amber-100">{auth.configError}</div>
            <div className="mt-2 text-amber-300/80">
              프로젝트 루트 `.env`에 Firebase 웹앱 값을 넣고 `npm run dev:spa`를 다시 시작하세요.
            </div>
          </div>
        ) : null}

        <button
          type="button"
          onClick={onGoogle}
          disabled={isBusy || Boolean(auth.configError)}
          className="mt-8 inline-flex h-11 items-center justify-center rounded-lg bg-white px-4 text-sm font-medium text-zinc-950 disabled:opacity-60"
        >
          {isBusy ? '로그인 중…' : 'Google로 로그인'}
        </button>

        {error ? <div className="mt-4 text-sm text-rose-200">{error}</div> : null}
      </div>
    </div>
  )
}
