# beokmkt 검색 노출 개선 로드맵

작성일: 2026-06-11
대상: 자체 블로그(beokmkt.web.app) + 네이버 블로그 + 티스토리 발행 파이프라인

---

## 1. 현재 잘 되어 있는 것

SSR 기반 메타태그(OG, 트위터 카드, canonical, article 시간), JSON-LD(Organization, WebSite, BlogPosting, Breadcrumb), robots.txt, llms.txt, 구글 site verification, 슬러그 중복 처리, 콘텐츠 검증(h2 개수·키워드 포함·길이), 카테고리별 프롬프트와 CTA 템플릿까지 기본 골격은 상당히 잘 갖춰져 있습니다. 문제는 "기술적 틀"이 아니라 **검색엔진에 실제로 닿는 경로**와 **콘텐츠 전략**입니다.

---

## 2. 치명적 문제 (P0 — 즉시 수정)

### 2.1 사이트맵이 2026-05-18에 멈춰 있음 (버그)

`functions/index.mjs`에 동적 사이트맵 핸들러(`sitemapHandler`)가 있지만, **빌드 결과물 `dist/`에 정적 `sitemap.xml`, `blog/sitemap.xml`, `blog/sitemap-posts.xml`이 포함**되어 있습니다. Firebase Hosting은 정적 파일을 rewrite보다 우선 서빙하므로 동적 핸들러는 프로덕션에서 한 번도 실행되지 않습니다. **5월 18일 이후 발행된 글은 사이트맵에 존재하지 않습니다.**

조치: `public/sitemap.xml` 삭제 + 빌드 스크립트에서 dist로 복사되지 않도록 제외. 배포 후 `curl https://beokmkt.web.app/sitemap.xml`로 최신 글 포함 여부 확인.

### 2.2 네이버 서치어드바이저 미등록

`naver-site-verification` 메타태그가 어디에도 없습니다. 자체 블로그가 네이버 검색에 노출되려면 서치어드바이저 등록이 필수입니다. 한국 검색 트래픽의 절반 이상이 네이버인데 이 경로가 닫혀 있습니다.

조치: 서치어드바이저 사이트 등록 → verification 메타 SSR 템플릿에 추가 → 사이트맵 제출.

### 2.3 RSS 피드 없음

네이버 서치어드바이저는 RSS 제출을 받고, 구글·빙·AI 크롤러의 신규 글 발견에도 RSS가 가장 빠른 경로입니다. 현재 자체 블로그에 RSS가 전혀 없습니다.

조치: `/blog/rss.xml` 엔드포인트 추가(최근 20~50개 글, full content 또는 excerpt) + `<link rel="alternate" type="application/rss+xml">`을 head에 추가 + 서치어드바이저에 제출.

### 2.4 IndexNow 키만 있고 핑 코드가 없음

`public/beokmkt indexnow key.txt`는 배포되어 있는데 발행 시 IndexNow를 호출하는 코드가 없습니다. 발행 직후 색인 요청이 안 나가고 크롤러가 알아서 오기를 기다리는 상태입니다.

조치: 발행 성공 시점(`createPost` 직후 / publish 엔드포인트)에 `api.indexnow.org` 핑 + Google에는 sitemap ping. 신규 글 색인 시간이 수일 → 수시간으로 단축됩니다.

### 2.5 도메인 문제: beokmkt.web.app

Firebase 기본 서브도메인은 브랜드 신뢰도·도메인 권위 축적 측면에서 불리하고, 글의 CTA가 가리키는 hongcomm.kr / beoksolution.com과 도메인이 분리되어 **블로그 SEO 성과가 본사 도메인에 전혀 쌓이지 않습니다.**

조치: `blog.hongcomm.kr`(또는 `hongcomm.kr/blog` 리버스 프록시) 커스텀 도메인 연결을 권장. 콘텐츠 마케팅의 최종 목적이 회사 도메인 유입이라면 가장 투자 대비 효과가 큰 결정입니다. 도메인 변경 시 기존 URL 301 리다이렉트 필수.

---

## 3. 전략적 문제 (P1 — 2~4주 내)

### 3.1 3개 채널에 동일 콘텐츠 → 유사문서 필터 위험

현재 같은 HTML을 자체 블로그·네이버·티스토리에 그대로 발행합니다(네이버/티스토리는 스타일만 변환). 네이버는 유사문서 판정에 매우 엄격해서 **늦게 발행된 쪽이 검색에서 통째로 누락**될 수 있고, 구글은 셋 중 하나를 임의로 대표 문서로 선택합니다. 지금 구조에서는 권위가 약한 자체 블로그가 밀릴 가능성이 높습니다.

조치 — 채널별 역할 정의:

| 채널 | 역할 | 콘텐츠 |
|---|---|---|
| 자체 블로그 | 원본(canonical), 항상 최초 발행 | 풀 버전 |
| 네이버 블로그 | 네이버 검색·블로그탭 공략 | 같은 주제를 다른 구성/문체로 재작성(70% 이상 차별화), 원본 링크 포함 |
| 티스토리 | 구글/다음 롱테일 보조 | 요약+다른 관점, 원본 링크 포함 |

파이프라인 관점에서는 LLM 호출을 채널별로 분리("같은 소재, 다른 글")하면 됩니다. 이미 티스토리용 AI 변환(`convertForTistory`)이 있으므로 "스타일 변환"을 "재작성"으로 승격하는 작업입니다.

### 3.2 키워드 리서치 단계가 없음

키워드를 사람이 직접 입력하는 구조라, 검색량이 없는 키워드로 글을 쓰면 아무리 잘 써도 노출이 없습니다. 파이프라인 가장 앞에 키워드 선정 모듈이 필요합니다.

조치: 네이버 검색광고 API(연관키워드 + 월간 조회수 + 경쟁정도)를 연동해 "주제 입력 → 조회수 있는 키워드 후보 → 키워드별 글 생성" 흐름으로 전환. 네이버/구글 자동완성과 '함께 찾는 질문' 수집을 보조로 사용. 조회수·경쟁도 데이터가 blog_schedule에 함께 저장되면 성과 분석도 가능해집니다.

### 3.3 내부 링크 제로

글 간 연결이 전혀 없습니다(관련 글, 본문 내 링크 모두 없음). 내부 링크는 크롤링 효율·체류시간·주제 권위(topical authority) 모두에 핵심입니다.

조치: (1) 발행 시 태그/키워드 유사도로 관련 글 3개를 글 하단에 자동 삽입, (2) 생성 프롬프트에 기존 글 목록(제목+URL)을 주입해 본문 중 자연스러운 앵커 링크 1~2개를 넣게 함.

### 3.4 이미지 풀이 작고 반복 사용됨

고정 이미지 12~16장을 모든 글에 돌려쓰고 있고 marketing 카테고리는 Unsplash 스톡입니다. 네이버는 **원본 이미지**를 품질 신호로 강하게 보며, 동일 이미지 반복은 유사문서 판정에도 불리합니다.

조치: 글별 고유 이미지 생성(AI 이미지 또는 제목·핵심 데이터 기반 자동 인포그래픽/카드 이미지 렌더링 — 이미 render-executor 인프라가 있어 OG 이미지 자동 생성에 재활용 가능). 최소한 featured_image(OG 이미지)라도 글마다 고유하게.

### 3.5 글 구조가 전부 동일 (서론 h2 + 본론 2~3 + 결론 h2)

프롬프트와 검증기가 모든 글을 같은 골격으로 강제합니다. 같은 구조 + 같은 이미지 + 같은 CTA 푸터 = 검색엔진이 학습하기 쉬운 "자동 생성 발자국"이며, 구글의 scaled content abuse 정책 대상이 될 수 있습니다.

조치: 구조 템플릿을 4~5종(가이드형, 비교형, FAQ형, 사례형, 체크리스트형)으로 늘리고 검색 의도에 따라 선택. 검증기의 "h2 최소 4개" 같은 고정 규칙도 템플릿별로 완화.

---

## 4. 보강 과제 (P2 — 지속 운영)

### 4.1 성과 측정 루프

현재 노출·클릭·순위 데이터를 전혀 수집하지 않아 "어떤 글/키워드가 먹히는지" 알 수 없습니다. Google Search Console API + 네이버 서치어드바이저 + GA4를 연동해 글별 노출/클릭/순위를 대시보드(ops-metrics에 통합)로 보고, 성과 좋은 키워드 클러스터에 후속 글을 배치하는 루프를 만드세요. **이게 없으면 나머지 개선의 효과 검증이 불가능합니다.**

### 4.2 E-E-A-T 신호

Organization JSON-LD의 `sameAs`가 빈 배열입니다. 회사 SNS·홈페이지 URL 추가, 글에 저자(person) 정보와 소개 페이지, About/연락처 페이지 연결을 권장합니다. AI 생성 콘텐츠일수록 "누가 쓴 글인지" 신호가 중요합니다.

### 4.3 FAQPage 스키마

콘텐츠에 FAQ 섹션을 추가하고 FAQPage JSON-LD를 출력하면 구글 리치 결과와 AI 검색(llms.txt를 이미 갖춘 방향과 일치) 노출에 유리합니다. 프롬프트 JSON에 `faq` 필드만 추가하면 됩니다.

### 4.4 네이버 워커 안정성

클립보드 HTML 붙여넣기 + 셀렉터 추측 방식은 SmartEditor 업데이트마다 깨집니다. 발행 후 URL 캡처 실패 시 성공/실패 판정이 모호한 것도 문제. 발행 결과 검증(글 목록 재조회로 확인)과 실패 스크린샷 저장을 추가하고, 장기적으로는 네이버 발행 빈도·시간대(타깃 독자 활동 시간) 전략도 스케줄러에 반영하세요.

### 4.5 SSR 페이지 품질

블로그 글 SSR이 SPA CSS를 제거하는데 본문에는 Tailwind 클래스(`prose`, `not-prose` 등)가 남아 있어 일부 요소가 의도와 다르게 렌더링될 수 있습니다. 실제 발행 글을 브라우저에서 확인하고, 본문도 인라인 스타일 기반으로 통일하는 것이 안전합니다.

---

## 5. 실행 순서 요약

**1단계 (이번 주):** 사이트맵 버그 수정 → 네이버 서치어드바이저 등록 → RSS 추가 → IndexNow 핑 구현. 모두 작고 효과가 즉각적입니다.

**2단계 (2~4주):** 커스텀 도메인 결정·이전 → 채널별 콘텐츠 차별화(재작성 파이프라인) → 키워드 리서치 모듈(네이버 검색광고 API) → 내부 링크 자동화.

**3단계 (지속):** 글별 고유 이미지 → 구조 템플릿 다양화 → GSC/서치어드바이저 성과 대시보드 → 성과 기반 키워드 재투자 루프.

핵심 한 줄: **지금은 "글을 만드는 능력"은 충분하고, "검색엔진에 닿는 배관"(사이트맵·네이버 등록·RSS·도메인)과 "무엇을 쓸지 정하는 데이터"(키워드 리서치·성과 측정)가 빠져 있습니다.** 1단계 배관부터 고치는 것이 순서입니다.

---

## 6. 구현 현황 (2026-06-11 완료)

코드로 해결 가능한 항목은 모두 구현되었습니다.

| 항목 | 상태 | 위치 |
|---|---|---|
| 사이트맵 버그 (정적 파일이 동적 핸들러를 가림) | ✅ `public/`, `public/blog/`, `dist/` 정적 sitemap 전부 삭제 | — |
| RSS 피드 | ✅ `/rss.xml`, `/blog/rss.xml` + head에 alternate 링크 | `functions/index.mjs`, `server/index.mjs`, `seo.ts` |
| IndexNow 자동 핑 | ✅ 발행 3개 경로(파이프라인·publish API·스케줄러) 모두 | `functions/index.mjs` `pingIndexNow()` |
| 네이버 verification 메타 | ✅ env `NAVER_SITE_VERIFICATION` 설정 시 SSR head에 출력 | `functions/index.mjs` |
| 내부 링크 (본문 앵커) | ✅ 최근 12개 글을 프롬프트에 주입, AI가 1~2개 자연 링크 | `prompts.mjs`, `executor.mjs` |
| 관련 글 섹션 | ✅ 태그/카테고리 유사도 기반 3개, SSR 글 하단 렌더 | `functions/index.mjs` `selectRelatedPosts()` |
| 구조 템플릿 다양화 | ✅ 5종(가이드/비교/Q&A/사례/체크리스트), 제목 해시로 자동 배정, `structure` 옵션으로 지정 가능 | `prompts.mjs` `pickStructure()` |
| FAQ + FAQPage 스키마 | ✅ AI가 faq 생성 → 본문 FAQ 섹션 + JSON-LD 동시 출력 | `executor.mjs`, `functions/index.mjs` |
| 채널별 재작성 | ✅ 네이버/티스토리 발행 전 AI 재작성(70% 차별화) + 원본 출처 링크, 실패 시 원문 fallback | `executors/naver-blog-worker/channel-rewriter.mjs` |
| 키워드 리서치 | ✅ `POST /api/ai/keyword-research` — 네이버 검색광고 API(검색량/경쟁도) + 자동완성, 추천 키워드 필터 | `blog-pipeline/keyword-research.mjs` |
| Organization sameAs | ✅ hongcomm.kr, beoksolution.com 기본 + `ORG_SAME_AS` env 확장 | `functions/index.mjs` |
| 기존 버그 수정 | ✅ dev 서버 executor의 `naver_result` 미정의 참조 제거 | `server/blog-pipeline/executor.mjs` |

### 사람이 직접 해야 하는 남은 절차

1. **배포**: `npm run build:spa && firebase deploy` 후 `curl https://beokmkt.web.app/sitemap.xml`로 최신 글이 나오는지 확인 (이게 가장 중요).
2. **네이버 서치어드바이저** (searchadvisor.naver.com): 사이트 등록 → 발급받은 코드를 `.env`의 `NAVER_SITE_VERIFICATION`에 넣고 재배포 → 소유 확인 → 사이트맵(`/sitemap.xml`)과 RSS(`/blog/rss.xml`) 제출.
3. **네이버 검색광고 API 키** (manage.searchad.naver.com → 도구 → API 사용 관리): 발급 후 `NAVER_AD_API_KEY`, `NAVER_AD_API_SECRET`, `NAVER_AD_CUSTOMER_ID` 설정. 키 없이도 자동완성 기반으로는 동작.
4. **구글 서치 콘솔**: 사이트맵 재제출 (정적 파일 시절 URL이 캐시되어 있을 수 있음).
5. **커스텀 도메인 결정**: `blog.hongcomm.kr` 연결 여부는 비즈니스 결정 필요. 연결 시 `SPA_BASE_URL` 변경 + 기존 URL 301 리다이렉트.

### 다음 단계 (미구현, 후순위)

글별 고유 OG 이미지 자동 생성, GSC/서치어드바이저 성과 대시보드(ops-metrics 통합), 발행 시간대 최적화는 위 항목들의 효과가 확인된 뒤에 진행하는 것을 권장합니다.
