import { getBlogPromptTemplate, resolveLengthGuide, pickStructure } from './prompts.mjs'
import { applyHtmlTemplate } from './html-templates.mjs'
import { stripHtml, validateDraftContent, validateSeoMetadata, validateFinalPost } from './validators.mjs'
import { selectImages } from './image-pool.mjs'

class PipelineError extends Error {
  constructor(code, message, details = null) {
    super(message)
    this.code = code
    this.details = details
  }
}

function escapeAttribute(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function buildFigureHtml(image) {
  const url = escapeAttribute(image.url)
  const alt = escapeAttribute(image.alt)
  return `\n<figure class="my-8"><img src="${url}" alt="${alt}" class="w-full rounded-xl border border-zinc-800" loading="lazy" /><figcaption class="mt-2 text-center text-xs text-zinc-500">${alt}</figcaption></figure>`
}

function insertFiguresAfterHeadings(html, images = []) {
  if (!images.length) return html
  let headingIndex = 0
  let imageIndex = 0
  return html.replace(/<\/h2>/gi, (match) => {
    headingIndex += 1
    if (headingIndex < 2 || imageIndex >= images.length) return match
    const figure = buildFigureHtml(images[imageIndex])
    imageIndex += 1
    return `${match}${figure}`
  })
}

async function executeBlogPipeline(deps, options) {
    const {
      generateAiText,
      maybeParseJson,
      resolveAiConfig,
      newId,
      nowIso,
      ensureUniqueBlogSlug,
      addAuditLog,
      createPost,
      listPublishedPosts,
    } = deps

  const {
    title,
    topic,
    category = 'marketing',
    tone = 'professional',
    keywords = [],
    source_text = '',
    target_length = 'medium',
    language = 'ko',
    auto_publish = true,
    featured_image = null,
    cta_text = null,
    cta_link = null,
    cta_button_text = null,
    structure = null,
    ai_provider,
    ai_api_key,
    ai_model,
    ai_endpoint,
  } = options

  if (!title || !title.trim()) {
    throw new PipelineError('MISSING_TITLE', 'title is required')
  }

  const aiConfig = await resolveAiConfig({
    ai_provider,
    ai_api_key,
    ai_model,
    ai_endpoint,
  })

  if (!aiConfig.provider || !aiConfig.apiKey) {
    throw new PipelineError('AI_NOT_CONFIGURED', 'AI provider and API key are required')
  }

  const template = getBlogPromptTemplate(category, tone)
  const lengthGuide = resolveLengthGuide(target_length)
  const resolvedStructure = pickStructure(structure, `${title}${topic ?? ''}`)

  let recentPosts = []
  if (typeof listPublishedPosts === 'function') {
    try {
      recentPosts = await listPublishedPosts(12)
    } catch {
      recentPosts = []
    }
  }

  const userPrompt = template.buildUserPrompt({
    title: title.trim(),
    topic: topic?.trim() || title.trim(),
    toneLabel: template.toneLabel,
    lengthGuide,
    keywords,
    source_text,
    structure: resolvedStructure,
    recent_posts: recentPosts,
  })

  await addAuditLog('blog_pipeline.step_started', 'blog_pipeline', 'system', 'ai', {
    step: 'generate_content',
    category,
    tone,
    template_version: template.version,
  })

  const aiRawText = await generateAiText(aiConfig, template.system, userPrompt, { max_tokens: 4096 })
  if (!aiRawText) {
    throw new PipelineError('AI_NO_RESPONSE', 'AI returned empty response')
  }

  const parsed = maybeParseJson(aiRawText)
  if (!parsed || typeof parsed !== 'object') {
    throw new PipelineError('AI_INVALID_FORMAT', 'AI response is not valid JSON', {
      raw_length: aiRawText.length,
    })
  }

  const rawHtml = typeof parsed.html === 'string' ? parsed.html : ''
  if (!rawHtml) {
    throw new PipelineError('AI_NO_HTML', 'AI response missing html field')
  }

  const validationContext = { keywords, target_length }
  const contentValidation = validateDraftContent(rawHtml, validationContext)
  if (!contentValidation.valid) {
    throw new PipelineError('CONTENT_VALIDATION_FAILED', contentValidation.reason, {
      step: 'draft_content',
    })
  }

  const images = selectImages(category, keywords, title)
  const enrichedHtml = insertFiguresAfterHeadings(rawHtml, images)

  const html = applyHtmlTemplate(enrichedHtml, { category, cta_text, cta_link, cta_button_text })

  const seoData = {
    excerpt: typeof parsed.excerpt === 'string' ? parsed.excerpt.trim() : '',
    seo_title: typeof parsed.seo_title === 'string' ? parsed.seo_title.trim() : title.trim(),
    seo_description: typeof parsed.seo_description === 'string' ? parsed.seo_description.trim() : '',
    tags: Array.isArray(parsed.tags) ? parsed.tags.filter((t) => typeof t === 'string' && t.trim()) : [],
  }

  const faq = Array.isArray(parsed.faq)
    ? parsed.faq
        .filter((item) => item && typeof item.q === 'string' && typeof item.a === 'string' && item.q.trim() && item.a.trim())
        .slice(0, 6)
        .map((item) => ({ q: item.q.trim(), a: item.a.trim() }))
    : []

  if (!seoData.excerpt) {
    seoData.excerpt = stripHtml(rawHtml).slice(0, 180)
  }

  const seoValidation = validateSeoMetadata(seoData, validationContext)
  if (!seoValidation.valid) {
    throw new PipelineError('SEO_VALIDATION_FAILED', seoValidation.reason, {
      step: 'seo_metadata',
    })
  }

  const id = newId()
  const now = nowIso()
  const slug = await ensureUniqueBlogSlug(title)

  const post = {
    id,
    title: title.trim(),
    content: html,
    excerpt: seoData.excerpt,
    category,
    tags: seoData.tags,
    faq,
    structure: resolvedStructure,
    slug,
    featured_image: featured_image ?? images[0]?.url ?? null,
    status: 'draft',
    language,
    tone,
    seo_title: seoData.seo_title,
    seo_description: seoData.seo_description,
    published_at: null,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  }

  if (auto_publish) {
    const finalValidation = validateFinalPost({ ...post, content: html }, validationContext)
    if (!finalValidation.valid) {
      throw new PipelineError('FINAL_VALIDATION_FAILED', finalValidation.reason)
    }
    post.status = 'published'
    post.published_at = nowIso()
  }

  await createPost(post)

  await addAuditLog('blog_pipeline.post_created', 'blog_post', id, 'ai', {
    pipeline_version: 1,
    template_version: template.version,
    category,
    tone,
    auto_publish,
    ai_trace: {
      provider: aiConfig.provider,
      model: aiConfig.model,
    },
  })

  return {
    post_id: id,
    slug,
    status: post.status,
    title: post.title,
    seo_title: post.seo_title,
    tags: post.tags,
    published_at: post.published_at,
    template_version: template.version,
  }
}

export { executeBlogPipeline, PipelineError }
