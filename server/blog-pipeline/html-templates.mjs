function applyHtmlTemplate(rawHtml, options = {}) {
  if (!rawHtml || typeof rawHtml !== 'string') return rawHtml

  let html = rawHtml.trim()

  if (html.startsWith('```')) {
    const match = html.match(/```(?:html)?\s*([\s\S]*?)```/)
    if (match?.[1]) html = match[1].trim()
  }

  html = html.replace(/^<html[^>]*>[\s\S]*?<body[^>]*>/i, '').replace(/<\/body>\s*<\/html>\s*$/i, '')

  const sections = []

  sections.push(html)

  if (options.cta_text) {
    sections.push(`
<div class="cta-section not-prose mt-12 rounded-xl border border-zinc-700 bg-zinc-800/50 p-6 text-center">
  <p class="text-base text-zinc-200">${options.cta_text}</p>
  ${options.cta_link ? `<a href="${options.cta_link}" class="mt-3 inline-block rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-700">${options.cta_button_text ?? '자세히 보기'}</a>` : ''}
</div>`)
  }

  return sections.filter(Boolean).join('\n')
}

export { applyHtmlTemplate }
