import 'dotenv/config'
import path from 'path'
import { promises as fs } from 'fs'
import { chromium } from 'playwright'
import { persistSession, readJsonIfExists, snapshotSessionSize } from './session-helpers.mjs'

const NAV_TIMEOUT = Number(process.env.NAVER_BLOG_TIMEOUT_MS || '60000')
const NAVER_STORAGE = path.resolve(process.env.NAVER_BLOG_STORAGE_STATE_PATH || './.session/naver-session.json')
const TISTORY_STORAGE = path.resolve(process.env.TISTORY_SESSION_PATH || './.session/tistory-session.json')
const CHROME_PROFILE = path.resolve(process.env.CHROME_PROFILE_PATH || `${process.env.HOME}/Library/Application Support/Google/Chrome/Profile 1`)

function log(level, ...args) {
  const ts = new Date().toISOString()
  const prefix = `[${ts}] [keepalive][${level.toUpperCase()}]`
  if (level === 'error') console.error(prefix, ...args)
  else console.log(prefix, ...args)
}

async function probeSession(label, storagePath, testUrl, loginUrlPatterns = []) {
  const beforeSize = await snapshotSessionSize(storagePath)
  const browser = await chromium.launch({ headless: true })
  try {
    const context = await browser.newContext({
      storageState: storagePath,
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      locale: 'ko-KR',
    })
    const page = await context.newPage()
    page.setDefaultTimeout(NAV_TIMEOUT)
    await page.goto(testUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(() => {})

    // 세션 만료 시 로그인 페이지로 리다이렉트됨 — 덮어쓰기 방지
    const currentUrl = page.url()
    const isLoggedOut = loginUrlPatterns.some(p => currentUrl.includes(p))
    if (isLoggedOut) {
      log('warn', `${label}: 세션 만료 감지 (${currentUrl}) — 세션 파일 보존, 재로그인 필요`)
      await context.close()
      return { ok: false, expired: true, error: `세션 만료: ${currentUrl}` }
    }

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
      results.naver = await probeSession('naver', NAVER_STORAGE, 'https://blog.naver.com/PostWrite.naver', ['nid.naver.com'])
      log('info', `naver: ${results.naver.ok ? 'session refreshed ✓' : results.naver.expired ? '세션 만료 ✗ (재로그인 필요)' : 'failed ✗'} (${results.naver.before} → ${results.naver.after})`)
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
      results.tistory = await probeSession('tistory', TISTORY_STORAGE, 'https://www.tistory.com/', ['accounts.kakao.com', 'tistory.com/auth'])
      log('info', `tistory: ${results.tistory.ok ? 'session refreshed ✓' : results.tistory.expired ? '세션 만료 ✗ (재로그인 필요)' : 'failed ✗'}`)
    } else {
      log('info', 'tistory: 세션 없음 (npm run tistory-auth 필요)')
    }
  } catch (e) {
    results.tistory = { ok: false, error: e.message }
    log('error', `tistory probe 실패: ${e.message}`)
  }

  // Twitter는 persistent Chrome 프로필 기반 — 만료 감지만 수행(세션파일 미사용).
  // Chrome 사용 중이면 충돌하므로 best-effort, 실패는 경고만.
  try {
    const ctx = await chromium.launchPersistentContext(CHROME_PROFILE, {
      headless: true, channel: 'chrome', locale: 'ko-KR',
    })
    try {
      const page = await ctx.newPage()
      page.setDefaultTimeout(NAV_TIMEOUT)
      await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(() => {})
      const needsLogin = await page.locator('input[name="text"], input[name="password"], a[href="/login"]').first().isVisible().catch(() => false)
      log('info', needsLogin ? 'twitter: 로그인 필요 ✗ (node twitter-auth.mjs)' : 'twitter: 세션 유효 ✓')
    } finally {
      await ctx.close().catch(() => {})
    }
  } catch (e) {
    log('warn', `twitter probe 건너뜀 (Chrome 사용 중 등): ${e.message}`)
  }

  // 성공한 세션만 .bak으로 백업 (손상 시 복구용)
  if (results.naver?.ok) {
    await fs.copyFile(NAVER_STORAGE, NAVER_STORAGE + '.bak').catch(() => {})
  }
  if (results.tistory?.ok) {
    await fs.copyFile(TISTORY_STORAGE, TISTORY_STORAGE + '.bak').catch(() => {})
  }

  log('info', '─────────────────────────────────────────')
  process.exit(0)
}

main().catch((e) => {
  log('error', 'keepalive 치명적 오류:', e)
  process.exit(1)
})
