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
    primary: '#172033',
    secondary: '#26364f',
    accent: '#176b87',
    point: '#d45b3f',
    bg: '#ffffff',
    text: '#20242a',
    textLight: '#5f6875',
    border: '#d8dee8',
    highlight: '#f6f8fb',
    soft: '#fff7ed',
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
- 첫 문단 또는 "결론 요약" 성격의 문단은 요약 카드처럼 border/padding/background를 주어 강조
- h2: 왼쪽에 4px ${DESIGN_SYSTEM.colors.point} 보더, padding-left 16px, 배경 ${DESIGN_SYSTEM.colors.highlight}, font-size ${DESIGN_SYSTEM.fonts.h2}, font-weight 700, margin-top 36px, border-radius 8px
- h3: font-size ${DESIGN_SYSTEM.fonts.h3}, font-weight 700, color ${DESIGN_SYSTEM.colors.accent}, border-bottom 1px solid ${DESIGN_SYSTEM.colors.border}
- p: font-size ${DESIGN_SYSTEM.fonts.body}, line-height ${DESIGN_SYSTEM.fonts.lineHeight}, color ${DESIGN_SYSTEM.colors.text}, margin-bottom 16px
- strong: color ${DESIGN_SYSTEM.colors.point}, font-weight 700
- a: color ${DESIGN_SYSTEM.colors.accent}, text-decoration underline
- ul/ol: padding-left 24px, margin 14px 0 18px, background ${DESIGN_SYSTEM.colors.highlight}, border 1px solid ${DESIGN_SYSTEM.colors.border}, border-radius 10px, padding-top 14px, padding-bottom 14px
- li: margin-bottom 6px, line-height 1.7
- table: width 100%, border-collapse collapse, margin 20px 0
- th: background ${DESIGN_SYSTEM.colors.accent}, color white, padding 10px 14px, font-size 13px
- td: padding 10px 14px, border-bottom 1px solid ${DESIGN_SYSTEM.colors.border}, font-size 14px
- 짝수 tr: background #f8f9fa
- img: max-width 100%, border-radius 8px, margin 16px 0
- blockquote: margin 20px 0, padding 16px 18px, border-left 4px solid ${DESIGN_SYSTEM.colors.point}, background ${DESIGN_SYSTEM.colors.soft}, color ${DESIGN_SYSTEM.colors.text}
- hr: border none, border-top 1px solid ${DESIGN_SYSTEM.colors.border}, margin 32px 0
- CTA 버튼: display inline-block, background ${DESIGN_SYSTEM.colors.point}, color white, padding 12px 28px, border-radius 6px, text-decoration none, font-weight 600
- 마지막 문의/상담 문단은 CTA 박스처럼 background ${DESIGN_SYSTEM.colors.primary}, color white, padding 18px, border-radius 12px로 처리
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
  out = out.replace(/<h2\b([^>]*)>/gi, `<h2$1 style="margin:36px 0 14px;padding:12px 16px;border-left:4px solid ${DESIGN_SYSTEM.colors.point};border-radius:8px;background:${DESIGN_SYSTEM.colors.highlight};font-size:${DESIGN_SYSTEM.fonts.h2};line-height:1.45;color:${DESIGN_SYSTEM.colors.primary};font-weight:700;">`)
  out = out.replace(/<h3\b([^>]*)>/gi, `<h3$1 style="margin:26px 0 12px;padding-bottom:8px;border-bottom:1px solid ${DESIGN_SYSTEM.colors.border};font-size:${DESIGN_SYSTEM.fonts.h3};line-height:1.5;color:${DESIGN_SYSTEM.colors.accent};font-weight:700;">`)
  out = out.replace(/<p\b([^>]*)>/gi, `<p$1 style="margin:0 0 16px;font-size:${DESIGN_SYSTEM.fonts.body};line-height:${DESIGN_SYSTEM.fonts.lineHeight};color:${DESIGN_SYSTEM.colors.text};">`)
  out = out.replace(/<strong\b([^>]*)>/gi, `<strong$1 style="color:${DESIGN_SYSTEM.colors.point};font-weight:700;">`)
  out = out.replace(/<ul\b([^>]*)>/gi, `<ul$1 style="margin:16px 0 20px;padding:14px 18px 14px 34px;border:1px solid ${DESIGN_SYSTEM.colors.border};border-radius:10px;background:${DESIGN_SYSTEM.colors.highlight};">`)
  out = out.replace(/<ol\b([^>]*)>/gi, `<ol$1 style="margin:16px 0 20px;padding:14px 18px 14px 34px;border:1px solid ${DESIGN_SYSTEM.colors.border};border-radius:10px;background:${DESIGN_SYSTEM.colors.highlight};">`)
  out = out.replace(/<li\b([^>]*)>/gi, `<li$1 style="margin:0 0 8px;line-height:1.75;color:${DESIGN_SYSTEM.colors.text};">`)
  out = out.replace(/<blockquote\b([^>]*)>/gi, `<blockquote$1 style="margin:20px 0;padding:16px 18px;border-left:4px solid ${DESIGN_SYSTEM.colors.point};border-radius:8px;background:${DESIGN_SYSTEM.colors.soft};color:${DESIGN_SYSTEM.colors.text};">`)
  out = out.replace(/<table\b([^>]*)>/gi, `<table$1 style="width:100%;border-collapse:collapse;margin:22px 0;font-size:14px;">`)
  out = out.replace(/<th\b([^>]*)>/gi, `<th$1 style="padding:11px 12px;background:${DESIGN_SYSTEM.colors.accent};color:#fff;border:1px solid ${DESIGN_SYSTEM.colors.accent};text-align:left;">`)
  out = out.replace(/<td\b([^>]*)>/gi, `<td$1 style="padding:11px 12px;border:1px solid ${DESIGN_SYSTEM.colors.border};color:${DESIGN_SYSTEM.colors.text};">`)
  out = out.replace(/<img\b([^>]*)>/gi, `<img$1 style="max-width:100%;height:auto;border-radius:10px;margin:18px 0;">`)
  return out.trim()
}

export { convertForTistory }
