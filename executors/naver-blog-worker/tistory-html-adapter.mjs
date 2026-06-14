import 'dotenv/config'

const AI_API_KEY = process.env.AI_API_KEY || ''
const AI_MODEL = process.env.AI_MODEL || 'glm-5.1'
const AI_ENDPOINT = 'https://api.z.ai/api/coding/paas/v4/chat/completions'
const AI_DESIGN_ENABLED = process.env.TISTORY_AI_DESIGN === 'true'
const TISTORY_AI_THINKING = process.env.TISTORY_AI_THINKING === 'true'

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
      thinking: { type: TISTORY_AI_THINKING ? 'enabled' : 'disabled' },
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

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function inlineMarkdown(text) {
  return escapeHtml(text)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
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
  if (!AI_API_KEY || !AI_DESIGN_ENABLED) {
    return convertForTistoryFallback(html)
  }

  const text = stripHtmlToStructured(html)

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `다음 텍스트를 HTML로 변환하세요. 모든 내용을 그대로 유지하세요:\n\n${text}` },
  ]

  try {
    const response = await callAi(messages)
    return normalizeTistoryHtml(extractHtmlFromResponse(response))
  } catch (e) {
    console.error(`[tistory-html-adapter] AI 변환 실패, fallback 사용: ${e.message}`)
    return convertForTistoryFallback(html)
  }
}

function markdownToHtml(markdown) {
  const source = String(markdown ?? '')
  const hasStructuralHtml = /<(h2|h3|p|ul|ol|li|blockquote|table|img)\b/i.test(source)
  const hasMarkdownBlocks = /(^|\n)\s*(#{2,3}\s+|[-*]\s+|\d+\.\s+|>\s+|\|.+\||!\[[^\]]*\]\([^)\s]+\))/m.test(source)
  if (hasStructuralHtml && !hasMarkdownBlocks) return source

  const lines = source.split(/\r?\n/)
  const out = []
  let paragraph = []
  let listType = ''
  let tableRows = []

  const closeParagraph = () => {
    if (!paragraph.length) return
    out.push(`<p>${inlineMarkdown(paragraph.join(' '))}</p>`)
    paragraph = []
  }
  const closeList = () => {
    if (!listType) return
    out.push(`</${listType}>`)
    listType = ''
  }
  const closeTable = () => {
    if (!tableRows.length) return
    const rows = tableRows
      .filter((row) => !/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(row))
      .map((row, index) => {
        const cells = row.replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim())
        const tag = index === 0 ? 'th' : 'td'
        return `<tr>${cells.map((cell) => `<${tag}>${inlineMarkdown(cell)}</${tag}>`).join('')}</tr>`
      })
      .join('')
    if (rows) out.push(`<table><tbody>${rows}</tbody></table>`)
    tableRows = []
  }
  const openList = (type) => {
    closeParagraph()
    closeTable()
    if (listType === type) return
    closeList()
    listType = type
    out.push(`<${type}>`)
  }

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) {
      closeParagraph()
      closeList()
      closeTable()
      continue
    }
    if (/^<p\b[\s\S]*<\/p>$/i.test(line) || /^<img\b/i.test(line) || /^<blockquote\b/i.test(line)) {
      closeParagraph()
      closeList()
      closeTable()
      out.push(line)
      continue
    }
    if (/^\|.+\|$/.test(line)) {
      closeParagraph()
      closeList()
      tableRows.push(line)
      continue
    }
    closeTable()
    const image = line.match(/^!\[([^\]]*)\]\(([^)\s]+)\)$/)
    if (image) {
      closeParagraph()
      closeList()
      out.push(`<img src="${escapeHtml(image[2])}" alt="${escapeHtml(image[1])}">`)
      continue
    }
    const h2 = line.match(/^##\s+(.+)$/)
    if (h2) {
      closeParagraph()
      closeList()
      out.push(`<h2>${inlineMarkdown(h2[1])}</h2>`)
      continue
    }
    const h3 = line.match(/^###\s+(.+)$/)
    if (h3) {
      closeParagraph()
      closeList()
      out.push(`<h3>${inlineMarkdown(h3[1])}</h3>`)
      continue
    }
    const quote = line.match(/^>\s+(.+)$/)
    if (quote) {
      closeParagraph()
      closeList()
      out.push(`<blockquote>${inlineMarkdown(quote[1])}</blockquote>`)
      continue
    }
    const bullet = line.match(/^[-*]\s+(.+)$/)
    if (bullet) {
      openList('ul')
      const checked = bullet[1].match(/^\[([ xX])\]\s+(.+)$/)
      const text = checked ? `${checked[1].toLowerCase() === 'x' ? '✓ ' : ''}${checked[2]}` : bullet[1]
      out.push(`<li>${inlineMarkdown(text)}</li>`)
      continue
    }
    const numbered = line.match(/^\d+\.\s+(.+)$/)
    if (numbered) {
      openList('ol')
      out.push(`<li>${inlineMarkdown(numbered[1])}</li>`)
      continue
    }
    paragraph.push(line)
  }
  closeParagraph()
  closeList()
  closeTable()
  return out.join('\n')
}

function sanitizeHtml(html) {
  return String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<\/?(?:s|strike|del)\b[^>]*>/gi, '')
    .replace(/\sclass=["'][^"']*["']/gi, '')
    .replace(/\son\w+=["'][^"']*["']/gi, '')
    .replace(/javascript:/gi, '')
}

function addOrMergeStyle(html, tagName, style) {
  const regex = new RegExp(`<${tagName}\\b([^>]*)>`, 'gi')
  return html.replace(regex, (match, attrs) => {
    if (/style=["'][^"']*["']/i.test(attrs)) {
      return match.replace(/style=["']([^"']*)["']/i, (_m, existing) => `style="${existing};${style}"`)
    }
    return `<${tagName}${attrs} style="${style}">`
  })
}

function normalizeTistoryHtml(html) {
  let out = sanitizeHtml(markdownToHtml(html))
  const styles = {
    h2: `margin:38px 0 16px;padding:14px 18px;border-left:5px solid ${DESIGN_SYSTEM.colors.point};border-radius:10px;background:${DESIGN_SYSTEM.colors.highlight};font-size:${DESIGN_SYSTEM.fonts.h2};line-height:1.45;color:${DESIGN_SYSTEM.colors.primary};font-weight:800;`,
    h3: `margin:28px 0 12px;padding-bottom:8px;border-bottom:1px solid ${DESIGN_SYSTEM.colors.border};font-size:${DESIGN_SYSTEM.fonts.h3};line-height:1.5;color:${DESIGN_SYSTEM.colors.accent};font-weight:800;`,
    p: `margin:0 0 16px;font-size:${DESIGN_SYSTEM.fonts.body};line-height:${DESIGN_SYSTEM.fonts.lineHeight};color:${DESIGN_SYSTEM.colors.text};`,
    strong: `color:${DESIGN_SYSTEM.colors.point};font-weight:800;`,
    a: `color:${DESIGN_SYSTEM.colors.accent};text-decoration:underline;`,
    ul: `margin:16px 0 22px;padding:16px 20px 16px 36px;border:1px solid ${DESIGN_SYSTEM.colors.border};border-radius:12px;background:${DESIGN_SYSTEM.colors.highlight};`,
    ol: `margin:16px 0 22px;padding:16px 20px 16px 36px;border:1px solid ${DESIGN_SYSTEM.colors.border};border-radius:12px;background:${DESIGN_SYSTEM.colors.highlight};`,
    li: `margin:0 0 8px;line-height:1.75;color:${DESIGN_SYSTEM.colors.text};`,
    blockquote: `margin:22px 0;padding:16px 18px;border-left:5px solid ${DESIGN_SYSTEM.colors.point};border-radius:10px;background:${DESIGN_SYSTEM.colors.soft};color:${DESIGN_SYSTEM.colors.text};`,
    table: `width:100%;border-collapse:collapse;margin:24px 0;font-size:14px;`,
    th: `padding:12px 14px;background:${DESIGN_SYSTEM.colors.accent};color:#fff;border:1px solid ${DESIGN_SYSTEM.colors.accent};text-align:left;`,
    td: `padding:12px 14px;border:1px solid ${DESIGN_SYSTEM.colors.border};color:${DESIGN_SYSTEM.colors.text};vertical-align:top;`,
    img: `max-width:100%;height:auto;border-radius:12px;margin:20px 0;`,
  }
  for (const [tag, style] of Object.entries(styles)) {
    out = addOrMergeStyle(out, tag, style)
  }
  out = out.replace(/(<h2\b[^>]*>[\s\S]*?<\/h2>)/i, '<section style="margin:0 0 28px;padding:18px 20px;border:1px solid #d8dee8;border-radius:14px;background:#f6f8fb;">$1</section>')
  out = ensureTistoryLeadSummary(out)
  out = ensureTistoryCta(out)
  return out.trim()
}

function plainTextFromHtml(html) {
  return String(html ?? '')
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

function hasLeadSummaryText(html) {
  return /핵심\s*요약|요약|먼저\s*확인|결론부터/i.test(plainTextFromHtml(html).slice(0, 700))
}

function hasCtaText(html) {
  return /상담|문의|운영\s*상담/i.test(plainTextFromHtml(html).slice(-900))
}

function extractFirstSentences(html, max = 3) {
  const text = plainTextFromHtml(html)
  const sentences = text
    .split(/(?<=[.!?。]|다\.|요\.|니다\.)\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 20)
  const picked = sentences.slice(0, max)
  if (picked.length) return picked
  return text ? [text.slice(0, 180)] : []
}

function ensureTistoryLeadSummary(html) {
  if (!html.trim() || hasLeadSummaryText(html)) return html
  const bullets = extractFirstSentences(html, 3)
  if (!bullets.length) return html
  const items = bullets
    .map((line) => `<li style="margin:0 0 8px;line-height:1.75;color:${DESIGN_SYSTEM.colors.text};">${escapeHtml(line)}</li>`)
    .join('')
  const summary = [
    `<section style="margin:0 0 26px;padding:18px 20px;border:1px solid ${DESIGN_SYSTEM.colors.border};border-radius:14px;background:${DESIGN_SYSTEM.colors.highlight};">`,
    `<p style="margin:0 0 10px;font-size:15px;line-height:1.7;color:${DESIGN_SYSTEM.colors.primary};font-weight:800;">먼저 확인할 핵심 요약</p>`,
    `<ul style="margin:0;padding:0 0 0 20px;">${items}</ul>`,
    `</section>`,
  ].join('')
  return `${summary}\n${html}`
}

function ensureTistoryCta(html) {
  if (!html.trim() || hasCtaText(html)) return html
  const cta = [
    `<section style="margin:34px 0 0;padding:20px 22px;border-radius:14px;background:${DESIGN_SYSTEM.colors.primary};color:#fff;">`,
    `<p style="margin:0 0 8px;font-size:16px;line-height:1.7;color:#fff;font-weight:800;">운영 환경 점검이 필요하신가요?</p>`,
    `<p style="margin:0;font-size:15px;line-height:1.8;color:#fff;">홈페이지 구축, 보안 설정, 신청폼 연동처럼 실제 운영에 연결되는 작업은 비오케이솔루션에 문의해 현재 상황에 맞는 점검을 받아보실 수 있습니다.</p>`,
    `</section>`,
  ].join('')
  return `${html}\n${cta}`
}

function tistoryHtmlQuality(html) {
  const value = String(html ?? '')
  const text = plainTextFromHtml(value)
  return {
    chars: text.length,
    headings: (value.match(/<h[23]\b/gi) || []).length,
    lists: (value.match(/<(ul|ol)\b/gi) || []).length,
    listItems: (value.match(/<li\b/gi) || []).length,
    tables: (value.match(/<table\b/gi) || []).length,
    callouts: (value.match(/<blockquote\b/gi) || []).length,
    images: (value.match(/<img\b/gi) || []).length,
    bolds: (value.match(/<strong\b/gi) || []).length,
    hasLeadSummary: /핵심\s*요약|요약|먼저\s*확인|결론부터/i.test(text.slice(0, 700)),
    hasCta: /상담|문의|운영\s*상담/i.test(text.slice(-900)),
  }
}

function validateTistoryHtml(html) {
  const quality = tistoryHtmlQuality(html)
  const reasons = []
  if (quality.chars < 1000) reasons.push(`본문 짧음(${quality.chars}자)`)
  if (quality.headings < 3) reasons.push(`소제목 부족(${quality.headings})`)
  if (quality.listItems < 4) reasons.push(`목록 부족(${quality.listItems})`)
  if ((quality.tables + quality.callouts) < 1) {
    reasons.push('표 또는 콜아웃 없음')
  }
  if ((quality.tables + quality.callouts + quality.images + quality.bolds) < 3) {
    reasons.push('표/콜아웃/이미지/강조 구조 부족')
  }
  if (!quality.hasLeadSummary) reasons.push('첫머리 요약 없음')
  if (!quality.hasCta) reasons.push('상담 CTA 없음')
  return { ok: reasons.length === 0, reasons, quality }
}

function convertForTistoryFallback(html) {
  return normalizeTistoryHtml(html)
}

export { convertForTistory, validateTistoryHtml }
