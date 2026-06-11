const LENGTH_RULES = {
  short: { min: 350, max: 5000 },
  medium: { min: 700, max: 8000 },
  long: { min: 1200, max: 12000 },
}

function normalizeText(value) {
  return String(value ?? '').toLowerCase().replace(/\s+/g, '')
}

function stripHtml(html) {
  return String(html ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

function cleanKeywords(keywords = []) {
  return Array.isArray(keywords)
    ? keywords.map((keyword) => String(keyword ?? '').trim()).filter(Boolean)
    : []
}

function includesNormalized(haystack, needle) {
  const normalizedNeedle = normalizeText(needle)
  if (!normalizedNeedle) return true
  return normalizeText(haystack).includes(normalizedNeedle)
}

function validateDraftContent(html, options = {}) {
  if (!html || typeof html !== 'string') {
    return { valid: false, reason: 'html is empty or not a string' }
  }

  if (/```/.test(html)) {
    return { valid: false, reason: 'markdown code fences are not allowed' }
  }

  if (/<h1[^>]*>/i.test(html)) {
    return { valid: false, reason: 'h1 tags are not allowed inside blog content' }
  }

  const lengthRule = LENGTH_RULES[options.target_length] ?? LENGTH_RULES.medium
  const stripped = stripHtml(html)
  if (stripped.length < lengthRule.min) {
    return { valid: false, reason: `content too short (${stripped.length} chars, minimum ${lengthRule.min})` }
  }

  if (stripped.length > lengthRule.max) {
    return { valid: false, reason: `content too long (${stripped.length} chars, maximum ${lengthRule.max})` }
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
  if (h2Count < 3) {
    return { valid: false, reason: `too few h2 headings (${h2Count}, minimum 3)` }
  }

  const keywords = cleanKeywords(options.keywords)
  const primaryKeyword = keywords[0]
  if (primaryKeyword && !includesNormalized(stripped, primaryKeyword)) {
    return { valid: false, reason: `primary keyword missing from content (${primaryKeyword})` }
  }

  if (primaryKeyword) {
    const h2Text = (html.match(/<h2[^>]*>[\s\S]*?<\/h2>/gi) ?? []).join(' ')
    if (!includesNormalized(h2Text, primaryKeyword)) {
      return { valid: false, reason: `primary keyword missing from h2 headings (${primaryKeyword})` }
    }
  }

  return { valid: true }
}

function validateSeoMetadata(seo, options = {}) {
  if (!seo || typeof seo !== 'object') {
    return { valid: false, reason: 'seo metadata is empty or not an object' }
  }

  const seoTitle = typeof seo.seo_title === 'string' ? seo.seo_title.trim() : ''
  if (!seoTitle) {
    return { valid: false, reason: 'seo_title is required' }
  }
  if (seoTitle.length < 20) {
    return { valid: false, reason: `seo_title too short (${seoTitle.length} chars, minimum 20)` }
  }
  if (seoTitle.length > 65) {
    return { valid: false, reason: `seo_title too long (${seoTitle.length} chars, maximum 65)` }
  }

  const seoDesc = typeof seo.seo_description === 'string' ? seo.seo_description.trim() : ''
  if (!seoDesc) {
    return { valid: false, reason: 'seo_description is required' }
  }
  if (seoDesc.length < 50) {
    return { valid: false, reason: `seo_description too short (${seoDesc.length} chars, minimum 50)` }
  }
  if (seoDesc.length > 160) {
    return { valid: false, reason: `seo_description too long (${seoDesc.length} chars, maximum 160)` }
  }

  const tags = Array.isArray(seo.tags) ? seo.tags.filter((t) => typeof t === 'string' && t.trim()) : []
  if (tags.length < 3) {
    return { valid: false, reason: `too few tags (${tags.length}, minimum 3)` }
  }
  if (tags.length > 8) {
    return { valid: false, reason: `too many tags (${tags.length}, maximum 8)` }
  }
  const longTag = tags.find((tag) => tag.trim().length > 30)
  if (longTag) {
    return { valid: false, reason: `tag too long (${longTag})` }
  }

  const excerpt = typeof seo.excerpt === 'string' ? seo.excerpt.trim() : ''
  if (!excerpt) {
    return { valid: false, reason: 'excerpt is required' }
  }
  if (excerpt.length < 20) {
    return { valid: false, reason: `excerpt too short (${excerpt.length} chars, minimum 20)` }
  }
  if (excerpt.length > 220) {
    return { valid: false, reason: `excerpt too long (${excerpt.length} chars, maximum 220)` }
  }

  const keywords = cleanKeywords(options.keywords)
  const primaryKeyword = keywords[0]
  if (primaryKeyword) {
    if (!includesNormalized(seoTitle, primaryKeyword)) {
      return { valid: false, reason: `primary keyword missing from seo_title (${primaryKeyword})` }
    }
    if (!includesNormalized(seoDesc, primaryKeyword)) {
      return { valid: false, reason: `primary keyword missing from seo_description (${primaryKeyword})` }
    }
  }

  return { valid: true }
}

function validateFinalPost(post, options = {}) {
  if (!post || typeof post !== 'object') {
    return { valid: false, reason: 'post object is empty' }
  }

  if (!post.id) {
    return { valid: false, reason: 'post id is missing' }
  }

  if (!post.title || !post.title.trim()) {
    return { valid: false, reason: 'post title is missing' }
  }

  const contentValid = validateDraftContent(post.content, options)
  if (!contentValid.valid) {
    return { valid: false, reason: `post content: ${contentValid.reason}` }
  }

  return { valid: true }
}

export { validateDraftContent, validateSeoMetadata, validateFinalPost, stripHtml }
