function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function applyInlineMarkdown(text) {
  return escapeHtml(text)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
}

function markdownToHtml(markdown) {
  const hasStructuralHtml = /<(h[1-6]|p|ul|ol|li|blockquote|table|img)\b/i.test(markdown)
  const hasMarkdownBlocks = /(^|\n)\s*(#{2,3}\s+|[-*]\s+|\d+\.\s+|!\[[^\]]*\]\([^)\s]+\))/m.test(markdown)
  if (hasStructuralHtml && !hasMarkdownBlocks) return markdown

  const lines = String(markdown ?? '').split(/\r?\n/)
  const out = []
  let paragraph = []
  let listType = ''

  const closeParagraph = () => {
    if (!paragraph.length) return
    out.push(`<p>${applyInlineMarkdown(paragraph.join(' '))}</p>`)
    paragraph = []
  }
  const closeList = () => {
    if (!listType) return
    out.push(`</${listType}>`)
    listType = ''
  }
  const openList = (type) => {
    closeParagraph()
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
      continue
    }

    const image = line.match(/^!\[([^\]]*)\]\(([^)\s]+)\)$/)
    if (image) {
      closeParagraph()
      closeList()
      out.push(`<figure><img src="${escapeHtml(image[2])}" alt="${escapeHtml(image[1])}"></figure>`)
      continue
    }

    const h3 = line.match(/^###\s+(.+)$/)
    if (h3) {
      closeParagraph()
      closeList()
      out.push(`<p><strong>${applyInlineMarkdown(h3[1])}</strong></p>`)
      continue
    }

    const h2 = line.match(/^##\s+(.+)$/)
    if (h2) {
      closeParagraph()
      closeList()
      out.push(`<p><strong>${applyInlineMarkdown(h2[1])}</strong></p>`)
      continue
    }

    const bullet = line.match(/^[-*]\s+(.+)$/)
    if (bullet) {
      openList('ul')
      out.push(`<li>${applyInlineMarkdown(bullet[1])}</li>`)
      continue
    }

    const numbered = line.match(/^\d+\.\s+(.+)$/)
    if (numbered) {
      openList('ol')
      out.push(`<li>${applyInlineMarkdown(numbered[1])}</li>`)
      continue
    }

    paragraph.push(line)
  }
  closeParagraph()
  closeList()

  return out.join('\n')
}

const INLINE_STYLES = {
  h2: 'font-size:1.5em;font-weight:700;margin:1.2em 0 .6em;line-height:1.4;color:#222;',
  h3: 'font-size:1.2em;font-weight:700;margin:1em 0 .5em;line-height:1.4;color:#333;',
  p: 'margin:0 0 .8em;line-height:1.7;color:#333;font-size:14px;',
  ul: 'margin:0 0 .8em 1.5em;padding:0;line-height:1.7;color:#333;',
  ol: 'margin:0 0 .8em 1.5em;padding:0;line-height:1.7;color:#333;',
  li: 'margin-bottom:.3em;',
  strong: 'font-weight:700;color:#111;',
  em: 'font-style:italic;',
  blockquote: 'border-left:3px solid #cbd5e1;padding:.5em .8em;margin:1em 0;color:#475569;background:#f8fafc;',
  figure: 'margin:1em 0;text-align:center;',
  figcaption: 'margin-top:.4em;font-size:12px;color:#64748b;',
  img: 'max-width:100%;height:auto;border-radius:8px;',
  hr: 'border:none;border-top:1px solid #e2e8f0;margin:1.5em 0;',
  a: 'color:#1d4ed8;text-decoration:underline;',
  code: 'background:#f1f5f9;padding:.1em .35em;border-radius:4px;font-family:Menlo,monospace;font-size:.9em;',
  pre: 'background:#f1f5f9;padding:.8em;border-radius:6px;overflow-x:auto;font-family:Menlo,monospace;font-size:.85em;margin:1em 0;',
}

function applyInlineStyle(tagName) {
  return INLINE_STYLES[tagName] || ''
}

function stripUnsafeTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/ on\w+="[^"]*"/gi, '')
    .replace(/ on\w+='[^']*'/gi, '')
    .replace(/javascript:/gi, '')
}

function rewriteTag(match, fullTag, tagName) {
  const tag = tagName.toLowerCase()
  const style = applyInlineStyle(tag)
  if (!style) return match
  if (/style=["'][^"']*["']/i.test(fullTag)) {
    return fullTag.replace(/style=["']([^"']*)["']/i, (m, existing) => `style="${existing};${style}"`)
  }
  return fullTag.replace(/<(\w+)([^>]*)>/i, `<$1$2 style="${style}">`)
}

function addInlineStyles(html) {
  const tags = Object.keys(INLINE_STYLES).join('|')
  const regex = new RegExp(`<(\\/?(${tags}))\\b([^>]*)?>`, 'gi')
  return html.replace(regex, (match, _g1, tagName, _attrs) => {
    if (match.startsWith('</')) return match
    return rewriteTag(match, match, tagName)
  })
}

function stripTailwindClasses(html) {
  return html.replace(/<(\w+)([^>]*)>/gi, (match, tag, rest) => {
    const cleaned = rest.replace(/\s*class="[^"]*"/gi, '').replace(/\s*class='[^']*'/gi, '')
    return `<${tag}${cleaned}>`
  })
}

function extractImagesFromFigures(html) {
  const images = []
  const figureRegex = /<figure[\s\S]*?<img[^>]*src="([^"]+)"[^>]*(?:alt="([^"]*)")?[^>]*\/?>[\s\S]*?<\/figure>/gi
  const matches = [...html.matchAll(figureRegex)]
  for (const m of matches) {
    images.push({ url: m[1], alt: m[2] || '' })
  }
  return images
}

function convertBrandHeader(html) {
  return html.replace(
    /<div class="not-prose mb-8[^"]*"[^>]*>[\s\S]*?<\/div>/i,
    (match) => {
      const nameMatch = match.match(/font-semibold[^>]*>\s*([^<]+)\s*</)
      const taglineMatch = match.match(/text-xs[^>]*>\s*([^<]+)\s*</)
      const name = nameMatch?.[1]?.trim() || ''
      const tagline = taglineMatch?.[1]?.trim() || ''
      if (!name) return ''
      return `<div style="padding:12px 16px;border:1px solid #e2e8f0;background:#f8fafc;border-radius:8px;margin-bottom:16px;"><strong style="color:#0f172a;">${escapeHtml(name)}</strong>${tagline ? `<div style="font-size:12px;color:#475569;margin-top:2px;">${escapeHtml(tagline)}</div>` : ''}</div>`
    }
  )
}

function convertCtaBlock(html) {
  return html.replace(
    /<div class="not-prose mt-10[^"]*"[^>]*>[\s\S]*?<a[^>]*>([^<]+)<\/a>[\s\S]*?<\/div>/i,
    (match, buttonText) => {
      const textMatch = match.match(/<p[^>]*>\s*([^<]+?)\s*<\/p>/)
      const linkMatch = match.match(/<a[^>]*href="([^"]+)"[^>]*>/)
      const footerMatch = match.match(/<p[^>]*class="mt-3[^>]*>\s*([^<]+?)\s*<\/p>/)
      const text = textMatch?.[1]?.trim() || ''
      const link = linkMatch?.[1] || ''
      const footer = footerMatch?.[1]?.trim() || ''
      const button = (buttonText || '').trim()
      const parts = []
      parts.push('<div style="margin-top:32px;padding:20px;border:1px solid #cbd5e1;background:linear-gradient(135deg,#f1f5f9,#e2e8f0);border-radius:10px;text-align:center;">')
      if (text) parts.push(`<p style="margin:0 0 12px;font-size:14px;color:#1e293b;">${escapeHtml(text)}</p>`)
      if (link && button) {
        parts.push(`<a href="${escapeHtml(link)}" target="_blank" rel="noopener" style="display:inline-block;padding:10px 20px;background:#2563eb;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;font-size:14px;">${escapeHtml(button)}</a>`)
      }
      if (footer) parts.push(`<p style="margin:12px 0 0;font-size:11px;color:#64748b;">${escapeHtml(footer)}</p>`)
      parts.push('</div>')
      return parts.join('')
    }
  )
}

function convertForNaver(html) {
  if (!html || typeof html !== 'string') return ''
  let out = markdownToHtml(html)

  out = stripUnsafeTags(out)
  out = convertBrandHeader(out)
  out = convertCtaBlock(out)
  out = stripTailwindClasses(out)
  out = addInlineStyles(out)

  return out.trim()
}

export { convertForNaver, extractImagesFromFigures }
