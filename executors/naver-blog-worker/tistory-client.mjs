import 'dotenv/config'
import { chromium } from 'playwright'
import { persistSession, readJsonIfExists } from './session-helpers.mjs'
import path from 'path'

const BLOG_NAME = process.env.TISTORY_BLOG_NAME || 'beoksolution'
const STORAGE_PATH = path.resolve(process.env.TISTORY_SESSION_PATH || './.session/tistory-session.json')
const NAV_TIMEOUT = Number(process.env.NAVER_BLOG_TIMEOUT_MS || '60000')
const PUBLIC_ORIGIN = `https://${BLOG_NAME}.tistory.com`

class TistoryError extends Error {
  constructor(code, message, details = null) {
    super(message)
    this.code = code
    this.details = details
  }
}

async function loadSession() {
  const data = await readJsonIfExists(STORAGE_PATH)
  if (!data) throw new TistoryError('TISTORY_NOT_AUTHED', '티스토리 세션이 없습니다. 먼저 `npm run tistory-auth` 를 실행하세요.')
  return data
}

async function openTistoryEditorPage() {
  const storageState = await loadSession()
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    storageState,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 900 },
    locale: 'ko-KR',
    permissions: ['clipboard-read', 'clipboard-write'],
  })
  const page = await context.newPage()
  page.setDefaultTimeout(NAV_TIMEOUT)
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `https://${BLOG_NAME}.tistory.com` })

  const writeUrl = `https://${BLOG_NAME}.tistory.com/manage/newpost/`
  await page.goto(writeUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(() => {})

  const needsLogin = page.url().includes('/auth/login') ||
    await page.locator(
      'input[name="loginKey"], input[name="password"], form[action*="login"], a.link_kakao_id:has-text("카카오계정으로 로그인")'
    ).first().isVisible().catch(() => false)
  if (needsLogin) {
    await browser.close().catch(() => {})
    throw new TistoryError('TISTORY_LOGIN_REQUIRED', '티스토리 세션이 만료되었습니다. `npm run tistory-auth` 로 다시 로그인하세요.')
  }

  return { browser, context, page }
}

async function assertTistoryAuthenticated() {
  const { browser, context } = await openTistoryEditorPage()
  try {
    await persistSession(context, STORAGE_PATH)
  } finally {
    await browser.close().catch(() => {})
  }
}

function normalizeText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim()
}

function isPublicPostUrl(url) {
  return typeof url === 'string' && new RegExp(`^https://${BLOG_NAME}\\.tistory\\.com/\\d+(?:[/?#].*)?$`).test(url)
}

async function resolvePublishedUrl(page, title) {
  await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {})
  await page.waitForTimeout(2000)

  const currentUrl = page.url()
  if (isPublicPostUrl(currentUrl)) return currentUrl.split(/[?#]/)[0]

  const canonical = await page.locator('link[rel="canonical"]').first()
    .getAttribute('href')
    .catch(() => null)
  if (isPublicPostUrl(canonical)) return canonical.split(/[?#]/)[0]

  const rssUrl = `${PUBLIC_ORIGIN}/rss`
  const expectedTitle = normalizeText(title)
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const rss = await fetch(rssUrl, { cache: 'no-store' }).then((res) => res.text()).catch(() => '')
    if (rss) {
      const itemPattern = /<item\b[\s\S]*?<\/item>/gi
      const items = rss.match(itemPattern) || []
      for (const item of items) {
        const titleMatch = item.match(/<title>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/title>/i)
        const linkMatch = item.match(/<link>\s*([^<]+)\s*<\/link>/i)
        const itemTitle = normalizeText(titleMatch?.[1] || '')
        const itemLink = (linkMatch?.[1] || '').trim()
        if (itemTitle && expectedTitle && itemTitle === expectedTitle && isPublicPostUrl(itemLink)) {
          return itemLink.split(/[?#]/)[0]
        }
      }

      // 티스토리 에디터가 제목을 보정하는 경우가 있어 최신 공개글을 후보로 한 번 더 본다.
      const latestLink = items[0]?.match(/<link>\s*([^<]+)\s*<\/link>/i)?.[1]?.trim()
      const latestTitle = normalizeText(items[0]?.match(/<title>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/title>/i)?.[1] || '')
      if (isPublicPostUrl(latestLink) && latestTitle && (
        latestTitle.includes(expectedTitle.slice(0, 12)) || expectedTitle.includes(latestTitle.slice(0, 12))
      )) {
        return latestLink.split(/[?#]/)[0]
      }
    }
    await page.waitForTimeout(1500)
  }

  throw new TistoryError(
    'TISTORY_PUBLIC_URL_NOT_FOUND',
    `티스토리 발행 후 공개 글 URL을 확인하지 못했습니다. current_url=${currentUrl}`
  )
}

async function writePostWithBrowser({ title, content_html, tags }) {
  const { browser, context, page } = await openTistoryEditorPage()
  try {
    await page.waitForTimeout(2000)

    const titleInput = page.locator('#post-title-inp')
    await titleInput.waitFor({ state: 'visible', timeout: 15000 })
    await titleInput.fill(title)

    await page.waitForTimeout(500)
    const iframeEl = await page.locator('iframe#editor-tistory_ifr').elementHandle()
    const iframeContent = await iframeEl.contentFrame()
    await iframeContent.locator('body').click()
    await page.waitForTimeout(300)
    await page.keyboard.press('Meta+a')
    await page.keyboard.press('Backspace')
    await page.waitForTimeout(200)
    await page.evaluate(async (html) => {
      await navigator.clipboard.write([
        new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }) })
      ])
    }, content_html)
    await page.keyboard.press('Meta+v')
    await page.waitForTimeout(2000)

    if (Array.isArray(tags) && tags.length) {
      const tagInput = page.locator('#tagText')
      if ((await tagInput.count()) > 0 && (await tagInput.isVisible().catch(() => false))) {
        await tagInput.fill(tags.join(', '))
        await page.keyboard.press('Enter')
      }
    }

    const doneBtn = page.locator('button.btn.btn-default:has-text("완료")')
    await doneBtn.waitFor({ state: 'visible', timeout: 10000 })
    await doneBtn.click()
    await page.waitForTimeout(2000)

    const publicRadio = page.locator('input.form-radio[value="20"]')
    if (await publicRadio.isVisible().catch(() => false)) {
      await publicRadio.check()
    }

    const saveBtn = page.locator('button[type="submit"].btn.btn-default')
    await saveBtn.waitFor({ state: 'visible', timeout: 10000 })
    await saveBtn.click()

    await page.waitForURL(url => !url.toString().includes('newpost'), { timeout: 30000 }).catch(() => {})
    const publishedUrl = await resolvePublishedUrl(page, title)

    await persistSession(context, STORAGE_PATH)

    return {
      status: 'success',
      url: publishedUrl,
      published_at: new Date().toISOString(),
    }
  } finally {
    await browser.close().catch(() => {})
  }
}

export { writePostWithBrowser, assertTistoryAuthenticated, TistoryError }
