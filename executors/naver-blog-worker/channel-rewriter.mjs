// ─── 채널별 콘텐츠 재작성 ────────────────────────────────────────────────────
// 같은 글을 자체 블로그·네이버·티스토리에 그대로 올리면 유사문서 필터에 걸려
// 늦게 발행된 채널이 검색에서 통째로 누락될 수 있다.
// 채널별로 구성·문체·표현을 다르게 재작성해 각 채널이 독립 문서로 평가받게 한다.
//
// 환경변수:
//   CHANNEL_REWRITE=false   재작성 비활성화 (원문 그대로 발행)
//   AI_API_KEY / AI_MODEL   tistory-html-adapter와 동일한 AI 설정 공유

import 'dotenv/config'

const AI_API_KEY = process.env.AI_API_KEY || ''
const AI_MODEL = process.env.AI_MODEL || 'glm-5.1'
const AI_ENDPOINT = process.env.AI_REWRITE_ENDPOINT || 'https://api.z.ai/api/coding/paas/v4/chat/completions'
const REWRITE_ENABLED = process.env.CHANNEL_REWRITE !== 'false'
const AI_REWRITE_TIMEOUT_MS = Number(process.env.AI_REWRITE_TIMEOUT_MS || '120000')
const HANZI_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/

const CHANNEL_GUIDES = {
  naver: `네이버 블로그 독자 특성에 맞게 재작성:
- 검색자가 편하게 읽을 수 있는 자연스러운 존댓말. 단, 전문성과 신뢰감을 최우선으로 유지
- 문단을 짧게 끊어 모바일에서 읽기 쉽게
- 네이버 검색 사용자가 입력할 법한 표현을 소제목에 반영
- 제목도 원래 제목과 다르게 작성하되, 실무형 검색 제목처럼 차분하고 구체적으로 작성
- 절대 금지: 낚시성 제목, 과장, 속어, 유행어, 감탄사, 이모지, "꿀팁", "환장", "대박", "지옥", "끝판왕", "완벽", "무조건", "충격", "실화"`,
  tistory: `티스토리 블로그 독자 특성에 맞게 재작성:
- 구글 검색 유입 독자가 10초 안에 가치를 판단할 수 있게 첫머리에 핵심 요약 3줄을 둔다
- 단순 줄글 금지: h2/h3, 불릿, 번호 목록, 비교표, 체크리스트, blockquote 콜아웃을 상황에 맞게 적극 사용한다
- 각 h2는 "무엇/왜/어떻게/주의점/체크리스트" 중 하나가 분명히 드러나게 쓴다
- 실무자가 바로 적용할 수 있는 판단 기준, 단계, 확인 항목, 장애 대응 흐름을 포함한다
- 내용이 둘 이상 비교되면 반드시 표를 쓴다. 절차가 있으면 번호 목록을 쓴다. 주의사항은 blockquote로 분리한다
- 과장된 광고문 대신 차분한 전문가 톤으로, 마지막에 부드러운 상담 CTA를 둔다
- 제목도 원래 제목과 다르게 새로 작성하되 검색 의도와 실무 효용을 분명히 담는다
- 절대 금지: 낚시성 제목, 과장, 속어, 유행어, 감탄사, 이모지, "꿀팁", "환장", "대박", "지옥", "끝판왕", "완벽", "무조건", "충격", "실화"`,
}

// <img> 태그를 마크다운 이미지로 변환(스트리핑 과정에서 살아남게).
function imgTagsToMarkdown(html) {
  return String(html ?? '').replace(/<img\b[^>]*>/gi, (tag) => {
    const src = (tag.match(/src=["']([^"']+)["']/i) || [])[1] || ''
    const alt = (tag.match(/alt=["']([^"']*)["']/i) || [])[1] || ''
    return src ? `\n\n![${alt}](${src})\n\n` : ''
  })
}

// 마크다운 이미지 ![alt](src) → <img> 태그(발행 직전 복원).
function markdownImagesToHtml(html) {
  return String(html ?? '').replace(
    /!\[([^\]]*)\]\(([^)\s]+)\)/g,
    (_m, alt, src) => `<img src="${src}" alt="${alt}" style="max-width:100%;height:auto;border-radius:8px;margin:16px 0;">`
  )
}

function stripToPlainText(html) {
  return imgTagsToMarkdown(String(html ?? ''))
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<figcaption[\s\S]*?<\/figcaption>/gi, ' ')
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n\n## $1\n')
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n\n### $1\n')
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '\n- $1')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

async function callAi(messages) {
  const res = await fetch(AI_ENDPOINT, {
    method: 'POST',
    signal: AbortSignal.timeout(AI_REWRITE_TIMEOUT_MS),
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${AI_API_KEY}`,
    },
    body: JSON.stringify({
      model: AI_MODEL,
      messages,
      temperature: 0.35,
      max_tokens: 8192,
    }),
  })
  if (!res.ok) {
    const err = await res.text().catch(() => '')
    throw new Error(`AI API error ${res.status}: ${err}`)
  }
  const data = await res.json()
  return data.choices?.[0]?.message?.content || ''
}

function extractJson(text) {
  let cleaned = String(text ?? '')
    .replace(/<think[\s\S]*?<\/think>/gi, '')
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  try {
    return JSON.parse(cleaned.slice(start, end + 1))
  } catch {
    return null
  }
}

function buildSourceFooter(canonicalUrl) {
  if (!canonicalUrl) return ''
  return `\n<p>이 글의 원본과 더 많은 자료는 <a href="${canonicalUrl}">비오케이솔루션 블로그</a>에서 확인하실 수 있습니다.</p>`
}

const FORBIDDEN_NAVER_TONE = [
  '꿀팁',
  '환장',
  '대박',
  '지옥',
  '끝판왕',
  '무조건',
  '충격',
  '실화',
  '발업',
  'ㅋㅋ',
  'ㅎㅎ',
  '😅',
  '🔥',
  '✨',
]

function hasForbiddenTone(text) {
  const value = String(text ?? '')
  return FORBIDDEN_NAVER_TONE.some((word) => value.includes(word))
}

function hasHanzi(text) {
  return HANZI_RE.test(String(text ?? ''))
}

function hasEnoughRichStructure(html) {
  const value = String(html ?? '')
  const headings = (value.match(/<h2\b/gi) || []).length
  const lists = (value.match(/<(ul|ol)\b/gi) || []).length
  const listItems = (value.match(/<li\b/gi) || []).length
  const tables = (value.match(/<table\b/gi) || []).length
  const callouts = (value.match(/<blockquote\b/gi) || []).length
  const bolds = (value.match(/<strong\b/gi) || []).length
  return headings >= 3 && lists >= 1 && listItems >= 3 && (tables + callouts + bolds) >= 2
}

function hasTistorySemanticRisk(text) {
  const value = String(text ?? '').replace(/\s+/g, ' ')
  const riskyPatterns = [
    /핵심은\s*단순히[^.?!]{0,80}기능에\s*있(?:습니다|다)/,
    /중요한\s*것은\s*단순히[^.?!]{0,80}기능에\s*있(?:습니다|다)/,
    /목적은\s*단순히[^.?!]{0,80}기능에\s*있(?:습니다|다)/,
  ]
  return riskyPatterns.some((pattern) => pattern.test(value))
}

function sanitizeAllowedHtml(html) {
  return String(html ?? '')
    .replace(/<\/?(?:s|strike|del)\b[^>]*>/gi, '')
    .replace(/\sstyle=["'][^"']*text-decoration\s*:\s*(?:line-through|line-through[^;"']*)[^"']*["']/gi, '')
}

/**
 * 채널용으로 글을 재작성한다.
 * @param {{ title: string, html: string, channel: 'naver'|'tistory', canonicalUrl?: string }} params
 * @returns {Promise<{ title: string, html: string, rewritten: boolean }>}
 */
async function rewriteForChannel({ title, html, channel, canonicalUrl = '' }) {
  const fallback = {
    title,
    // 폴백(재작성 미수행)에서도 마크다운 이미지는 <img>로 복원해 소실 방지
    html: `${markdownImagesToHtml(html)}${buildSourceFooter(canonicalUrl)}`,
    rewritten: false,
  }

  if (!REWRITE_ENABLED || !AI_API_KEY) return fallback
  const guide = CHANNEL_GUIDES[channel]
  if (!guide) return fallback

  const plainText = stripToPlainText(html)
  if (plainText.length < 200) return fallback

  const systemPrompt = `당신은 한국어 블로그 콘텐츠 재작성 전문가입니다.
주어진 글과 같은 주제·같은 사실관계를 유지하되, 완전히 다른 글처럼 보이도록 재작성합니다.

절대 규칙:
- 문장, 문단 구성, 소제목, 표현을 원문과 70% 이상 다르게 작성 (단순 동의어 치환 금지)
- 원문에 없는 사실, 수치, 통계를 만들어내지 말 것
- 분량은 원문의 80~120% 수준 유지
- 허용 태그: h2, h3, p, ul, ol, li, strong, blockquote, img 사용 (인라인 스타일, class 금지)
- 티스토리는 table, thead, tbody, tr, th, td 태그도 허용
- 본문의 이미지 마크다운 ![설명](url) 은 src/alt를 변경·삭제하지 말고 자연스러운 위치에 그대로 유지할 것 (재작성된 흐름에 맞게 위치만 조정 가능)
- 오직 한국어 한글로만 작성. 중국어 간체/번체·한자 혼입 금지
- 반드시 JSON만 출력: { "title": "...", "html": "..." }

${guide}`

  try {
    const response = await callAi([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `원래 제목: ${title}\n\n원문:\n${plainText}` },
    ])
    const parsed = extractJson(response)
    const newTitle = typeof parsed?.title === 'string' && parsed.title.trim() ? parsed.title.trim() : title
    let newHtml = typeof parsed?.html === 'string' && parsed.html.trim() ? parsed.html.trim() : ''
    if (!newHtml || stripToPlainText(newHtml).length < plainText.length * 0.5) {
      console.warn(`[channel-rewriter] ${channel} 재작성 결과가 비정상적으로 짧아 원문 사용`)
      return fallback
    }
    if (channel === 'naver' && hasForbiddenTone(`${newTitle}\n${stripToPlainText(newHtml)}`)) {
      console.warn('[channel-rewriter] naver 재작성 톤이 운영 기준에 맞지 않아 원문 사용')
      return fallback
    }
    if (hasHanzi(`${newTitle}\n${stripToPlainText(newHtml)}`)) {
      console.warn(`[channel-rewriter] ${channel} 재작성 결과에 한자/중문자가 섞여 원문 사용`)
      return fallback
    }
    if (channel === 'tistory') {
      if (hasForbiddenTone(`${newTitle}\n${stripToPlainText(newHtml)}`)) {
        console.warn('[channel-rewriter] tistory 재작성 톤이 운영 기준에 맞지 않아 원문 사용')
        return fallback
      }
      if (!hasEnoughRichStructure(newHtml)) {
        console.warn('[channel-rewriter] tistory 재작성 구조가 부족해 원문 사용')
        return fallback
      }
      if (hasTistorySemanticRisk(`${newTitle}\n${stripToPlainText(newHtml)}`)) {
        console.warn('[channel-rewriter] tistory 재작성 의미 반전 위험 문장이 있어 원문 사용')
        return fallback
      }
    }
    // 모델이 마크다운으로 남긴 이미지를 <img>로 복원(어댑터가 인식하도록)
    newHtml = markdownImagesToHtml(sanitizeAllowedHtml(newHtml))
    return {
      title: newTitle,
      html: `${newHtml}${buildSourceFooter(canonicalUrl)}`,
      rewritten: true,
    }
  } catch (e) {
    console.warn(`[channel-rewriter] ${channel} 재작성 실패, 원문 사용: ${e.message}`)
    return fallback
  }
}

export { rewriteForChannel }
