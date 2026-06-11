// ─── 키워드 리서치 모듈 ──────────────────────────────────────────────────────
// 네이버 검색광고 API(keywordstool)로 월간 검색량/경쟁도를 조회하고,
// 네이버 자동완성으로 연관 검색어를 수집한다.
// 검색광고 API 키가 없으면 자동완성만으로 동작한다 (graceful degradation).
//
// 필요 환경변수 (검색광고 API):
//   NAVER_AD_API_KEY      - 검색광고 API 액세스 라이선스
//   NAVER_AD_API_SECRET   - 비밀키
//   NAVER_AD_CUSTOMER_ID  - 광고주 ID (CUSTOMER_ID)

import crypto from 'node:crypto'

const SEARCHAD_BASE = 'https://api.searchad.naver.com'
const AUTOCOMPLETE_URL = 'https://ac.search.naver.com/nx/ac'

class KeywordResearchError extends Error {
  constructor(code, message, details = null) {
    super(message)
    this.code = code
    this.details = details
  }
}

function readSearchAdConfig(env = process.env) {
  const apiKey = env.NAVER_AD_API_KEY || ''
  const apiSecret = env.NAVER_AD_API_SECRET || ''
  const customerId = env.NAVER_AD_CUSTOMER_ID || ''
  if (!apiKey || !apiSecret || !customerId) return null
  return { apiKey, apiSecret, customerId }
}

function signSearchAdRequest(method, uri, timestamp, secret) {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${method}.${uri}`).digest('base64')
}

function parseQueryCount(value) {
  // 네이버는 10 미만을 "< 10" 문자열로 반환한다
  if (typeof value === 'number') return value
  const str = String(value ?? '').trim()
  if (str.startsWith('<')) return 5
  const n = Number(str.replace(/,/g, ''))
  return Number.isFinite(n) ? n : 0
}

async function fetchSearchAdKeywords(seedKeywords, config) {
  // hintKeywords는 공백 제거 필수, 최대 5개
  const hints = seedKeywords
    .map((k) => String(k ?? '').replace(/\s+/g, ''))
    .filter(Boolean)
    .slice(0, 5)

  if (!hints.length) return []

  const uri = '/keywordstool'
  const method = 'GET'
  const timestamp = String(Date.now())
  const query = new URLSearchParams({ hintKeywords: hints.join(','), showDetail: '1' })

  const res = await fetch(`${SEARCHAD_BASE}${uri}?${query.toString()}`, {
    method,
    headers: {
      'X-Timestamp': timestamp,
      'X-API-KEY': config.apiKey,
      'X-Customer': config.customerId,
      'X-Signature': signSearchAdRequest(method, uri, timestamp, config.apiSecret),
    },
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new KeywordResearchError('SEARCHAD_API_ERROR', `naver searchad API error ${res.status}`, { body: body.slice(0, 300) })
  }

  const data = await res.json()
  const list = Array.isArray(data?.keywordList) ? data.keywordList : []

  return list.map((item) => {
    const pc = parseQueryCount(item.monthlyPcQcCnt)
    const mobile = parseQueryCount(item.monthlyMobileQcCnt)
    return {
      keyword: item.relKeyword ?? '',
      monthly_pc: pc,
      monthly_mobile: mobile,
      monthly_total: pc + mobile,
      competition: item.compIdx ?? null, // 낮음/중간/높음
      avg_monthly_ad_clicks: parseQueryCount(item.monthlyAvePcClkCnt) + parseQueryCount(item.monthlyAveMobileClkCnt),
      source: 'naver_searchad',
    }
  }).filter((item) => item.keyword)
}

async function fetchAutocomplete(seed) {
  const query = new URLSearchParams({
    q: seed,
    con: '0',
    frm: 'nv',
    ans: '2',
    r_format: 'json',
    r_enc: 'UTF-8',
    r_unicode: '0',
    t_koreng: '1',
    run: '2',
    rev: '4',
    q_enc: 'UTF-8',
    st: '100',
  })

  const res = await fetch(`${AUTOCOMPLETE_URL}?${query.toString()}`, {
    headers: {
      referer: 'https://www.naver.com/',
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    },
  })

  if (!res.ok) return []

  const data = await res.json().catch(() => null)
  const items = Array.isArray(data?.items) ? data.items : []
  const suggestions = []
  for (const group of items) {
    if (!Array.isArray(group)) continue
    for (const entry of group) {
      const text = Array.isArray(entry) ? entry[0] : entry
      if (typeof text === 'string' && text.trim()) suggestions.push(text.trim())
    }
  }
  return [...new Set(suggestions)]
}

async function researchKeywords(seedKeywords, env = process.env) {
  const seeds = (Array.isArray(seedKeywords) ? seedKeywords : [seedKeywords])
    .map((k) => String(k ?? '').trim())
    .filter(Boolean)

  if (!seeds.length) {
    throw new KeywordResearchError('MISSING_KEYWORDS', 'seed keywords are required')
  }

  const config = readSearchAdConfig(env)

  const [searchAdResult, autocompleteResults] = await Promise.all([
    config
      ? fetchSearchAdKeywords(seeds, config).catch((error) => ({ error }))
      : Promise.resolve(null),
    Promise.all(seeds.slice(0, 5).map(async (seed) => ({
      seed,
      suggestions: await fetchAutocomplete(seed).catch(() => []),
    }))),
  ])

  let keywords = []
  let searchadError = null
  if (searchAdResult && !Array.isArray(searchAdResult) && searchAdResult.error) {
    searchadError = searchAdResult.error instanceof Error ? searchAdResult.error.message : 'searchad request failed'
  } else if (Array.isArray(searchAdResult)) {
    keywords = searchAdResult.sort((a, b) => b.monthly_total - a.monthly_total)
  }

  return {
    seeds,
    searchad_configured: Boolean(config),
    searchad_error: searchadError,
    keywords,
    autocomplete: autocompleteResults,
    // 글감 추천: 검색량이 있으면서 경쟁이 낮음/중간인 키워드 우선
    recommended: keywords
      .filter((k) => k.monthly_total >= 100 && k.competition !== '높음')
      .slice(0, 20),
  }
}

export { researchKeywords, KeywordResearchError }
