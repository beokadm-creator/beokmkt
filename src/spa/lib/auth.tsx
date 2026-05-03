import { ReactNode, createContext, useContext, useEffect, useMemo, useState } from 'react'
import { GoogleAuthProvider, User, onIdTokenChanged, signInWithPopup, signOut } from 'firebase/auth'
import { auth, firebaseAuthConfigError } from './firebase'

const TOKEN_KEY = 'beokmkt_id_token'

type AuthState = {
  user: User | null
  isReady: boolean
  configError: string | null
  signInWithGoogle: () => Promise<void>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider(props: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [isReady, setIsReady] = useState(false)

  useEffect(() => {
    if (!auth) {
      localStorage.removeItem(TOKEN_KEY)
      setUser(null)
      setIsReady(true)
      return
    }

    const unsub = onIdTokenChanged(auth, async (u) => {
      setUser(u)
      if (u) {
        const token = await u.getIdToken()
        localStorage.setItem(TOKEN_KEY, token)
      } else {
        localStorage.removeItem(TOKEN_KEY)
      }
      setIsReady(true)
    })
    return () => unsub()
  }, [])

  const value = useMemo<AuthState>(() => {
    return {
      user,
      isReady,
      configError: firebaseAuthConfigError,
      signInWithGoogle: async () => {
        if (!auth) throw new Error(firebaseAuthConfigError ?? 'Firebase Auth is not configured')
        const provider = new GoogleAuthProvider()
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
  }, [isReady, user])

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
