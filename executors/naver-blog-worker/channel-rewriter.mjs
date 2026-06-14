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

const CHANNEL_GUIDES = {
  naver: `네이버 블로그 독자 특성에 맞게 재작성:
- 검색자가 친근하게 읽을 수 있는 경험담/대화형 문체 (존댓말, "~인데요", "~하시면 좋아요" 톤)
- 문단을 짧게 끊어 모바일에서 읽기 쉽게
- 네이버 검색 사용자가 입력할 법한 표현을 소제목에 반영
- 제목도 네이버 검색 클릭을 유도하는 형태로 새로 작성 (원래 제목과 다르게)`,
  tistory: `티스토리 블로그 독자 특성에 맞게 재작성:
- 정보 정리형 문체, 핵심을 표/목록으로 구조화
- 구글 검색 유입을 고려한 명확한 소제목
- 제목도 원래 제목과 다르게 새로 작성`,
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
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${AI_API_KEY}`,
    },
    body: JSON.stringify({
      model: AI_MODEL,
      messages,
      temperature: 0.7,
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
  return `\n<p>이 글의 원본과 더 많은 자료는 <a href="${canonicalUrl}">홍커뮤니케이션 블로그</a>에서 확인하실 수 있습니다.</p>`
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
- 본문의 이미지 마크다운 ![설명](url) 은 src/alt를 변경·삭제하지 말고 자연스러운 위치에 그대로 유지할 것 (재작성된 흐름에 맞게 위치만 조정 가능)
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
    // 모델이 마크다운으로 남긴 이미지를 <img>로 복원(어댑터가 인식하도록)
    newHtml = markdownImagesToHtml(newHtml)
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
