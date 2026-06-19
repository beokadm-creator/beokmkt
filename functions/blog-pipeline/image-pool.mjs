import { HONGCOMM_BLOG_IMAGES, HONGCOMM_PORTFOLIO_IMAGES, stableIndex } from '../blog-images.mjs'

// 이미지를 주제 태그로 분류 — 글 키워드와 겹치는 그룹에서만 선택
const IMAGE_POOL = {
  mice: [
    { url: 'https://hongcomm.kr/img/page/a1.png', alt: '학술대회 등록 시스템 화면', tags: ['등록', '접수', '시스템', '학술대회', '초록', '학회'] },
    { url: 'https://hongcomm.kr/img/page/a5.png', alt: '학술대회 온라인 결제 화면', tags: ['결제', '등록', '시스템', '학술대회', '접수'] },
    { url: 'https://hongcomm.kr/img/page/b2.png', alt: '모바일 디지털 명찰', tags: ['명찰', '현장', '체크인', '디지털', '출입'] },
    { url: 'https://hongcomm.kr/img/page/b1.png', alt: '행사 바우처', tags: ['바우처', '현장', '행사', '참가'] },
    { url: 'https://hongcomm.kr/img/page/c1.jpg', alt: '실제 명찰 출력 예시', tags: ['명찰', '현장', '체크인', '출력'] },
    { url: 'https://hongcomm.kr/img/page/2.jpg', alt: '고속 명찰 출력 기기', tags: ['명찰', '현장', '체크인', '출력', '기기'] },
    { url: 'https://hongcomm.kr/img/page/6.jpg', alt: '마스터 컨트롤러', tags: ['컨트롤', '운영', '관리', '현장', '시스템'] },
    { url: 'https://hongcomm.kr/img/page/3.jpg', alt: '수강출입 인증 대기화면', tags: ['인증', '출입', '체크인', '현장', 'QR'] },
    { url: 'https://hongcomm.kr/img/page/4.jpg', alt: '수강출입 인증 완료화면', tags: ['인증', '출입', '체크인', '현장', 'QR'] },
    { url: 'https://hongcomm.kr/theme/basic/img/kaid.png', alt: 'KAID 학회 홈페이지', tags: ['학회', '홈페이지', '학술대회', '솔루션'] },
    { url: 'https://hongcomm.kr/theme/basic/img/kr.png', alt: 'AI 동시통역 발화 최적화', tags: ['동시통역', '통역', '번역', 'AI', '언어'] },
    { url: 'https://hongcomm.kr/theme/basic/img/en.png', alt: 'AI 동시통역 문맥 번역', tags: ['동시통역', '통역', '번역', 'AI', '언어'] },
    ...HONGCOMM_PORTFOLIO_IMAGES,
  ],
  marketing: [
    { url: 'https://beokmkt.web.app/assets/blog/beok/seo-card.svg', alt: '비오케이솔루션 검색 노출 기본 세팅 카드', tags: ['SEO', '검색', '노출', '구글', '서치콘솔', '사이트맵', '색인', '메타', '마케팅'] },
    { url: 'https://beokmkt.web.app/assets/blog/beok/automation-card.svg', alt: '비오케이솔루션 예약 결제 알림 자동화 카드', tags: ['콘텐츠', '자동화', '예약', '결제', '알림톡', 'AI', '문의', '응대', '폼'] },
    { url: 'https://beokmkt.web.app/assets/blog/beok/workflow-card.svg', alt: '비오케이솔루션 홈페이지 운영 흐름 카드', tags: ['브랜딩', '캠페인', '전략', '홈페이지', '운영', '개선', '전환'] },
    { url: 'https://beokmkt.web.app/assets/blog/beok/checklist-card.svg', alt: '비오케이솔루션 홈페이지 운영 체크리스트 카드', tags: ['체크리스트', '준비', '주의', '필수', '방법', '단계', '확인', '운영'] },
    { url: 'https://hongcomm.kr/img/page/a1.png', alt: '온라인 등록과 접수 시스템 화면', tags: ['마케팅', '디지털', '성과', '대시보드', '분석', '등록', '접수', '시스템'] },
    { url: 'https://hongcomm.kr/img/page/6.jpg', alt: '행사 운영 통합 관리 시스템 화면', tags: ['콘텐츠', '자동화', '분석', '데이터', '전략', '운영', '관리', '시스템'] },
    { url: 'https://hongcomm.kr/theme/basic/img/kaid.png', alt: '마케팅 랜딩페이지와 홈페이지 사례', tags: ['홈페이지', '랜딩페이지', '브랜딩', '전환', '솔루션'] },
    ...HONGCOMM_PORTFOLIO_IMAGES.slice(0, 16),
  ],
  company: [
    { url: 'https://beokmkt.web.app/assets/blog/beok/workflow-card.svg', alt: '비오케이솔루션 홈페이지 운영 흐름 카드', tags: ['홈페이지', '제작', '운영', '관리', '문의', '개선', '서비스'] },
    { url: 'https://beokmkt.web.app/assets/blog/beok/seo-card.svg', alt: '비오케이솔루션 검색 노출 기본 세팅 카드', tags: ['SEO', '검색', '노출', '구글', '서치콘솔', '사이트맵', '메타'] },
    { url: 'https://beokmkt.web.app/assets/blog/beok/automation-card.svg', alt: '비오케이솔루션 예약 결제 알림 자동화 카드', tags: ['예약', '결제', '알림톡', 'AI', '자동화', '문의', '응대', '폼'] },
    { url: 'https://beokmkt.web.app/assets/blog/beok/checklist-card.svg', alt: '비오케이솔루션 홈페이지 운영 체크리스트 카드', tags: ['체크리스트', '준비', '주의', '필수', '방법', '단계', '확인', '운영'] },
    { url: 'https://hongcomm.kr/img/page/a1.png', alt: '맞춤 시스템 화면 예시', tags: ['시스템', '소프트웨어', '개발', '관리자', '대시보드'] },
    { url: 'https://hongcomm.kr/img/page/a5.png', alt: '결제 연동 시스템 화면', tags: ['결제', 'API', '연동', '시스템'] },
    { url: 'https://hongcomm.kr/img/page/6.jpg', alt: '행사 관리 마스터 컨트롤러', tags: ['관리', '관리자', '운영', '시스템'] },
    { url: 'https://beoksolution.com/img/logo.png', alt: '비오케이솔루션 홈페이지 제작 운영 서비스 로고', tags: ['홈페이지', '제작', '구독', '운영', 'SEO', '예약', '결제', '알림톡', 'AI', '자동화'] },
    ...HONGCOMM_BLOG_IMAGES.slice(0, 20),
  ],
}

function selectImages(category, keywords = [], title = '') {
  const pool = IMAGE_POOL[category] || IMAGE_POOL.mice
  const searchText = `${title} ${keywords.join(' ')}`.toLowerCase()

  const uniquePool = [...new Map(pool.map((img) => [img.url, img])).values()]
  const scored = uniquePool.map((img) => {
    const matchCount = img.tags.filter((tag) => searchText.includes(tag.toLowerCase())).length
    return { ...img, score: matchCount }
  })

  const maxScore = Math.max(...scored.map((img) => img.score))
  const eligible = scored
    .filter((img) => img.score >= Math.max(0, maxScore - 1))
    .sort((a, b) => a.url.localeCompare(b.url))
  const start = stableIndex(`${category}|${title}|${keywords.join('|')}`, eligible.length)
  return [...eligible.slice(start), ...eligible.slice(0, start)].slice(0, 3)
}

export { IMAGE_POOL, selectImages }
