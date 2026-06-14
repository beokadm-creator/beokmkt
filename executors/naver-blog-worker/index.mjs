import 'dotenv/config'
import { promises as fs } from 'fs'
import path from 'path'
import readline from 'readline'
import http from 'http'
import { chromium } from 'playwright'
import { convertForNaver } from './naver-html-adapter.mjs'
import { convertForTistory } from './tistory-html-adapter.mjs'
import { rewriteForChannel } from './channel-rewriter.mjs'
import { writePostWithBrowser as tistoryWritePost, assertTistoryAuthenticated, TistoryError } from './tistory-client.mjs'
import { postTweet, TwitterError } from './twitter-client.mjs'
import { generateTweetSummary } from './twitter-summary.mjs'
import { persistSession, readJsonIfExists } from './session-helpers.mjs'

const PORT = Number(process.env.WORKER_PORT || '8788')
const MAIN_API_URL = (process.env.MAIN_API_URL || 'http://localhost:8787').replace(/\/+$/, '')
const MAIN_API_TOKEN = process.env.MAIN_API_TOKEN || ''

const NAVER_USERNAME = process.env.NAVER_BLOG_USERNAME || ''
const NAVER_BLOG_ID = process.env.NAVER_BLOG_ID || ''
const HEADLESS = process.env.NAVER_BLOG_HEADLESS !== 'false'
const SLOW_MO = Number(process.env.NAVER_BLOG_SLOW_MO || '0')
const NAV_TIMEOUT = Number(process.env.NAVER_BLOG_TIMEOUT_MS || '60000')
const STORAGE_PATH = path.resolve(
  process.env.NAVER_BLOG_STORAGE_STATE_PATH || './.session/naver-session.json'
)

const WRITE_URL = process.env.NAVER_BLOG_WRITE_URL || (
  NAVER_BLOG_ID
    ? `https://blog.naver.com/PostWriteForm.naver?blogId=${encodeURIComponent(NAVER_BLOG_ID)}&Redirect=Write&redirect=Write`
    : 'https://blog.naver.com/PostWrite.naver'
)
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

function isValidPublishedUrl(platform, url) {
  if (!url || typeof url !== 'string') return false
  if (platform === 'naver') {
    return /PostView\.naver|blog\.naver\.com\/[^/?#]+\/\d+/.test(url)
  }
  return /^https?:\/\//.test(url)
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
  const smartEditorBody = page.locator(
    '.se-section-text .se-text-paragraph, .se-component.se-text .se-text-paragraph, .se-module.se-module-text:not(.se-title-text) .se-text-paragraph'
  ).first()
  let inIframe = false
  if ((await smartEditorBody.count()) > 0 && (await smartEditorBody.isVisible().catch(() => false))) {
    await smartEditorBody.click({ delay: 100 })
  } else {
    const editorFrame = page.frameLocator('iframe[id*="se2_editor"], iframe[title*="스마트에디터"], iframe#se2_editor').first()
    await editorFrame.locator('body').click({ delay: 100 }).catch(() => {})
    inIframe = true
  }

  const plainText = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  const probe = plainText.replace(/\s+/g, ' ').slice(0, 80)
  const editorHasProbe = async () => {
    if (!probe) return true
    const text = await page.locator('body').innerText().catch(() => '')
    return text.replace(/\s+/g, ' ').includes(probe)
  }

  // Strategy 1: Clipboard API + Ctrl/Cmd+V
  // newContext에 clipboard-write 권한 부여 후 사용. headless에서도 동작.
  const clipOk = await page.evaluate(async (htmlPayload) => {
    try {
      const blob = new Blob([htmlPayload], { type: 'text/html' })
      const item = new ClipboardItem({ 'text/html': blob })
      await navigator.clipboard.write([item])
      return true
    } catch {
      return false
    }
  }, html)

  if (clipOk) {
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
    await page.keyboard.press(`${modifier}+KeyV`)
    await page.waitForTimeout(800)
    if (await editorHasProbe()) return
    log('warn', 'clipboard paste 후 본문 검증 실패 — 폴백 시도')
  }

  // Strategy 2: 합성 ClipboardEvent (clipboard-write 권한 불필요, SE3 paste 핸들러 직접 호출)
  // isTrusted=false를 에디터가 거부하면 조용히 실패할 수 있음 — 에러로 escalate
  log('warn', 'clipboard.write 실패 — 합성 ClipboardEvent 폴백 시도')
  const IFRAME_SELECTOR = 'iframe[id*="se2_editor"], iframe[title*="스마트에디터"], iframe#se2_editor'
  const syntheticOk = inIframe
    ? await page.frameLocator(IFRAME_SELECTOR).first().locator('body').evaluate((el, htmlPayload) => {
        try {
          const dt = new DataTransfer()
          dt.setData('text/html', htmlPayload)
          dt.setData('text/plain', htmlPayload.replace(/<[^>]+>/g, ''))
          el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
          return true
        } catch { return false }
      }, html).catch(() => false)
    : await page.evaluate((htmlPayload) => {
        try {
          const dt = new DataTransfer()
          dt.setData('text/html', htmlPayload)
          dt.setData('text/plain', htmlPayload.replace(/<[^>]+>/g, ''))
          const el = document.activeElement || document.body
          el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
          return true
        } catch { return false }
      }, html).catch(() => false)

  if (!syntheticOk) {
    log('warn', '합성 ClipboardEvent 실패 — 직접 입력 폴백 시도')
  } else {
    await page.waitForTimeout(800)
    if (await editorHasProbe()) return
    log('warn', '합성 ClipboardEvent 후 본문 검증 실패 — 직접 입력 폴백 시도')
  }

  const execOk = await page.evaluate((htmlPayload) => {
    try {
      return document.execCommand('insertHTML', false, htmlPayload)
    } catch {
      return false
    }
  }, html).catch(() => false)
  if (execOk) {
    await page.waitForTimeout(800)
    if (await editorHasProbe()) return
    log('warn', 'execCommand 후 본문 검증 실패 — plain text 입력 폴백 시도')
  }

  await smartEditorBody.click({ delay: 100 }).catch(() => {})
  await page.keyboard.insertText(plainText || html.replace(/<[^>]+>/g, ''))
  await page.waitForTimeout(800)
  if (await editorHasProbe()) return

  throw new WorkerError('PASTE_FAILED', 'SmartEditor 본문 입력 실패 (모든 입력 전략 후 본문 검증 실패)')
}

async function fillNaverTitle(page, title) {
  const selectors = [
    '.se-title-text .se-text-paragraph',
    '.se-documentTitle .se-text-paragraph',
    '.se-title-text',
    'input[name="title"]',
    '#title',
    '.se_title_input input',
    'input[placeholder*="제목"]',
  ]
  for (const sel of selectors) {
    const handle = page.locator(sel).first()
    if ((await handle.count()) > 0 && (await handle.isVisible().catch(() => false))) {
      await handle.click({ timeout: 5000 })
      const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
      await page.keyboard.press(`${modifier}+KeyA`).catch(() => {})
      await page.keyboard.insertText(title)
      return true
    }
  }
  throw new WorkerError('TITLE_INPUT_NOT_FOUND', '네이버 제목 입력 영역을 찾지 못했습니다.')
}

async function clickPublishButton(page) {
  await dismissEditorOverlays(page)

  const clickFirstVisible = async (selectors, label) => {
    for (const sel of selectors) {
      const handles = page.locator(sel)
      const count = await handles.count().catch(() => 0)
      for (let i = 0; i < count; i += 1) {
        const handle = handles.nth(i)
        if (!(await handle.isVisible().catch(() => false))) continue
        await handle.click({ timeout: 5000, force: true })
        log('info', `${label} 클릭: ${sel}`)
        return true
      }
    }
    return false
  }

  const opened = await clickFirstVisible([
    'button[class^="publish_btn"]',
    'button[class*=" publish_btn"]',
    'button:visible:has-text("발행")',
    'a:visible:has-text("발행")',
    '.se_publish_btn',
    '[data-action="publish"]',
  ], '네이버 1차 발행 버튼')
  if (!opened) {
    throw new WorkerError('PUBLISH_BUTTON_NOT_FOUND', '발행 버튼을 찾지 못했습니다.')
  }

  await page.waitForTimeout(1500)
  await page.locator('.se-help-panel-close-button').first()
    .click({ timeout: 1000, force: true })
    .catch(() => {})

  const confirmSelectors = [
    'button[class^="confirm_btn"]',
    'button[class*=" confirm_btn"]',
    '[data-action="confirm"]',
  ]
  let confirmed = false
  for (const sel of confirmSelectors) {
    const handle = page.locator(sel).first()
    if ((await handle.count()) > 0 && (await handle.isVisible().catch(() => false))) {
      await handle.click({ timeout: 5000, force: true })
      log('info', `네이버 최종 발행 버튼 클릭: ${sel}`)
      confirmed = true
      break
    }
  }
  if (!confirmed) {
    throw new WorkerError('PUBLISH_CONFIRM_NOT_FOUND', '최종 발행 버튼을 찾지 못했습니다.')
  }
}

async function dismissEditorOverlays(page) {
  const selectors = [
    '.se-help-panel-close-button',
    'button.se-popup-button-cancel',
    'button:has-text("아니오")',
    'button:has-text("취소")',
  ]
  for (const sel of selectors) {
    const handle = page.locator(sel).first()
    if ((await handle.count()) > 0 && (await handle.isVisible().catch(() => false))) {
      await handle.click({ timeout: 2000, force: true }).catch(() => {})
      await page.waitForTimeout(300)
    }
  }
}

async function capturePublishedUrl(page) {
  await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {})
  await page.waitForTimeout(2500)
  const url = page.url()
  if (/PostView\.naver|blog\.naver\.com\/[^/?#]+\/\d+/.test(url)) return url
  const candidate = await page.locator(
    'a[href*="/PostView.naver"], a[href*="blog.naver.com"][href*="/"][href*="/"]'
  ).evaluateAll((links) => {
    const hrefs = links
      .map((a) => a.href || a.getAttribute('href') || '')
      .filter((href) => /PostView\.naver|blog\.naver\.com\/[^/?#]+\/\d+/.test(href))
    return hrefs[0] || null
  }).catch(() => null)
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

async function publishToNaver({ post_id, title, content_html, tags, link, canonical_url }) {
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
      permissions: ['clipboard-read', 'clipboard-write'],
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

    await fillNaverTitle(page, publishTitle)

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
    if (!publishedUrl) {
      throw new WorkerError('PUBLISH_URL_NOT_FOUND', '네이버 발행 후 공개 글 URL을 확인하지 못했습니다.')
    }
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
    await assertTistoryAuthenticated()

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
    if (MAIN_API_TOKEN) {
      headers['x-api-key'] = MAIN_API_TOKEN
      headers.authorization = `Bearer ${MAIN_API_TOKEN}`
    }
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
    if (logData[dedupKey] && isValidPublishedUrl(platform, logData[dedupKey].url)) {
      log('warn', `중복 발행 차단 [${dedupKey}] → 기존 URL 반환: ${logData[dedupKey].url}`)
      return sendJson(res, 200, { ok: true, platform, url: logData[dedupKey].url, deduped: true })
    } else if (logData[dedupKey]) {
      log('warn', `무효 발행 로그 무시 [${dedupKey}] → ${logData[dedupKey].url || '(URL 없음)'}`)
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
    if (postId) await reportResultToMain(postId, platform, { status: 'success', title: body.title, url: result.url, published_at: result.published_at })
    return sendJson(res, 200, { ok: true, platform, ...result })
  } catch (e) {
    const code = e instanceof WorkerError ? e.code : (e instanceof TistoryError ? e.code : 'UNKNOWN')
    log('error', `❌ 발행 실패 [${code}]: ${e.message}`)
    if (postId) await reportResultToMain(postId, platform, { status: 'failed', title: body.title, error: e.message, code })
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
    if (postId && pubLog[`${platform}:${postId}`] && isValidPublishedUrl(platform, pubLog[`${platform}:${postId}`].url)) {
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
