import { useEffect, useMemo, useState } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { applySeo } from '../lib/seo'

export default function LoginPage() {
  const auth = useAuth()
  const location = useLocation()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isBusy, setIsBusy] = useState(false)

  const from = useMemo(() => {
    const s = new URLSearchParams(location.search)
    return s.get('from') || '/dashboard'
  }, [location.search])

  const normalizedEmail = email.trim().toLowerCase()
  const hasEmailInput = normalizedEmail.length > 0
  const emailAllowed = hasEmailInput ? auth.isAllowedAdminEmail(normalizedEmail) : false
  const emailError = hasEmailInput && !emailAllowed ? '허용된 관리자 이메일만 로그인할 수 있습니다.' : null
  const passwordMissing = hasEmailInput && !password ? '비밀번호를 입력하세요.' : null

  useEffect(() => {
    const canonical = `${window.location.origin}/login`
    applySeo({
      title: 'beokmkt 관리자 로그인',
      description: 'beokmkt 관리자 전용 로그인 페이지',
      canonical,
      robots: 'noindex,nofollow,noarchive,nosnippet',
    })
  }, [])

  async function onSubmit(e?: React.FormEvent) {
    e?.preventDefault()
    if (!emailAllowed) {
      setError(emailError ?? '관리자 이메일을 입력하세요.')
      return
    }
    if (!password) {
      setError('비밀번호를 입력하세요.')
      return
    }
    setIsBusy(true)
    setError(null)
    try {
      await auth.signInWithPassword(normalizedEmail, password)
    } catch (e) {
      setError(e instanceof Error ? e.message : '로그인 실패')
    } finally {
      setIsBusy(false)
    }
  }

  if (auth.isReady && auth.user && auth.isAdmin) return <Navigate to={from} replace />

  return (
    <div className="min-h-full bg-zinc-950 text-zinc-50">
      <div className="mx-auto flex min-h-full w-full max-w-md flex-col justify-center px-6 py-16">
        <div className="text-lg font-semibold">beokmkt 콘솔 로그인</div>
        <div className="mt-2 text-sm text-zinc-400">허용된 관리자 계정으로만 이메일과 비밀번호 로그인할 수 있습니다.</div>

        <form className="mt-8 space-y-4" onSubmit={onSubmit}>
          <label className="block">
            <div className="mb-2 text-sm font-medium text-zinc-200">관리자 이메일</div>
            <input
              type="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value)
                setError(null)
              }}
              placeholder="admin@company.com"
              autoComplete="email"
              spellCheck={false}
              className="h-11 w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-50 outline-none ring-0 placeholder:text-zinc-500 focus:border-zinc-600"
            />
          </label>

          <label className="block">
            <div className="mb-2 text-sm font-medium text-zinc-200">비밀번호</div>
            <input
              type="password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value)
                setError(null)
              }}
              placeholder="비밀번호 입력"
              autoComplete="current-password"
              className="h-11 w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-50 outline-none ring-0 placeholder:text-zinc-500 focus:border-zinc-600"
            />
          </label>

          {auth.allowedAdminEmails.length === 1 ? (
            <div className="text-xs text-zinc-500">허용된 관리자 이메일: {auth.allowedAdminEmails[0]}</div>
          ) : null}

          {auth.configError ? (
            <div className="rounded-xl border border-amber-900/60 bg-amber-950/30 p-4 text-sm text-amber-200">
              <div className="font-medium">Firebase 설정이 필요합니다.</div>
              <div className="mt-2 break-words text-amber-100">{auth.configError}</div>
              <div className="mt-2 text-amber-300/80">
                프로젝트 루트 `.env`에 Firebase 웹앱 값을 넣고 `npm run dev:spa`를 다시 시작하세요.
              </div>
            </div>
          ) : null}

          {auth.accessError ? (
            <div className="rounded-xl border border-rose-900/60 bg-rose-950/30 p-4 text-sm text-rose-200">
              <div className="font-medium">관리자 접근이 거부되었습니다.</div>
              <div className="mt-2 break-words text-rose-100">{auth.accessError}</div>
            </div>
          ) : null}

          {emailError ? <div className="text-sm text-rose-200">{emailError}</div> : null}
          {!error && !emailError && passwordMissing ? <div className="text-sm text-zinc-500">{passwordMissing}</div> : null}

          <button
            type="submit"
            disabled={isBusy || Boolean(auth.configError) || !emailAllowed || !password}
            className="inline-flex h-11 w-full items-center justify-center rounded-lg bg-white px-4 text-sm font-medium text-zinc-950 disabled:opacity-60"
          >
            {isBusy ? '로그인 중…' : '로그인'}
          </button>
        </form>

        <div className="mt-4 text-xs text-zinc-500">
          콘솔 로그인은 관리자 전용입니다. Google 계정 연결은 로그인 후 설정 화면에서 진행합니다.
        </div>

        {error ? <div className="mt-4 text-sm text-rose-200">{error}</div> : null}
      </div>
    </div>
  )
}
