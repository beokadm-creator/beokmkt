# blog_publisher

블로그 자동 발행 시스템 재설계 골격. 생성·검수·발행을 **상태머신 기반으로 분리**해
안정적인 주기 발행을 목표로 한다. 설계 배경은 [`DESIGN.md`](./DESIGN.md) 참고.

## 구조

```
blog_publisher/
├── DESIGN.md            # 설계 문서(아키텍처/모델 전략/발행 안정화)
├── run.py               # 워커 실행 진입점
├── config.py            # 모델 등급/임계값/자격증명(환경변수)
├── db/
│   ├── schema.sql       # posts 상태머신 테이블
│   └── db.py            # 원자적 상태 전환/재시도 헬퍼
├── llm/
│   ├── client.py        # GLM 클라이언트(단계별 모델/thinking 토글)
│   └── prompts.py       # 개요/섹션/검수 프롬프트
├── research/            # ★근거 계층(기획 05) + 검색노출(기획 07)
│   ├── provider.py      # 검색 공급자: Tavily(구글계열) + 네이버 검색 API
│   ├── collect.py       # 자료 수집 + analyze_serp(타깃 엔진 상위 분석)
│   ├── extract.py       # URL 본문 추출(재작성용, 기획 10)
│   └── evidence.py      # 의도 도출 + 근거팩 빌더(출처 귀속, 타깃 SERP 반영)
├── render/              # 자체 블로그 디자인(기획 09)
│   ├── template.html    # 시맨틱+SEO 헤드+TOC 템플릿
│   ├── style.css        # 가독성·반응형·다크모드
│   └── renderer.py      # 마크다운→HTML, TOC, JSON-LD
├── pipeline/
│   ├── generate.py      # 생성 워커: 채널→엔진→리서치→근거팩→작성→SEO
│   ├── seo.py           # 엔진별 SEO 최적화(네이버 C-Rank/DIA vs 구글)
│   ├── factcheck.py     # 사실검증 게이트: 주장↔근거팩 대조(grounding)
│   ├── review.py        # 품질 검수: 규칙 게이트 + 문체/구조 LLM 게이트
│   ├── rewrite.py       # URL 재작성 발행(가드레일, 기획 10)
│   ├── translate.py     # 영문 번역 발행(기획 11)
│   ├── schedule_publish.py  # 재고→발행 큐(시각 분산·윈도우)
│   └── publish.py       # 발행 워커: 상태머신+재시도+멱등성
├── publishers/
│   ├── base.py          # Publisher 인터페이스 + 예외 분류
│   ├── selfhosted.py    # 자체 블로그(API, 안정)
│   ├── naver.py         # 네이버(Playwright)
│   └── tistory.py       # 티스토리(Playwright)
└── utils/text.py        # 중복률/길이/금칙어 검사
```

## 설치

```bash
pip install -r requirements.txt
playwright install chromium      # 네이버/티스토리 자동화용
```

## 환경변수 (예시)

```bash
export LLM_API_KEY=...            # GLM API 키
export LLM_BASE_URL=https://open.bigmodel.cn/api/paas/v4
export MODEL_OUTLINE=glm-4.6
export MODEL_SECTION=glm-4.5
export MODEL_REVIEW=glm-4.5

# 웹 리서치(근거기반 엔진 — 필수). 사실 수집용 일반 웹 검색.
export SEARCH_PROVIDER=tavily
export TAVILY_API_KEY=...
export SOURCE_BLOCKLIST=spam.example,ad.example   # (선택) 제외 도메인
export MIN_GROUNDING_RATIO=0.9                     # 사실검증 통과 기준

# 검색 노출(SEO). 네이버 블로그→네이버, 티스토리·자체→구글 (채널별 자동).
# 네이버 채널 SERP 분석에 네이버 검색 API 키 필요.
export NAVER_CLIENT_ID=...
export NAVER_CLIENT_SECRET=...
export SELFHOST_API_URL=...
export SELFHOST_API_KEY=...
export NAVER_BLOG_ID=...
export TISTORY_BLOG=...
```

## 사용

```bash
python run.py selftest                           # ★키 없이 전 파이프라인 가동 검증(mock)
python run.py init                              # DB 초기화
python run.py seed "노트북 추천 2026" naver review  # 시드(채널/유형: review|howto|niche)
python run.py generate                          # 근거기반 생성(리서치→근거팩→작성)
python run.py factcheck                         # 사실검증 게이트(근거 대조)
python run.py review                            # 품질 검수(문체/구조)
python run.py schedule                          # 발행 큐 편성(시각 분산)
python run.py publish                           # 큐 소비(발행)
python run.py loop                              # 데모: 전체 흐름 1회

# 부가 파이프라인
python run.py rewrite <url> naver review        # URL 재작성 발행(가드레일·출처표기)
python run.py translate <post_id> selfhosted    # 영문 번역 발행
```

## 운영(cron 권장)

```
*/30 * * * *  python run.py generate
*/15 * * * *  python run.py factcheck
*/30 * * * *  python run.py review
0    9 * * *  python run.py schedule
*/5  * * * *  python run.py publish
```

## 핵심 설계 요약

- **모델 등급은 감이 아니라 검수 통과율로 결정한다.** 게이트를 먼저 만들고 싼 모델로 통과율이 유지되는지 측정.
- **발행 불안정은 모델이 아니라 채널 구조 문제.** 네이버/티스토리는 공식 API가 없어 본질적으로 깨지기 쉽다 → 90% 자동 + 실패분 사람 폴백(`needs_human`).
- **재고 버퍼 + 시각 분산**이 주기적 안정 발행의 핵심.

> 참고: 네이버/티스토리 어댑터의 `SELECTORS`는 예시값이다. 실제 에디터 DOM에 맞춰 갱신하고,
> 최초 1회 수동 로그인으로 `*_state.json` 세션을 저장해야 한다.
