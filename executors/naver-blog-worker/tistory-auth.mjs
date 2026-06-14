import 'dotenv/config'
import { promises as fs } from 'fs'
import path from 'path'
import readline from 'readline'
import { chromium } from 'playwright'
import { persistSession } from './session-helpers.mjs'

const STORAGE_PATH = path.resolve(process.env.TISTORY_SESSION_PATH || './.session/tistory-session.json')
const NAV_TIMEOUT = Number(process.env.NAVER_BLOG_TIMEOUT_MS || '60000')

// 티스토리 로그인 진입점(카카오 OAuth로 리다이렉트됨).
// 카카오 인증 후 티스토리 세션 쿠키까지 함께 설정되도록 반드시 이 경로로 진입한다.
const LOGIN_URL = process.env.TISTORY_LOGIN_URL || 'https://www.tistory.com/auth/login'

// "로그인 상태 유지"가 켜지면 카카오가 장기 토큰을 발급한다(세션 최대 유지 핵심).
const STAY_SIGNED_IN_SELECTORS = [
  'input[name="stay_signed_in"]',
  'input#staySignedIn',
  'input#stayLogin',
  'input[name="stayLogin"]',
  'label:has-text("로그인 상태 유지") input[type="checkbox"]',
]
// 장기 세션을 나타내는 쿠키 이름(캡처 확인용).
const LONGLIVED_COOKIE_RE = /_kawlt|_kawltea|_karmt|_kahai|TSSESSION|_T_ANO|_tt_/i

function log(level, ...args) {
  const ts = new Date().toISOString()
  const prefix = `[${ts}] [${level.toUpperCase()}]`
  if (level === 'error') console.error(prefix, ...args)
  else console.log(prefix, ...args)
}

async function main() {
  log('info', '=== 티스토리 로그인 ===')

  const browser = await chromium.launch({ headless: false, slowMo: 100 })
  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1366, height: 900 },
      locale: 'ko-KR',
    })
    const page = await context.newPage()
    page.setDefaultTimeout(NAV_TIMEOUT)

    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT })

    log('info', `로그인 페이지로 이동: ${LOGIN_URL}`)
    log('info', '  1) 카카오 계정으로 로그인')
    log('info', '  2) ★ "로그인 상태 유지"를 반드시 켜 두세요 (세션 최대 유지 — 자동 체크도 시도합니다)')
    log('info', '  3) 로그인 완료되면 이 터미널에서 Enter')
    log('info', '')

    // "로그인 상태 유지" 자동 체크 — 카카오 페이지가 늦게 떠도 잡도록 폴링(백그라운드).
    let polling = true
    const ensureStaySignedIn = async () => {
      while (polling) {
        for (const sel of STAY_SIGNED_IN_SELECTORS) {
          try {
            const box = page.locator(sel).first()
            if ((await box.count()) > 0 && !(await box.isChecked().catch(() => true))) {
              await box.check({ timeout: 1000, force: true }).catch(() => {})
              log('info', '"로그인 상태 유지" 자동 체크됨')
            }
          } catch { /* 무시 */ }
        }
        await page.waitForTimeout(1500)
      }
    }
    ensureStaySignedIn()

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    await new Promise((resolve) => rl.question('', resolve))
    rl.close()
    polling = false

    await page.reload().catch(() => {})

    const loggedIn = await page.locator('a[href*="logout"], button:has-text("로그아웃"), .tt_menubar_link, a.link_logout, .gnb_logout_button').first().isVisible().catch(() => false)
    if (!loggedIn) {
      log('warn', '로그인 상태를 확인할 수 없습니다. 그래도 세션을 저장합니다.')
    }

    // 장기 토큰 캡처 확인 — "로그인 상태 유지"가 제대로 적용됐는지 검증.
    const state = await context.storageState()
    const now = Date.now() / 1000
    const longLived = state.cookies.filter((c) => c.expires && c.expires > now + 86400)
    const tokens = state.cookies.filter((c) => LONGLIVED_COOKIE_RE.test(c.name))
    log('info', `저장될 쿠키 ${state.cookies.length}개 (1일+ 장기 ${longLived.length}개)`)
    if (tokens.length) {
      const maxDays = Math.max(...tokens.map((c) => (c.expires > 0 ? (c.expires - now) / 86400 : 0)))
      log('info', `카카오/티스토리 장기 토큰 캡처: ${tokens.map((c) => c.name).join(', ')} (최장 ~${maxDays.toFixed(0)}일)`)
    } else {
      log('warn', '⚠ 장기 토큰이 안 보입니다 — "로그인 상태 유지"가 꺼져 있었을 수 있습니다. 세션이 빨리 만료될 수 있어요.')
    }

    const ok = await persistSession(context, STORAGE_PATH)
    if (ok) {
      log('info', `세션 저장 완료 → ${STORAGE_PATH}`)
    } else {
      log('error', '세션 저장 실패')
    }
  } finally {
    await browser.close().catch(() => {})
  }
}

main().catch((e) => {
  log('error', '티스토리 로그인 오류:', e)
  process.exit(1)
})
