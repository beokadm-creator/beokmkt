function validateDraftContent(html) {
  if (!html || typeof html !== 'string') {
    return { valid: false, reason: 'html is empty or not a string' }
  }

  const stripped = html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
  if (stripped.length < 200) {
    return { valid: false, reason: `content too short (${stripped.length} chars, minimum 200)` }
  }

  if (stripped.length > 10000) {
    return { valid: false, reason: `content too long (${stripped.length} chars, maximum 10000)` }
  }

  const hasH2 = /<h2[^>]*>/i.test(html)
  if (!hasH2) {
    return { valid: false, reason: 'missing h2 headings - content structure required' }
  }

  const hasParagraphs = /<p[^>]*>/i.test(html)
  if (!hasParagraphs) {
    return { valid: false, reason: 'missing p tags - paragraph content required' }
  }

  const h2Count = (html.match(/<h2[^>]*>/gi) ?? []).length
  if (h2Count < 2) {
    return { valid: false, reason: `too few h2 headings (${h2Count}, minimum 2)` }
  }

  return { valid: true }
}

function validateSeoMetadata(seo) {
  if (!seo || typeof seo !== 'object') {
    return { valid: false, reason: 'seo metadata is empty or not an object' }
  }

  const seoTitle = typeof seo.seo_title === 'string' ? seo.seo_title.trim() : ''
  if (!seoTitle) {
    return { valid: false, reason: 'seo_title is required' }
  }
  if (seoTitle.length < 10) {
    return { valid: false, reason: `seo_title too short (${seoTitle.length} chars, minimum 10)` }
  }
  if (seoTitle.length > 70) {
    return { valid: false, reason: `seo_title too long (${seoTitle.length} chars, maximum 70)` }
  }

  const seoDesc = typeof seo.seo_description === 'string' ? seo.seo_description.trim() : ''
  if (!seoDesc) {
    return { valid: false, reason: 'seo_description is required' }
  }
  if (seoDesc.length < 30) {
    return { valid: false, reason: `seo_description too short (${seoDesc.length} chars, minimum 30)` }
  }
  if (seoDesc.length > 170) {
    return { valid: false, reason: `seo_description too long (${seoDesc.length} chars, maximum 170)` }
  }

  const tags = Array.isArray(seo.tags) ? seo.tags.filter((t) => typeof t === 'string' && t.trim()) : []
  if (tags.length === 0) {
    return { valid: false, reason: 'at least one tag is required' }
  }

  const excerpt = typeof seo.excerpt === 'string' ? seo.excerpt.trim() : ''
  if (!excerpt) {
    return { valid: false, reason: 'excerpt is required' }
  }
  if (excerpt.length < 20) {
    return { valid: false, reason: `excerpt too short (${excerpt.length} chars, minimum 20)` }
  }

  return { valid: true }
}

function validateFinalPost(post) {
  if (!post || typeof post !== 'object') {
    return { valid: false, reason: 'post object is empty' }
  }

  if (!post.id) {
    return { valid: false, reason: 'post id is missing' }
  }

  if (!post.title || !post.title.trim()) {
    return { valid: false, reason: 'post title is missing' }
  }

  const contentValid = validateDraftContent(post.content)
  if (!contentValid.valid) {
    return { valid: false, reason: `post content: ${contentValid.reason}` }
  }

  return { valid: true }
}

export { validateDraftContent, validateSeoMetadata, validateFinalPost }
