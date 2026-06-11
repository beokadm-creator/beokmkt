import 'dotenv/config'
import { chromium } from 'playwright'
import readline from 'readline'
import path from 'path'
import { promises as fs } from 'fs'

const CHROME_PROFILE = path.resolve(process.env.CHROME_PROFILE_PATH || `${process.env.HOME}/Library/Application Support/Google/Chrome/Profile 1`)
const SESSION_DIR = path.resolve('./.session')

function log(level, ...args) {
  const ts = new Date().toISOString()
  const prefix = `[${ts}] [${level.toUpperCase()}]`
  if (level === 'error') console.error(prefix, ...args)
  else console.log(prefix, ...args)
}

async function main() {
  log('info', '=== X(트위터) 로그인 (Chrome 프로필) ===')
  log('info', `Chrome 프로필: ${CHROME_PROFILE}`)

  await fs.mkdir(SESSION_DIR, { recursive: true })

  const context = await chromium.launchPersistentContext(CHROME_PROFILE, {
    headless: false,
    channel: 'chrome',
    viewport: { width: 1366, height: 900 },
    locale: 'ko-KR',
  })

  try {
    const page = await context.newPage()
    page.setDefaultTimeout(60000)

    await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {})
    await page.waitForTimeout(3000)

    const url = page.url()
    if (url.includes('login') || url.includes('flow')) {
      log('info', '로그인이 필요합니다. Chrome에서 직접 로그인하세요.')
      log('info', '완료되면 이 터미널에서 Enter를 눌러주세요.')
    } else {
      log('info', '이미 로그인되어 있습니다. 확인 후 Enter를 눌러주세요.')
    }

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    await new Promise((resolve) => rl.question('', resolve))
    rl.close()

    log('info', '세션이 Chrome 프로필에 저장되어 있습니다.')
    log('info', '트위터 발행 시 동일한 Chrome 프로필을 사용합니다.')
  } finally {
    await context.close().catch(() => {})
  }
}

main().catch((e) => {
  log('error', '오류:', e)
  process.exit(1)
})
