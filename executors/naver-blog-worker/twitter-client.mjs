import 'dotenv/config'
import { chromium } from 'playwright'
import path from 'path'

const CHROME_PROFILE = path.resolve(process.env.CHROME_PROFILE_PATH || `${process.env.HOME}/Library/Application Support/Google/Chrome/Profile 1`)
const NAV_TIMEOUT = Number(process.env.TWITTER_TIMEOUT_MS || '60000')

class TwitterError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

async function postTweet({ text }) {
  let context
  try {
    context = await chromium.launchPersistentContext(CHROME_PROFILE, {
      headless: true,
      channel: 'chrome',
      viewport: { width: 1366, height: 900 },
      locale: 'ko-KR',
    })
  } catch (e) {
    throw new TwitterError('TWITTER_CHROME_BUSY', 'Chrome이 실행 중입니다. Chrome을 종료한 후 다시 시도하세요.')
  }

  try {
    const page = await context.newPage()
    page.setDefaultTimeout(NAV_TIMEOUT)

    await page.goto('https://x.com/compose/post', { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(() => {})
    await page.waitForTimeout(3000)

    const needsLogin = await page.locator('input[name="text"], input[name="username_or_email"], input[name="password"]').first().isVisible().catch(() => false)
    if (needsLogin) {
      throw new TwitterError('TWITTER_LOGIN_REQUIRED', '트위터 로그인이 필요합니다. node twitter-auth.mjs 를 실행하세요.')
    }

    const editor = page.locator('[data-testid="tweetTextarea_0"], [contenteditable="true"][role="textbox"]').first()
    await editor.waitFor({ state: 'visible', timeout: 15000 })
    await editor.click()
    await page.waitForTimeout(300)
    await editor.fill(text)
    await page.waitForTimeout(500)

    const tweetBtn = page.locator('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]').first()
    await tweetBtn.waitFor({ state: 'visible', timeout: 10000 })
    await tweetBtn.click()

    await page.waitForTimeout(5000)

    const url = page.url()
    let tweetUrl = null
    if (url.includes('/status/')) {
      tweetUrl = url
    } else {
      await page.waitForTimeout(3000)
      const finalUrl = page.url()
      if (finalUrl.includes('/status/')) tweetUrl = finalUrl
    }

    return {
      status: 'success',
      url: tweetUrl,
      published_at: new Date().toISOString(),
    }
  } finally {
    await context.close().catch(() => {})
  }
}

export { postTweet, TwitterError }
