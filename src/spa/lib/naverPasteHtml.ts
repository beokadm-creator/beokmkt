/**
 * Convert rich HTML blog content to Naver SmartEditor-safe HTML for manual paste.
 *
 * v3 sanitizer — v2 structure + cohesive inline styles for designed Naver-blog output.
 *   - v2 base: image URLs, no bare text, table structure, links, inline formatting
 *   - v3 addition: every emitted tag carries a `style="..."` attribute using a cohesive
 *     design system (Korean blog readability, Naver-green #03c75a accent, clean typography).
 *     Only paste-safe inline CSS properties are used (no flexbox/grid/variables/transforms).
 *     Classes are preserved for backward compat but design is carried by inline styles.
 *
 * Design palette: body #222, subhead #111, accent #03c75a / #0a8f43, bg #f6f8fa,
 *   borders #e5e7eb, muted #444.
 *
 * Allowed output tags: <p> <strong> <blockquote> <ul> <ol> <li> <br> <hr>
 *   <table> <tbody> <tr> <td> <th> <a> <img>
 * Special: <p class="subhead"> for headings
 *
 * Native DOM API only (no DOMPurify).
 */

/* ── Inline style constants (paste-safe, no flexbox/grid/variables) ── */

const STYLE_P = 'margin:0 0 16px;line-height:1.75;color:#222;font-size:1em;'

const STYLE_SUBHEAD =
  'font-size:1.3em;font-weight:800;line-height:1.4;margin:36px 0 14px;color:#111;letter-spacing:-0.01em;'

const STYLE_P_IMG = 'text-align:center;margin:24px 0;'

const STYLE_IMG = 'max-width:100%;height:auto;border-radius:12px;display:inline-block;'

const STYLE_BLOCKQUOTE =
  'margin:18px 0;padding:14px 18px;border-left:4px solid #03c75a;background:#f6f8fa;color:#444;border-radius:0 8px 8px 0;line-height:1.7;font-size:0.98em;'

const STYLE_LIST = 'margin:0 0 16px;padding-left:1.4em;line-height:1.75;color:#222;'

const STYLE_LI = 'margin:6px 0;'

const STYLE_TABLE =
  'border-collapse:collapse;width:100%;margin:20px 0;font-size:0.96em;line-height:1.6;'

const STYLE_TD =
  'border:1px solid #e5e7eb;padding:10px 12px;vertical-align:top;color:#222;'

const STYLE_TH =
  'border:1px solid #e5e7eb;padding:10px 12px;vertical-align:top;background:#f6f8fa;font-weight:700;color:#111;text-align:left;'

const STYLE_HR = 'border:none;border-top:1px solid #e5e7eb;margin:28px 0;'

const STYLE_A = 'color:#0a8f43;text-decoration:underline;text-underline-offset:2px;'

const UNWRAP_TAGS = new Set([
  'SECTION', 'DIV', 'ARTICLE', 'MAIN', 'HEADER', 'FOOTER', 'NAV', 'ASIDE',
  'SPAN', 'FIGURE', 'FIGCAPTION', 'DETAILS', 'SUMMARY', 'MARK',
])
const STRIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'IFRAME', 'FORM', 'INPUT', 'TEXTAREA', 'SELECT',
  'BUTTON', 'VIDEO', 'AUDIO', 'CANVAS', 'SVG', 'NOSCRIPT',
])
const HEADING_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6'])
const INLINE_TAGS = new Set([
  'STRONG', 'B', 'EM', 'I', 'U', 'S', 'SUB', 'SUP', 'CODE', 'ABBR',
  'CITE', 'DFN', 'KBD', 'SAMP', 'VAR', 'SMALL', 'TIME', 'A', 'IMG', 'BR',
])

/** Block-level tags used by containsBlockElement to detect block descendants. */
const BLOCK_SELECTOR =
  'p,div,section,article,main,header,footer,nav,aside,ul,ol,li,table,thead,tbody,tfoot,tr,td,th,blockquote,h1,h2,h3,h4,h5,h6,hr,figure,address,pre,dl,dt,dd'

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function escAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

interface NaverPasteResult {
  html: string
  title: string
  tags: string[]
}

/**
 * Convert rich HTML content to SmartEditor-safe HTML.
 *
 * @param content - Rich HTML string (the blog post body)
 * @param title - Post title (passed through for convenience)
 * @param tags - Post tags array; leading # is stripped
 * @returns Sanitized HTML, title, and cleaned tags
 */
export function toNaverPasteHtml(
  content: string,
  title: string,
  tags: string[],
): NaverPasteResult {
  const doc = new DOMParser().parseFromString(content, 'text/html')
  const blocks = processBlock(doc.body.childNodes)
  const html = blocks.join('\n').replace(/\n{3,}/g, '\n\n').trim()

  return {
    html,
    title,
    tags: (tags ?? []).map((t) => t.replace(/^#+\s*/, '').trim()).filter(Boolean),
  }
}

/**
 * Returns true if the element contains any block-level descendant.
 */
function containsBlockElement(node: Element): boolean {
  return node.querySelector(BLOCK_SELECTOR) !== null
}

/**
 * Get plain text from a node tree (no tags). Used for heading text extraction.
 */
function getInlineText(node: Element): string {
  let result = ''
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      result += child.textContent ?? ''
    } else if (child instanceof Element) {
      result += child.textContent ?? ''
    }
  }
  return result
}

/**
 * Process a node and its children as inline HTML.
 * Preserves: <strong>/<b>, <a href>, <img src alt>, <br>.
 * Everything else → escaped textContent.
 */
function processInlineNode(node: Element): string {
  let result = ''
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      const t = child.textContent ?? ''
      if (t) result += esc(t)
      continue
    }
    if (!(child instanceof Element)) continue
    const tag = child.tagName.toUpperCase()
    if (tag === 'STRONG' || tag === 'B') {
      const text = child.textContent?.trim() ?? ''
      if (text) result += `<strong>${esc(text)}</strong>`
    } else if (tag === 'A') {
      const href = child.getAttribute('href')?.trim() ?? ''
      const text = child.textContent?.trim() ?? ''
      if (text) {
        if (href) {
          result += `<a href="${escAttr(href)}" style="${STYLE_A}">${esc(text)}</a>`
        } else {
          result += esc(text)
        }
      }
    } else if (tag === 'IMG') {
      const src = child.getAttribute('src')?.trim() ?? ''
      const alt = child.getAttribute('alt')?.trim() ?? ''
      if (src) result += `<img src="${escAttr(src)}" alt="${escAttr(alt)}" style="${STYLE_IMG}">`
    } else if (tag === 'BR') {
      result += '<br>'
    } else if (UNWRAP_TAGS.has(tag)) {
      result += processInlineNode(child)
    } else if (INLINE_TAGS.has(tag)) {
      // Other inline tags → just their text content escaped
      const text = child.textContent ?? ''
      if (text) result += esc(text)
    } else {
      result += esc(child.textContent ?? '')
    }
  }
  return result
}

/**
 * Process a <table> element into structural HTML.
 * Cells are separate <td>/<th> elements — never concatenated.
 */
function processTable(tableNode: Element): string {
  const rows = Array.from(tableNode.querySelectorAll('tr'))
  if (rows.length === 0) return ''

  let html = `<table style="${STYLE_TABLE}"><tbody>`
  for (const tr of rows) {
    const cells: string[] = []
    for (const cell of tr.children) {
      const cellTag = cell.tagName.toUpperCase()
      if (cellTag === 'TD' || cellTag === 'TH') {
        const content = processInlineNode(cell).trim() || '(empty)'
        const cellStyle = cellTag === 'TH' ? STYLE_TH : STYLE_TD
        cells.push(`<${cellTag.toLowerCase()} style="${cellStyle}">${content}</${cellTag.toLowerCase()}>`)
      }
    }
    if (cells.length > 0) {
      html += `<tr>${cells.join('')}</tr>`
    }
  }
  html += '</tbody></table>'
  return html
}

/**
 * Collect <li> items from a <ul>/<ol> element.
 */
function collectListItems(listNode: Element): string[] {
  const items: string[] = []
  for (const child of listNode.children) {
    if (child.tagName === 'LI') {
      const inline = processInlineNode(child).trim()
      if (inline) items.push(inline)
    }
  }
  return items
}

/**
 * Main block-level walker with paragraph buffering.
 *
 * Mirrors the Python `para_buf`/`flush_para` model: consecutive text and inline
 * content accumulates in `paraBuf`. When a block element is encountered, the buffer
 * is flushed as a `<p>` first, then the block is emitted. This guarantees no bare text.
 */
function processBlock(nodes: NodeListOf<ChildNode>): string[] {
  const out: string[] = []
  const paraBuf: string[] = []

  function flushPara(): void {
    const joined = paraBuf.join('').replace(/\s+/g, ' ').trim()
    if (joined) {
      out.push(`<p style="${STYLE_P}">${joined}</p>`)
    }
    paraBuf.length = 0
  }

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]
    const tag = node instanceof Element ? (node.tagName ?? '').toUpperCase() : ''

    // Text node → add to paragraph buffer
    if (node.nodeType === Node.TEXT_NODE) {
      const t = (node.textContent ?? '').replace(/\s+/g, ' ')
      if (t.trim()) paraBuf.push(esc(t))
      continue
    }

    if (!tag) continue

    // Strip dangerous/non-visible tags
    if (STRIP_TAGS.has(tag)) continue

    // Unwrap neutral containers
    if (UNWRAP_TAGS.has(tag)) {
      if (containsBlockElement(node)) {
        flushPara()
        out.push(...processBlock(node.childNodes))
      } else {
        paraBuf.push(processInlineNode(node))
      }
      continue
    }

    // Headings → <p class="subhead">
    if (HEADING_TAGS.has(tag)) {
      flushPara()
      const text = getInlineText(node).trim()
      if (text) {
        out.push(`<p class="subhead" style="${STYLE_SUBHEAD}"><strong>${esc(text)}</strong></p>`)
      }
      continue
    }

    // Block-level <img> → standalone <p> with image
    if (tag === 'IMG') {
      flushPara()
      const src = node.getAttribute('src')?.trim() ?? ''
      const alt = node.getAttribute('alt')?.trim() ?? ''
      if (src) {
        out.push(`<p style="${STYLE_P_IMG}"><img src="${escAttr(src)}" alt="${escAttr(alt)}" style="${STYLE_IMG}"></p>`)
      }
      continue
    }

    // <p> → strip attrs, keep inline content
    if (tag === 'P') {
      flushPara()
      const inline = processInlineNode(node).trim()
      if (inline) {
        out.push(`<p style="${STYLE_P}">${inline}</p>`)
      }
      continue
    }

    // <blockquote> / <q>
    if (tag === 'BLOCKQUOTE' || tag === 'Q') {
      flushPara()
      const inner = processBlock(node.childNodes).join('')
      if (inner.trim()) {
        out.push(`<blockquote style="${STYLE_BLOCKQUOTE}">${inner}</blockquote>`)
      }
      continue
    }

    // <ul> / <ol>
    if (tag === 'UL' || tag === 'OL') {
      flushPara()
      const listType = tag.toLowerCase() as 'ul' | 'ol'
      const items = collectListItems(node)
      if (items.length > 0) {
        const liHtml = items.map((item) => `<li style="${STYLE_LI}">${item}</li>`).join('')
        out.push(`<${listType} style="${STYLE_LIST}">${liHtml}</${listType}>`)
      }
      continue
    }

    // <table>
    if (tag === 'TABLE') {
      flushPara()
      const tableHtml = processTable(node)
      if (tableHtml) {
        out.push(tableHtml)
      }
      continue
    }

    // <br> → inside paragraph buffer
    if (tag === 'BR') {
      paraBuf.push('<br>')
      continue
    }

    // <hr>
    if (tag === 'HR') {
      flushPara()
      out.push('<hr style="' + STYLE_HR + '">')
      continue
    }

    // Standalone <li> (not inside ul/ol) → wrap in <ul>
    if (tag === 'LI') {
      flushPara()
      const itemHtml = processInlineNode(node).trim()
      if (itemHtml) {
        out.push(`<ul style="${STYLE_LIST}"><li style="${STYLE_LI}">${itemHtml}</li></ul>`)
      }
      continue
    }

    // Inline tags at block level → join paragraph buffer
    if (INLINE_TAGS.has(tag)) {
      paraBuf.push(processInlineNode(node))
      continue
    }

    // Fallback: unwrap unknown tag, recurse as blocks
    flushPara()
    out.push(...processBlock(node.childNodes))
  }

  flushPara()
  return out
}
