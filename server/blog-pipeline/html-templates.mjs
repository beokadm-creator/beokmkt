const COMPANY_BRANDING = {
  mice: {
    site: 'hongcomm.kr',
    name: '홍커뮤니케이션',
    logo_url: 'https://beokmkt.web.app/assets/hongcomm-logo.png',
    tagline: 'MICE 행사기획 · IT 솔루션 · 동시통역',
    cta_text: '학술행사·국제회의·컨퍼런스 운영을 기획부터 현장까지 지원합니다.',
    cta_link: 'https://hongcomm.kr',
    cta_button: '홍커뮤니케이션 문의하기',
  },
  marketing: {
    site: 'hongcomm.kr',
    name: '홍커뮤니케이션',
    logo_url: 'https://beokmkt.web.app/assets/hongcomm-logo.png',
    tagline: 'MICE 행사기획 · IT 솔루션 · 동시통역',
    cta_text: '디지털 마케팅과 콘텐츠 전략이 필요하신가요?',
    cta_link: 'https://hongcomm.kr',
    cta_button: '홍커뮤니케이션 문의하기',
  },
  company: {
    site: 'beoksolution.com',
    name: '비오케이솔루션',
    logo_url: 'https://beokmkt.web.app/assets/beoksolution-logo.png',
    tagline: '맞춤 소프트웨어 · 예약시스템 · 관리자 · 플랫폼',
    cta_text: '맞춤 소프트웨어 개발, 예약 시스템, 관리자 대시보드를 제안드립니다.',
    cta_link: 'https://beoksolution.com',
    cta_button: '비오케이솔루션 상담 신청',
  },
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function applyHtmlTemplate(rawHtml, options = {}) {
  if (!rawHtml || typeof rawHtml !== 'string') return rawHtml

  let html = rawHtml.trim()

  // 코드 펜스 제거
  if (html.startsWith('```')) {
    const match = html.match(/```(?:html)?\s*([\s\S]*?)```/)
    if (match?.[1]) html = match[1].trim()
  }

  // html/body 래퍼 제거
  html = html.replace(/^<html[^>]*>[\s\S]*?<body[^>]*>/i, '').replace(/<\/body>\s*<\/html>\s*$/i, '')

  const category = options.category || 'marketing'
  const brand = COMPANY_BRANDING[category] || COMPANY_BRANDING.marketing

  const sections = []

  // 회사 헤더 배너
  sections.push(`<div class="not-prose mb-8 rounded-xl border border-zinc-800 bg-zinc-900/60 p-5 flex items-center gap-4">
  <div class="shrink-0">
    <div class="h-10 w-10 rounded-lg bg-zinc-800 flex items-center justify-center text-lg font-bold text-zinc-300">${brand.name.charAt(0)}</div>
  </div>
  <div>
    <p class="text-sm font-semibold text-zinc-100">${escapeHtml(brand.name)}</p>
    <p class="text-xs text-zinc-400">${escapeHtml(brand.tagline)}</p>
  </div>
</div>`)

  // 본문
  sections.push(html)

  // CTA 푸터 (커스텀 또는 기본)
  const ctaText = options.cta_text || brand.cta_text
  const ctaLink = options.cta_link || brand.cta_link
  const ctaButton = options.cta_button_text || brand.cta_button

  sections.push(`<div class="not-prose mt-10 rounded-xl border border-zinc-700 bg-gradient-to-br from-zinc-800/60 to-zinc-900/80 p-6 text-center">
  <p class="text-base text-zinc-200">${escapeHtml(ctaText)}</p>
  <a href="${escapeHtml(ctaLink)}" target="_blank" rel="noopener" class="mt-4 inline-block rounded-lg bg-blue-600 px-6 py-2.5 text-sm font-medium text-white hover:bg-blue-700 transition-colors">${escapeHtml(ctaButton)}</a>
  <p class="mt-3 text-xs text-zinc-500">${escapeHtml(brand.name)} — ${escapeHtml(brand.site)}</p>
</div>`)

  return sections.filter(Boolean).join('\n')
}

export { applyHtmlTemplate, COMPANY_BRANDING }
