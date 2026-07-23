/**
 * Convert rich blog HTML to clean, Tistory-friendly HTML for manual paste.
 *
 * Unlike Naver SmartEditor (see naverPasteHtml.ts), Tistory has a real HTML
 * editor and renders standard semantic markup — so we KEEP structure (h2/h3,
 * tables, lists, blockquote, img) instead of flattening it. We only:
 *   - whitelist tags (drop scripts/embeds, unwrap layout containers/classes)
 *   - strip all attributes except href (a) and src/alt (img)
 *   - apply light inline styles for readable rendering in either editor mode
 *
 * The output is meant to be pasted into Tistory's "HTML" editor mode (as source)
 * or the basic editor (as rich content) — both work.
 *
 * Native DOM API only (no DOMPurify).
 */

const ALLOWED = new Set([
  'H2', 'H3', 'H4', 'P', 'UL', 'OL', 'LI', 'BLOCKQUOTE',
  'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH',
  'A', 'IMG', 'STRONG', 'B', 'EM', 'I', 'BR', 'HR',
])

/** Layout/inline wrappers that should be unwrapped (keep children, drop the tag). */
const UNWRAP = new Set([
  'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'HEADER', 'FOOTER', 'NAV', 'ASIDE',
  'SPAN', 'FIGURE', 'MARK', 'SMALL', 'TIME', 'ABBR', 'CITE', 'DFN',
])

const STRIP = new Set([
  'SCRIPT', 'STYLE', 'IFRAME', 'FORM', 'INPUT', 'TEXTAREA', 'SELECT',
  'BUTTON', 'VIDEO', 'AUDIO', 'CANVAS', 'SVG', 'NOSCRIPT', 'LINK', 'META',
])

const VOID_TAGS = new Set(['IMG', 'BR', 'HR'])

const STYLE: Record<string, string> = {
  H2: 'font-size:1.4em;font-weight:800;line-height:1.4;margin:34px 0 12px;',
  H3: 'font-size:1.2em;font-weight:700;line-height:1.4;margin:26px 0 10px;',
  H4: 'font-size:1.05em;font-weight:700;margin:22px 0 8px;',
  P: 'margin:0 0 16px;line-height:1.8;',
  UL: 'margin:0 0 16px;padding-left:1.4em;line-height:1.8;',
  OL: 'margin:0 0 16px;padding-left:1.4em;line-height:1.8;',
  LI: 'margin:6px 0;',
  BLOCKQUOTE:
    'margin:18px 0;padding:12px 18px;border-left:4px solid #ff9a3c;background:#fff7f0;border-radius:0 8px 8px 0;line-height:1.7;',
  TABLE: 'border-collapse:collapse;width:100%;margin:20px 0;font-size:0.96em;',
  TD: 'border:1px solid #e5e7eb;padding:8px 12px;vertical-align:top;',
  TH: 'border:1px solid #e5e7eb;padding:8px 12px;background:#f6f8fa;font-weight:700;text-align:left;',
  IMG: 'max-width:100%;height:auto;border-radius:10px;',
  A: 'color:#e06c1f;text-decoration:underline;',
  HR: 'border:none;border-top:1px solid #e5e7eb;margin:28px 0;',
}

export interface TistoryPasteResult {
  html: string
  title: string
  tags: string[]
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function serialize(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return esc(node.textContent ?? '')
  if (!(node instanceof Element)) return ''

  const tag = node.tagName.toUpperCase()
  if (STRIP.has(tag)) return ''

  const inner = Array.from(node.childNodes).map(serialize).join('')

  // <figcaption> → centered caption paragraph (figure itself is unwrapped)
  if (tag === 'FIGCAPTION') {
    return inner.trim()
      ? `<p style="text-align:center;font-size:0.85em;color:#888;margin:6px 0 18px;">${inner}</p>`
      : ''
  }

  if (UNWRAP.has(tag) || !ALLOWED.has(tag)) return inner

  let attrs = ''
  if (tag === 'A') {
    const href = node.getAttribute('href')?.trim()
    if (href) attrs += ` href="${escAttr(href)}"`
  } else if (tag === 'IMG') {
    const src = node.getAttribute('src')?.trim()
    if (!src) return ''
    const alt = node.getAttribute('alt')?.trim() ?? ''
    attrs += ` src="${escAttr(src)}" alt="${escAttr(alt)}"`
  }

  const style = STYLE[tag]
  if (style) attrs += ` style="${style}"`

  const lower = tag.toLowerCase()
  if (VOID_TAGS.has(tag)) return `<${lower}${attrs}>`
  return `<${lower}${attrs}>${inner}</${lower}>`
}

/**
 * Convert rich HTML content to clean Tistory-ready HTML.
 *
 * @param content - Rich HTML string (the blog post body)
 * @param title - Post title (passed through)
 * @param tags - Post tags array; leading # is stripped
 */
export function toTistoryPasteHtml(
  content: string,
  title: string,
  tags: string[],
): TistoryPasteResult {
  const doc = new DOMParser().parseFromString(content, 'text/html')
  const html = Array.from(doc.body.childNodes)
    .map(serialize)
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return {
    html,
    title,
    tags: (tags ?? []).map((t) => t.replace(/^#+\s*/, '').trim()).filter(Boolean),
  }
}
