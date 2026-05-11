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
  ],
  marketing: [
    { url: 'https://images.unsplash.com/photo-1460925895917-afdab827c52f?auto=format&fit=crop&w=1600&q=80', alt: '디지털 마케팅 성과 대시보드', tags: ['마케팅', '디지털', '성과', '대시보드', '분석', 'SEO'] },
    { url: 'https://images.unsplash.com/photo-1551288049-bebda4e38f71?auto=format&fit=crop&w=1600&q=80', alt: '콘텐츠 마케팅 데이터 분석 화면', tags: ['콘텐츠', '콘텐츠 마케팅', '자동화', '분석', '데이터', '전략'] },
    { url: 'https://images.unsplash.com/photo-1557804506-669a67965ba0?auto=format&fit=crop&w=1600&q=80', alt: '마케팅 전략 회의와 캠페인 기획', tags: ['브랜딩', '광고', '캠페인', 'SNS', '전략', '마케팅'] },
    { url: 'https://hongcomm.kr/theme/basic/img/kaid.png', alt: '마케팅 랜딩페이지와 홈페이지 사례', tags: ['홈페이지', '랜딩페이지', '브랜딩', '전환', '솔루션'] },
  ],
  company: [
    { url: 'https://hongcomm.kr/img/page/a1.png', alt: '맞춤 시스템 화면 예시', tags: ['시스템', '소프트웨어', '개발', '관리자', '대시보드'] },
    { url: 'https://hongcomm.kr/img/page/a5.png', alt: '결제 연동 시스템 화면', tags: ['결제', 'API', '연동', '시스템'] },
    { url: 'https://hongcomm.kr/img/page/6.jpg', alt: '행사 관리 마스터 컨트롤러', tags: ['관리', '관리자', '운영', '시스템'] },
  ],
}

function selectImages(category, keywords = [], title = '') {
  const pool = IMAGE_POOL[category] || IMAGE_POOL.mice
  const searchText = `${title} ${keywords.join(' ')}`.toLowerCase()

  const scored = pool.map((img) => {
    const matchCount = img.tags.filter((tag) => searchText.includes(tag.toLowerCase())).length
    return { ...img, score: matchCount }
  }).filter((img) => img.score > 0)

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.url.localeCompare(b.url)
  })
  return scored.slice(0, 2)
}

export { IMAGE_POOL, selectImages }
