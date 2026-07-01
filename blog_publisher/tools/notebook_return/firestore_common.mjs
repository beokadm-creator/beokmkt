import path from 'path'
import { fileURLToPath } from 'url'
import { existsSync, readFileSync } from 'fs'
import { initializeApp, cert, applicationDefault, getApps } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const PROJECT_ID = process.env.NOTEBOOK_RETURN_FIREBASE_PROJECT_ID || 'notebook-return'
const CRED_PATH_RAW = process.env.NOTEBOOK_RETURN_FIREBASE_CREDENTIALS
  || '.secrets/firebase-admin-notebook-return.json'
const SECRET_KEY_PATH = path.isAbsolute(CRED_PATH_RAW)
  ? CRED_PATH_RAW
  : path.resolve(__dirname, '../..', CRED_PATH_RAW)

// 자격증명 우선순위: 명시적 서비스계정 키 → GOOGLE_APPLICATION_CREDENTIALS → ADC.
// beokmkt 자체 프로젝트(sync_pipeline_snapshot.mjs)와 동일한 패턴이지만
// notebook-return 프로젝트를 대상으로 한다. 앱 이름을 분리해 두 프로젝트가
// 같은 프로세스에서도 충돌하지 않게 한다.
export function getNotebookReturnDb() {
  const appName = 'notebook-return'
  const existing = getApps().find((a) => a.name === appName)
  if (existing) return getFirestore(existing)

  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS_NOTEBOOK_RETURN
    || (existsSync(SECRET_KEY_PATH) ? SECRET_KEY_PATH : '')

  let app
  if (credPath && existsSync(credPath)) {
    const sa = JSON.parse(readFileSync(credPath, 'utf-8'))
    app = initializeApp({ projectId: sa.project_id || PROJECT_ID, credential: cert(sa) }, appName)
  } else {
    app = initializeApp({ projectId: PROJECT_ID, credential: applicationDefault() }, appName)
  }
  return getFirestore(app)
}

export function failSkip(message) {
  // exit code 3 = 자격증명/일시적 문제로 건너뜀(파이썬 쪽에서 RetryableError로 처리).
  console.log(JSON.stringify({ ok: false, skip: true, reason: message }))
  process.exit(3)
}

export function failFatal(message) {
  console.log(JSON.stringify({ ok: false, skip: false, reason: message }))
  process.exit(1)
}
