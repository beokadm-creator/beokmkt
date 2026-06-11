import 'dotenv/config'
import path from 'path'
import { promises as fs } from 'fs'
import { chromium } from 'playwright'
import { persistSession, readJsonIfExists, snapshotSessionSize } from './session-helpers.mjs'

const NAV_TIMEOUT = Number(process.env.NAVER_BLOG_TIMEOUT_MS || '60000')
const NAVER_STORAGE = path.resolve(process.env.NAVER_BLOG_STORAGE_STATE_PATH || './.session/naver-session.json')
const TISTORY_STORAGE = path.resolve(process.env.TISTORY_SESSION_PATH || './.session/tistory-session.json')

function log(level, ...args) {
  const ts = new Date().toISOString()
  const prefix = `[${ts}] [keepalive][${level.toUpperCase()}]`
  if (level === 'error') console.error(prefix, ...args)
  else console.log(prefix, ...args)
}

async function probeSession(label, storagePath, testUrl) {
  const beforeSize = await snapshotSessionSize(storagePath)
  const browser = await chromium.launch({ headless: true })
  try {
    const context = await chromium.newContext({
      storageState: storagePath,
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      locale: 'ko-KR',
    })
    const page = await context.newPage()
    page.setDefaultTimeout(NAV_TIMEOUT)
    await page.goto(testUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(() => {})
    await persistSession(context, storagePath)
    const afterSize = await snapshotSessionSize(storagePath)
    await context.close()
    return { ok: true, before: beforeSize, after: afterSize }
  } catch (e) {
    return { ok: false, error: e.message }
  } finally {
    await browser.close().catch(() => {})
  }
}

async function main() {
  log('info', '─────────────────────────────────────────')
  log('info', '세션 keepalive 시작')

  const results = { naver: null, tistory: null }

  try {
    const naverExists = await readJsonIfExists(NAVER_STORAGE)
    if (naverExists) {
      results.naver = await probeSession('naver', NAVER_STORAGE, 'https://blog.naver.com/PostWrite.naver')
      log('info', `naver: ${results.naver.ok ? 'session refreshed ✓' : 'failed ✗'} (${results.naver.before} → ${results.naver.after})`)
    } else {
      log('info', 'naver: 세션 없음 (npm run login 필요)')
    }
  } catch (e) {
    results.naver = { ok: false, error: e.message }
    log('error', `naver probe 실패: ${e.message}`)
  }

  try {
    const tistoryExists = await readJsonIfExists(TISTORY_STORAGE)
    if (tistoryExists) {
      results.tistory = await probeSession('tistory', TISTORY_STORAGE, 'https://www.tistory.com/')
      log('info', `tistory: ${results.tistory.ok ? 'session refreshed ✓' : 'failed ✗'}`)
    } else {
      log('info', 'tistory: 세션 없음 (npm run tistory-auth 필요)')
    }
  } catch (e) {
    results.tistory = { ok: false, error: e.message }
    log('error', `tistory probe 실패: ${e.message}`)
  }

  log('info', '─────────────────────────────────────────')
  process.exit(0)
}

main().catch((e) => {
  log('error', 'keepalive 치명적 오류:', e)
  process.exit(1)
})
