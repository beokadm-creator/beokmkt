// ─── hongcomm.kr portfolio scraper ─────────────────────────────────────────────
// Scrapes the Gnuboard-based portfolio section at hongcomm.kr.
// Pure Node fetch + regex — no external dependencies.
//
// Detail page structure (verified across wr_id=323..343):
//   <h1 class="pv_hero_title">EVENT NAME</h1>
//   <div class="pv_info_label">행사명</div><div class="pv_info_val">...</div>
//   <div class="pv_info_label">장소</div><div class="pv_info_val">...</div>
//   <div class="pv_info_label">행사일</div><div class="pv_info_val">...</div>
//   <meta name="description" content="[카테고리] 장소: ... 행사일: ..." />
//   Gallery: <img src="https://hongcomm.kr/data/editor/YYMM/<hash>.jpg">  (~20-30)
//   Thumb:   <img src="https://hongcomm.kr/data/file/portfolio/thumb-<hash>_<size>.jpg">
//
// List page structure:
//   <li class="gall_li"> → <a href="...&wr_id=N"> → <img src="thumb"> →
//     <p class="gall_txt">카테고리</p>
//     <p class="gall_txt2">제목</p>
//     <p class="gall_meta">행사명 / 장소 / 행사일</p>

const BASE_URL = 'https://hongcomm.kr'
const FETCH_TIMEOUT_MS = 15_000

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'

async function fetchHtml(url) {
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: {
      'user-agent': UA,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  })
  if (!res.ok) throw new Error(`hongcomm HTTP ${res.status} for ${url}`)
  return res.text()
}

// ─── Detail page scraper ──────────────────────────────────────────────────────

function parseTitle(html) {
  const m = html.match(/<h1\s+class="pv_hero_title">([\s\S]*?)<\/h1>/)
  return m ? decodeHtmlEntities(m[1].trim()) : ''
}

function parseCategory(html) {
  const m = html.match(/meta\s+name="description"\s+content="\[([^\]]+)\]/)
  return m ? m[1].trim() : ''
}

function parseInfoFields(html) {
  const result = {}
  const labelRe = /<div\s+class="pv_info_label">([\s\S]*?)<\/div>\s*<div\s+class="pv_info_val">([\s\S]*?)<\/div>/g
  let m
  while ((m = labelRe.exec(html)) !== null) {
    const label = decodeHtmlEntities(m[1].trim())
    const value = decodeHtmlEntities(m[2].trim())
    if (label === '행사명') result.event_name = value
    else if (label === '장소') result.venue = value
    else if (label === '행사일') result.date = value
  }
  return result
}

function parseGalleryPhotos(html) {
  // Extract all unique data/editor image URLs (the actual gallery photos)
  const set = new Set()
  const re = /src="(https:\/\/hongcomm\.kr\/data\/editor\/[^"]+\.(?:jpg|jpeg|png))"/gi
  let m
  while ((m = re.exec(html)) !== null) set.add(m[1])
  return [...set]
}

function parseThumbUrl(html) {
  const m = html.match(/src="(https:\/\/hongcomm\.kr\/data\/file\/portfolio\/thumb-[^"]+\.jpg)"/)
  return m ? m[1] : ''
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#034;/g, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
}

/**
 * Fetch and parse a single portfolio detail page.
 * @param {string} wrId - The wr_id number
 * @returns {Promise<{wr_id, title, category, event_name, venue, date, photos, thumbUrl, raw_url}>}
 */
export async function fetchPortfolioDetail(wrId) {
  const id = String(wrId).trim()
  const url = `${BASE_URL}/bbs/board.php?bo_table=portfolio&wr_id=${id}`
  const html = await fetchHtml(url)

  const title = parseTitle(html)
  const category = parseCategory(html)
  const info = parseInfoFields(html)
  const photos = parseGalleryPhotos(html)
  const thumbUrl = parseThumbUrl(html)

  return {
    wr_id: id,
    title,
    category,
    event_name: info.event_name || title,
    venue: info.venue || '',
    date: info.date || '',
    photos,
    thumbUrl,
    raw_url: url,
  }
}

/**
 * Fetch detail from a full URL (accepts ?bo_table=portfolio&wr_id=N format).
 */
export async function fetchPortfolioDetailFromUrl(detailUrl) {
  const m = String(detailUrl).match(/wr_id=(\d+)/)
  if (!m) throw new Error('invalid detailUrl: missing wr_id parameter')
  return fetchPortfolioDetail(m[1])
}

// ─── Photo selection heuristic ────────────────────────────────────────────────

/**
 * Select 6-8 representative photos from the gallery using even-spacing.
 * Photos are sorted by URL (gallery order). Evenly distributed indices
 * capture variety across the gallery timeline (venue setup → sessions → audience).
 * Skips obvious duplicates: if two adjacent photos share the same second-level
 * timestamp, only the first is kept (burst-shot dedup).
 * @param {string[]} photos - Gallery photo URLs (already unique, gallery order)
 * @param {number} count - Target count (default 7)
 * @returns {string[]} Selected photo URLs
 */
export function selectRepresentativePhotos(photos, count = 7) {
  if (!photos.length) return []
  if (photos.length <= count) return [...photos]

  // Burst dedup: if two adjacent photos were taken in the same second, skip the later one
  const extractSecond = (url) => {
    const filename = url.split('/').pop()
    const m = filename.match(/_(\d{10})_/)
    return m ? m[1] : ''
  }

  const deduped = []
  let prevSecond = ''
  for (const url of photos) {
    const sec = extractSecond(url)
    if (sec && sec === prevSecond) continue // burst shot, skip
    deduped.push(url)
    prevSecond = sec
  }

  const source = deduped.length >= 3 ? deduped : photos

  if (source.length <= count) return source

  // Evenly space selection across the gallery
  const step = (source.length - 1) / (count - 1)
  const selected = []
  for (let i = 0; i < count; i++) {
    const idx = Math.round(i * step)
    selected.push(source[idx])
  }
  return selected
}

// ─── List page scraper ─────────────────────────────────────────────────────────

/**
 * Fetch and parse the portfolio list page.
 * @param {object} options
 * @param {number} [options.page=1]
 * @param {string} [options.category] - Filter: '학회', '기업', '대학', '심포지움'
 * @returns {Promise<{items: Array, page: number}>}
 */
export async function fetchPortfolioList({ page = 1, category = '' } = {}) {
  let url = `${BASE_URL}/bbs/board.php?bo_table=portfolio`
  if (page > 1) url += `&page=${page}`
  if (category) url += `&sca=${encodeURIComponent(category)}`

  const html = await fetchHtml(url)

  // Extract list items from <li class="gall_li"> blocks
  const items = []
  const blockRe = /<li\s+class="gall_li[^"]*">([\s\S]*?)<\/li>\s*<\/ul>/g
  let m
  while ((m = blockRe.exec(html)) !== null) {
    const block = m[1]

    const idMatch = block.match(/wr_id=(\d+)/)
    if (!idMatch) continue

    const titleMatch = block.match(/class="gall_txt2">([\s\S]*?)<\/p>/)
    const catMatch = block.match(/class="gall_txt">([\s\S]*?)<\/p>/)
    const thumbMatch = block.match(/src="(https:\/\/hongcomm\.kr\/data\/file\/portfolio\/thumb-[^"]+\.jpg)"/)
    const metaMatch = block.match(/class="gall_meta">([\s\S]*?)<\/p>/)

    let venue = ''
    let date = ''
    if (metaMatch) {
      const metaText = decodeHtmlEntities(metaMatch[1].trim()).replace(/\s+/g, ' ').trim()
      const parts = metaText.split(/\s*\/\s*/)
      // Pattern: 행사명 / 장소 / 행사일
      if (parts.length >= 2) venue = parts[parts.length - 2].replace(/\s+/g, ' ').trim()
      if (parts.length >= 1) date = parts[parts.length - 1].replace(/\s+/g, ' ').trim()
    }

    items.push({
      wr_id: idMatch[1],
      title: titleMatch ? decodeHtmlEntities(titleMatch[1].trim()).replace(/\s+/g, ' ').trim() : '',
      category: catMatch ? decodeHtmlEntities(catMatch[1].trim()).replace(/\s+/g, ' ').trim() : '',
      venue,
      date,
      thumbUrl: thumbMatch ? thumbMatch[1] : '',
      detailUrl: `${BASE_URL}/bbs/board.php?bo_table=portfolio&wr_id=${idMatch[1]}`,
    })
  }

  return { items, page }
}
