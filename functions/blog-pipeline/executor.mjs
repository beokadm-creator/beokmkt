import { getBlogPromptTemplate, resolveLengthGuide } from './prompts.mjs'
import { applyHtmlTemplate } from './html-templates.mjs'
import { validateDraftContent, validateSeoMetadata, validateFinalPost } from './validators.mjs'

class PipelineError extends Error {
  constructor(code, message, details = null) {
    super(message)
    this.code = code
    this.details = details
  }
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

  const userPrompt = template.buildUserPrompt({
    title: title.trim(),
    topic: topic?.trim() || title.trim(),
    toneLabel: template.toneLabel,
    lengthGuide,
    keywords,
    source_text,
  })

  await addAuditLog('blog_pipeline.step_started', 'blog_pipeline', 'system', 'ai', {
    step: 'generate_content',
    category,
    tone,
    template_version: template.version,
  })

  const aiRawText = await generateAiText(aiConfig, template.system, userPrompt)
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

  const contentValidation = validateDraftContent(rawHtml)
  if (!contentValidation.valid) {
    throw new PipelineError('CONTENT_VALIDATION_FAILED', contentValidation.reason, {
      step: 'draft_content',
    })
  }

  const html = applyHtmlTemplate(rawHtml, { cta_text, cta_link, cta_button_text })

  const seoData = {
    excerpt: typeof parsed.excerpt === 'string' ? parsed.excerpt.trim() : '',
    seo_title: typeof parsed.seo_title === 'string' ? parsed.seo_title.trim() : title.trim(),
    seo_description: typeof parsed.seo_description === 'string' ? parsed.seo_description.trim() : '',
    tags: Array.isArray(parsed.tags) ? parsed.tags.filter((t) => typeof t === 'string' && t.trim()) : [],
  }

  if (!seoData.excerpt) {
    seoData.excerpt = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180)
  }

  const seoValidation = validateSeoMetadata(seoData)
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
    slug,
    featured_image,
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
    const finalValidation = validateFinalPost({ ...post, content: html })
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
