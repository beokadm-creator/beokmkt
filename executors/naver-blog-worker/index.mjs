import 'dotenv/config'
import { promises as fs } from 'fs'
import path from 'path'
import readline from 'readline'
import http from 'http'
import { chromium } from 'playwright'
import { convertForNaver } from './naver-html-adapter.mjs'
import { convertForTistory, validateTistoryHtml } from './tistory-html-adapter.mjs'
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
const DEBUG_DIR = path.resolve(process.env.BLOG_WORKER_DEBUG_DIR || './.session/debug')

// 멱등성: 발행 성공 기록(post_id+platform). 재시도 시 중복 발행 방지.
const PUBLISHED_LOG = path.resolve('./.session/published-log.json')
let publishQueue = Promise.resolve()

async function runPublishExclusive(label, task) {
  const previous = publishQueue.catch(() => {})
  let release
  publishQueue = new Promise((resolve) => { release = resolve })
  await previous
  log('info', `발행 큐 진입: ${label}`)
  try {
    return await task()
  } finally {
    release()
    log('info', `발행 큐 해제: ${label}`)
  }
}

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
  if (platform === 'tistory') {
    return /^https:\/\/[^/]+\.tistory\.com\/\d+(?:[/?#].*)?$/.test(url)
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

function safeName(value) {
  return String(value || 'unknown').replace(/[^a-zA-Z0-9가-힣._-]+/g, '-').slice(0, 80)
}

async function dumpPageDiagnostics(page, label, context = '') {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const base = path.join(DEBUG_DIR, `${stamp}-${safeName(label)}-${safeName(context)}`)
  try {
    await fs.mkdir(DEBUG_DIR, { recursive: true })
    await page.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => {})
    await fs.writeFile(`${base}.html`, await page.content()).catch(() => {})
    const buttons = await page.locator('button, a[role="button"], a').evaluateAll((nodes) => nodes
      .map((node) => ({
        tag: node.tagName,
        text: (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim(),
        className: node.className || '',
        id: node.id || '',
        href: node.href || '',
        visible: !!(node.offsetWidth || node.offsetHeight || node.getClientRects().length),
      }))
      .filter((node) => node.visible && node.text)
      .slice(0, 200)
    ).catch(() => [])
    await fs.writeFile(`${base}.buttons.json`, JSON.stringify({
      url: page.url(),
      label,
      context,
      buttons,
    }, null, 2)).catch(() => {})
    log('warn', `진단 덤프 저장: ${base}.{png,html,buttons.json}`)
  } catch (e) {
    log('warn', `진단 덤프 실패(무시): ${e.message}`)
  }
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

async function pasteHtmlIntoEditor(page, html, debugContext = '') {
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

  await page.evaluate(() => {
    try {
      if (document.queryCommandState?.('strikeThrough')) {
        document.execCommand('strikeThrough', false, null)
      }
    } catch {}
  }).catch(() => {})

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

  // 텍스트 존재만으로는 평문 붕괴(제목/목록/이미지 소실)를 못 잡는다.
  // 원본 HTML의 구조량과 에디터 실제 구조를 비교해 '리치 paste가 살았는지' 검증한다.
  const expectedImages = (html.match(/<img\b/gi) || []).length
  const expectedBlocks = (html.match(/<(h2|h3|p|li)\b/gi) || []).length
  const editorStructureOk = async () => {
    const actual = await page.evaluate(() => {
      const inTitle = (el) => !!el.closest('.se-title-text, .se-documentTitle')
      const paragraphs = Array.from(document.querySelectorAll('.se-text-paragraph'))
        .filter((p) => !inTitle(p) && (p.textContent || '').trim().length > 0).length
      const images = document.querySelectorAll('.se-component.se-image img, .se-image img, .se-module-image img').length
      return { paragraphs, images }
    }).catch(() => ({ paragraphs: 0, images: 0 }))
    if (expectedImages >= 1 && actual.images === 0) {
      log('warn', '네이버 에디터 이미지 삽입 확인 실패 — 본문 구조가 유지되면 발행 계속')
    }
    // 블록이 여럿이던 글이 본문 문단 1개 이하로 뭉개졌으면 붕괴
    if (expectedBlocks >= 5 && actual.paragraphs <= 1) return false
    return true
  }
  const editorOk = async () => (await editorHasProbe()) && (await editorStructureOk())

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
    if (await editorOk()) return
    log('warn', 'clipboard paste 후 구조 검증 실패 — 폴백 시도')
  }

  // Strategy 2: 합성 ClipboardEvent (clipboard-write 권한 불필요, SE3 paste 핸들러 직접 호출)
  // isTrusted=false를 에디터가 거부하면 조용히 실패할 수 있음 — 에러로 escalate
  log('warn', 'clipboard.write 실패 — 합성 ClipboardEvent 폴백 시도')
  const IFRAME_SELECTOR = 'iframe[id*="se2_editor"], iframe[title*="스마트에디터"], iframe#se2_editor'
  // text/html만 설정한다. text/plain을 함께 주면 SmartEditor가 평문을 집어
  // 제목·굵게·목록·이미지가 통째로 날아간다(구조 소실). HTML만 전달해 구조 보존.
  const syntheticOk = inIframe
    ? await page.frameLocator(IFRAME_SELECTOR).first().locator('body').evaluate((el, htmlPayload) => {
        try {
          const dt = new DataTransfer()
          dt.setData('text/html', htmlPayload)
          el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
          return true
        } catch { return false }
      }, html).catch(() => false)
    : await page.evaluate((htmlPayload) => {
        try {
          const dt = new DataTransfer()
          dt.setData('text/html', htmlPayload)
          const el = document.activeElement || document.body
          el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
          return true
        } catch { return false }
      }, html).catch(() => false)

  if (!syntheticOk) {
    log('warn', '합성 ClipboardEvent 실패 — 직접 입력 폴백 시도')
  } else {
    await page.waitForTimeout(800)
    if (await editorOk()) return
    log('warn', '합성 ClipboardEvent 후 구조 검증 실패 — 직접 입력 폴백 시도')
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
    if (await editorOk()) return
    log('warn', 'execCommand 후 구조 검증 실패')
  }

  // 평문 타이핑 폴백은 제거했다. 모든 리치 전략이 구조 보존에 실패하면
  // 제목/목록/이미지가 날아간 '쓰레기 글'을 발행하느니 needs_human으로 격리한다.
  await dumpPageDiagnostics(page, 'naver-paste-structure-lost', debugContext)
  throw new WorkerError(
    'PASTE_STRUCTURE_LOST',
    'SmartEditor 본문 구조 입력 실패 (리치 paste 전략 모두 실패 — 평문 발행 차단)'
  )
}

async function normalizeNaverEditorContent(page) {
  const stripInFrame = async (frame) => frame.evaluate(() => {
    const roots = Array.from(document.querySelectorAll(
      '.se-main-container, .se-content, .se-component, [contenteditable="true"]'
    ))
    if (!roots.length) roots.push(document.body)

    let unwrapped = 0
    let lineThrough = 0
    for (const root of roots) {
      if (!root) continue
      for (const node of Array.from(root.querySelectorAll('strike, s, del'))) {
        const parent = node.parentNode
        if (!parent) continue
        while (node.firstChild) parent.insertBefore(node.firstChild, node)
        parent.removeChild(node)
        unwrapped += 1
      }
      for (const el of Array.from(root.querySelectorAll('[style]'))) {
        const style = el.getAttribute('style') || ''
        if (/text-decoration\s*:\s*line-through/i.test(style)) {
          const cleaned = style
            .replace(/text-decoration(?:-line)?\s*:\s*line-through[^;"]*;?/gi, '')
            .replace(/;;+/g, ';')
            .trim()
          if (cleaned) el.setAttribute('style', cleaned)
          else el.removeAttribute('style')
          lineThrough += 1
        }
      }
    }

    try {
      if (document.queryCommandState?.('strikeThrough')) {
        document.execCommand('strikeThrough', false, null)
      }
    } catch {}

    const remainingStrike = document.querySelectorAll('strike, s, del').length
    const remainingLineThrough = Array.from(document.querySelectorAll('[style]'))
      .filter((el) => /text-decoration(?:-line)?\s*:\s*line-through/i.test(el.getAttribute('style') || ''))
      .length
    return { unwrapped, lineThrough, remainingStrike, remainingLineThrough }
  }).catch(() => ({ unwrapped: 0, lineThrough: 0, remainingStrike: 0, remainingLineThrough: 0 }))

  let total = { unwrapped: 0, lineThrough: 0, remainingStrike: 0, remainingLineThrough: 0 }
  for (let pass = 0; pass < 2; pass += 1) {
    total = { unwrapped: 0, lineThrough: 0, remainingStrike: 0, remainingLineThrough: 0 }
    for (const frame of [page.mainFrame(), ...page.frames().filter((frame) => frame !== page.mainFrame())]) {
      const result = await stripInFrame(frame)
      total.unwrapped += result.unwrapped
      total.lineThrough += result.lineThrough
      total.remainingStrike += result.remainingStrike
      total.remainingLineThrough += result.remainingLineThrough
    }
    if (total.remainingStrike === 0 && total.remainingLineThrough === 0) break
    await page.waitForTimeout(300)
  }

  if (total.unwrapped || total.lineThrough) {
    log('warn', `네이버 에디터 취소선 서식 제거: strike=${total.unwrapped}, style=${total.lineThrough}`)
  }
  if (total.remainingStrike || total.remainingLineThrough) {
    await dumpPageDiagnostics(page, 'naver-strike-remains', `strike-${total.remainingStrike}-style-${total.remainingLineThrough}`)
    throw new WorkerError(
      'EDITOR_STRIKE_REMAINS',
      `네이버 에디터 취소선 서식 잔존: strike=${total.remainingStrike}, style=${total.remainingLineThrough}`
    )
  }
}

async function ensureNaverStrikeToolbarOff(page) {
  const strikeButton = page.locator('.se-strikethrough-toolbar-button, button:has-text("취소선")').first()
  if ((await strikeButton.count()) === 0 || !(await strikeButton.isVisible().catch(() => false))) return
  const selected = await strikeButton.evaluate((el) => {
    const className = el.className || ''
    const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim()
    return className.includes('se-is-selected') || text.includes('취소선 해제')
  }).catch(() => false)
  if (!selected) return
  await strikeButton.click({ timeout: 5000, force: true })
  await page.waitForTimeout(300)
  log('warn', '네이버 에디터 취소선 툴바 사전 해제')
}

async function countNaverStrikeNodes(page) {
  let total = 0
  for (const frame of [page.mainFrame(), ...page.frames().filter((frame) => frame !== page.mainFrame())]) {
    total += await frame.evaluate(() => document.querySelectorAll('strike, s, del').length)
      .catch(() => 0)
  }
  return total
}

async function clearNaverStrikeWithToolbar(page, debugContext = '') {
  const strikeCount = await countNaverStrikeNodes(page)
  if (strikeCount === 0) return

  const body = page.locator(
    '.se-section-text .se-text-paragraph, .se-component.se-text .se-text-paragraph, .se-module.se-module-text:not(.se-title-text) .se-text-paragraph'
  ).first()
  if ((await body.count()) > 0 && (await body.isVisible().catch(() => false))) {
    await body.click({ timeout: 5000, force: true })
  }

  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
  await page.keyboard.press(`${modifier}+KeyA`).catch(() => {})
  await page.keyboard.press(`${modifier}+KeyA`).catch(() => {})
  await page.waitForTimeout(200)

  await ensureNaverStrikeToolbarOff(page)
  await page.waitForTimeout(500)
  log('warn', `네이버 에디터 취소선 툴바 해제 시도: detected=${strikeCount}`)
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

// 발행 설정 레이어의 '주제' 선택 — best-effort. 실패해도 발행은 막지 않는다.
async function selectNaverTheme(page, theme) {
  if (!theme) return
  try {
    const openers = [
      'button.selectbox_button',
      'button[class*="category"]',
      'button[class*="theme"]',
      'button:has-text("주제")',
    ]
    let opened = false
    for (const sel of openers) {
      const btn = page.locator(sel).first()
      if ((await btn.count()) > 0 && (await btn.isVisible().catch(() => false))) {
        await btn.click({ timeout: 2000, force: true }).catch(() => {})
        opened = true
        break
      }
    }
    if (!opened) {
      log('warn', `네이버 주제 선택 UI 미발견 — 주제 미설정으로 진행 (${theme})`)
      return
    }
    await page.waitForTimeout(500)
    const option = page.locator(
      `button:has-text("${theme}"), a:has-text("${theme}"), label:has-text("${theme}")`
    ).last()
    if ((await option.count()) > 0 && (await option.isVisible().catch(() => false))) {
      await option.click({ timeout: 2000, force: true }).catch(() => {})
      log('info', `네이버 주제 설정: ${theme}`)
    } else {
      log('warn', `네이버 주제 옵션 '${theme}' 미발견 — 미설정으로 진행`)
    }
    await page.waitForTimeout(300)
  } catch (e) {
    log('warn', `네이버 주제 설정 오류(무시): ${e.message}`)
  }
}

async function clickPublishButton(page, theme = '', debugContext = '') {
  await dismissEditorOverlays(page)

  const finalPublishVisible = async () => (
    await page.locator('button[data-testid="seOnePublishBtn"], button[class^="confirm_btn"]').first()
      .isVisible()
      .catch(() => false)
  )

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

  await page.waitForTimeout(1200)
  if (!(await finalPublishVisible())) {
    log('warn', '네이버 발행 설정 레이어 미확인 — 1차 발행 버튼 재클릭')
    await clickFirstVisible([
      'button[class^="publish_btn"]',
      'button[class*=" publish_btn"]',
      '.se_publish_btn',
    ], '네이버 1차 발행 버튼(재시도)')
    await page.waitForTimeout(1200)
  }

  await page.locator('.se-help-panel-close-button').first()
    .click({ timeout: 1000, force: true })
    .catch(() => {})

  // 발행 설정 레이어가 열린 상태에서 주제 선택(검색 분류 신호)
  if (await finalPublishVisible()) {
    await selectNaverTheme(page, theme)
    if (!(await finalPublishVisible())) {
      log('warn', '네이버 주제 선택 후 발행 레이어가 닫힘 — 재오픈')
      await clickFirstVisible([
        'button[class^="publish_btn"]',
        'button[class*=" publish_btn"]',
        '.se_publish_btn',
      ], '네이버 1차 발행 버튼(주제 선택 후 재오픈)')
      await page.waitForTimeout(1200)
    }
  }

  const confirmSelectors = [
    'button[data-testid="seOnePublishBtn"]',
    'button[class^="confirm_btn"]',
    'button[class*=" confirm_btn"]',
    'button[class*="confirm"]',
    '[data-action="confirm"]',
    '.layer_btn_area__UzyKH button:has-text("발행")',
    '.layer_publish__vA9PX button:has-text("발행")',
    '[class*="layer_btn_area"] button:has-text("발행")',
    '[class*="layer_publish"] button:has-text("발행")',
  ]
  let confirmed = false
  for (const sel of confirmSelectors) {
    const handles = page.locator(sel)
    const count = await handles.count().catch(() => 0)
    for (let i = 0; i < count; i += 1) {
      const handle = handles.nth(i)
      if (!(await handle.isVisible().catch(() => false))) continue
      const text = (await handle.innerText().catch(() => '')).replace(/\s+/g, ' ').trim()
      if (text && !/(발행|확인|완료|등록)/.test(text)) continue
      await handle.click({ timeout: 5000, force: true })
      log('info', `네이버 최종 발행 버튼 클릭: ${sel}${text ? ` text="${text}"` : ''}`)
      await page.waitForTimeout(1200)
      if (await page.locator('button[data-testid="seOnePublishBtn"], button[class^="confirm_btn"]').first().isVisible().catch(() => false)) {
        log('warn', `네이버 최종 발행 버튼 클릭 후 레이어가 닫히지 않음: ${sel}`)
        continue
      }
      confirmed = true
      break
    }
    if (confirmed) break
  }
  if (!confirmed) {
    await dumpPageDiagnostics(page, 'naver-confirm-not-found', debugContext)
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

function stripHtmlText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

function hasMarkdownTableLeak(html) {
  return String(html || '')
    .split(/\r?\n/)
    .some((line) => /^\s*\|.+\|\s*$/.test(line) || /^\s*\|?\s*:?-{3,}:?\s*\|/.test(line))
}

function assertNaverAutoPublishable(html) {
  const imageCount = (String(html || '').match(/<img\b/gi) || []).length
  const markdownImageCount = (String(html || '').match(/!\[[^\]]*\]\([^)\s]+\)/g) || []).length
  const tableCount = (String(html || '').match(/<table\b/gi) || []).length
  const markdownTableLeak = hasMarkdownTableLeak(html)
  const reasons = []
  if (imageCount > 0) reasons.push(`이미지 ${imageCount}개`)
  if (markdownImageCount > 0) reasons.push(`마크다운 이미지 ${markdownImageCount}개`)
  if (tableCount > 0) reasons.push(`HTML 표 ${tableCount}개`)
  if (markdownTableLeak) reasons.push('마크다운 표 문법 잔존')
  if (!reasons.length) return
  throw new WorkerError(
    'NAVER_RICH_CONTENT_UNSUPPORTED',
    `네이버 SmartEditor 자동 발행에서 구조 보존이 검증되지 않은 리치 원고입니다: ${reasons.join(', ')}. ` +
      '이미지/표 보존 발행은 수동 확인 또는 전용 업로드 구현 후 진행하세요.',
    { imageCount, markdownImageCount, tableCount, markdownTableLeak }
  )
}

function hasVisibleStrike(html) {
  const matches = String(html || '').matchAll(/<(?:strike|s|del)\b[^>]*>([\s\S]*?)<\/(?:strike|s|del)>/gi)
  for (const match of matches) {
    const text = stripHtmlText(match[1]).replace(/[\u200b\u200c\u200d\ufeff]/g, '').trim()
    if (text) return true
  }
  return /text-decoration(?:-line)?\s*:\s*line-through/i.test(String(html || ''))
}

const NAVER_PUBLIC_FORBIDDEN = [
  '꿀팁',
  '환장',
  '대박',
  '지옥',
  '끝판왕',
  '무조건',
  '충격',
  '실화',
  '발업',
]

async function validateNaverPublicPost(url, debugContext = '') {
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': 'Mozilla/5.0 blog-publisher-quality-check' },
      signal: AbortSignal.timeout(20000),
    })
    const html = await res.text()
    if (!res.ok) {
      throw new WorkerError('NAVER_PUBLIC_HTTP_FAILED', `네이버 공개 URL 응답 실패: HTTP ${res.status}`)
    }
    const text = stripHtmlText(html)
    const forbidden = NAVER_PUBLIC_FORBIDDEN.filter((word) => text.includes(word))
    const visibleStrike = hasVisibleStrike(html)
    if (forbidden.length || visibleStrike) {
      throw new WorkerError(
        'NAVER_PUBLIC_QUALITY_FAILED',
        `네이버 공개 글 품질 검증 실패: forbidden=${forbidden.join(',') || '-'}, visibleStrike=${visibleStrike}`
      )
    }
    log('info', `네이버 공개 글 품질 검증 통과: ${url}`)
  } catch (e) {
    if (e instanceof WorkerError) throw e
    throw new WorkerError('NAVER_PUBLIC_CHECK_FAILED', `네이버 공개 글 검증 오류: ${e.message || e}`)
  }
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

async function publishToNaver({ post_id, title, content_html, tags, link, canonical_url, topic_theme }) {
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
  assertNaverAutoPublishable(rewritten.html)
  const naverHtml = convertForNaver(rewritten.html)
  if (!naverHtml.trim()) throw new WorkerError('EMPTY_CONTENT', '변환된 본문이 비어있습니다.')
  assertNaverAutoPublishable(naverHtml)

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

    await ensureNaverStrikeToolbarOff(page)
    await fillNaverTitle(page, publishTitle)

    await ensureNaverStrikeToolbarOff(page)
    await pasteHtmlIntoEditor(page, naverHtml, post_id || publishTitle)
    await clearNaverStrikeWithToolbar(page, post_id || publishTitle)
    await normalizeNaverEditorContent(page)

    if (Array.isArray(tags) && tags.length) {
      const tagInput = page.locator('input[placeholder*="태그"], .tag_input input, input[name="tags"]').first()
      if ((await tagInput.count()) > 0 && (await tagInput.isVisible().catch(() => false))) {
        await tagInput.fill(tags.join(', '))
        await page.keyboard.press('Enter')
      }
    }

    await clickPublishButton(page, topic_theme, post_id || publishTitle)
    const publishedUrl = await capturePublishedUrl(page)
    if (!publishedUrl) {
      await dumpPageDiagnostics(page, 'naver-url-not-found', post_id || publishTitle)
      throw new WorkerError('PUBLISH_URL_NOT_FOUND', '네이버 발행 후 공개 글 URL을 확인하지 못했습니다.')
    }
    await validateNaverPublicPost(publishedUrl, post_id || publishTitle)
    await saveStorageState(context)

    return {
      status: 'success',
      url: publishedUrl,
      title: publishTitle,
      rewritten: rewritten.rewritten,
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

    log('info', '티스토리 HTML 변환 시작…')
    const convertedHtml = await convertForTistory(rewritten.html)
    log('info', `티스토리 HTML 변환 완료 (${convertedHtml.length}자)`)
    const quality = validateTistoryHtml(convertedHtml)
    if (!quality.ok) {
      throw new WorkerError(
        'TISTORY_HTML_QUALITY_FAILED',
        `티스토리 발행 전 HTML 품질 검증 실패: ${quality.reasons.join(', ')}`,
        quality.quality
      )
    }
    const result = await tistoryWritePost({ title: rewritten.title, content_html: convertedHtml, tags })
    return {
      ...result,
      title: rewritten.title,
      rewritten: rewritten.rewritten,
      quality: quality.quality,
    }
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

  return runPublishExclusive(`${platform}:${postId || body.title}`, async () => {
    // 멱등성: 큐 안에서 다시 확인해 동시 요청의 성공 직후 재발행을 차단한다.
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
      if (postId) {
        await reportResultToMain(postId, platform, {
          status: 'success',
          title: result.title || body.title,
          original_title: body.title,
          rewritten: result.rewritten ?? false,
          quality: result.quality ?? null,
          url: result.url,
          published_at: result.published_at,
        })
      }
      return sendJson(res, 200, { ok: true, platform, ...result })
    } catch (e) {
      const code = e instanceof WorkerError ? e.code : (e instanceof TistoryError ? e.code : 'UNKNOWN')
      log('error', `❌ 발행 실패 [${code}]: ${e.message}`)
      if (postId) await reportResultToMain(postId, platform, { status: 'failed', title: body.title, error: e.message, code })
      return sendJson(res, 500, { ok: false, error: e.message, code })
    }
  })
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
  for (const platform of platforms) {
    try {
      await runPublishExclusive(`${platform}:${postId || body.title}`, async () => {
        const dedupKey = postId ? `${platform}:${postId}` : ''
        if (dedupKey) {
          const pubLog = await loadPublishedLog()
          if (pubLog[dedupKey] && isValidPublishedUrl(platform, pubLog[dedupKey].url)) {
            results[platform] = { ok: true, url: pubLog[dedupKey].url, deduped: true }
            return
          }
        }
        let r
        if (platform === 'tistory') r = await publishToTistory(body)
        else if (platform === 'naver') r = await publishToNaver(body)
        else if (platform === 'twitter') r = await publishToTwitter(body)
        else { results[platform] = { ok: false, error: 'unsupported' }; return }
        results[platform] = { ok: true, ...r }
        if (postId) await recordPublished(`${platform}:${postId}`, r.url)
        if (postId) {
          await reportResultToMain(postId, platform, {
            status: 'success',
            title: r.title || body.title,
            original_title: body.title,
            rewritten: r.rewritten ?? false,
            quality: r.quality ?? null,
            url: r.url,
            published_at: r.published_at,
          })
        }
      })
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
