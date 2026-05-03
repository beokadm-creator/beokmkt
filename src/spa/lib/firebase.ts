import { initializeApp } from 'firebase/app'
import { Auth, getAuth } from 'firebase/auth'

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY as string,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN as string,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID as string,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET as string,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID as string,
  appId: import.meta.env.VITE_FIREBASE_APP_ID as string,
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID as string | undefined,
}

const requiredFirebaseKeys = [
  'VITE_FIREBASE_API_KEY',
  'VITE_FIREBASE_AUTH_DOMAIN',
  'VITE_FIREBASE_PROJECT_ID',
  'VITE_FIREBASE_STORAGE_BUCKET',
  'VITE_FIREBASE_MESSAGING_SENDER_ID',
  'VITE_FIREBASE_APP_ID',
] as const

const missingFirebaseKeys = requiredFirebaseKeys.filter((key) => {
  const value = import.meta.env[key]
  return typeof value !== 'string' || !value.trim()
})

let configError =
  missingFirebaseKeys.length > 0 ? `Firebase 설정이 비어 있습니다: ${missingFirebaseKeys.join(', ')}` : null

let authInstance: Auth | null = null

if (!configError) {
  try {
    const app = initializeApp(firebaseConfig)
    authInstance = getAuth(app)
  } catch (error) {
    configError = error instanceof Error ? error.message : 'Firebase 초기화 실패'
    console.error(configError)
  }
}

export const auth = authInstance
export const firebaseAuthConfigError = configError
