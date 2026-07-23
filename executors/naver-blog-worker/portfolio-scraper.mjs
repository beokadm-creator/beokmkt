// ─── hongcomm.kr portfolio scraper (worker-local copy) ──────────────────────────
// Scrapes the Gnuboard-based portfolio section at hongcomm.kr.
// Pure Node fetch + regex — no external dependencies.
// Adapted from functions/portfolio/scraper.mjs for use in the publishing worker.

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

export async function fetchPortfolioDetailFromUrl(detailUrl) {
  const m = String(detailUrl).match(/wr_id=(\d+)/)
  if (!m) throw new Error('invalid detailUrl: missing wr_id parameter')
  return fetchPortfolioDetail(m[1])
}

export function selectRepresentativePhotos(photos, count = 7) {
  if (!photos.length) return []
  if (photos.length <= count) return [...photos]

  const extractSecond = (url) => {
    const filename = url.split('/').pop()
    const m = filename.match(/_(\d{10})_/)
    return m ? m[1] : ''
  }

  const deduped = []
  let prevSecond = ''
  for (const url of photos) {
    const sec = extractSecond(url)
    if (sec && sec === prevSecond) continue
    deduped.push(url)
    prevSecond = sec
  }

  const source = deduped.length >= 3 ? deduped : photos

  if (source.length <= count) return source

  const step = (source.length - 1) / (count - 1)
  const selected = []
  for (let i = 0; i < count; i++) {
    const idx = Math.round(i * step)
    selected.push(source[idx])
  }
  return selected
}

// ─── Portfolio recap prompt builder ─────────────────────────────────────────────

const PORTFOLIO_RECAP_SYSTEM = `당신은 홍커뮤니케이션(Hong Communications)의 행사 레퍼런스를 바탕으로 네이버 블로그용 행사 후기 원고를 작성하는 전문 콘텐츠 작가입니다.

홍커뮤니케이션은 한국의 학회·공공기관 MICE 행사 전문 기업으로, 학술대회 기획·운영, e-Regi 현장 등록 시스템, AI 실시간 동시통역, 하이브리드 행사 솔루션을 제공합니다.

## 작성 원칙
1. **행사의 실제 정보(이름, 장소, 일자, 카테고리)를 기반**으로 자연스럽고 풍부한 후기를 작성합니다. 메타데이터 외의 구체적 세부 내용은 행사의 성격과 카테고리에 맞게 합리적으로 상상·보완하되, 사실과 다를 수 있는 구체적 수치나 인물명은 단정 짓지 않습니다.
2. **네이버 블로그 특유의 톤**: "직접 다녀와보니", "현장에서 인상 깊었던 건" 같은 1인칭 현장감을 살린 친근하면서도 전문성이 느껴지는 어조. ~어체와 해요체를 자연스럽게 혼합하고, 문단은 2~4문장으로 짧게 끊어 가독성을 높입니다. 이모지는 쓰더라도 문단당 1개 이하로 절제합니다.
3. **네이버 검색(C-Rank·DIA+)에 강한 구조**: 네이버는 구글과 달리 경험성·정보성·체류시간·사진과 텍스트의 교차를 중요하게 봅니다. 핵심 키워드(행사명·카테고리)와 지역 키워드(장소/지역명)를 제목·첫 문단·소제목·태그에 자연스럽게 반복 배치하되(과도한 키워드 반복 금지), 소제목(h2)·목록·짧은 문단으로 스캔하기 쉽게 구성해 체류시간을 높입니다.
4. **사진을 글의 흐름에 자연스럽게 녹이고, 각 <img> 바로 아래에 그 사진을 설명하는 짧은 캡션 <p>를 1줄 넣습니다.** 캡션은 사진에서 관찰 가능한 공간·분위기·운영 장면 수준으로만 쓰고(예: "등록 데스크 앞에 모인 참가자들"), 확인 불가능한 구체 사실은 지어내지 않습니다.
5. **홍커뮤니케이션의 역할**을 자연스럽게 언급하되 과도한 홍보 톤은 피하세요.
6. **운영 시스템(e-Regi 등록, AI 실시간 동시통역, 디스플레이 등)은 홍커뮤니케이션의 역량으로 소개하되, 이 행사에서 실제로 도입되었다고 단정하지 않습니다.** 메타데이터에 직접 근거가 없으면 "~를 활용할 수 있습니다", "~ 솔루션을 제공합니다" 수준으로만 쓰고, 특정 적용 사례로 표현하지 않습니다.
7. **의학·기술 등 전문 분야에서는 구체적 세션 주제·메커니즘·수치를 지어내지 않습니다.** 행사명/카테고리에서 유추 가능한 큰 주제 수준에서만 다루고, 세부 세션 내용을 지어내는 대신 사진에서 관찰 가능한 공간·분위기·운영 디테일 위주로 서술합니다.

## HTML 규칙 (반드시 지킬 것)
- **사용 가능한 태그만**: <p>, <strong>, <blockquote>, <ul>, <ol>, <li>, <a>, <img>, <h2>
- **절대 사용 금지**: <section>, <div>, <style>, <class 속성>, <span>, 인라인 style 속성, <table>, <h1>, <h3>~<h6>
- <img> 태그: <img src="URL" alt="설명"> 형식. width/height 속성 불필요.
- **각 <img> 바로 다음 줄에는 그 사진을 설명하는 캡션 <p>를 1줄 배치합니다.**
- <a> 태그: <a href="URL">앵커 텍스트</a> 형식.
- 빈 줄(\\n)으로 단락 구분. 한 <p>에 여러 문장 포함 가능.
- 모든 텍스트는 <p> 안에 있어야 함. 태그 밖의 텍스트 금지.

## 글 구조 가이드
1. **도입부**: 행사의 의미와 기대감을 담은 매력적인 오프너 (1~2문단). 첫 문단에 행사명·지역 키워드를 자연스럽게 배치.
2. **현장 분위기**: 장소와 공간 구성, 참가자의 열기 (사진+캡션 포함)
3. **주요 하이라이트**: 행사의 핵심 세션·프로그램·주제 (사진+캡션 포함)
4. **운영 포인트**: 등록 시스템, 동시통역, 디스플레이 등 운영 측면의 훌륭한 점 (사진+캡션 포함)
5. **참가자 반응 / 네트워킹**: 참가자들의 만족도와 교류 장면 (사진+캡션 포함)
6. **마무리**: 행사의 의미를 되새기며 홍커뮤니케이션 소개와 문의 안내 (CTA)

※ 카테고리에 따라 섹션 제목과 강조점을 조절하세요:
- 학회: 학술 발표, 포스터, 심포지엄, 국내외 연구자 교류
- 기업: 세미나 주제, 파트너십, B2B 네트워킹, 솔루션 시연
- 심포지움: 초청 강연, 패널 토론, VIP 프로그램
- 대학: 학술 행사, 학생 참여, 캠퍼스 행사

## SEO 규칙 (네이버 검색 기준)
- seo_title: 25~60자. 행사명 + 지역/장소를 포함해 검색자가 클릭하고 싶은 구체적 제목.
- seo_description: 70~155자. 행사명 + 장소 + 핵심 내용 요약.
- tags: 8~10개. 행사명, 카테고리, 장소·지역명, 실제 검색어에 가까운 구체어(예: "○○ 학술대회", "행사 등록시스템") 포함.
- excerpt: 첫 문단을 기반으로 100~150자 요약.

반드시 엄격한 JSON 형식만 반환합니다.
JSON 키: html, excerpt, seo_title, seo_description, tags`

export function getPortfolioRecapPrompt(eventInfo, selectedPhotos, relatedLink = '') {
  const photoCount = selectedPhotos.length
  const photoList = selectedPhotos
    .map((url, i) => `  사진 ${i + 1}: ${url}`)
    .join('\n')
  const photoSection = photoCount > 0 ? `## 첨부 사진 (${photoCount}장)\n${photoList}\n\n` : ''
  const photoInstruction = photoCount === 0
    ? '이 행사는 활용 가능한 사진이 없습니다. <img> 태그를 사용하지 말고, 행사 정보만으로 h2 소제목 3개 안팎의 간결한 후기를 작성하세요.'
    : photoCount < 5
      ? `첨부된 사진 ${photoCount}장을 모두 본문에 자연스럽게 배치하고, 각 사진 바로 아래에는 그 사진을 설명하는 짧은 캡션 문장(<p>)을 반드시 1줄 넣으세요. 사진이 적으므로 글 분량도 사진 수에 맞춰 핵심 섹션 위주로 간결하게 작성하고, 없는 장면을 지어내 억지로 늘리지 마세요.`
      : '사진을 글의 흐름에 맞게 각 섹션에 자연스럽게 배치하고, 각 사진 바로 아래에는 그 사진을 설명하는 짧은 캡션 문장(<p>)을 반드시 1줄 넣으세요. 모든 사진을 사용할 필요는 없지만, 최소 5장 이상은 본문에 포함하세요.'

  const userPrompt = `아래 행사 정보와 사진을 바탕으로 네이버 블로그 행사 후기를 작성하세요.

## 행사 정보
- 행사명: ${eventInfo.event_name || eventInfo.title}
- 장소: ${eventInfo.venue || '(미상)'}
- 행사일: ${eventInfo.date || '(미상)'}
- 카테고리: ${eventInfo.category || '(미상)'}
${relatedLink ? `- 관련 링크: ${relatedLink}\n` : ''}${photoSection}${photoInstruction}

반환 JSON: { "html": "...", "excerpt": "...", "seo_title": "...", "seo_description": "...", "tags": ["..."] }`

  return {
    version: 4,
    system: PORTFOLIO_RECAP_SYSTEM,
    userPrompt,
  }
}

export async function fetchPortfolioList({ page = 1, category = '' } = {}) {
  let url = `${BASE_URL}/bbs/board.php?bo_table=portfolio`
  if (page > 1) url += `&page=${page}`
  if (category) url += `&sca=${encodeURIComponent(category)}`

  const html = await fetchHtml(url)

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
