const TEMPLATES = {
  mice: {
    version: 1,
    system: `당신은 한국의 전문 MICE 산업 콘텐츠 작가입니다.
학술대회, 전시회, 하이브리드 이벤트, 컨벤션 등 MICE 분야의 전문적인 블로그 글을 작성합니다.
반드시 엄격한 JSON 형식만 반환합니다.
JSON 키: html, excerpt, seo_title, seo_description, tags
html은 시맨틱 HTML(h2, h3, p, ul, li, strong, em, blockquote)을 사용합니다. 코드 블록으로 감싸지 마세요.`,
    user: (ctx) => [
      `제목: ${ctx.title}`,
      `주제: ${ctx.topic}`,
      `어조: ${ctx.toneLabel}`,
      `목표 길이: ${ctx.lengthGuide}`,
      `키워드: ${ctx.keywords?.join(', ') ?? ''}`,
      ctx.source_text ? `참고 자료:\n${ctx.source_text}` : '',
      '',
      '요구사항:',
      '- 자연스럽고 전문적인 한국어로 작성',
      '- MICE 산업 전문 용어를 정확하게 사용',
      '- 실무적인 인사이트와 구체적인 예시 포함',
      '- 서론에서 독자의 관심을 끌고 문제 의식 제시',
      '- 본론에서 해결책이나 가이드를 단계별로 제시',
      '- 결론에 명확한 CTA(행동 유도) 포함',
      '- SEO 친화적인 제목 구조와 헤딩 계층',
      '- 마크다운 사용 금지, HTML만 사용',
      '',
      '반환 JSON: { "html": "...", "excerpt": "...", "seo_title": "...", "seo_description": "...", "tags": ["..."] }',
    ].filter(Boolean).join('\n'),
  },
  marketing: {
    version: 1,
    system: `당신은 한국의 전문 디지털 마케팅 콘텐츠 작가입니다.
콘텐츠 마케팅, SNS 마케팅, 디지털 광고, 브랜딩 등 마케팅 분야의 실용적인 블로그 글을 작성합니다.
반드시 엄격한 JSON 형식만 반환합니다.
JSON 키: html, excerpt, seo_title, seo_description, tags
html은 시맨틱 HTML(h2, h3, p, ul, li, strong, em, blockquote)을 사용합니다. 코드 블록으로 감싸지 마세요.`,
    user: (ctx) => [
      `제목: ${ctx.title}`,
      `주제: ${ctx.topic}`,
      `어조: ${ctx.toneLabel}`,
      `목표 길이: ${ctx.lengthGuide}`,
      `키워드: ${ctx.keywords?.join(', ') ?? ''}`,
      ctx.source_text ? `참고 자료:\n${ctx.source_text}` : '',
      '',
      '요구사항:',
      '- 자연스럽고 전문적인 한국어로 작성',
      '- 마케팅 트렌드와 실전 팁을 균형 있게 포함',
      '- 데이터나 통계로 주장을 뒷받침',
      '- 독자가 바로 실천할 수 있는 구체적인 액션 아이템 제시',
      '- 서론에서 공감대를 형성하고 페인포인트 제시',
      '- 본론에서 해결책을 체계적으로 정리',
      '- 결론에 명확한 CTA 포함',
      '- SEO 친화적인 제목 구조와 헤딩 계층',
      '- 마크다운 사용 금지, HTML만 사용',
      '',
      '반환 JSON: { "html": "...", "excerpt": "...", "seo_title": "...", "seo_description": "...", "tags": ["..."] }',
    ].filter(Boolean).join('\n'),
  },
  company: {
    version: 1,
    system: `당신은 한국의 기업 소식 및 PR 콘텐츠 작가입니다.
회사 소식, 서비스 업데이트, 팀 소개, 성공 사례 등을 전문적이고 친근하게 작성합니다.
반드시 엄격한 JSON 형식만 반환합니다.
JSON 키: html, excerpt, seo_title, seo_description, tags
html은 시맨틱 HTML(h2, h3, p, ul, li, strong, em, blockquote)을 사용합니다. 코드 블록으로 감싸지 마세요.`,
    user: (ctx) => [
      `제목: ${ctx.title}`,
      `주제: ${ctx.topic}`,
      `어조: ${ctx.toneLabel}`,
      `목표 길이: ${ctx.lengthGuide}`,
      `키워드: ${ctx.keywords?.join(', ') ?? ''}`,
      ctx.source_text ? `참고 자료:\n${ctx.source_text}` : '',
      '',
      '요구사항:',
      '- 자연스럽고 친근한 한국어로 작성',
      '- 회사의 전문성과 신뢰감을 잘 드러낼 것',
      '- 구체적인 사례와 결과를 포함',
      '- 독자가 회사 서비스에 관심을 갖도록 자연스럽게 유도',
      '- 마크다운 사용 금지, HTML만 사용',
      '',
      '반환 JSON: { "html": "...", "excerpt": "...", "seo_title": "...", "seo_description": "...", "tags": ["..."] }',
    ].filter(Boolean).join('\n'),
  },
}

const TONE_LABELS = {
  professional: '전문적이고 신뢰감 있는 어조',
  casual: '친근하고 쉬운 어조',
  informative: '객관적이고 정보 전달 중심의 어조',
  persuasive: '설득력 있고 행동을 유도하는 어조',
}

const LENGTH_GUIDES = {
  short: '300~500자, 2~3개 섹션',
  medium: '800~1500자, 4~6개 섹션',
  long: '2000~4000자, 6~10개 섹션',
}

function getBlogPromptTemplate(category = 'marketing', tone = 'professional') {
  const cat = TEMPLATES[category] ?? TEMPLATES.marketing
  return {
    version: cat.version,
    category: category || 'marketing',
    tone: tone || 'professional',
    system: cat.system,
    buildUserPrompt: cat.user,
    toneLabel: TONE_LABELS[tone] ?? TONE_LABELS.professional,
  }
}

function resolveLengthGuide(targetLength) {
  return LENGTH_GUIDES[targetLength] ?? LENGTH_GUIDES.medium
}

export { getBlogPromptTemplate, resolveLengthGuide, TEMPLATES, TONE_LABELS, LENGTH_GUIDES }
