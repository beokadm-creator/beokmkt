import 'dotenv/config'
import { promises as fs } from 'fs'
import path from 'path'
import readline from 'readline'
import { chromium } from 'playwright'
import { persistSession } from './session-helpers.mjs'

const STORAGE_PATH = path.resolve(process.env.TISTORY_SESSION_PATH || './.session/tistory-session.json')
const NAV_TIMEOUT = Number(process.env.NAVER_BLOG_TIMEOUT_MS || '60000')

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

    await page.goto('https://www.tistory.com/', { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT })

    log('info', '브라우저가 열렸습니다. 티스토리에 로그인하세요.')
    log('info', '  1) 우상단 [로그인] 클릭')
    log('info', '  2) 카카오/티스토리 계정으로 로그인')
    log('info', '  3) 로그인 완료되면 이 터미널에서 Enter')
    log('info', '')

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    await new Promise((resolve) => rl.question('', resolve))
    rl.close()

    await page.reload().catch(() => {})

    const loggedIn = await page.locator('a[href*="logout"], button:has-text("로그아웃"), .tt_menubar_link, a.link_logout, .gnb_logout_button').first().isVisible().catch(() => false)
    if (!loggedIn) {
      log('warn', '로그인 상태를 확인할 수 없습니다. 그래도 세션을 저장합니다.')
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
