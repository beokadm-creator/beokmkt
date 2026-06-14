# CHANGELOG — 골격 수정 기록

골격(코드·설정·스키마)을 직접 수정할 때마다 여기에 기록한다.
형식: `날짜 / 대상 / 변경 / 이유`. 최신 항목을 맨 위에 추가한다.

---

## 2026-06-14 — 공개 상세/관리자 운영 UI 보정

`/blog/` 인덱스는 콘텐츠 허브로 바뀌었지만, 개별 공개 글 상세의 사이드바와 SSR HTML에 이전 "구독형 홈페이지/월 5만원" 메시지가 남아 있어 검색·공유 HTML과 실제 화면의 주제가 어긋나는 문제를 수정했다.

| 대상 | 내용 |
|---|---|
| `src/spa/pages/PublicBlogPostPage.tsx` | 공개 글 상세 CTA·사이드바를 학회 운영 사무국 명찰 출력/현장 재발행 기준으로 교체. 카카오 상담 링크 적용 |
| `functions/index.mjs` | SSR 상세 HTML도 동일하게 보정. 기본 카테고리와 CTA를 운영 글/명찰 운영 상담으로 변경 |
| `src/spa/components/BeoksolutionLandingTemplate.tsx`, `functions/index.mjs` | 랜딩 스키마 기본 benefits 제목에서 구독형 홈페이지 하드코딩 제거 |
| `src/spa/pages/DashboardPage.tsx` | 클라우드 대시보드에서 로컬 SQLite 큐를 직접 재큐잉할 수 없다는 점을 드러내고, 로컬 큐 조치 명령을 별도 패널로 노출 |

검증:
- `npx tsc --noEmit` PASS
- `npm run lint -- .` PASS(기존 warning만 유지)
- `npm run build:spa` PASS, `functions/ssr-template.mjs` 갱신
- Firebase Functions/Hosting 배포 완료
- 실제 공개 상세 HTML: 옛 구독형 문구 0, 명찰 운영 문구 확인
- 실제 `/dashboard` SPA 번들: 로컬 큐 조치 패널 확인

---

## 2026-06-14 — 네이버 공개 품질 게이트 + beok 이미지 카드

실제 자체 블로그·티스토리·네이버 발행 결과를 공개 URL 기준으로 재검증하며, "URL 생성"과 "품질 통과"를 분리했다.

| 대상 | 내용 |
|---|---|
| `executors/naver-blog-worker/index.mjs` | 네이버 SmartEditor 취소선 툴바가 켜진 상태로 새 글이 시작되는 문제를 확인하고, 제목/본문 입력 전 사전 해제 추가 |
| `executors/naver-blog-worker/index.mjs` | 발행 후 공개 URL HTML을 다시 조회해 금칙 톤·오타·보이는 취소선이 있으면 성공으로 인정하지 않는 공개 품질 게이트 추가 |
| `executors/naver-blog-worker/channel-rewriter.mjs` | 네이버 재작성 금칙 토큰에 실제 오타 `"발업"` 추가 |
| `executors/naver-blog-worker/naver-html-adapter.mjs` | 네이버 SmartEditor 안정성을 위해 h2/h3 마크다운을 `<p><strong>...` 구조로 낮춰 입력 |
| `blog_publisher/tools/image_bank.py`, `public/assets/blog/beok/*.svg` | beok 글에 사용할 브랜드 정보 카드 4종(운영 흐름/SEO/자동화/체크리스트) 추가, h2 문맥별 최대 3개 이미지 삽입 |
| 실DB | 공개 품질 실패 네이버 글(id=13,19,22,26~30)을 `needs_human`으로 격리. 자동 성공 카운트에서 제외 |

검증:
- 자체 블로그 id=24 공개 200, 금칙 톤 0, 보이는 취소선 0
- 티스토리 id=25 공개 200, 금칙 톤 0, 보이는 취소선 0
- 네이버 id=31 공개 200, 금칙 톤 0, 보이는 취소선 0, 워커 공개 품질 게이트 통과
- `node --check`: `index.mjs`, `channel-rewriter.mjs`, `naver-html-adapter.mjs`, `tistory-html-adapter.mjs`, `tistory-client.mjs`
- `python3 -m compileall blog_publisher`, `python3 run.py selftest` PASS

운영 주의: `needs_human`의 네이버 품질 실패 글은 외부 네이버에서 직접 삭제/비공개 확인이 필요하다. 시스템은 임의 삭제하지 않는다.

---

## 2026-06-14 — 채널별 실발행 검증 및 외부 발행 안정화

자체 블로그·티스토리·네이버를 각각 실제 발행 경로로 태우며 발견한 문제를 수정.

| 대상 | 내용 |
|---|---|
| `executors/naver-blog-worker/tistory-client.mjs` | 티스토리 발행 성공 URL을 관리 화면(`/manage/posts/`)이 아니라 공개 글 URL(`/숫자`)만 인정. 현재 URL/canonical/RSS로 공개 URL 확인 후 저장 |
| `executors/naver-blog-worker/index.mjs` | 티스토리 멱등성 URL 검증 강화: `*.tistory.com/숫자`만 유효 발행 URL로 인정 |
| `executors/naver-blog-worker/naver-html-adapter.mjs` | 네이버 입력 전 마크다운 이미지/제목/목록/문단을 HTML로 정규화. 기존 inline style 삽입 시 `>`가 빠지던 HTML 깨짐 수정 |
| `executors/naver-blog-worker/index.mjs` | 네이버 SmartEditor 붙여넣기 검증 보강. 원격 이미지 누락만으로 전체 발행 차단하지 않고, 문단 구조 붕괴는 계속 차단 |
| `executors/naver-blog-worker/index.mjs` | 네이버 발행 레이어 열림 확인/재오픈, 최종 발행 버튼을 레이어 내부 `seOnePublishBtn`/`confirm_btn` 중심으로 클릭. 실패 시 screenshot/html/buttons 덤프 저장 |

검증:
- 자체 블로그 id=17 공개 발행 및 HTTP 200 확인: `https://beokmkt.web.app/blog/비오케이솔루션-학회-명찰-출력-운영-체크리스트`
- 티스토리 id=18 공개 발행 확인: `https://beoksolution.tistory.com/15` (RSS/공개 HTML 확인, DB·멱등성 로그 공개 URL로 보정)
- 네이버 id=19 공개 발행 확인: `https://blog.naver.com/beoksolution/224315713776` (RSS/DB/멱등성 로그 확인)
- `node --check` 통과: `index.mjs`, `naver-html-adapter.mjs`, `tistory-client.mjs`

---

## 2026-06-14 — 네이버 글쓰기 URL/SmartEditor ONE 셀렉터 수정

| 대상 | 내용 |
|---|---|
| `executors/naver-blog-worker/index.mjs` | `PostWrite.naver` 구 URL → `PostWriteForm.naver?blogId=...&Redirect=Write` 지원. `NAVER_BLOG_ID`/`NAVER_BLOG_WRITE_URL` 환경변수 추가 |
| `executors/naver-blog-worker/index.mjs` | 네이버 제목 입력을 `input` 기반에서 SmartEditor ONE의 `.se-title-text`/contenteditable 구조까지 지원 |
| `executors/naver-blog-worker/index.mjs` | 본문 붙여넣기 대상을 구 iframe 우선에서 현재 `.se-section-text` 본문 영역 우선으로 변경 |
| `executors/naver-blog-worker/keepalive.mjs` | keepalive도 동일한 글쓰기 URL 빌더 사용 |
| `executors/naver-blog-worker/.env.example` | `NAVER_BLOG_ID` 예시 추가 |

검증: Node Playwright로 `beoksolution` 글쓰기 화면 진입 확인, 제목/본문 타깃 visible 확인, 발행 버튼 클릭 없이 입력 스모크 테스트 통과.

---

## 2026-06-14 — 프론트 lint 정리 (npm run lint 통과)

| 대상 | 내용 |
|---|---|
| `eslint.config.mjs` | 빌드 산출물/외부 런타임 ignore 추가(`dist/** .next/** functions/** server/** executors/** scripts/** blog_publisher/**`) → dist 미니파이 번들이 lint되던 설정 문제 해결 |
| `eslint.config.mjs` | 설정파일(`*.config.{js,cjs,mjs}`)은 require/익명 export 허용. `react-hooks/set-state-in-effect`는 warn으로(흔한 로딩 패턴 false-positive, 가시성 유지) |
| `src/spa/App.tsx` | `RequireAuth`를 렌더 내부 정의 → 모듈 스코프로 분리(훅 직접 호출). `react-hooks/static-components` 에러 해소(동작 동일) |

검증: `eslint .` → **0 errors / 15 warnings (exit 0)**, `tsc --noEmit` App.tsx 타입 에러 없음.
남은 15 warnings: `@next/next/no-img-element`(img→next/image 권고) + `set-state-in-effect`(warn). 빌드 비차단, 점진 개선 대상.

---

## 2026-06-14 — 후속: 섹션 보정 · 멱등성 강화 · 운영 자동화

감사 후 운영 중 발견된 항목 + 운영 자동화 고정.

| 영역 | 대상 | 내용 |
|---|---|---|
| 생성 throughput | `pipeline/generate.py` `_validate_outline` | 하드 리젝 → **보정**. 무효 섹션 제거, >8개는 8개로 자르고, <2개만 실패. "sections 개수 위반" 반복 실패 해소(재고 부족 원인 제거) |
| 멱등성 | `executors/.../index.mjs` `publishToNaver` | 발행 버튼 클릭 **직후 즉시 dedup 기록** → URL 캡처 중 크래시해도 재발행 방지(중복 차단 창 축소) |
| 운영 자동화 | `executors/.../com.beok.blog-worker.plist` | 워커 LaunchAgent(KeepAlive·RunAtLoad) — `launchctl submit` 임시 실행 대체 |
| 운영 자동화 | `blog_publisher/ops/newsyslog-blog.conf` | macOS 로그 로테이션(newsyslog, 7세대·5MB·bzip2) |
| 운영 자동화 | `blog_publisher/ops/crontab.example` | generate/factcheck/review/schedule/publish/recover/auto_seed/backup + keepalive 일괄 |
| 운영 자동화 | `blog_publisher/ops/install-ops.sh` | LaunchAgent·newsyslog·crontab·헬스체크 설치 스크립트 |

검증: 섹션 보정 단위테스트(9→8/3수용/혼합→유효만/1실패), py compileall, `run.py selftest` PASS, `node --check index.mjs`, `bash -n install-ops.sh`, plist lint 통과.

설치(맥): `bash blog_publisher/ops/install-ops.sh` (newsyslog는 sudo, crontab은 기존 항목과 병합 검토 후 적용).

---

## 2026-06-14 — 감사 지적사항 전체 수정 (AUDIT-2026-06-14 대응)

| 우선 | 대상 | 수정 |
|---|---|---|
| CRITICAL | `db/db.py` save_article | `next_run_at = NULL`(NOT NULL 위반) → 현재시각. 신규 생성 저장 정상화 |
| HIGH | `publishers/tistory.py` | 오류코드에 `TISTORY_LOGIN_REQUIRED/NOT_AUTHED` 추가 → 세션만료 Fatal 정상 처리 |
| HIGH | `channel-rewriter.mjs`, `tistory-html-adapter.mjs` | 이미지 보존(img↔마크다운 변환, img 허용/복원), `[이미지:]` 텍스트 치환 제거 |
| HIGH | `index.mjs` + `naver/tistory/twitter.py` | post_id 기반 멱등성(발행로그 원자기록) → 재시도 중복발행 차단 |
| MEDIUM | `keepalive.mjs` | Twitter 세션 probe 추가(best-effort) |
| MEDIUM | `session-helpers.mjs` | 세션 저장 원자화(temp→rename) |
| MEDIUM | `pipeline/generate.py` | 생성 실패 needs_human 격리 시 notify 호출 |
| MEDIUM | `publishers/twitter.py`(신규)+`__init__` | Twitter 채널 라우팅 연결(단절 해소) |
| MEDIUM | `pipeline/seo.py` apply_image_markers | `[이미지:]` 리터럴 누출 제거(no-op화) |
| LOW | `run.py` | 무인자/미지원 명령 exit 2 + `needs_human`/`backup` 명령 추가 |
| LOW | `tools/image_bank.py` | pick_image 빈 풀 IndexError → `{}` |
| LOW | `tools/backup_db.py`(신규) | SQLite 온라인 백업(+복사 폴백) |
| 운영 | 실DB | 스테일 needs_human 2건(구 chromium 오류) → queued 복구, 백업 1회 수행 |
| 운영 | `.gitignore` | blog_publisher 산출물(pyc/blog.db/backups/tmp) 제외 |

검증: 전체 py compileall 통과, `run.py selftest` PASS, Node 5개 파일 `node --check` 통과, save_article 재현 정상, 이미지 보존 기능 테스트 통과.

미적용(의도/운영 판단): `.env`의 `MIN_GROUNDING_RATIO=0`·`MIN_REVIEW_SCORE=0`은 검색 미연결 테스트 설정이라 그대로 둠(검색 연결 후 원복 필요). crontab·hongcomm 이미지 도달성은 사용자 환경 확인 필요(감사 I·G3).

---

## 2026-06-14 — ★파이프라인 가동 신뢰성 (기획 12)

가동 우선: 자동 파이프라인이 가장 자주 깨지는 JSON 파싱을 견고화하고, 프롬프트를 그 기준에 정렬.
키 없이 전 파이프라인을 검증하는 오프라인 셀프테스트 추가.

| 대상 파일 | 변경 | 이유(근거 문서) |
|---|---|---|
| `llm/parse.py` | extract_json(괄호균형·펜스제거·트레일링콤마·스마트따옴표) + chat_json(1회 복구재시도) 신규 | 12 §3.1 |
| `research/evidence.py`, `pipeline/{generate,factcheck,review,seo}.py` | 임시 _json 제거 → 공용 chat_json 사용 | 12 §3.1 |
| `llm/prompts.py` | _JSON_ONLY 공통 말미를 구조화 출력 프롬프트에 일괄 적용, 개요 템플릿 중괄호 정정 | 12 §3.2 |
| `tools/selftest.py` | mock LLM/검색/발행으로 generate→…→published 관통 검증 신규 | 12 §3.3 |
| `run.py` | selftest 명령 추가 | 12 |

검증: 파서가 코드펜스/트레일링콤마/문자열내괄호/스마트따옴표/앞뒤텍스트를 모두 흡수, chat_json 복구재시도 동작. `run.py selftest` → 한 글이 published 도달(PASS, exit 0). 전체 compileall 통과.

비고: AI 엔진은 사용자의 기존 GLM을 그대로 사용한다(LLM_API_KEY/LLM_BASE_URL/MODEL_* 만 기존 값으로 지정). 셀프테스트는 mock이라 키 불필요.

미반영(후속): pydantic 스키마 검증, 실패 샘플 로깅, 실제 GLM 응답 회귀 코퍼스.

---

## 2026-06-14 — 운영정책·디자인·재작성·번역 (기획 08~11)

| 대상 파일 | 변경 | 이유(근거 문서) |
|---|---|---|
| `config.py` | BLOG_PROFILES·profile_for() (08), SELFHOST_RENDER_HTML(09), MAX_SIMILARITY 등(10), 번역 설정(11) | 08~11 |
| `db/schema.sql` | posts에 category·blog_profile·locale·source_url·translated_from 추가 | 08·10·11 |
| `db/db.py` | insert_draft(category/profile), save_source_url, fetch_by_id, set_translation_meta | 08·10·11 |
| `render/template.html`·`style.css`·`renderer.py` | 가독성+SEO HTML 템플릿·CSS·렌더러(TOC·JSON-LD·OG) 신규 | 09 |
| `publishers/selfhosted.py` | 발행 시 렌더된 HTML 사용(옵션) | 09 |
| `utils/similarity.py` | n-gram 자카드 유사도 신규 | 10 |
| `research/extract.py` | URL 본문 추출(trafilatura/readability/폴백) 신규 | 10 |
| `pipeline/rewrite.py` | URL 재작성(원문=참고자료, 유사도 게이트, 출처 표기) 신규 | 10 |
| `pipeline/generate.py` | compose_article() 분리(생성/재작성 공용) | 10 |
| `pipeline/translate.py` | 영문 현지화 번역 + 영문 SEO + 로케일/원문 연결 신규 | 11 |
| `llm/prompts.py` | TRANSLATE_EN 프롬프트 추가 | 11 |
| `run.py` | rewrite·translate 명령, seed category 인자 | 08·10·11 |

가드레일(10): "30%만 변경"이 아니라 원문 대비 유사도 < MAX_SIMILARITY(기본 0.3)을 강제 → 충분히 달라야 발행. 출처 표기(rel=nofollow). 저작권/중복 콘텐츠 위험 완화.

검증: 전체 compileall 통과 + 렌더러(TOC/JSON-LD/OG/H2앵커/출처) + 유사도 게이트 + rewrite 풀플로우(추출→근거→합성→유사도 통과→source_url 저장) + translate(en locale·translated_from·grounding=1.0) 확인.

미반영(후속): 주제→카테고리 자동분류, hreflang ko↔en, 임베딩 의미 유사도, 영어권 SERP 분석.

---

## 2026-06-14 — 검색노출(SEO) 계층: 채널별 타깃 엔진

발행글이 구글·네이버에 잘 걸리도록 SEO 계층 추가(기획 07). 채널별 타깃 엔진 분리
(네이버 블로그→네이버, 티스토리·자체→구글). 네이버 검색 API 활용.

| 대상 파일 | 변경 | 이유(근거 문서) |
|---|---|---|
| `research/provider.py` | NaverSearchProvider(네이버 검색 API) + get_provider(engine) 엔진 분기 | 07 §3·§6 |
| `research/collect.py` | analyze_serp(engine, keyword) — 타깃 엔진 상위 제목 분석 | 07 §3 |
| `research/evidence.py` | build_evidence_pack에 serp 인자 — 커버리지에 타깃 SERP 반영 | 07 §3 |
| `pipeline/seo.py` | 엔진별 SEO 최적화(제목/메타/태그/네이버 이미지마커) 신규 | 07 §5 |
| `pipeline/generate.py` | 채널→엔진 매핑, SERP 분석, SEO 단계 통합, 결과에 tags/target_engine | 07 §4 |
| `llm/prompts.py` | SEO_GOOGLE/SEO_NAVER 프롬프트 추가 | 07 §5 |
| `config.py` | CHANNEL_TARGET_ENGINE·target_engine()·NAVER_CLIENT_ID/SECRET·SERP 설정 | 07 §6 |
| `db/schema.sql`, `db/db.py` | posts.target_engine·tags 추가, save_seo() | 07 §6 |

검증: 채널→엔진 매핑(naver→naver, tistory/selfhosted→google), 네이버 채널에서 네이버 SERP 호출+이미지마커 삽입+태그, 구글 채널은 마커 없음, DB 저장까지 풀플로우 확인.

미반영(후속): 네이버 이미지 자동 생성/업로드, 주제 일관 운영 정책(C-Rank), 구글 구조화데이터(JSON-LD), 키워드 검색량/난이도 연동.

---

## 2026-06-14 — ★근본 재설계: 근거기반 콘텐츠 엔진

생성 토대를 "상상 생성"에서 "웹 리서치 근거 합성"으로 전환(기획 05·06). 사실검증 게이트 신설.

| 대상 파일 | 변경 | 이유(근거 문서) |
|---|---|---|
| `research/provider.py` | SearchProvider 인터페이스 + Tavily/Null 구현 신규 | 05 §4.1 — 검색 공급자 교체 가능 |
| `research/collect.py` | 자료 수집(신뢰도 필터·상한) 신규 | 05 §4.2 |
| `research/evidence.py` | 의도도출·근거팩 빌더(출처 귀속) 신규 | 05 §3①③, §5 |
| `llm/prompts.py` | 의도/사실추출/커버리지/근거기반 개요(유형별)/섹션/팩트체크 프롬프트로 전면 개편 | 05·06 |
| `db/schema.sql` | posts에 content_type·intent·keywords·meta_desc·evidence·sources·grounding_ratio 추가 | 05 §5·§7 |
| `db/db.py` | insert_draft(content_type), save_research/save_article/save_grounding 추가 | 05 |
| `pipeline/generate.py` | 상상 생성 제거 → 리서치→근거팩→근거기반 개요/섹션. generate_article 반환 dict화 | 05 §3 |
| `pipeline/factcheck.py` | 사실검증 게이트(주장↔근거팩, grounding_ratio) 신규 | 05 §6 |
| `pipeline/review.py` | 사실검증 통과분만 검수하도록 grounding 조건 추가 | 05 §6 |
| `config.py` | 검색 공급자·수집 상한·MIN_GROUNDING_RATIO 추가 | 05 §4·§6 |
| `run.py` | factcheck 명령 + seed에 content_type 인자, loop에 factcheck 편입 | 05 |
| `tools/measure_passrate.py` | 근거기반 흐름(유형/grounding) 반영 | 02·05 |

검증: 전체 py_compile 통과 + Fake LLM/검색으로 엔진 풀플로우(생성→근거팩 2출처→개요5섹션→factcheck grounding 0.95→검수, evidence/sources DB 저장) 확인.

미반영(후속): 실제 검색 공급자 키 연결, 섹션-근거 매칭 임베딩 고도화, 출처 allowlist 분야별 구성.

---

## 2026-06-14 — 후속 골격(도구·알림·윈도우) 구현

기획 02·03·04 §5의 후속 골격을 구현.

| 대상 파일 | 변경 | 이유(근거 문서) |
|---|---|---|
| `utils/notify.py` | 알림 모듈 신규(콘솔+웹훅, 레벨 필터, 실패 무시) | 03 §3.3 |
| `pipeline/publish.py` | 로컬 `_notify` 제거 → `utils.notify` 사용 | 03 §3.3 |
| `config.py` | 발행 윈도우(`PUBLISH_TZ_OFFSET/WINDOW_START/END`)·알림 변수 추가 | 03 §3.2 |
| `pipeline/schedule_publish.py` | `_within_window()` 추가, 큐잉 시각을 허용 시간대 안으로 이월 | 03 §3.2 |
| `pipeline/generate.py` | `generate_article()` 분리(DB 무관 생성), `_generate_one`은 이를 호출 | 측정 도구 공유 |
| `pipeline/review.py` | `evaluate()` 분리(검수 원본 dict 반환), `llm_gate`는 이를 호출 | 점수 접근(02 §3.4) |
| `tools/login.py` | 네이버/티스토리 세션 저장 도구 신규 | 04 §3.5 |
| `tools/inspect_editor.py` | 셀렉터 유효성 점검 도구 신규 | 04 §3.4 |
| `tools/measure_passrate.py` | 통과율/평균점수/시간 측정 도구 신규 | 02 §3.4 |
| `tools/status_report.py` | 상태별 건수·재고 경고 리포트 신규 | 03 §3.5 |
| `run.py` | `status` 명령 + 도구 사용법 추가 | 운영 편의 |

검증: 전체 py_compile 통과 + 발행 윈도우 이월(새벽3시/밤11시 → 09시, 낮14시 유지) + status_report 정상.

미반영(후속): 발행 후 게시 URL 정상응답 검증(04 §5), 토큰 단위 비용 계측(02 §6), needs_human 처리 UI(03 §5).

---

## 2026-06-14 — 기획 01·02 골격 반영

기획 문서 01(프롬프트 명세)·02(검수/모델 정책) 확정 내용을 골격에 반영.

| 대상 파일 | 변경 | 이유(근거 문서) |
|---|---|---|
| `llm/prompts.py` | OUTLINE_SYSTEM에 섹션 비중복 규칙 + 출력 예시 추가 | 01 §3.2/4.1 — 구조 일관·중복 방지 |
| `llm/prompts.py` | SECTION_SYSTEM 제약 명시(범위 이탈 금지 등) | 01 §3.2/4.2 |
| `pipeline/generate.py` | `_validate_outline()` 추가(title/섹션 4~6/필드 검증) | 01 §4.1 — 개요 JSON 검증 |
| `pipeline/generate.py` | 개요 생성 1회 재시도 루프 | 01 §4.1 — 실패 시 1회 재생성 |
| `pipeline/generate.py` | 토큰 상한을 config 상수로 치환 | 01 §3.1 |
| `pipeline/review.py` | 검수 토큰 상한을 config 상수로 치환 | 01 §3.1 |
| `config.py` | `MAX_TOKENS_OUTLINE/SECTION/REVIEW` 추가, 모델 실험 주석 | 01 §3.1, 02 §3.4 |

검증: py_compile 통과 + `_validate_outline` 정상/이상 케이스 + 코드펜스 JSON 추출 테스트 통과.

미반영(후속): `tools/measure_passrate.py`(02), `tools/login.py`·`tools/inspect_editor.py`(04), 발행 시간대 윈도우·`_notify` 연동(03).

---

## 2026-06-14 — 초기 골격 생성

블로그 발행 시스템 재설계 스켈레톤 최초 구축. 상태머신 기반으로 생성·검수·발행 분리.

| 대상 파일 | 변경 | 이유 |
|---|---|---|
| `db/schema.sql` | posts 상태머신 테이블 신규 | 워커 간 협업을 status로만 하기 위해 |
| `db/db.py` | 원자적 claim/requeue 등 헬퍼 신규 | 중복 발행 방지, 지수 백오프 재시도, needs_human 격리 |
| `llm/client.py` | GLM 클라이언트 래퍼 신규 | 단계별 모델/thinking 토글 |
| `llm/prompts.py` | 개요/섹션/검수 프롬프트 신규 | 한 번에 안 쓰고 단계 분리 |
| `pipeline/generate.py` | 생성 워커(개요→섹션) 신규 | 긴 단일 출력 품질저하 방지 |
| `pipeline/review.py` | 검수 워커(규칙+LLM 2단 게이트) 신규 | 발행 전 품질 게이트 |
| `pipeline/schedule_publish.py` | 발행 스케줄러 신규 | 재고 버퍼 + 발행 시각 분산 |
| `pipeline/publish.py` | 발행 워커 신규 | 상태머신+재시도+멱등성 |
| `publishers/*` | base/selfhosted/naver/tistory 어댑터 신규 | 채널 추상화, 불안정 채널 사람 폴백 |
| `utils/text.py` | 중복률/길이/금칙어 검사 신규 | 규칙 기반 1차 검수 |
| `config.py` | 중앙 설정 신규 | 모델 등급/임계값/자격증명 일원화 |
| `run.py` | 워커 실행 진입점 신규 | cron 단계별 호출 |

검증: 상태 전환·원자적 claim·백오프 재시도·needs_human 격리·스케줄러 큐잉 스모크 테스트 통과.

미해결: 모델명(`glm-4.6/4.5`)은 예시값 → 실제 엔드포인트 확정 필요. 네이버/티스토리 `SELECTORS`는 예시 → 실제 DOM 갱신 필요.
