import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { applySeo } from '../lib/seo'

type BlogPost = {
  id: string
  title: string
  excerpt: string
  category: string
  tags: string[]
  slug: string
  seo_description?: string
  featured_image?: string | null
  published_at: string | null
  created_at: string
}

type ListResponse = { items: BlogPost[]; total: number }

const KAKAO_CHAT_URL = 'https://pf.kakao.com/_wxexmxgn/chat'

const plans = [
  {
    name: '라이트 관리형',
    price: '월 5만원',
    label: '일반 홈페이지',
    description: '초기 제작비 없이 회사소개, 서비스 소개, 문의 연결까지 빠르게 시작하는 기본형입니다.',
    features: ['초기 제작비 0원', '1~5페이지 반응형 홈페이지', '서버/SSL/기본 유지관리 포함', '기본 SEO/Search Console 세팅', '텍스트·이미지 수정 월 1회'],
  },
  {
    name: '성장 관리형',
    price: '월 20만원',
    label: '예약·결제·알림톡',
    description: '문의와 신청을 실제 운영 데이터로 연결해야 하는 사업자를 위한 운영형 홈페이지입니다.',
    features: ['라이트 포함', '예약·신청폼·결제 연동', '알림톡/SMS/이메일 연동', '관리자 페이지와 고객 데이터 관리', '수정 월 5회 및 월간 점검'],
  },
  {
    name: '프리미엄 운영형',
    price: '월 50만원~',
    label: 'AI·자동화·커스텀',
    description: '상담, 콘텐츠, 고객관리, 업무 자동화까지 맞춤형 시스템으로 확장하는 구독형 플랫폼입니다.',
    features: ['라이트+성장 포함', '완전 맞춤 기능 설계', 'AI 상담/콘텐츠/견적 엔진 도입', 'CRM·대시보드·외부 API 연동', '우선 대응 및 월간 개선 리포트'],
  },
]

const aiFeatures = [
  '문의 내용을 자동 분류하고 답변 초안을 만드는 AI 상담 엔진',
  '블로그, FAQ, 공지 초안을 생성하는 AI 콘텐츠 엔진',
  '상담 내용을 바탕으로 예상 견적 범위를 정리하는 AI 견적 보조',
  '예약·결제·문의 데이터를 요약하는 운영 리포트 자동화',
]

export default function PublicBlogPage() {
  const [data, setData] = useState<ListResponse | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const posts = data?.items ?? []

  useEffect(() => {
    fetch('/api/blog-posts?status=published&limit=50')
      .then(r => r.json())
      .then(d => setData(d?.data ?? d))
      .catch(() => {})
      .finally(() => setIsLoading(false))
  }, [])

  useEffect(() => {
    const canonical = `${window.location.origin}/blog/`
    applySeo({
      title: '초기 제작비 0원 홈페이지 구독 서비스 | 홍커뮤니케이션',
      description: '월 5만원 라이트 홈페이지부터 예약, 결제, 알림톡, AI 자동화까지 확장하는 구독형 홈페이지 제작·운영 서비스입니다.',
      canonical,
      type: 'website',
      keywords: ['홈페이지 구독', '초기 제작비 무료', '홈페이지 유지관리', '예약 시스템', '결제 연동', '알림톡', 'AI 자동화'],
      jsonLd: [
        {
          '@context': 'https://schema.org',
          '@type': 'Service',
          name: '홈페이지 구독형 제작·운영 서비스',
          description: '초기 제작비 없이 홈페이지 제작, 서버, 유지관리, SEO, 예약·결제·알림톡, AI 자동화까지 단계별로 제공하는 구독 서비스',
          provider: {
            '@type': 'Organization',
            name: '홍커뮤니케이션',
            url: window.location.origin,
          },
          areaServed: 'KR',
          hasOfferCatalog: {
            '@type': 'OfferCatalog',
            name: '홈페이지 구독 요금제',
            itemListElement: plans.map((plan) => ({
              '@type': 'Offer',
              name: plan.name,
              description: plan.description,
              priceCurrency: 'KRW',
            })),
          },
          url: canonical,
        },
        {
          '@context': 'https://schema.org',
          '@type': 'Blog',
          name: '홍커뮤니케이션 레퍼런스와 인사이트',
          description: '홈페이지 제작, 행사 운영, 예약 시스템, AI 자동화 관련 실무형 인사이트',
          url: canonical,
          inLanguage: 'ko-KR',
          publisher: {
            '@type': 'Organization',
            name: '홍커뮤니케이션',
            url: window.location.origin,
          },
        },
        {
          '@context': 'https://schema.org',
          '@type': 'BreadcrumbList',
          itemListElement: [
            {
              '@type': 'ListItem',
              position: 1,
              name: '블로그',
              item: canonical,
            },
          ],
        },
        {
          '@context': 'https://schema.org',
          '@type': 'ItemList',
          itemListElement: posts.slice(0, 20).map((post, index) => ({
            '@type': 'ListItem',
            position: index + 1,
            url: `${window.location.origin}/blog/${encodeURIComponent(post.slug || post.id)}`,
            name: post.title,
          })),
        },
      ],
    })
  }, [posts])

  if (isLoading) {
    return (
      <div className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center">
        <p className="text-zinc-500 text-sm">불러오는 중…</p>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800 bg-zinc-950">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link to="/blog/" className="text-sm font-semibold tracking-tight text-white">홍커뮤니케이션</Link>
          <nav className="hidden items-center gap-6 text-sm text-zinc-400 md:flex">
            <a href="#plans" className="hover:text-white">요금제</a>
            <a href="#ai" className="hover:text-white">AI 운영</a>
            <a href="#references" className="hover:text-white">레퍼런스</a>
          </nav>
          <a
            href={KAKAO_CHAT_URL}
            target="_blank"
            rel="noreferrer"
            className="rounded-md bg-yellow-300 px-4 py-2 text-sm font-semibold text-zinc-950 hover:bg-yellow-200"
          >
            카카오톡 문의
          </a>
        </div>
      </header>

      <main>
        <section className="border-b border-zinc-800">
          <div className="mx-auto grid max-w-6xl gap-10 px-6 py-16 lg:grid-cols-[1.1fr_0.9fr] lg:py-20">
            <div>
              <p className="text-sm font-medium text-yellow-300">초기 제작비 0원 · 서버비와 유지관리 포함</p>
              <h1 className="mt-4 max-w-3xl text-4xl font-bold leading-tight tracking-tight text-white md:text-5xl">
                홈페이지를 만들고 끝내지 말고, 매달 운영되는 영업 시스템으로 시작하세요.
              </h1>
              <p className="mt-5 max-w-2xl text-base leading-7 text-zinc-400">
                월 5만원 라이트 홈페이지부터 예약, 결제, 알림톡, AI 상담 엔진까지 사업 단계에 맞춰 확장합니다.
                제작비 부담을 낮추고 운영과 개선을 구독으로 관리합니다.
              </p>
              <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                <a href="#plans" className="rounded-md bg-white px-5 py-3 text-center text-sm font-semibold text-zinc-950 hover:bg-zinc-200">
                  요금제 확인하기
                </a>
                <a
                  href={KAKAO_CHAT_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-md border border-yellow-300 px-5 py-3 text-center text-sm font-semibold text-yellow-200 hover:bg-yellow-300 hover:text-zinc-950"
                >
                  카카오톡으로 상담하기
                </a>
              </div>
            </div>
            <div className="grid content-start gap-3 rounded-lg border border-zinc-800 bg-zinc-900/50 p-5">
              {['제작비 없이 시작', '서버/SSL 포함', 'SEO 기본 세팅', '예약·결제 확장', 'AI 운영 자동화'].map((item) => (
                <div key={item} className="flex items-center justify-between border-b border-zinc-800 py-3 last:border-b-0">
                  <span className="text-sm text-zinc-300">{item}</span>
                  <span className="text-sm font-semibold text-yellow-300">포함</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="plans" className="border-b border-zinc-800">
          <div className="mx-auto max-w-6xl px-6 py-14">
            <div className="max-w-2xl">
              <h2 className="text-2xl font-bold text-white">3가지 구독 요금제</h2>
              <p className="mt-3 text-sm leading-6 text-zinc-400">
                초기 제작비는 낮추고, 사업이 커질수록 기능과 자동화를 확장하는 구조입니다.
              </p>
            </div>
            <div className="mt-8 grid gap-4 lg:grid-cols-3">
              {plans.map((plan) => (
                <article key={plan.name} className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-6">
                  <p className="text-xs font-medium text-yellow-300">{plan.label}</p>
                  <h3 className="mt-3 text-xl font-semibold text-white">{plan.name}</h3>
                  <p className="mt-2 text-3xl font-bold text-white">{plan.price}</p>
                  <p className="mt-4 min-h-12 text-sm leading-6 text-zinc-400">{plan.description}</p>
                  <ul className="mt-5 space-y-2 text-sm text-zinc-300">
                    {plan.features.map((feature) => (
                      <li key={feature} className="flex gap-2">
                        <span className="text-yellow-300">•</span>
                        <span>{feature}</span>
                      </li>
                    ))}
                  </ul>
                  <a
                    href={KAKAO_CHAT_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-6 block rounded-md border border-zinc-700 px-4 py-3 text-center text-sm font-semibold text-white hover:border-yellow-300 hover:text-yellow-200"
                  >
                    이 요금제로 상담
                  </a>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section id="ai" className="border-b border-zinc-800">
          <div className="mx-auto grid max-w-6xl gap-8 px-6 py-14 md:grid-cols-[0.8fr_1.2fr]">
            <div>
              <p className="text-sm font-medium text-yellow-300">프리미엄 차별화</p>
              <h2 className="mt-3 text-2xl font-bold text-white">AI 엔진은 챗봇보다 운영 자동화에 가깝게 설계합니다.</h2>
              <p className="mt-4 text-sm leading-6 text-zinc-400">
                단순 응답 챗봇보다 문의, 콘텐츠, 견적, 리포트를 연결하는 엔진으로 설계해야 실제 운영 비용을 줄입니다.
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {aiFeatures.map((feature) => (
                <div key={feature} className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-5 text-sm leading-6 text-zinc-300">
                  {feature}
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="consult" className="border-b border-zinc-800 bg-zinc-900/30">
          <div className="mx-auto grid max-w-6xl gap-8 px-6 py-14 md:grid-cols-2">
            <div>
              <h2 className="text-2xl font-bold text-white">신청 전에 3가지만 확인하면 됩니다.</h2>
              <p className="mt-3 text-sm leading-6 text-zinc-400">
                지금 필요한 범위를 확인한 뒤 카카오톡으로 보내주시면 가장 가까운 요금제를 기준으로 안내합니다.
              </p>
            </div>
            <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-6">
              <ol className="space-y-4 text-sm text-zinc-300">
                <li><span className="font-semibold text-white">1. 목적</span> 회사소개, 예약, 결제, 상담 자동화 중 무엇이 필요한가요?</li>
                <li><span className="font-semibold text-white">2. 기능</span> 문의폼, 결제, 알림톡, 관리자, AI 중 어떤 기능이 필요한가요?</li>
                <li><span className="font-semibold text-white">3. 일정</span> 언제까지 오픈해야 하고 기존 자료는 준비되어 있나요?</li>
              </ol>
              <a
                href={KAKAO_CHAT_URL}
                target="_blank"
                rel="noreferrer"
                className="mt-6 block rounded-md bg-yellow-300 px-5 py-3 text-center text-sm font-semibold text-zinc-950 hover:bg-yellow-200"
              >
                카카오톡으로 바로 상담하기
              </a>
              <p className="mt-3 text-center text-xs text-zinc-500">평일 상담 기준으로 확인 후 순차 답변합니다.</p>
            </div>
          </div>
        </section>

        <section id="references" className="mx-auto max-w-6xl px-6 py-14">
          <h2 className="text-2xl font-bold text-white">레퍼런스와 운영 인사이트</h2>
          <p className="mt-3 text-sm leading-6 text-zinc-400">
            단순 홈페이지를 넘어 예약, 행사, 커머스, AI 자동화까지 운영해온 경험을 기반으로 제작합니다.
          </p>

          <div className="mt-10 grid gap-4 sm:grid-cols-2">
            {[
              { cat: '홈페이지 제작', title: '제작보다 중요한 것은 매달 바뀌는 정보입니다.', desc: '공지, 가격, 사진, FAQ가 멈추지 않아야 홈페이지가 검색과 상담 전환에 계속 기여합니다.' },
              { cat: '예약 시스템', title: '전화 문의를 예약 데이터로 바꾸는 구조', desc: '신청폼, 예약, 결제, 알림톡, 관리자 페이지를 연결하면 반복 응대가 줄어듭니다.' },
              { cat: '학술대회', title: '등록, 결제, QR 출결까지 운영해본 경험', desc: '행사 운영에서 검증된 흐름을 병원, 학원, 설명회, 세미나 홈페이지에도 적용합니다.' },
              { cat: 'AI 자동화', title: '문의와 콘텐츠를 운영 리포트까지 연결', desc: 'AI는 외부 챗봇이 아니라 운영자가 매달 반복 업무를 줄이는 내부 엔진이어야 합니다.' },
            ].map((item) => (
              <div key={item.cat} className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-5">
                <span className="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400">{item.cat}</span>
                <h3 className="mt-3 text-sm font-semibold text-zinc-100">{item.title}</h3>
                <p className="mt-2 text-xs leading-relaxed text-zinc-400">{item.desc}</p>
              </div>
            ))}
          </div>

          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[
              { cat: 'Academic', name: 'e-Regi 학술대회 통합 시스템', desc: '등록, 결제, QR 출결, 배지, 알림톡, 학회 포털, 파트너 포털 통합' },
              { cat: 'Society', name: '학회·기관 홈페이지 솔루션', desc: '회원, 행사, 자료실, 결제, 논문 투고, 학회지, 관리자 대시보드' },
              { cat: 'AI', name: 'AI 실시간 동시통역 플랫폼', desc: 'QR 접속 기반 38개국 언어 음성·자막 통역' },
              { cat: 'Reservation', name: '스마트 설명회·예약 시스템', desc: '대기열, 매크로 방지, CAPTCHA, 실시간 관제, 알림톡' },
              { cat: 'Conference', name: '컨퍼런스 전자초록집', desc: '발표, 연사, 세션, 초록 PWA' },
              { cat: 'Commerce', name: 'Trevi 여행·호텔 예약 커머스', desc: '멀티 공급사, 채널 매니저, PMS, 예약, 결제, 환불, 정산, CRM' },
              { cat: 'Energy', name: 'EMS · BMS 통합 운영·관제', desc: 'ESS, BESS, 태양광 PV, 충전기 맵 기반 대시보드' },
              { cat: 'Automation', name: 'AgentRegi 법률·행정 자동화 SaaS', desc: '사건 진단, 전문가 매칭, 서류 수집, 전자신청, Document AI' },
              { cat: 'Intelligence', name: 'EUM News AI 뉴스 인텔리전스', desc: '기업 단위 뉴스 수집, AI 필터링, 투자 리서치, M&A 모니터링' },
              { cat: 'Content Ops', name: 'beokmkt 숏폼 콘텐츠 AI 파이프라인', desc: '아이디어, 스크립트, 렌더링, 발행, 작업 큐, 실패 복구' },
              { cat: 'Mobile', name: '모바일 서비스 앱 플랫폼', desc: 'React Native, Expo, Firebase, 관리자 콘솔 통합 앱' },
              { cat: 'Internal', name: '사내 위키·매뉴얼 시스템', desc: '트리 구조, 블록 편집기, PIN 인증, 검색, 버전 히스토리' },
            ].map((item) => (
              <div key={item.cat} className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-5">
                <span className="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400">{item.cat}</span>
                <h3 className="mt-3 text-sm font-semibold text-zinc-100">{item.name}</h3>
                <p className="mt-2 text-xs leading-relaxed text-zinc-400">{item.desc}</p>
              </div>
            ))}
          </div>
        </section>

        <div className="sticky bottom-0 border-t border-zinc-800 bg-zinc-950/95 px-4 py-3 backdrop-blur md:hidden">
          <div className="mx-auto flex max-w-6xl gap-2">
            <a href="#plans" className="flex-1 rounded-md border border-zinc-700 px-4 py-3 text-center text-sm font-semibold text-white">
              요금제
            </a>
            <a href={KAKAO_CHAT_URL} target="_blank" rel="noreferrer" className="flex-1 rounded-md bg-yellow-300 px-4 py-3 text-center text-sm font-semibold text-zinc-950">
              카카오 문의
            </a>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-zinc-800 py-6 text-center text-xs text-zinc-600">
        © {new Date().getFullYear()} 홍커뮤니케이션 · beoksolution
      </footer>
    </div>
  )
}
