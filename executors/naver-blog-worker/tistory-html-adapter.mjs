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
    .replace(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g, '<img src="$2" alt="$1">')
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
    .replace(/([^\n])(!\[[^\]]*]\(https?:\/\/[^)\s]+\))/g, '$1\n$2')
    .replace(/(!\[[^\]]*]\(https?:\/\/[^)\s]+\))([^\n])/g, '$1\n$2')
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
  out = ensureTistoryDecisionChecklist(out)
  out = ensureTistoryServiceProof(out)
  out = ensureTistoryOperationFlow(out)
  out = ensureTistoryOpsComparison(out)
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

function hasDecisionChecklist(html) {
  return /운영\s*체크포인트|실행\s*체크|판단\s*기준/i.test(plainTextFromHtml(html))
}

function isConferenceBadgeContent(html) {
  return /학회|명찰|사무국|참가자|재발행|접수대/.test(plainTextFromHtml(html))
}

function hasServiceProof(html) {
  const text = plainTextFromHtml(html)
  return /실무\s*점검\s*범위/.test(text) || (/데이터\s*검수/.test(text) && /사후\s*정리/.test(text))
}

function hasOperationFlow(html) {
  const text = plainTextFromHtml(html)
  return /사무국\s*운영\s*흐름|명찰\s*발행은\s*데이터\s*확정부터/.test(text)
}

function hasOpsComparison(html) {
  const text = plainTextFromHtml(html)
  return /현장\s*혼잡을\s*줄이는\s*운영\s*기준\s*비교|흔한\s*문제\s*권장\s*기준/.test(text)
}

function extractHeadingTexts(html, max = 4) {
  const headings = []
  const regex = /<h[23]\b[^>]*>([\s\S]*?)<\/h[23]>/gi
  let match
  while ((match = regex.exec(String(html ?? ''))) !== null && headings.length < max) {
    const text = plainTextFromHtml(match[1])
    if (text && !/핵심\s*요약|운영\s*체크포인트/i.test(text)) headings.push(text)
  }
  return headings
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

function ensureTistoryDecisionChecklist(html) {
  if (!html.trim() || hasDecisionChecklist(html)) return html
  const headings = extractHeadingTexts(html, 4)
  if (headings.length < 2) return html
  const items = headings
    .map((heading) => `<li style="margin:0 0 8px;line-height:1.75;color:${DESIGN_SYSTEM.colors.text};"><strong style="color:${DESIGN_SYSTEM.colors.point};font-weight:800;">${escapeHtml(heading)}</strong> 기준을 실제 운영 전에 확인합니다.</li>`)
    .join('')
  const checklist = [
    `<section style="margin:26px 0;padding:18px 20px;border:1px solid ${DESIGN_SYSTEM.colors.border};border-radius:14px;background:#ffffff;">`,
    `<p style="margin:0 0 10px;font-size:15px;line-height:1.7;color:${DESIGN_SYSTEM.colors.primary};font-weight:800;">운영 체크포인트</p>`,
    `<ul style="margin:0;padding:0 0 0 20px;">${items}</ul>`,
    `</section>`,
  ].join('')
  return `${html}\n${checklist}`
}

function ensureTistoryServiceProof(html) {
  if (!html.trim() || !isConferenceBadgeContent(html) || hasServiceProof(html)) return html
  const items = [
    ['데이터 검수', '참가자 이름, 소속, 역할, 등록 구분, 식별 코드를 출력 전 기준 파일로 정리합니다.'],
    ['출력 기준', '명찰 크기, 줄바꿈, QR·바코드 인식, 여분 수량을 샘플 출력으로 확인합니다.'],
    ['현장 재발행', '오탈자, 역할 변경, 분실 요청을 승인 기준과 출력 기록으로 나누어 처리합니다.'],
    ['사후 정리', '미수령자, 현장 등록자, 변경 요청 기록을 행사 종료 후 정산 자료와 맞춥니다.'],
  ]
  const rows = items.map(([title, desc]) => [
    `<li style="margin:0;padding:12px 14px;border:1px solid ${DESIGN_SYSTEM.colors.border};border-radius:10px;background:#ffffff;">`,
    `<strong style="display:block;margin:0 0 4px;color:${DESIGN_SYSTEM.colors.primary};font-weight:800;">${title}</strong>`,
    `<span style="display:block;color:${DESIGN_SYSTEM.colors.textLight};font-size:14px;line-height:1.65;">${desc}</span>`,
    `</li>`,
  ].join('')).join('')
  const proof = [
    `<section style="margin:26px 0;padding:18px 20px;border:1px solid ${DESIGN_SYSTEM.colors.border};border-radius:14px;background:${DESIGN_SYSTEM.colors.highlight};">`,
    `<p style="margin:0 0 8px;font-size:15px;line-height:1.7;color:${DESIGN_SYSTEM.colors.accent};font-weight:800;">비오케이솔루션 실무 점검 범위</p>`,
    `<p style="margin:0 0 14px;font-size:15px;line-height:1.8;color:${DESIGN_SYSTEM.colors.text};">명찰 출력은 인쇄물이 아니라 접수 운영의 일부입니다. 데이터부터 현장 재발행까지 같은 기준으로 점검해야 접수대가 멈추지 않습니다.</p>`,
    `<ul style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:0;padding:0;list-style:none;">${rows}</ul>`,
    `</section>`,
  ].join('')
  return `${html}\n${proof}`
}

function ensureTistoryOperationFlow(html) {
  if (!html.trim() || !isConferenceBadgeContent(html) || hasOperationFlow(html)) return html
  const steps = [
    ['1', '명단 확정', '참가자 최종 파일, 역할 구분, 등록 상태, QR·바코드 열을 하나의 기준으로 잠급니다.'],
    ['2', '샘플 출력', '긴 소속명, 줄바꿈, 색상, 절단선, 코드 스캔 결과를 실제 출력물로 확인합니다.'],
    ['3', '현장 배치', '접수대, 재발행 창구, 여분 명찰, 목걸이 줄, 승인 담당자를 같은 동선 안에 둡니다.'],
    ['4', '기록 정리', '수정 요청, 재출력 시간, 미수령자, 현장 등록자를 행사 후 정산 자료로 남깁니다.'],
  ]
  const items = steps.map(([num, title, desc]) => [
    `<li style="display:flex;gap:12px;margin:0 0 10px;padding:14px;border:1px solid ${DESIGN_SYSTEM.colors.border};border-radius:12px;background:#ffffff;list-style:none;">`,
    `<span style="display:inline-flex;align-items:center;justify-content:center;flex:0 0 32px;width:32px;height:32px;border-radius:999px;background:${DESIGN_SYSTEM.colors.accent};color:#fff;font-size:13px;font-weight:800;">${num}</span>`,
    `<span style="display:block;">`,
    `<strong style="display:block;margin:0 0 4px;color:${DESIGN_SYSTEM.colors.primary};font-weight:800;">${title}</strong>`,
    `<span style="display:block;color:${DESIGN_SYSTEM.colors.textLight};font-size:14px;line-height:1.65;">${desc}</span>`,
    `</span>`,
    `</li>`,
  ].join('')).join('')
  const flow = [
    `<section style="margin:28px 0;padding:18px 20px;border:1px solid ${DESIGN_SYSTEM.colors.border};border-radius:14px;background:${DESIGN_SYSTEM.colors.highlight};">`,
    `<p style="margin:0 0 8px;font-size:14px;line-height:1.7;color:${DESIGN_SYSTEM.colors.accent};font-weight:800;">사무국 운영 흐름</p>`,
    `<h2 style="margin:0 0 14px;padding:0;border:0;background:transparent;font-size:${DESIGN_SYSTEM.fonts.h2};line-height:1.45;color:${DESIGN_SYSTEM.colors.primary};font-weight:800;">명찰 발행은 데이터 확정부터 현장 기록까지 이어집니다</h2>`,
    `<ol style="margin:0;padding:0;">${items}</ol>`,
    `</section>`,
  ].join('')
  return `${html}\n${flow}`
}

function ensureTistoryOpsComparison(html) {
  if (!html.trim() || !isConferenceBadgeContent(html) || hasOpsComparison(html)) return html
  const rows = [
    ['명단 파일', '담당자별 파일이 흩어져 있음', '최종 기준 파일 1개와 수정 로그 유지'],
    ['출력 검수', '전체 출력 후 오류를 현장에서 발견', '샘플 출력으로 표기·코드·케이스 삽입 확인'],
    ['재발행', '요청이 오면 바로 재출력', '승인자·수정 사유·출력 시간을 남긴 뒤 처리'],
    ['행사 후 정리', '미수령·변경 내역이 사라짐', '정산 자료와 다음 행사 기준으로 재사용'],
  ]
  const body = rows.map(([label, risk, standard]) => (
    `<tr><td style="padding:12px 14px;border:1px solid ${DESIGN_SYSTEM.colors.border};color:${DESIGN_SYSTEM.colors.text};vertical-align:top;">${label}</td><td style="padding:12px 14px;border:1px solid ${DESIGN_SYSTEM.colors.border};color:${DESIGN_SYSTEM.colors.text};vertical-align:top;">${risk}</td><td style="padding:12px 14px;border:1px solid ${DESIGN_SYSTEM.colors.border};color:${DESIGN_SYSTEM.colors.text};vertical-align:top;">${standard}</td></tr>`
  )).join('')
  const comparison = [
    `<section style="margin:28px 0;">`,
    `<h2 style="margin:0 0 14px;padding:14px 18px;border-left:5px solid ${DESIGN_SYSTEM.colors.point};border-radius:10px;background:${DESIGN_SYSTEM.colors.highlight};font-size:${DESIGN_SYSTEM.fonts.h2};line-height:1.45;color:${DESIGN_SYSTEM.colors.primary};font-weight:800;">현장 혼잡을 줄이는 운영 기준 비교</h2>`,
    `<table style="width:100%;border-collapse:collapse;margin:0 0 20px;font-size:14px;">`,
    `<thead><tr><th style="padding:12px 14px;background:${DESIGN_SYSTEM.colors.accent};color:#fff;border:1px solid ${DESIGN_SYSTEM.colors.accent};text-align:left;">항목</th><th style="padding:12px 14px;background:${DESIGN_SYSTEM.colors.accent};color:#fff;border:1px solid ${DESIGN_SYSTEM.colors.accent};text-align:left;">흔한 문제</th><th style="padding:12px 14px;background:${DESIGN_SYSTEM.colors.accent};color:#fff;border:1px solid ${DESIGN_SYSTEM.colors.accent};text-align:left;">권장 기준</th></tr></thead>`,
    `<tbody>${body}</tbody>`,
    `</table>`,
    `</section>`,
  ].join('')
  return `${html}\n${comparison}`
}

function ensureTistoryCta(html) {
  if (!html.trim() || hasCtaText(html)) return html
  const conference = isConferenceBadgeContent(html)
  const cta = [
    `<section style="margin:34px 0 0;padding:20px 22px;border-radius:14px;background:${DESIGN_SYSTEM.colors.primary};color:#fff;">`,
    conference
      ? `<p style="margin:0 0 8px;font-size:16px;line-height:1.7;color:#fff;font-weight:800;">학회 명찰 출력과 현장 재발행 기준이 필요하신가요?</p>`
      : `<p style="margin:0 0 8px;font-size:16px;line-height:1.7;color:#fff;font-weight:800;">운영 환경 점검이 필요하신가요?</p>`,
    conference
      ? `<p style="margin:0;font-size:15px;line-height:1.8;color:#fff;">비오케이솔루션은 참가자 데이터 정리, 명찰 출력, QR·바코드 확인, 현장 재발행 동선을 사무국 운영 흐름에 맞춰 함께 점검합니다. 행사 전 상담 문의로 현재 명단 구조와 출력 기준을 확인해 주세요.</p>`
      : `<p style="margin:0;font-size:15px;line-height:1.8;color:#fff;">홈페이지 구축, 보안 설정, 신청폼 연동처럼 실제 운영에 연결되는 작업은 비오케이솔루션에 문의해 현재 상황에 맞는 점검을 받아보실 수 있습니다.</p>`,
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
    hasBrandedCta: /비오케이솔루션/.test(text.slice(-1000)),
    hasDecisionChecklist: hasDecisionChecklist(value),
    hasServiceProof: hasServiceProof(value),
    hasOperationFlow: hasOperationFlow(value),
    hasOpsComparison: hasOpsComparison(value),
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
  if (!quality.hasBrandedCta) reasons.push('비오케이솔루션 CTA 없음')
  if (!quality.hasDecisionChecklist) reasons.push('운영 체크포인트 없음')
  if (isConferenceBadgeContent(html) && !quality.hasServiceProof) reasons.push('실무 점검 범위 없음')
  if (isConferenceBadgeContent(html) && !quality.hasOperationFlow) reasons.push('사무국 운영 흐름 없음')
  if (isConferenceBadgeContent(html) && !quality.hasOpsComparison) reasons.push('운영 기준 비교표 없음')
  return { ok: reasons.length === 0, reasons, quality }
}

function convertForTistoryFallback(html) {
  return normalizeTistoryHtml(html)
}

export { convertForTistory, validateTistoryHtml }
