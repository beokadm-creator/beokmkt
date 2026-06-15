export type BlogAxisKey = 'conference' | 'web' | 'systems' | 'mice' | 'insight'

export type BlogAxis = {
  key: BlogAxisKey
  label: string
  shortLabel: string
  description: string
  terms: string[]
  accent: string
}

export const BLOG_SITE_NAME = '비오케이솔루션 · 홍커뮤니케이션 블로그'
export const BLOG_SITE_DESCRIPTION =
  '비오케이솔루션의 홈페이지·맞춤형 시스템 개발과 홍커뮤니케이션의 MICE·학술대회 운영 레퍼런스를 다루는 공식 실무 블로그입니다.'

export const BLOG_BRANDS = [
  {
    key: 'beoksolution',
    name: '비오케이솔루션',
    label: '홈페이지·맞춤형 시스템 개발',
    description: '홈페이지 제작, 관리자 대시보드, 업무 자동화, 예약·결제·문자·이메일 API 연동을 설계합니다.',
    href: 'https://beoksolution.com',
    accent: 'text-yellow-200',
  },
  {
    key: 'hongcomm',
    name: '홍커뮤니케이션',
    label: 'MICE·학술대회 운영',
    description: '국제회의, 학술대회, 동시통역, 참가자 등록, 초록 접수, 현장 운영 레퍼런스를 다룹니다.',
    href: 'https://hongcomm.kr',
    accent: 'text-orange-200',
  },
] as const

export const BLOG_AXES: BlogAxis[] = [
  {
    key: 'conference',
    label: '학회 운영·명찰 출력',
    shortLabel: '학회운영',
    description: '참가자 데이터, QR·바코드, 현장 접수, 명찰 출력과 재발행 기준을 정리합니다.',
    terms: ['학회', '학술대회', '명찰', '사무국', '참가자', '접수', '출력', '발행', '재발행', 'QR', '바코드'],
    accent: 'text-yellow-200',
  },
  {
    key: 'web',
    label: '홈페이지 제작·운영',
    shortLabel: '홈페이지',
    description: '구독형 홈페이지, 반응형 웹, 신청폼, 검색 노출, 유지관리 기준을 다룹니다.',
    terms: ['홈페이지', '웹사이트', '반응형', 'SEO', '서치콘솔', '신청폼', '문의폼', '예약', '결제', 'SSL'],
    accent: 'text-sky-200',
  },
  {
    key: 'systems',
    label: '맞춤형 시스템 개발',
    shortLabel: '시스템개발',
    description: '관리자, 업무 자동화, 접수·결제·알림톡 연동처럼 운영을 줄이는 개발 사례를 정리합니다.',
    terms: ['시스템', '개발', '관리자', '자동화', '알림톡', 'DB', '데이터', '솔루션', '연동', '셀프호스팅'],
    accent: 'text-emerald-200',
  },
  {
    key: 'mice',
    label: '홍커뮤니케이션·MICE',
    shortLabel: 'MICE',
    description: '국제회의, 컨퍼런스, 동시통역, 학술대회 IT 시스템과 행사 운영 레퍼런스를 다룹니다.',
    terms: ['홍커뮤니케이션', 'MICE', '국제회의', '컨퍼런스', '동시통역', '전시회', '세미나', '레퍼런스', '포트폴리오'],
    accent: 'text-orange-200',
  },
]

export function classifyBlogAxis(post: {
  title?: string | null
  category?: string | null
  tags?: string[] | null
  excerpt?: string | null
  seo_description?: string | null
}) {
  const haystack = [
    post.title,
    post.category,
    post.excerpt,
    post.seo_description,
    ...(post.tags ?? []),
  ].filter(Boolean).join(' ')

  let best = BLOG_AXES[0]
  let bestScore = 0
  for (const axis of BLOG_AXES) {
    const score = axis.terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0)
    if (score > bestScore) {
      best = axis
      bestScore = score
    }
  }

  if (bestScore === 0) {
    return {
      key: 'insight' as const,
      label: post.category || '운영 인사이트',
      shortLabel: post.category || '인사이트',
      description: '비오케이솔루션 운영 인사이트',
      terms: [],
      accent: 'text-zinc-200',
    }
  }
  return best
}
