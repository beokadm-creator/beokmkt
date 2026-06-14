import 'dotenv/config'

const AI_API_KEY = process.env.AI_API_KEY || ''
const AI_MODEL = process.env.AI_MODEL || 'glm-5.1'
const AI_ENDPOINT = 'https://api.z.ai/api/coding/paas/v4/chat/completions'

function stripHtmlToStructured(html) {
  const blocks = []
  let remaining = html

  remaining = remaining.replace(/<script[\s\S]*?<\/script>/gi, '')
  remaining = remaining.replace(/<style[\s\S]*?<\/style>/gi, '')

  const patterns = [
    { regex: /<h1[^>]*>([\s\S]*?)<\/h1>/gi, tag: 'h1' },
    { regex: /<h2[^>]*>([\s\S]*?)<\/h2>/gi, tag: 'h2' },
    { regex: /<h3[^>]*>([\s\S]*?)<\/h3>/gi, tag: 'h3' },
    { regex: /<h4[^>]*>([\s\S]*?)<\/h4>/gi, tag: 'h4' },
    { regex: /<li[^>]*>([\s\S]*?)<\/li>/gi, tag: 'li' },
    { regex: /<p[^>]*>([\s\S]*?)<\/p>/gi, tag: 'p' },
    { regex: /<td[^>]*>([\s\S]*?)<\/td>/gi, tag: 'td' },
    { regex: /<th[^>]*>([\s\S]*?)<\/th>/gi, tag: 'th' },
    { regex: /<figcaption[^>]*>([\s\S]*?)<\/figcaption>/gi, tag: 'caption' },
    { regex: /<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, tag: 'a' },
    { regex: /<strong[^>]*>([\s\S]*?)<\/strong>/gi, tag: 'strong' },
    { regex: /<img[^>]*src="([^"]*)"[^>]*(?:alt="([^"]*)")?[^>]*\/?>/gi, tag: 'img' },
  ]

  const tagPositions = []
  for (const { regex, tag } of patterns) {
    let m
    while ((m = regex.exec(remaining)) !== null) {
      const text = m.slice(1).filter(Boolean).join(' ').replace(/<[^>]+>/g, '').trim()
      if (text || tag === 'img') {
        tagPositions.push({ index: m.index, tag, text, raw: m[0] })
      }
    }
  }

  tagPositions.sort((a, b) => a.index - b.index)
  for (const tp of tagPositions) {
    blocks.push({ tag: tp.tag, text: tp.text, raw: tp.raw })
  }

  if (blocks.length === 0) {
    const text = remaining
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
    return text
  }

  return blocks.map(b => {
    if (b.tag === 'img') {
      // 이미지를 텍스트 마커가 아니라 실제 <img>로 보존(원본 src/alt 유지)
      const src = (String(b.raw || '').match(/src=["']([^"']+)["']/i) || [])[1] || ''
      const alt = (String(b.raw || '').match(/alt=["']([^"']*)["']/i) || [])[1] || ''
      return src ? `<img src="${src}" alt="${alt}">` : ''
    }
    if (b.tag === 'a') return `${b.text}`
    return b.text
  }).filter(t => t).join('\n')
}

async function callAi(messages) {
  const res = await fetch(AI_ENDPOINT, {
    method: 'POST',
    signal: AbortSignal.timeout(90000),
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${AI_API_KEY}`,
    },
    body: JSON.stringify({
      model: AI_MODEL,
      messages,
      temperature: 0.2,
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

function extractHtmlFromResponse(text) {
  let cleaned = text
  cleaned = cleaned.replace(/<think[\s\S]*?<\/think>/gi, '')
  cleaned = cleaned.replace(/```html\s*/gi, '')
  cleaned = cleaned.replace(/```\s*/g, '')
  if (cleaned.includes('<') && cleaned.includes('>')) {
    const start = cleaned.indexOf('<')
    const end = cleaned.lastIndexOf('>') + 1
    if (start > 0) cleaned = cleaned.slice(start)
    if (end < cleaned.length) cleaned = cleaned.slice(0, end)
  }
  return cleaned.trim()
}

const DESIGN_SYSTEM = {
  colors: {
    primary: '#1a1a2e',
    secondary: '#16213e',
    accent: '#0f3460',
    point: '#e94560',
    bg: '#ffffff',
    text: '#2d2d2d',
    textLight: '#666666',
    border: '#e0e0e0',
    highlight: '#fff3e0',
  },
  fonts: {
    body: '15px',
    lineHeight: '1.8',
    h2: '22px',
    h3: '18px',
  },
}

const SYSTEM_PROMPT = `당신은 HTML 디자이너입니다. 주어진 블로그 글 텍스트를 티스토리 블로그용 HTML로 변환하세요.

절대 규칙:
- 원문의 모든 텍스트를 한 글자도 빠뜨리지 말고 그대로 유지할 것
- 내용 추가, 삭제, 요약, 재작성 절대 금지
- 오직 HTML 태그와 style 속성만 추가할 것
- thinking이나 설명 텍스트 없이 HTML 코드만 출력할 것

디자인 규칙:
- 모든 스타일은 인라인 style 속성으로 작성
- h2: 왼쪽에 4px ${DESIGN_SYSTEM.colors.point} 보더, padding-left 16px, 배경 ${DESIGN_SYSTEM.colors.highlight}, font-size ${DESIGN_SYSTEM.fonts.h2}, font-weight 700, margin-top 32px
- h3: font-size ${DESIGN_SYSTEM.fonts.h3}, font-weight 600, color ${DESIGN_SYSTEM.colors.accent}, border-bottom 1px solid ${DESIGN_SYSTEM.colors.border}
- p: font-size ${DESIGN_SYSTEM.fonts.body}, line-height ${DESIGN_SYSTEM.fonts.lineHeight}, color ${DESIGN_SYSTEM.colors.text}, margin-bottom 16px
- strong: color ${DESIGN_SYSTEM.colors.point}, font-weight 700
- a: color ${DESIGN_SYSTEM.colors.accent}, text-decoration underline
- ul/ol: padding-left 24px, margin-bottom 16px
- li: margin-bottom 6px, line-height 1.7
- table: width 100%, border-collapse collapse, margin 20px 0
- th: background ${DESIGN_SYSTEM.colors.accent}, color white, padding 10px 14px, font-size 13px
- td: padding 10px 14px, border-bottom 1px solid ${DESIGN_SYSTEM.colors.border}, font-size 14px
- 짝수 tr: background #f8f9fa
- img: max-width 100%, border-radius 8px, margin 16px 0
- hr: border none, border-top 1px solid ${DESIGN_SYSTEM.colors.border}, margin 32px 0
- CTA 버튼: display inline-block, background ${DESIGN_SYSTEM.colors.point}, color white, padding 12px 28px, border-radius 6px, text-decoration none, font-weight 600
- <html>, <head>, <body> 태그 금지, 본문 fragment만 출력`

async function convertForTistory(html) {
  if (!html || typeof html !== 'string') return ''
  if (!AI_API_KEY) {
    return convertForTistoryFallback(html)
  }

  const text = stripHtmlToStructured(html)

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `다음 텍스트를 HTML로 변환하세요. 모든 내용을 그대로 유지하세요:\n\n${text}` },
  ]

  try {
    const response = await callAi(messages)
    return extractHtmlFromResponse(response)
  } catch (e) {
    console.error(`[tistory-html-adapter] AI 변환 실패, fallback 사용: ${e.message}`)
    return convertForTistoryFallback(html)
  }
}

function convertForTistoryFallback(html) {
  let out = html
  out = out.replace(/<script[\s\S]*?<\/script>/gi, '')
  out = out.replace(/<style[\s\S]*?<\/style>/gi, '')
  out = out.replace(/ class="[^"]*"/gi, '')
  out = out.replace(/ class='[^']*'/gi, '')
  return out.trim()
}

export { convertForTistory }
