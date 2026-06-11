// ─── 구조 템플릿 (검색 의도별 글 골격 다양화) ─────────────────────────────────
// 모든 글이 같은 구조(서론 h2 + 본론 2~3 + 결론 h2)로 생성되면 검색엔진이
// 자동 생성 패턴으로 학습하기 쉽고 유사문서 판정에 불리하다.
// 글마다 구조를 다르게 배정해 footprint를 줄인다.

const STRUCTURES = {
  guide: {
    label: '단계별 가이드형',
    guide: [
      '- 짧은 서론(문제 제기, h2 없이 시작 가능) → 단계별 실행 가이드(각 단계를 h2로 구분) → 흔한 실수/주의사항 → 마무리 제언',
      '- 각 단계 제목은 "1단계: ..." 같은 기계적 표기 대신 행동 중심 문장으로 작성',
    ].join('\n'),
  },
  comparison: {
    label: '비교형',
    guide: [
      '- 서론(선택 고민 제시) → 비교 기준 정의 → 항목별 비교(목록 또는 표) → 상황별 추천 → 마무리 제언',
      '- 비교 대상의 장단점을 한쪽으로 치우치지 않게 서술',
    ].join('\n'),
  },
  qna: {
    label: 'Q&A형',
    guide: [
      '- 짧은 서론(주제 개요) → 독자가 실제 검색창에 입력할 법한 질문 4~6개를 각각 h2로 배치하고 바로 아래에 명확한 답변 → 마무리 제언',
      '- 질문은 의문문 그대로 작성 (예: "학술대회 등록 시스템 비용은 얼마나 드나요?")',
    ].join('\n'),
  },
  case_study: {
    label: '사례형',
    guide: [
      '- 서론(상황/과제 소개) → 배경과 문제 → 해결 과정 → 결과와 배운 점 → 적용 팁',
      '- 구체적 수치를 단정할 수 없으면 "운영 환경에 따라" 식으로 조건을 명시',
    ].join('\n'),
  },
  checklist: {
    label: '체크리스트형',
    guide: [
      '- 서론(준비 부족 시 리스크) → 영역별 체크리스트(영역을 h2로 구분, 항목은 ul/li) → 우선순위 정리 → 마무리 제언',
      '- 체크 항목은 실행 여부를 판단할 수 있는 구체적 문장으로 작성',
    ].join('\n'),
  },
}

function pickStructure(structure, seedText = '') {
  if (structure && STRUCTURES[structure]) return structure
  const keys = Object.keys(STRUCTURES)
  let hash = 0
  for (const ch of String(seedText)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return keys[hash % keys.length]
}

// ─── 공통 규칙 ────────────────────────────────────────────────────────────────

const COMMON_HTML_RULES = `html 작성 규칙 (반드시 지킬 것):
- h2 태그를 최소 3개 이상 사용하여 글을 구조화 (구조 지침을 따를 것)
- 각 h2 섹션 아래에 p, ul, li, blockquote 등을 적절히 사용
- h1 태그 사용 금지
- 코드 블록이나 마크다운 문법 사용 금지
- 순수 HTML만 출력`

const COMMON_SEO_RULES = `SEO 작성 규칙:
- 첫 번째 키워드를 핵심 키워드로 보고 seo_title, seo_description, 첫 문단, h2 중 1개 이상에 자연스럽게 포함
- seo_title은 25~60자, 검색자가 클릭할 구체적 효익을 포함
- seo_description은 70~155자, 문제-해결-대상을 한 문장으로 요약
- tags는 3~8개, 너무 포괄적인 단어보다 실제 검색어에 가까운 구체어 사용
- 출처 없는 숫자, 성과, 통계는 단정하지 말고 "예를 들어", "운영 환경에 따라"처럼 조건을 밝힘
- faq는 검색자가 실제로 묻는 질문 2~4개와 각 1~3문장의 간결한 답변으로 구성 (본문 내용의 단순 반복 금지, 본문에서 다루지 못한 실무 질문 위주)`

const JSON_CONTRACT = `반드시 엄격한 JSON 형식만 반환합니다.
JSON 키: html, excerpt, seo_title, seo_description, tags, faq
faq 형식: [{ "q": "질문", "a": "답변" }]`

function buildSystemPrompt(roleDescription) {
  return [roleDescription, JSON_CONTRACT, '', COMMON_HTML_RULES, '', COMMON_SEO_RULES].join('\n')
}

// ─── 사용자 프롬프트 공통 빌더 ────────────────────────────────────────────────

function buildContextLines(ctx) {
  return [
    `제목: ${ctx.title}`,
    `주제: ${ctx.topic}`,
    `어조: ${ctx.toneLabel}`,
    `목표 길이: ${ctx.lengthGuide}`,
    `키워드: ${ctx.keywords?.join(', ') ?? ''}`,
    ctx.source_text ? `참고 자료:\n${ctx.source_text}` : '',
  ]
}

function buildStructureLines(ctx) {
  const structureKey = ctx.structure && STRUCTURES[ctx.structure] ? ctx.structure : 'guide'
  const structure = STRUCTURES[structureKey]
  return ['', `글 구조 지침 (${structure.label}):`, structure.guide]
}

function buildInternalLinkLines(ctx) {
  const posts = Array.isArray(ctx.recent_posts) ? ctx.recent_posts.filter((p) => p?.title && p?.url) : []
  if (!posts.length) return []
  return [
    '',
    '기존 발행 글 목록 (내부 링크용):',
    ...posts.slice(0, 12).map((p) => `- ${p.title} → ${p.url}`),
    '',
    '내부 링크 규칙:',
    '- 위 목록에서 이번 글과 주제가 실제로 관련 있는 글 1~2개를 골라 본문 문장 속에 <a href="URL">자연스러운 앵커 텍스트</a> 형태로 링크할 것',
    '- 관련 있는 글이 없으면 억지로 넣지 말고 생략할 것',
  ]
}

const RETURN_LINE = '반환 JSON: { "html": "...", "excerpt": "...", "seo_title": "...", "seo_description": "...", "tags": ["..."], "faq": [{ "q": "...", "a": "..." }] }'

function buildUserPrompt(ctx, requirements) {
  return [
    ...buildContextLines(ctx),
    ...buildStructureLines(ctx),
    ...buildInternalLinkLines(ctx),
    '',
    '요구사항:',
    ...requirements,
    '- SEO 친화적인 제목 구조와 헤딩 계층',
    '- 마크다운 사용 금지, HTML만 사용',
    '',
    RETURN_LINE,
  ].filter(Boolean).join('\n')
}

// ─── 카테고리 템플릿 ─────────────────────────────────────────────────────────

const TEMPLATES = {
  mice: {
    version: 4,
    system: buildSystemPrompt(`당신은 한국의 전문 MICE 산업 콘텐츠 작가입니다.
학술대회, 전시회, 하이브리드 이벤트, 컨벤션 등 MICE 분야의 전문적인 블로그 글을 작성합니다.`),
    user: (ctx) => buildUserPrompt(ctx, [
      '- 자연스럽고 전문적인 한국어로 작성',
      '- MICE 산업 전문 용어를 정확하게 사용',
      '- 실무적인 인사이트와 구체적인 예시 포함',
      '- 서론에서 독자의 관심을 끌고 문제 의식 제시',
      '- 결론에 명확한 CTA(행동 유도) 포함',
    ]),
  },
  marketing: {
    version: 4,
    system: buildSystemPrompt(`당신은 한국의 전문 디지털 마케팅 콘텐츠 작가입니다.
콘텐츠 마케팅, SNS 마케팅, 디지털 광고, 브랜딩 등 마케팅 분야의 실용적인 블로그 글을 작성합니다.`),
    user: (ctx) => buildUserPrompt(ctx, [
      '- 자연스럽고 전문적인 한국어로 작성',
      '- 마케팅 트렌드와 실전 팁을 균형 있게 포함',
      '- 참고 자료에 있는 데이터나 통계만 단정적으로 사용',
      '- 독자가 바로 실천할 수 있는 구체적인 액션 아이템 제시',
      '- 결론에 명확한 CTA 포함',
    ]),
  },
  company: {
    version: 4,
    system: buildSystemPrompt(`당신은 한국의 기업 소식 및 PR 콘텐츠 작가입니다.
회사 소식, 서비스 업데이트, 팀 소개, 성공 사례 등을 전문적이고 친근하게 작성합니다.`),
    user: (ctx) => buildUserPrompt(ctx, [
      '- 자연스럽고 친근한 한국어로 작성',
      '- 회사의 전문성과 신뢰감을 잘 드러낼 것',
      '- 구체적인 사례와 결과를 포함',
      '- 독자가 회사 서비스에 관심을 갖도록 자연스럽게 유도',
    ]),
  },
}

const TONE_LABELS = {
  professional: '전문적이고 신뢰감 있는 어조',
  casual: '친근하고 쉬운 어조',
  informative: '객관적이고 정보 전달 중심의 어조',
  persuasive: '설득력 있고 행동을 유도하는 어조',
}

const LENGTH_GUIDES = {
  short: '500~800자, h2 3~4개 섹션',
  medium: '1200~1800자, h2 3~6개 섹션',
  long: '2200~3500자, h2 5~8개 섹션',
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

export { getBlogPromptTemplate, resolveLengthGuide, pickStructure, STRUCTURES, TEMPLATES, TONE_LABELS, LENGTH_GUIDES }
