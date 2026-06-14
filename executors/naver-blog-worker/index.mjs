import 'dotenv/config'
import { promises as fs } from 'fs'
import path from 'path'
import readline from 'readline'
import http from 'http'
import { chromium } from 'playwright'
import { convertForNaver } from './naver-html-adapter.mjs'
import { convertForTistory } from './tistory-html-adapter.mjs'
import { rewriteForChannel } from './channel-rewriter.mjs'
import { writePostWithBrowser as tistoryWritePost, TistoryError } from './tistory-client.mjs'
import { postTweet, TwitterError } from './twitter-client.mjs'
import { generateTweetSummary } from './twitter-summary.mjs'
import { persistSession, readJsonIfExists } from './session-helpers.mjs'

const PORT = Number(process.env.WORKER_PORT || '8788')
const MAIN_API_URL = (process.env.MAIN_API_URL || 'http://localhost:8787').replace(/\/+$/, '')
const MAIN_API_TOKEN = process.env.MAIN_API_TOKEN || ''

const NAVER_USERNAME = process.env.NAVER_BLOG_USERNAME || ''
const HEADLESS = process.env.NAVER_BLOG_HEADLESS !== 'false'
const SLOW_MO = Number(process.env.NAVER_BLOG_SLOW_MO || '0')
const NAV_TIMEOUT = Number(process.env.NAVER_BLOG_TIMEOUT_MS || '60000')
const STORAGE_PATH = path.resolve(
  process.env.NAVER_BLOG_STORAGE_STATE_PATH || './.session/naver-session.json'
)

const WRITE_URL = 'https://blog.naver.com/PostWrite.naver'
const LOGIN_URL = 'https://nid.naver.com/nidlogin.login'

// 멱등성: 발행 성공 기록(post_id+platform). 재시도 시 중복 발행 방지.
const PUBLISHED_LOG = path.resolve('./.session/published-log.json')

async function loadPublishedLog() {
  try { return JSON.parse(await fs.readFile(PUBLISHED_LOG, 'utf-8')) } catch { return {} }
}
async function recordPublished(key, url) {
  if (!key) return
  try {
    const logData = await loadPublishedLog()
    logData[key] = { url: url || '', at: new Date().toISOString() }
    await fs.mkdir(path.dirname(PUBLISHED_LOG), { recursive: true })
    const tmp = PUBLISHED_LOG + '.tmp'
    await fs.writeFile(tmp, JSON.stringify(logData, null, 2))
    await fs.rename(tmp, PUBLISHED_LOG)   // 원자적 교체
  } catch (e) { log('warn', `발행 로그 기록 실패(무시): ${e.message}`) }
}

class WorkerError extends Error {
  constructor(code, message, details = null) {
    super(message)
    this.code = code
    this.details = details
  }
}

function log(level, ...args) {
  const ts = new Date().toISOString()
  const prefix = `[${ts}] [${level.toUpperCase()}]`
  if (level === 'error') console.error(prefix, ...args)
  else console.log(prefix, ...args)
}

async function pathExists(p) {
  try { await fs.access(p); return true } catch { return false }
}

async function loadStorageState() {
  if (!(await pathExists(STORAGE_PATH))) return undefined
  try {
    const raw = await fs.readFile(STORAGE_PATH, 'utf-8')
    return JSON.parse(raw)
  } catch { return undefined }
}

async function saveStorageState(context) {
  const ok = await persistSession(context, STORAGE_PATH)
  if (ok) log('info', `세션 저장 → ${STORAGE_PATH}`)
  else log('warn', `세션 저장 실패 → ${STORAGE_PATH}`)
}

async function loginIfNeeded(page) {
  const onLoginPage = await page.locator('input[name="id"]').count() > 0
  if (!onLoginPage) return true
  if (!NAVER_USERNAME) {
    throw new WorkerError('LOGIN_REQUIRED', '세션이 만료되었습니다. npm run login 으로 다시 로그인하세요.')
  }
  log('info', `네이버 로그인 시도 (id: ${NAVER_USERNAME}) — 자동 로그인은 CAPTCHA/2FA가 있으면 실패할 수 있습니다.`)
  throw new WorkerError('LOGIN_REQUIRED', '세션이 만료되었습니다. npm run login 으로 다시 로그인하세요.')
}

async function pasteHtmlIntoEditor(page, html) {
  await page.bringToFront()
  const editorFrame = page.frameLocator('iframe[id*="se2_editor"], iframe[title*="스마트에디터"], iframe#se2_editor').first()
  await editorFrame.locator('body').click({ delay: 100 }).catch(() => {})

  await page.evaluate(async (htmlPayload) => {
    const blob = new Blob([htmlPayload], { type: 'text/html' })
    const item = new ClipboardItem({ 'text/html': blob })
    await navigator.clipboard.write([item])
  }, html)

  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
  await page.keyboard.press(`${modifier}+KeyV`)
  await page.waitForTimeout(800)
}

async function clickPublishButton(page) {
  const selectors = [
    'button:has-text("발행")',
    'a:has-text("발행")',
    'button:has-text("등록")',
    '.se_publish_btn',
    '[data-action="publish"]',
  ]
  for (const sel of selectors) {
    const handle = page.locator(sel).first()
    if ((await handle.count()) > 0 && (await handle.isVisible().catch(() => false))) {
      await handle.click({ timeout: 5000 }).catch(() => {})
      return true
    }
  }
  throw new WorkerError('PUBLISH_BUTTON_NOT_FOUND', '발행 버튼을 찾지 못했습니다.')
}

async function capturePublishedUrl(page) {
  await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {})
  const url = page.url()
  if (/PostView\.naver|blog\.naver\.com\/[^/]+\/\d+/.test(url)) return url
  const candidate = await page.locator('a[href*="/PostView.naver"], a[href*="blog.naver.com"][href*="/"][href*="/"]').first().getAttribute('href').catch(() => null)
  if (candidate) {
    if (candidate.startsWith('http')) return candidate
    return `https://blog.naver.com${candidate.startsWith('/') ? '' : '/'}${candidate}`
  }
  return null
}

async function dismissDraftRestorePopup(page) {
  const selectors = [
    'button.se-popup-button-cancel',
    'button:has-text("아니오")',
    'button:has-text("취소")',
    '.se-confirm-popup .se-popup-button-cancel',
  ]
  for (let attempt = 0; attempt < 10; attempt++) {
    for (const sel of selectors) {
      const handle = page.locator(sel).first()
      if ((await handle.count()) > 0 && (await handle.isVisible().catch(() => false))) {
        await handle.click({ timeout: 2000 }).catch(() => {})
        log('info', '임시저장 복원 팝업 닫음')
        return true
      }
    }
    await page.waitForTimeout(500)
  }
  return false
}

async function publishToNaver({ title, content_html, tags, link, canonical_url }) {
  // 유사문서 필터 회피: 네이버용으로 구성/문체를 재작성 (실패 시 원문 + 출처 링크)
  log('info', '네이버용 콘텐츠 재작성 (AI) 시작…')
  const rewritten = await rewriteForChannel({
    title,
    html: content_html,
    channel: 'naver',
    canonicalUrl: canonical_url || link || '',
  })
  log('info', `네이버용 재작성 ${rewritten.rewritten ? '완료' : '건너뜀(원문 사용)'} — 제목: ${rewritten.title}`)

  const publishTitle = rewritten.title
  const naverHtml = convertForNaver(rewritten.html)
  if (!naverHtml.trim()) throw new WorkerError('EMPTY_CONTENT', '변환된 본문이 비어있습니다.')

  const storageState = await loadStorageState()
  const browser = await chromium.launch({ headless: HEADLESS, slowMo: SLOW_MO })
  try {
    const context = await browser.newContext({
      storageState,
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1366, height: 900 },
      locale: 'ko-KR',
    })
    const page = await context.newPage()
    page.setDefaultTimeout(NAV_TIMEOUT)

    await page.goto(WRITE_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(() => {})
    await loginIfNeeded(page)
    await saveStorageState(context)

    if (page.url().includes('nid.naver.com') || (await page.locator('input[name="id"]').count() > 0)) {
      await page.goto(WRITE_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT })
    }

    await page.waitForTimeout(2000)
    await dismissDraftRestorePopup(page)

    const titleInput = page.locator('input[name="title"], #title, .se_title_input input, input[placeholder*="제목"]').first()
    await titleInput.waitFor({ state: 'visible', timeout: 10000 })
    await titleInput.fill(publishTitle)

    await pasteHtmlIntoEditor(page, naverHtml)

    if (Array.isArray(tags) && tags.length) {
      const tagInput = page.locator('input[placeholder*="태그"], .tag_input input, input[name="tags"]').first()
      if ((await tagInput.count()) > 0 && (await tagInput.isVisible().catch(() => false))) {
        await tagInput.fill(tags.join(', '))
        await page.keyboard.press('Enter')
      }
    }

    await clickPublishButton(page)
    const publishedUrl = await capturePublishedUrl(page)
    await saveStorageState(context)

    return {
      status: 'success',
      url: publishedUrl,
      published_at: new Date().toISOString(),
    }
  } finally {
    await browser.close().catch(() => {})
  }
}

async function publishToTistory({ title, content_html, tags, link, canonical_url }) {
  try {
    // 유사문서/중복콘텐츠 방지: 티스토리용 재작성 후 스타일 변환
    log('info', '티스토리용 콘텐츠 재작성 (AI) 시작…')
    const rewritten = await rewriteForChannel({
      title,
      html: content_html,
      channel: 'tistory',
      canonicalUrl: canonical_url || link || '',
    })
    log('info', `티스토리용 재작성 ${rewritten.rewritten ? '완료' : '건너뜀(원문 사용)'} — 제목: ${rewritten.title}`)

    log('info', '티스토리 HTML 변환 (AI) 시작…')
    const convertedHtml = await convertForTistory(rewritten.html)
    log('info', `티스토리 HTML 변환 완료 (${convertedHtml.length}자)`)
    const result = await tistoryWritePost({ title: rewritten.title, content_html: convertedHtml, tags })
    return result
  } catch (e) {
    if (e instanceof TistoryError) {
      throw new WorkerError(e.code, e.message, e.details)
    }
    throw e
  }
}

async function publishToTwitter({ title, content_html, tags, link }) {
  try {
    const blogLink = link || `${MAIN_API_URL}/blog-posts`
    log('info', '트위터 요약 생성 (AI) 시작…')
    const tweetText = await generateTweetSummary(content_html, title, blogLink)
    log('info', `트위터 요약 생성 완료 (${tweetText.length}자): ${tweetText.slice(0, 80)}…`)
    const result = await postTweet({ text: tweetText })
    return { ...result, tweet_text: tweetText }
  } catch (e) {
    if (e instanceof TwitterError) {
      throw new WorkerError(e.code, e.message)
    }
    throw e
  }
}

async function reportResultToMain(postId, platform, payload) {
  if (!MAIN_API_URL || MAIN_API_TOKEN === '__skip__') return
  try {
    const headers = { 'content-type': 'application/json' }
    if (MAIN_API_TOKEN) headers.authorization = `Bearer ${MAIN_API_TOKEN}`
    await fetch(`${MAIN_API_URL}/api/blog-posts/${encodeURIComponent(postId)}/external-publish-result`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ platform, ...payload }),
    })
  } catch (e) {
    log('warn', `메인 서버 결과 전송 실패 (무시): ${e.message}`)
  }
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
    if (!raw) return resolve({})
      try { resolve(JSON.parse(raw)) } catch (e) { reject(e) }
    })
    req.on('error', reject)
  })
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'POST, GET, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization',
  })
  res.end(JSON.stringify(payload))
}

async function handlePublish(req, res, platform) {
  const body = await parseJsonBody(req)
  const postId = body.post_id || body.blog_post_id
  if (!body.title || !body.content_html) {
    return sendJson(res, 400, { error: 'title, content_html 은 필수입니다.' })
  }

  log('info', `─────────────────────────────────────`)
  log('info', `발행 요청 수신 [${platform}] post_id=${postId} title="${body.title}"`)
  if (platform !== 'twitter') {
    log('info', `content_html length=${(body.content_html || '').length} preview=${(body.content_html || '').slice(0, 100)}`)
  }

  // 멱등성: 이미 발행된 post_id+platform이면 재발행하지 않고 기존 URL 반환
  const dedupKey = postId ? `${platform}:${postId}` : ''
  if (dedupKey) {
    const logData = await loadPublishedLog()
    if (logData[dedupKey]) {
      log('warn', `중복 발행 차단 [${dedupKey}] → 기존 URL 반환: ${logData[dedupKey].url}`)
      return sendJson(res, 200, { ok: true, platform, url: logData[dedupKey].url, deduped: true })
    }
  }

  try {
    let result
    if (platform === 'tistory') {
      log('info', '티스토리 API 호출 중…')
      result = await publishToTistory(body)
    } else if (platform === 'naver') {
      log('info', '네이버 블로그 Playwright 실행 중…')
      result = await publishToNaver(body)
    } else if (platform === 'twitter') {
      log('info', '트위터 Playwright 실행 중…')
      result = await publishToTwitter(body)
    } else {
      return sendJson(res, 400, { error: `지원하지 않는 platform: ${platform}` })
    }

    log('info', `✅ 발행 성공 [${platform}] → ${result.url || '(URL 없음)'}`)
    if (dedupKey) await recordPublished(dedupKey, result.url)
    if (postId) await reportResultToMain(postId, platform, { status: 'success', url: result.url, published_at: result.published_at })
    return sendJson(res, 200, { ok: true, platform, ...result })
  } catch (e) {
    const code = e instanceof WorkerError ? e.code : (e instanceof TistoryError ? e.code : 'UNKNOWN')
    log('error', `❌ 발행 실패 [${code}]: ${e.message}`)
    if (postId) await reportResultToMain(postId, platform, { status: 'failed', error: e.message, code })
    return sendJson(res, 500, { ok: false, error: e.message, code })
  }
}

async function handlePublishAll(req, res) {
  const body = await parseJsonBody(req)
  const postId = body.post_id || body.blog_post_id
  const platforms = Array.isArray(body.platforms) ? body.platforms : ['naver', 'tistory']
  if (!body.title || !body.content_html) {
    return sendJson(res, 400, { error: 'title, content_html 은 필수입니다.' })
  }

  log('info', `─────────────────────────────────────`)
  log('info', `다중 플랫폼 발행 요청 post_id=${postId} platforms=[${platforms.join(',')}]`)

  const results = {}
  const pubLog = postId ? await loadPublishedLog() : {}
  for (const platform of platforms) {
    if (postId && pubLog[`${platform}:${postId}`]) {
      results[platform] = { ok: true, url: pubLog[`${platform}:${postId}`].url, deduped: true }
      continue
    }
    try {
      let r
      if (platform === 'tistory') r = await publishToTistory(body)
      else if (platform === 'naver') r = await publishToNaver(body)
      else if (platform === 'twitter') r = await publishToTwitter(body)
      else { results[platform] = { ok: false, error: 'unsupported' }; continue }
      results[platform] = { ok: true, ...r }
      if (postId) await recordPublished(`${platform}:${postId}`, r.url)
      if (postId) await reportResultToMain(postId, platform, { status: 'success', url: r.url, published_at: r.published_at })
    } catch (e) {
      const code = e instanceof WorkerError ? e.code : (e instanceof TistoryError ? e.code : 'UNKNOWN')
      results[platform] = { ok: false, error: e.message, code }
      if (postId) await reportResultToMain(postId, platform, { status: 'failed', error: e.message, code })
    }
  }
  return sendJson(res, 200, { ok: true, results })
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, GET, OPTIONS',
      'access-control-allow-headers': 'content-type, authorization',
    })
    return res.end()
  }
  const url = new URL(req.url, `http://localhost:${PORT}`)

  if (req.method === 'GET' && url.pathname === '/health') {
    return sendJson(res, 200, { ok: true, worker: 'blog-publisher' })
  }
  if (req.method === 'POST' && url.pathname === '/publish-naver') return handlePublish(req, res, 'naver')
  if (req.method === 'POST' && url.pathname === '/publish-tistory') return handlePublish(req, res, 'tistory')
  if (req.method === 'POST' && url.pathname === '/publish-twitter') return handlePublish(req, res, 'twitter')
  if (req.method === 'POST' && url.pathname === '/publish') return handlePublishAll(req, res)

  sendJson(res, 404, { error: 'not found' })
})

async function performLoginOnly() {
  log('info', '=== 로그인 전용 모드 ===')
  const storageState = await loadStorageState()
  const browser = await chromium.launch({ headless: false, slowMo: 100 })
  try {
    const context = await browser.newContext({
      storageState,
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1366, height: 900 },
      locale: 'ko-KR',
    })
    const page = await context.newPage()
    page.setDefaultTimeout(NAV_TIMEOUT)
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT })

    log('info', '브라우저가 열렸습니다. 직접 로그인하세요 (2FA 포함).')
    log('info', '  💡 로그인 화면에서 [로그인 상태 유지] 체크박스를 꼭 체크하세요.')
    log('info', '완료되면 이 터미널에서 Enter를 눌러 세션을 저장합니다.')
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    await new Promise((resolve) => rl.question('', resolve))
    rl.close()

    await saveStorageState(context)
    log('info', '세션 저장 완료. 이제 워커를 일반 모드로 실행하세요.')
  } finally {
    await browser.close().catch(() => {})
  }
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--login-only')) {
    return performLoginOnly()
  }

  server.listen(PORT, () => {
    log('info', `═══ 블로그 발행 HTTP 서버 시작 ═══`)
    log('info', `  PORT         : ${PORT}`)
    log('info', `  MAIN_API_URL : ${MAIN_API_URL}`)
    log('info', `─────────────────────────────────────`)
    log('info', `  [네이버 블로그]`)
    log('info', `    HEADLESS      : ${HEADLESS}`)
    log('info', `    SESSION_PATH  : ${STORAGE_PATH}`)
    log('info', `  [티스토리]`)
    log('info', `    SESSION_PATH  : ./session/tistory-session.json`)
    log('info', `─────────────────────────────────────`)
    log('info', `  엔드포인트:`)
    log('info', `    POST /publish-naver    - 네이버 1건`)
    log('info', `    POST /publish-tistory  - 티스토리 1건`)
    log('info', `    POST /publish-twitter  - 트위터 1건`)
    log('info', `    POST /publish          - 다중 (body: platforms 배열)`)
    log('info', `    GET  /health`)
    log('info', ``)
  })
}

main().catch((e) => {
  log('error', '워커 치명적 오류:', e)
  process.exit(1)
})
