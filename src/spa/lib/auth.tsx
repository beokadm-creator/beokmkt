import { ReactNode, createContext, useContext, useEffect, useMemo, useState } from 'react'
import { GoogleAuthProvider, User, onIdTokenChanged, signInWithPopup, signOut } from 'firebase/auth'
import { auth, firebaseAuthConfigError } from './firebase'

const TOKEN_KEY = 'beokmkt_id_token'
const adminEmails = String(import.meta.env.VITE_ADMIN_EMAILS ?? '')
  .split(',')
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean)
const adminUids = String(import.meta.env.VITE_ADMIN_UIDS ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)

const adminEmailSet = new Set(adminEmails)
const adminUidSet = new Set(adminUids)
const adminConfigError =
  adminEmails.length > 0 || adminUids.length > 0
    ? null
    : '관리자 허용 목록이 비어 있습니다: VITE_ADMIN_EMAILS 또는 VITE_ADMIN_UIDS를 설정하세요.'

function isAllowedAdmin(user: Pick<User, 'email' | 'uid'> | null | undefined) {
  if (!user) return false
  if (adminEmailSet.size > 0) {
    const email = user.email?.trim().toLowerCase() ?? ''
    if (!email || !adminEmailSet.has(email)) return false
  }
  if (adminUidSet.size > 0) {
    const uid = user.uid?.trim() ?? ''
    if (!uid || !adminUidSet.has(uid)) return false
  }
  return adminEmailSet.size > 0 || adminUidSet.size > 0
}

type AuthState = {
  user: User | null
  isReady: boolean
  isAdmin: boolean
  configError: string | null
  accessError: string | null
  allowedAdminEmails: string[]
  isAllowedAdminEmail: (email: string) => boolean
  signInWithGoogle: (emailHint?: string) => Promise<void>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider(props: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [isReady, setIsReady] = useState(false)
  const [accessError, setAccessError] = useState<string | null>(null)

  useEffect(() => {
    if (!auth) {
      localStorage.removeItem(TOKEN_KEY)
      setUser(null)
      setIsReady(true)
      return
    }

    const authInstance = auth

    const unsub = onIdTokenChanged(authInstance, async (u) => {
      if (!u) {
        setUser(null)
        localStorage.removeItem(TOKEN_KEY)
        setIsReady(true)
        return
      }

      const email = u.email?.trim().toLowerCase() ?? ''
      if (!isAllowedAdmin(u)) {
        setUser(null)
        localStorage.removeItem(TOKEN_KEY)
        setAccessError(email ? `허용되지 않은 관리자 계정입니다: ${email}` : '이 계정은 관리자 로그인 허용 목록에 없습니다.')
        try {
          await signOut(authInstance)
        } catch {
          // Ignore follow-up sign-out failures after access is denied.
        }
        setIsReady(true)
        return
      }

      setAccessError(null)
      setUser(u)
      const token = await u.getIdToken()
      localStorage.setItem(TOKEN_KEY, token)
      setIsReady(true)
    })
    return () => unsub()
  }, [])

  const value = useMemo<AuthState>(() => {
    const isAdmin = isAllowedAdmin(user)
    return {
      user,
      isReady,
      isAdmin,
      configError: firebaseAuthConfigError ?? adminConfigError,
      accessError,
      allowedAdminEmails: adminEmails,
      isAllowedAdminEmail: (email: string) => {
        const normalized = email.trim().toLowerCase()
        return normalized ? adminEmailSet.has(normalized) : false
      },
      signInWithGoogle: async (emailHint?: string) => {
        if (!auth) throw new Error(firebaseAuthConfigError ?? 'Firebase Auth is not configured')
        if (adminConfigError) throw new Error(adminConfigError)
        const provider = new GoogleAuthProvider()
        const normalizedHint = typeof emailHint === 'string' ? emailHint.trim().toLowerCase() : ''
        if (normalizedHint) {
          provider.setCustomParameters({
            login_hint: normalizedHint,
            prompt: 'select_account',
          })
        }
        await signInWithPopup(auth, provider)
      },
      signOut: async () => {
        if (!auth) {
          localStorage.removeItem(TOKEN_KEY)
          return
        }
        await signOut(auth)
      },
    }
  }, [accessError, isReady, user])

  return <AuthContext.Provider value={value}>{props.children}</AuthContext.Provider>
}

export function useAuth() {
  const v = useContext(AuthContext)
  if (!v) throw new Error('AuthProvider is missing')
  return v
}

export function getCachedIdToken() {
  return localStorage.getItem(TOKEN_KEY)
}
