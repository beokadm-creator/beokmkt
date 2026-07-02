# CHANGELOG — 골격 수정 기록

골격(코드·설정·스키마)을 직접 수정할 때마다 여기에 기록한다.
형식: `날짜 / 대상 / 변경 / 이유`. 최신 항목을 맨 위에 추가한다.

---

## 2026-07-02 — 공개 근접중복 글 정리(247→154건)

주제 편중 구조 수정(아래 항목)과 별도로, 이미 공개된 selfhosted 글 중 "같은 틀+변형" 조합형 근접중복을 실제로 정리했다. `strategy_audit`의 문자열 완전일치 중복 탐지는 0건이었지만(GLM이 매번 문구를 바꿔 씀), 제목 앞 2단어(앵커) 기준 군집 분석 결과 "명찰재발행"(11건), "학회홈페이지"(11건), "협회/병원/학원 홈페이지"(각 10건) 등 16개 이상 앵커가 3~11건씩 중복 발행돼 있었다.

| 대상 | 내용 |
|---|---|
| `tools/prune_duplicate_anchors.py`(신규) | 공개 API 전체 페이지네이션 조회 → 앵커별 그룹화 → 앵커당 cap개 초과분을 선정(기본 가장 오래된 글 유지)해 `DELETE /api/blog-posts/{id}`로 soft-delete. `--apply` 없으면 dry-run, 실행 결과는 `reports/prune-duplicate-anchors-*.json`에 기록 |
| `public/sitemap.xml`, `public/rss.xml`, `public/blog/rss.xml` | `scripts/generate-static-sitemaps.mjs` 재실행으로 삭제 후 154건 기준 재생성(다음 `npm run build:spa` 배포 시 반영) |

실행:
- cap=2(앵커당 2건 유지, 가장 오래된 글 우선) 기준 사용자 승인 후 즉시 실행
- 삭제 93건 전부 성공(실패 0), 공개 API 재조회로 247→154건 확인
- soft-delete이므로 `deleted_at` 기록 방식 — 필요 시 Firestore에서 해당 필드 제거로 복구 가능

미완료(별도 승인 필요):
- 로컬 sitemap/rss는 커밋했지만 `dist/`는 gitignore 대상 빌드 산출물이라 실제 배포(`npm run build:spa` + firebase deploy)는 수행하지 않음

---

## 2026-07-02 — 주제 편중(명찰 도배) 구조 해소 + 브랜드별 퍼블리싱 개편

발행 214건 중 명찰 계열이 과점하고("명찰 재발행 시스템 ○○" 템플릿 양산), 렌더 컴포넌트가 명찰/학회 전용 하드코딩이라 그 외 주제(홈페이지 개발·MICE·반품 노트북)는 평문으로 발행되던 문제를 구조적으로 해결했다. notebook_return은 사이트가 bodyHtml을 그대로 innerHTML로 꽂는데 컴포넌트 CSS가 없어 순수 텍스트로 보이던 결함도 함께 수정.

| 대상 | 내용 |
|---|---|
| `tools/keyword_bank.py` | 명찰 전용 20개 블록 → 대표 6개로 축소. beok 홈페이지·시스템 개발 홍보 10개, hong 솔루션(Society Portal/e-Regi/AI통역) 8개 추가. `pillar_of()` 주제축 분류기 신설(7축). notebook_return 브랜드×관점·용도×예산 확장 100개 |
| `tools/auto_seed.py` | 배치 선택을 앵커 단일 라운드로빈 → pillar→앵커 2단계 라운드로빈으로 교체(한 축의 배치 독점 차단). 테마 포화 시 전면 재허용 폴백 → 포화 마커 최소 후보 우선으로 수정 |
| `pipeline/generate.py` | draft 선택을 FIFO → 최근 12건에서 덜 나온 pillar 우선으로 재배열(명찰 draft 연번 백로그가 있어도 발행 흐름이 섞임) |
| `pipeline/schedule_publish.py` | 발행 큐 선택도 pillar→앵커 2단계 라운드로빈 |
| `render/renderer.py` | 점검범위/운영흐름/비교표/CTA/요약판단을 문맥(badge/conference/beok/hong/notebook_return)별 변형으로 교체. hong CTA(hongcomm.kr), notebook_return CTA(시세·재고 확인) 신설. 쿠팡 파트너스 고지 블록(미사용이던 `NOTEBOOK_RETURN_DISCLOSURE`) 자동 삽입 |
| `render/embed_style.css` + `render_body_embed()` | 외부 호스트(innerHTML 삽입)용 스타일 내장 fragment. `.bp-article` 스코프로 호스트 CSS 오염 없이 컴포넌트 스타일 보장 |
| `publishers/notebook_return.py` | `render_body_embed` 사용 + category/topic 전달(컴포넌트 분기·고지 활성화), permalink footer를 스코프 안으로 이동 |
| `tistory-html-adapter.mjs` | 문맥 분류(`contentContext`) 신설, 점검범위/흐름/비교표/CTA를 badge/conference/beok/hong 변형으로 교체, 검증기도 문맥 기반으로 갱신 |
| `config.py` | `SEED_MAX_PER_ANCHOR` 3→6 (확장 풀 129개는 소진 후 편중 재유입 원인; 250+ 유지) |
| `quality_selftest.py` | 브랜드 변형 렌더 회귀테스트 추가. 사전 존재하던 mock 시그니처 불일치(collect category kwarg, FakeDb.requeue_draft) 수리. stock-seed 다양성 검증을 토큰 매칭 → pillar 커버리지로 교체 |

운영 적용:
- 로컬 DB: `reset_draft_backlog --apply`로 명찰/학회 편중 draft 17건 archive + 4축 라운드로빈 24건 재시드 완료
- Windows 운영 PC: git pull 후 `run-task.ps1 -Task reset-draft-backlog` 1회 실행 필요(기존 편중 백로그 격리)

검증:
- 시드 시뮬레이션: selfhosted 15건 배치가 6개 pillar로 균등 분산(badge_ops 2/15)
- `python3 run.py quality_selftest` PASS / `python3 run.py selftest` PASS / `node --check tistory-html-adapter.mjs` PASS

---

## 2026-06-21 — 키워드 고갈 재고 보충 복구

Windows 운영 PC에서 `draft/reviewed/queued=0`이고 `stock_seed selfhosted 40`이 "새 키워드 없음"으로 종료됐다. 게이트 문제가 아니라 `keyword_bank.py`의 82개 기본 주제가 모두 DB에 사용된 공급 고갈이므로, 운영 축별 조합 주제를 대폭 확장했다.

| 대상 | 내용 |
|---|---|
| `tools/keyword_bank.py` | 기존 82개 기본 주제는 유지하고, 홈페이지 제작·시스템 개발·학회/학술대회 운영·홍커뮤니케이션 MICE 축의 조합형 주제 388개를 추가 생성 |
| `tools/keyword_bank.py` | stock_seed 초기 보충부터 특정 축에 몰리지 않도록 homepage/system/conference/mice 순서로 라운드로빈 배치 |
| `quality_selftest.py` | 기본 키워드가 모두 사용된 임시 DB에서도 `stock_seed`가 확장 주제로 새 draft를 만드는 회귀테스트 추가 |

검증:
- 확장 결과: `base=82`, `total=470`, `added=388`
- 기본 82개 소진 DB에서 `stock_seed`가 새 draft 8건 생성 확인
- `python3 blog_publisher/run.py quality_selftest` PASS
- `python3 blog_publisher/run.py selftest` PASS
- `python3 -m compileall -q blog_publisher` PASS
- `git diff --check` PASS

---

## 2026-06-21 — 운영 글 문장 밀도 품질 조정

사용자가 "글은 장황하지 않아도 되지만 품질을 올려야 한다"고 지적했다. 생성 글이 길이를 맞추는 데 치우치지 않도록, 섹션별 내용 기준을 장면·판단·행동 중심으로 강화하고 운영 글 최종 목표 길이를 더 짧게 조정했다.

| 대상 | 내용 |
|---|---|
| `llm/prompts.py` | 각 섹션에 `운영 장면 1개 + 판단 기준 1개 + 독자 행동 1개`를 담도록 지시. 추상어와 반복 결론을 금지하고, 마지막 문장을 점검 행동으로 끝내도록 보강 |
| `pipeline/generate.py` | 운영 글 최종 내부 상한을 2550자에서 2200자로 낮춰 publish gate보다 보수적으로 장황함을 줄임 |
| `quality_selftest.py` | 섹션 품질 지시 토큰과 2200자 내부 상한 계약을 회귀테스트에 반영 |

검증:
- `python3 blog_publisher/run.py quality_selftest` PASS
- `python3 blog_publisher/run.py selftest` PASS
- `python3 -m compileall -q blog_publisher` PASS
- `git diff --check` PASS

---

## 2026-06-21 — 운영 글 최종 길이 밴드 안정화

Windows 운영 PC에서 이미지·근거 개선 후 `운영 글 본문 부족(389~883/900자)`이 새로 드러났다. 섹션 최대 240자만으로는 unsupported 문장 제거와 모델 출력 변동을 흡수하지 못해 900자 하한 아래로 빠지는 케이스가 생겼으므로, 섹션 계약과 최종 body 보정을 함께 조정했다.

| 대상 | 내용 |
|---|---|
| `config.py`, `llm/prompts.py` | 섹션 최소값을 120자 이상으로 강제하고, 섹션 본문 계약을 200~260자로 조정 |
| `pipeline/generate.py` | 최종 운영 글 plain text를 900~2600자 밴드에 맞추는 `_fit_operational_length_band()` 추가. 짧은 글은 근거 안전한 운영 체크 섹션으로 보강하고, 긴 글은 H2/이미지/표를 보존한 채 본문 문단만 축약 |
| `quality_selftest.py` | 짧은 생성물과 과긴 본문 모두 최종 900~2600자 밴드에 들어오고 publish 길이 게이트를 통과하는 회귀테스트 추가 |

검증:
- `python3 blog_publisher/run.py quality_selftest` PASS
- `python3 blog_publisher/run.py selftest` PASS
- `python3 -m compileall -q blog_publisher` PASS
- `git diff --check` PASS

---

## 2026-06-21 — 근거 없는 가격·기간·규모 생성 차단

길이와 이미지 게이트 해결 후 Windows 운영 PC에서 `low_grounding`과 `unsupported`가 주 병목으로 드러났다. 모델이 공식 근거에 없는 요금, 구축 기간, 지원 언어 수 같은 구체 사업정보를 보강하려고 지어내는 문제였으므로, 유료 외부검색 없이 공식 출처를 넓히고 위험 구체 주장을 생성·팩트체크 양쪽에서 차단했다.

| 대상 | 내용 |
|---|---|
| `config.py` | 기본 공식 출처를 beoksolution 루트/레퍼런스/AI 요약/llms와 hongcomm 회사·사업·오프라인·온라인·솔루션·제품·클라이언트·포트폴리오 페이지로 확장. `MAX_SOURCES` 기본값 10 → 16 |
| `llm/prompts.py` | 근거팩에 없는 가격, 월 요금, 구축 기간, 최단/최소/최대, 지원 언어/국가/고객 수, 요금제명 생성 금지 지시 강화 |
| `pipeline/factcheck.py` | LLM factcheck와 별도로 로컬 `local_unsupported_claims()` 추가. 근거팩에 없는 가격·기간·규모 수치가 있으면 grounding을 0.5 이하로 낮춰 탈락 처리 |
| `pipeline/generate.py` | 최종 본문 저장 전 근거팩 밖 위험 구체 수치 문장을 제거하는 `_remove_unsupported_specific_claims()` 추가 |
| `quality_selftest.py` | 근거 없는 `월 20만원`, `최단 3일`, `38개국`, `월 50만원`은 제거/탈락하고, 근거 안 사실은 오탐하지 않는 회귀테스트 추가 |

검증:
- `python3 blog_publisher/run.py quality_selftest` PASS
- `python3 blog_publisher/run.py selftest` PASS
- `python3 -m compileall -q blog_publisher` PASS
- `git diff --check` PASS

---

## 2026-06-21 — 최종 생성 본문 이미지 소실 방지

f684a5f 이후에도 Windows 운영 PC에서 review 단계의 `운영 글 이미지 부족(0~1/2장)`이 계속 발생했다. 원인은 `inject_images()` 단독이 아니라, 최종 생성 경로에서 run-meta 제거 정규식이 hongcomm 포트폴리오 이미지 URL 내부의 날짜처럼 보이는 숫자 조각을 치환해 이미지 마크다운을 깨뜨리는 데 있었다.

| 대상 | 내용 |
|---|---|
| `pipeline/generate.py` | `_strip_run_meta_text()`가 `![...](...)`와 `<img>` 구간을 보호한 뒤 run-meta/date tag를 제거하도록 수정. 이미지 마크다운이 H2 제목 줄에 붙으면 별도 줄로 분리 |
| `pipeline/generate.py` | `conference/event_ops/mice` 등 운영 축 category는 무조건 hong 이미지 풀로, `company/web/systems`는 beok 이미지 풀로 폴백. 운영 키워드가 있으면 빈 문자열 대신 hong/beok 중 하나를 선택 |
| `config.py` | Windows `.env`에 오래된 `SECTION_MAX_LEN=300`이 남아 있어도 코드에서 240으로 하드 캡 |
| `quality_selftest.py` | `compose_article()` 최종 body 기준으로 이미지 URL 보존, H2 인라인 이미지 금지, 신뢰 이미지 2장, 2600자 이하, publish gate 통과를 회귀테스트로 추가 |

검증:
- `python3 blog_publisher/run.py quality_selftest` PASS
- `python3 blog_publisher/run.py selftest` PASS
- `python3 -m compileall -q blog_publisher` PASS
- `git diff --check` PASS

---

## 2026-06-21 — 운영 글 이미지/길이 게이트 정합 보강

Windows 운영 PC에서 생성은 충분히 도는데 review 단계에서 `운영 글 이미지 부족(0~1/2장)`과 `운영 글 본문 과다(2600자 초과)`로 통과 원고가 줄어드는 병목을 보강했다.

| 대상 | 내용 |
|---|---|
| `config.py`, `llm/prompts.py` | 섹션 본문 기본 상한을 300자에서 240자로 낮추고, 생성 프롬프트도 180~240자로 맞춤 |
| `pipeline/generate.py` | 자동 점검표 문구를 짧게 줄여 최종 plain text가 2600자 안에 들어갈 여유를 확보. category가 `conference/event_ops`처럼 축 이름이어도 운영 키워드 기준으로 hong/beok 이미지 풀을 자동 선택 |
| `tools/image_bank.py` | H2 개수나 본문 구조와 무관하게 운영 글에 신뢰 이미지 2장 이상이 남도록 이미지 top-up 보강 |
| `quality_selftest.py` | 운영 글 생성→review→schedule 테스트에 `2600자 이하 + 이미지 2장 + 신뢰 이미지 2장` 계약을 명시하고 sparse 본문 이미지 보강 회귀테스트 추가 |

검증:
- `python3 blog_publisher/run.py quality_selftest` PASS
- `python3 blog_publisher/run.py selftest` PASS
- `python3 -m compileall -q blog_publisher` PASS
- `git diff --check` PASS

---

## 2026-06-19 — hongcomm 이미지 반복 방지와 포트폴리오 이미지 풀 확장

블로그 글이 매번 같은 사진을 쓰면 검색 품질과 사용자 신뢰가 떨어지므로, hongcomm.kr 공개 포트폴리오 이미지를 발행 파이프라인과 공개 블로그 fallback에 반영했다. 본문 안 중복뿐 아니라 글 간 대표 이미지 반복도 줄이기 위해 이미지 선택에 글별 salt와 최근 공개 이미지 회피를 추가했다.

| 대상 | 내용 |
|---|---|
| `tools/image_bank.py` | hongcomm.kr 포트폴리오 공개 썸네일 48개를 `_HONG_PORTFOLIO` 풀로 추가. `pick_image/featured_image/inject_images`에 `salt`와 `avoid`를 도입해 같은 문맥도 글마다 회전 |
| `pipeline/generate.py` | 생성 시 최근 published 본문 이미지를 피해서 본문 이미지를 삽입 |
| `publishers/selfhosted.py` | 대표 이미지가 본문 이미지나 최근 공개 글 이미지와 겹치지 않도록 발행 직전 회피 |
| `functions/blog-images.mjs`, `functions/index.mjs` | Firebase SSR fallback/OG 이미지 후보를 5장 고정에서 hongcomm 공개 이미지 풀로 확장 |
| `functions/blog-pipeline/image-pool.mjs` | AI 블로그 생성 이미지 후보와 선택 로직을 hongcomm 포트폴리오 기반 회전 방식으로 보강 |
| `src/spa/lib/blogImages.ts`, 공개 블로그 페이지 | 클라이언트 라우팅 fallback도 SSR과 같은 이미지 풀 사용 |
| `image_asset_audit.py`, `quality_selftest.py` | hongcomm 포트폴리오 이미지 도달성 및 대표 이미지 회전 회귀테스트 추가 |

검증:
- `python3 blog_publisher/run.py quality_selftest` PASS
- `python3 blog_publisher/run.py image_audit` PASS (`73/73`)
- `python3 blog_publisher/run.py selftest`, `python3 -m compileall -q blog_publisher` PASS
- `node --check functions/index.mjs functions/blog-images.mjs functions/blog-pipeline/image-pool.mjs` PASS
- `npx tsc --noEmit`, `npm run build:spa`, `git diff --check` PASS

---

## 2026-06-19 — Windows Publish 태스크와 Control 큐 분리

Windows 운영 PC에서 `reviewed/queued`는 쌓이지만 `published`가 거의 늘지 않는 병목을 점검했다. 원인은 5분 주기 `Publish` 태스크가 발행 전에 inline control queue를 먼저 폴링하면서 긴 `generate` 명령을 잡고, `IgnoreNew`/긴 실행 제한과 겹쳐 실제 발행 시간이 밀리는 구조였다. Control 명령 실행은 전용 태스크 하나로 일원화하고, 예약 태스크는 자기 단계만 실행하도록 분리했다.

| 대상 | 내용 |
|---|---|
| `ops/windows/run-task.ps1` | control queue 폴링을 기본 off로 변경하고, 필요할 때만 `-RunControl`로 opt-in. `publish/schedule/generate/review` 예약 태스크는 자기 작업만 수행 |
| `ops/windows/install-windows-tasks.ps1` | 분 단위 태스크와 `BEOK Blog Control`에 20분 `ExecutionTimeLimit`, `IgnoreNew`, `Hidden` 설정을 등록 직후 적용. `BEOK Blog Worker`는 no time limit과 실패 시 재시작 설정 |
| `ops/windows/run-control.ps1` | Firebase command queue 전담 폴링 전에 `http://127.0.0.1:8788/health`를 확인하고 worker가 죽어 있으면 `BEOK Blog Worker` 태스크를 재실행 |
| `ops/windows/README.md` | Control 전담 큐 처리, Publish 점유 방지, worker watchdog, 20분 실행 제한 운영 계약 문서화 |
| `quality_selftest.py` | Windows ops 계약 회귀테스트 추가. inline control 기본 실행 재발, 72시간 제한 회귀, worker watchdog 누락을 차단 |

검증:
- `python3 blog_publisher/run.py quality_selftest` PASS
- `python3 blog_publisher/run.py selftest` PASS
- `python3 -m compileall -q blog_publisher`, `git diff --check` PASS

---

## 2026-06-18 — review LLM 55점 스타일 이슈로 인한 0% 탈락 해소

길이 정합 이후 Windows 실측에서 새 원고가 factcheck와 publish length gate는 통과했지만, review LLM이 `score=55`, `unnatural_ko`, `generic`을 반환해 전부 탈락하는 2차 병목이 드러났다. 규칙 게이트와 발행 게이트가 이미 길이·이미지·구조·중복·서비스 축을 차단하므로, LLM review는 사실성/주제이탈/위험/환각 중심의 안전망으로 조정했다.

| 대상 | 내용 |
|---|---|
| `config.py` | `REVIEW_HARD_FAIL_SCORE` 기본값 60 → 50. 기본 critical issue에서 `unnatural_ko` 제거 |
| `pipeline/review.py` | `unnatural_ko/generic/repetitive`는 규칙·발행 게이트 통과 글에서 advisory로 둔다는 정책 주석 반영 |
| `llm/prompts.py` | 섹션 작성 프롬프트에 번역투/보고서투 회피와 문단 리듬 변경 지시 추가. review 프롬프트도 50점 기준과 hard/advisory issue 구분으로 조정 |
| `quality_selftest.py` | Windows 실측 패턴(`score=55`, `unnatural_ko`, `generic`)이 review→schedule을 통과해 `queued`가 되는 회귀테스트 추가. `factual_doubt/off_topic`은 계속 차단 검증 |

검증:
- `python3 blog_publisher/run.py quality_selftest` PASS
- `python3 blog_publisher/run.py selftest` PASS
- `python3 -m compileall -q blog_publisher`, `git diff --check` PASS

---

## 2026-06-18 — 운영 글 생성 길이와 발행 게이트 정합

Windows 운영 PC에서 새 selfhosted 원고가 factcheck를 통과해도 review 단계에서 `운영 글 본문 과다(.../2600자)`로 전부 탈락해 `reviewed=0`, `queued=0`에 고착되는 문제가 있었다. 원인은 생성 계약(5섹션 × 섹션 최대 380자)과 발행 게이트(운영 글 plain text 2600자 이하)가 맞지 않는 것이므로, 생성 쪽을 줄이는 A안으로 정합시켰다.

| 대상 | 내용 |
|---|---|
| `config.py` | `SECTION_MAX_LEN` 기본값 380 → 300 |
| `pipeline/generate.py` | 개요 섹션 상한 5 → 4. 5개 이상 개요는 4개로 보정 |
| `llm/prompts.py` | 개요는 3~4섹션, 섹션 본문은 220~300자로 작성하도록 생성 프롬프트 조정 |
| `quality_selftest.py` | 운영 글 mock이 실제 generate→factcheck→review→schedule을 지나 `queued`가 되는 회귀테스트 추가. `SECTION_MAX_LEN<=300`, `SECTION_MAX<=4` 계약 검증 |

검증:
- `python3 blog_publisher/run.py quality_selftest` PASS (`ops flow: 운영 글 생성 길이와 발행 게이트 길이 상한 정합, queued 전환 유지`)
- `python3 blog_publisher/run.py selftest` PASS (`reviewed → queued → published`)
- `python3 -m compileall -q blog_publisher`, `git diff --check` PASS

---

## 2026-06-18 — Firebase 기반 Windows 운영 제어 큐 추가

운영자가 Windows PC에 직접 명령어를 복붙해야 하는 구조를 없애기 위해 Firebase Functions가 Firestore 명령 큐를 만들고, Windows 운영 PC가 outbound 방식으로 명령을 가져가 실행하는 control plane을 추가했다. Windows PC 인바운드 포트는 열지 않으며, Function은 `BLOG_API_KEY`/Firebase admin auth로 보호되고 Windows는 허용된 작업 whitelist만 실행한다.

| 대상 | 내용 |
|---|---|
| `functions/index.mjs` | `/api/pipeline/commands` 생성/조회, `/claim`, `/:id/complete` 추가. `status-refresh`, `drain-once`, `reset-draft-backlog-and-drain` runbook 지원 |
| `functions/index.mjs` | `/api/pipeline/stats`의 `ops.control`에 최근 명령, pending/running 수 노출 |
| `ops/windows/run-control.ps1` | Firebase 명령 claim → whitelisted `run-task.ps1` 실행 → complete 보고 |
| `ops/windows/run-task.ps1` | 일반 예약 작업 시작 시 control queue도 확인. 재귀 방지를 위해 `-SkipControl` 추가 |
| `ops/windows/install-windows-tasks.ps1` | 신규 설치 시 `BEOK Blog Control` 1분 주기 태스크 등록 |
| `ops/windows/README.md` | Firebase Function runbook 호출 예시와 지원 runbook 문서화 |

검증:
- `node --check functions/index.mjs` PASS
- PowerShell 스크립트는 Mac에 PowerShell 런타임이 없어 Windows에서 최종 실행 확인 필요

---

## 2026-06-18 — 미공개 draft 병목 리셋 명령 추가

품질 조정 이전 원고가 미공개 draft/reviewed/queued에 남아 있으면 스케줄러가 발행을 강제하지 않아도 재고가 낮은 품질의 병목으로 보인다. 공개 글은 건드리지 않고, 미공개 active 원고만 `archived`로 격리한 뒤 beoksolution 홈페이지 구축·학회/기관 홈페이지·MICE 레퍼런스·명찰/접수 운영 축을 섞어 새 draft를 만드는 수동 운영 명령을 추가했다.

| 대상 | 내용 |
|---|---|
| `tools/reset_draft_backlog.py` | 기본 dry-run. `--apply` 시 active 미공개 원고를 archive하고 selfhosted replacement draft 24건을 축별 round-robin으로 시드 |
| `run.py` | `python run.py reset_draft_backlog [--apply]` 명령 추가 |
| `ops/windows/run-task.ps1` | Windows에서 `-Task reset-draft-backlog`로 적용 가능 |
| `quality_selftest.py` | 리셋 후 새 주제축이 홈페이지/MICE/학회시스템/명찰운영으로 분산되는지 회귀테스트 추가 |
| `ops/windows/README.md` | dry-run 확인 후 적용하는 운영 절차 추가 |

검증:
- `python3 blog_publisher/run.py reset_draft_backlog` dry-run PASS
- `python3 -m compileall -q blog_publisher`, `python3 blog_publisher/run.py quality_selftest`, `python3 blog_publisher/run.py selftest` PASS

---

## 2026-06-18 — 자체 블로그 주제·생성 적체 가시화 보강

운영 대시보드 기준 selfhosted 최신 글은 `2026-06-17T14:23:02Z` 1건 이후 오늘 발행이 없고, 로컬 상태 리포트는 `reviewed=0`, `queued=0`으로 보였다. 실제로는 주제 부족이 아니라 body 없는 draft가 쌓인 상태였으므로, beoksolution.com의 운영형 홈페이지 구축 아젠다를 키워드 우선순위에 올리고 generate 처리량과 상태 리포트의 적체 진단을 보강했다.

| 대상 | 내용 |
|---|---|
| `keyword_bank.py` | beoksolution.com 핵심 서비스(초기 제작비 0원, 월 5만원, 서버/SSL/SEO, 예약·결제·알림톡, AI 상담/견적, 학회·기관 홈페이지)를 selfhosted 우선 시드 주제로 추가 |
| `config.py`, `generate.py`, `run.py` | `GENERATE_BATCH` 기본값 2 추가. `run.py generate [batch]`로 1회 생성 처리량 지정 가능 |
| `status_report.py` | draft를 생성 대기(empty body), factcheck 대기, review 대기로 분해해 적체 위치를 표시 |
| `quality_selftest.py` | 홈페이지 구축 아젠다와 generate batch 기본값 회귀테스트 추가 |

검증:
- `python3 -m compileall -q blog_publisher`, `python3 blog_publisher/run.py quality_selftest`, `python3 blog_publisher/run.py selftest` PASS
- `python3 blog_publisher/run.py status`에서 생성 대기 15건, factcheck 대기 1건, review 대기 1건으로 적체 위치 확인

---

## 2026-06-17 — Windows 태스크 git update 경합 방지

공개 `/api/pipeline/stats`가 `LOCAL_SNAPSHOT_STALE`을 표시했고, 마지막 로컬 SQLite 스냅샷이 `2026-06-15T05:59:20Z` 이후 갱신되지 않았다. Windows 작업 스케줄러의 여러 태스크가 같은 시각에 `git fetch/merge`를 동시에 실행하면 `.git/index.lock` 경합으로 본 작업(`generate/review/publish/sync_snapshot`)까지 실행되지 않을 수 있어, Git 업데이트를 잠금으로 직렬화하고 업데이트 실패가 본 작업 실패로 전파되지 않게 보강했다.

| 대상 | 내용 |
|---|---|
| `ops/windows/git-update.ps1` | 공용 Git 업데이트 함수 추가. `.git/beok-update.lock`으로 fetch/merge 직렬화, stale lock 정리, 실패 시 경고 후 현재 checkout으로 계속 실행 |
| `ops/windows/run-task.ps1` | 모든 예약 태스크가 공용 Git 업데이트 함수를 사용하도록 변경 |
| `ops/windows/run-worker.ps1` | 워커 시작 전 Git 업데이트도 동일 잠금 정책 적용 |
| `ops/windows/run-keepalive.ps1` | keepalive 실행 전 Git 업데이트도 동일 잠금 정책 적용 |

검증:
- `git diff --check` PASS
- PowerShell 런타임은 이 Mac에 없어 Windows에서 `run-task.ps1 -Task status`로 최종 확인 필요

---

## 2026-06-17 — review 0% 탈락 루프 완화

리뷰 재고가 0%로 떨어지는 원인을 분리한 결과, 로컬 draft 샘플은 규칙 게이트를 통과했지만 LLM 리뷰의 `generic`/`repetitive` 같은 주관 평가가 hard fail로 처리될 수 있었다. 규칙 게이트와 발행 게이트가 이미 길이·구조·이미지·중복·서비스 축을 차단하므로, LLM 리뷰는 치명 신호 중심의 2차 안전망으로 조정했다.

| 대상 | 내용 |
|---|---|
| `pipeline/review.py` | `review_blockers()` 추가. 60점 미만 또는 critical issue만 hard fail, 주관 개선 이슈는 advisory 처리 |
| `config.py` | `REVIEW_HARD_FAIL_SCORE`, `REVIEW_CRITICAL_ISSUES` 추가. 오래된 `.env`의 섹션 토큰 상한은 1500으로 강제 클램프 |
| `db.py` | 리뷰어/API 오류 시 본문과 grounding을 지우지 않고 draft로 보류하는 `defer_review()` 추가 |
| `prompts.py` | 리뷰 프롬프트를 80점 목표선/60점 hard fail선 정책과 일치하도록 수정 |
| `measure_passrate.py` | 실제 리뷰 판정 함수(`review_blockers`)를 재사용해 측정값과 운영 동작 불일치 제거 |
| `quality_selftest.py` | 주관 이슈 통과, 저점수/주제이탈 차단, 유효 섹션 토큰 상한 회귀테스트 추가 |
| `planning/02-검수게이트-모델운영-정책.md` | LLM 리뷰 hard fail 기준과 오류 보류 정책 갱신 |

검증:
- `python3 -m compileall -q blog_publisher`, `python3 blog_publisher/run.py quality_selftest`, `python3 blog_publisher/run.py selftest` PASS

---

## 2026-06-17 — stale pipeline snapshot 표시 보정

공개 `/api/pipeline/stats`가 15분 이상 오래된 로컬 SQLite 스냅샷을 현재 상태처럼 우선 표시해 자동 글쓰기가 정상인지 판단하기 어려웠다. 스냅샷이 stale이면 실시간 Firestore 집계로 fallback하고 운영 이슈를 명시하도록 Firebase Functions 응답을 보정했다.

| 대상 | 내용 |
|---|---|
| `functions/index.mjs` | `snapshotStale`일 때 local snapshot의 `by_status`, `recent`, `published_today` 등을 사용하지 않고 live 집계로 fallback |
| `functions/index.mjs` | `ops.issue=LOCAL_SNAPSHOT_STALE` 및 Windows 태스크/log 확인 액션 추가 |

검증:
- `node --check functions/index.mjs` PASS

---

## 2026-06-16 — review 탈락 draft 재생성 루프 복구

공개 대시보드와 로컬 DB 모두 `draft=17`, `reviewed=0`, `queued=0` 상태로 확인되어 발행이 멈춘 원인을 점검했다. 일부 글이 review 탈락 후 본문을 유지한 채 draft에 남아 같은 글을 반복 검수하는 문제가 있어 실제 재생성 대상으로 돌아가도록 수정했다.

| 대상 | 내용 |
|---|---|
| `db.py` | `mark_review_failed()`가 본문을 비우고 `grounding_ratio`를 초기화하도록 변경. 검수 탈락 글이 다음 generate 대상이 되게 함 |
| `db.py` | `save_article()`이 재생성 저장 시 이전 `grounding_ratio/review_issues`를 초기화하도록 변경 |

검증:
- 공개 API 기준 최신 발행은 2026-06-14 이후 정지 상태, pipeline stats는 `draft=17`, `reviewed=0`, `queued=0`
- `python3 -m compileall -q blog_publisher`, `python3 run.py selftest`, `python3 run.py quality_selftest` PASS

---

## 2026-06-16 — 자체 블로그 렌더 디자인 보강 및 URL 보안 세척

첨부 진단에서 확인된 자체 블로그 렌더링 결함을 적용하고, LLM/근거 데이터가 만든 마크다운 링크·이미지가 위험 URL을 HTML로 내보내지 못하도록 보안 세척을 추가했다. OG/히어로 SVG 생성기는 추가했지만, 정적 파일 배포 경로가 확정되지 않아 자동 발행 연동은 보류했다.

| 대상 | 내용 |
|---|---|
| `render/renderer.py` | 제목 줄에 붙은 이미지 분리, 목차/요약의 마크다운 원문 제거, 단독 이미지 `figure/figcaption` 승격, hero 이미지 지원, callout 변형 추가 |
| `render/renderer.py` | `javascript:` 등 위험 URL 스킴 차단. 링크는 `http/https/mailto/#/상대경로`, 이미지는 `http/https/사이트 상대경로`만 허용 |
| `render/style.css` | 번호 칩 H2, 리드 문단, 표/그림/요약/목차/CTA/콜아웃 디자인 보강, 모바일·다크모드 유지 |
| `tools/og_card.py` | 제목·카테고리 기반 고유 SVG OG 카드 생성 모듈 추가. 자동 발행 연동은 호스팅 경로 확정 후 적용 |
| `quality_selftest.py` | 제목 이미지 분리, 마크다운 원문 미노출, 위험 URL 제거, OG SVG escape 회귀 테스트 추가 |
| `planning/13-디자인품질-보강-제안.md` | 원인 진단, 적용 패치, 남은 OG 연동/채널 차별화 로드맵 기록 |

검증:
- `python3 -m compileall -q blog_publisher`, `python3 run.py quality_selftest`, `python3 run.py selftest`, `node --check` PASS

---

## 2026-06-16 — 발행 전 compact/readable 품질 게이트 강화

생성 규칙만으로는 긴 글, 이미지 부족 글, 같은 이미지를 반복한 글이 발행 단계까지 도달할 수 있어 publish 직전 차단 기준을 강화했다. 목표는 자체 블로그/티스토리에 나가는 글을 짧고 읽기 쉬운 HTML 구조로 유지하는 것이다.

| 대상 | 내용 |
|---|---|
| `content_quality.py` | 운영 글 기준을 900~2600자 범위로 조정. 이미지 최소 2장, 홍커뮤니케이션/비오케이 계열 이미지 최소 2장, 이미지 URL 반복, 소제목 3개 미만, 표 없음 차단 |
| `quality_selftest.py` | 정상 샘플/긴 글/무이미지/반복이미지/얇은 글에 대한 publish gate 회귀 테스트 추가 |

검증:
- `python3 -m compileall -q blog_publisher`, `python3 run.py quality_selftest`, `python3 run.py selftest` PASS

---

## 2026-06-16 — 품질 조정 이전 글 리셋 및 자체 블로그 연속 운영 보강

짧고 이미지가 다양한 본문 규칙이 들어가기 전에 생성/발행된 글을 운영 DB에서 제거하고, 같은 주제를 새 규칙으로 다시 생성할 수 있게 일회성 리셋 명령을 추가했다. 자체 블로그는 외부 계정 리스크가 낮으므로 재고 보충과 스케줄 주기를 더 촘촘히 조정했다.

| 대상 | 내용 |
|---|---|
| `reset_pre_quality_posts.py`, `run.py` | `reset_pre_quality --apply` 명령 추가. cutoff 이전 selfhosted/tistory 활성 글을 archived 처리하고, 자체 블로그 공개 글은 API로 soft delete 후 같은 주제를 새 draft로 재등록 |
| `reset_pre_quality_posts.py` | 티스토리는 현재 삭제 어댑터가 없으므로 이미 발행된 URL을 report에 수동 삭제 목록으로 남김 |
| `ops/windows/run-task.ps1` | Windows 운영 PC에서 `reset-pre-quality` 태스크로 리셋 명령 실행 가능. selfhosted stock target 15→40 |
| `ops/windows/install-windows-tasks.ps1` | Stock Seed 6시간→1시간, Schedule 30분→15분으로 조정 |
| `.gitignore` | `blog_publisher/reports/` 런타임 리포트 제외 |

검증:
- `python3 -m compileall -q blog_publisher`, `python3 run.py reset_pre_quality` dry-run PASS
- `python3 run.py quality_selftest` PASS
- macOS 환경에 PowerShell이 없어 ps1 파싱은 미실행. Windows 운영 PC에서 pull 후 기존 설치 스크립트로 태스크 재등록 필요

---

## 2026-06-15 — Tavily 비용 의존 제거 및 공식 출처 기반 생성

Tavily는 무료 한도가 있어도 초과 시 비용이 발생하는 외부 검색 API이므로 기본 생성 조건에서 제거했다. 신규 원고는 기본적으로 `beoksolution.com`, `hongcomm.kr` 공식 사이트를 근거 출처로 사용하고, Tavily는 설정했을 때만 선택 보조 검색으로 사용한다.

| 대상 | 내용 |
|---|---|
| `config.py` | `OFFICIAL_SOURCE_URLS` 기본값 추가. `SEARCH_PROVIDER/TAVILY_API_KEY` 없이도 공식 출처가 있으면 생성 가능하도록 변경 |
| `research/official_sources.py`, `research/collect.py` | 공식 사이트 HTML 수집기를 추가하고 외부 검색보다 먼저 근거팩 출처로 사용 |
| `generate.py`, `status_report.py` | Tavily 미설정 경고를 공식 출처 기반 상태 문구로 변경 |
| `sync_pipeline_snapshot.mjs`, `server/index.mjs`, `DashboardPage.tsx` | 운영 대시보드에서 `official_sources=2`, `external_search=off` 구조로 표시. Tavily 입력 유도 제거 |

검증:
- 공식 출처 수집 2건(`beoksolution.com`, `hongcomm.kr`) 확인
- `python3 -m compileall -q blog_publisher`, `node --check`, `status`, `sync_snapshot`, `npm run build:spa`, `npx tsc --noEmit`, `npm run lint -- --max-warnings=999` PASS

---

## 2026-06-15 — 자체 블로그 브랜드 주체 노출 강화

자체 블로그가 비오케이솔루션과 홍커뮤니케이션의 홍보 채널임을 첫 화면, 글 상세, SSR/RSS/JSON-LD에서 명확히 드러내도록 보정했다.

| 대상 | 내용 |
|---|---|
| `PublicBlogPage.tsx` | 히어로와 브랜드 섹션에 `비오케이솔루션 × 홍커뮤니케이션 공식 블로그`, 각 회사 역할/링크 추가 |
| `PublicBlogPostPage.tsx` | 글 상세 CTA와 우측 패널에 비오케이솔루션/홍커뮤니케이션 링크와 홍보 블로그 맥락 추가 |
| `blogTaxonomy.ts`, `server/index.mjs`, `functions/index.mjs` | 사이트명·설명·RSS·SSR·JSON-LD를 두 회사 공식 블로그 기준으로 변경 |
| `config.py`, `sync_pipeline_snapshot.mjs` | 운영 대시보드 focus name 기본값을 `비오케이솔루션 · 홍커뮤니케이션 블로그`로 변경 |

검증:
- `npm run build:spa`, `npx tsc --noEmit`, `npm run lint -- --max-warnings=999` PASS
- `python3 -m compileall -q blog_publisher`, `node --check`, `sync_snapshot` PASS

---

## 2026-06-15 — 복합 콘텐츠 전략 고정 및 공개 글 감사 보강

hongcomm.kr의 MICE·학술대회 운영 맥락과 beoksolution의 홈페이지/맞춤 시스템 개발 맥락을 함께 다루도록 자동 시드와 품질 게이트를 재정렬했다. 명찰 단독 draft 15건은 복합 주제로 교체했고, 공개 블로그에서 서비스 축을 벗어난 마케팅 트렌드 글 1건은 삭제했다.

| 대상 | 내용 |
|---|---|
| `keyword_bank.py`, `prompts.py` | 학술대회 홈페이지, 등록/결제/초록/명찰, MICE 운영, 관리자/백오피스 개발을 연결하는 우선 주제와 작성 지시 추가 |
| `content_quality.py` | 포괄 제목, 서비스 앵커 부족, 학회/MICE 글의 시스템 해법 누락을 발행 전 차단 |
| `strategy_audit.py`, `run.py` | 실제 공개 API 기준 삭제/리라이트/유지 후보를 분류하는 `strategy_audit` 명령 추가 |
| `config.py`, `sync_pipeline_snapshot.mjs`, `server/index.mjs`, `functions/index.mjs` | 허용 콘텐츠 축과 focus inventory 계산을 복합 블로그 기준으로 통일 |
| `CONTENT-STRATEGY-2026-06-15.md` | 운영 기준, 발행 금지 기준, 우선 발행 주제 문서화 |

검증:
- 공개 전략 감사: 39건 검사, 삭제 후보 0건, 리라이트 후보 9건
- 로컬 draft 15건을 복합 주제로 교체, focus_inventory 15 확인
- `python3 -m compileall -q blog_publisher`, `quality_selftest`, `node --check`, `npm run build:spa` PASS

---

## 2026-06-15 — 블로그 다중 콘텐츠 축 복구 및 중복 발행 차단 강화

블로그를 단일 `학회 명찰` 캠페인처럼 취급하던 구조를 `홈페이지 제작`, `맞춤형 시스템 개발`, `학회 운영·명찰 출력`, `홍커뮤니케이션·MICE` 축으로 재정리했다. 개발 홍보 글은 삭제 대상이 아니라 별도 콘텐츠 축으로 유지하고, 진짜 오프토픽·중복 글만 걸러내도록 품질 기준을 바꿨다.

| 대상 | 내용 |
|---|---|
| `src/spa/lib/blogTaxonomy.ts` | 공개 블로그 공통 콘텐츠 축/사이트명/설명 추가 |
| `PublicBlogPage.tsx`, `PublicBlogPostPage.tsx` | 명찰 글만 우선 노출하던 필터 제거. 네 개 콘텐츠 축 허브와 축 기반 관련 글 추천으로 변경 |
| `seo.ts`, `server/index.mjs`, `functions/index.mjs` | OG/RSS/SSR 사이트명을 `비오케이솔루션 블로그`로 확대 |
| `verify_public_posts.py`, `sync_pipeline_snapshot.mjs`, `server/index.mjs` | 공개 품질 검증을 단일 목표 주제가 아니라 허용 콘텐츠 축 기준으로 변경 |
| `content_quality.py` | 당일 동일 본문 차단에 더해 같은 콘텐츠 축의 제목 유사 중복도 차단 |
| `category_map.py`, `config.py`, `auto_seed.py`, `status_report.py`, `DashboardPage.tsx` | 시스템개발 축과 허용 콘텐츠 축 문구 반영 |

운영 정리:
- 프로덕션 자체 블로그에서 중복 제목 4건 삭제. 최신 1건씩은 유지.
- 개발/홈페이지 홍보 글은 삭제하지 않고 블로그 허용 축으로 복구.

검증:
- `npm run build:spa`, `npx tsc --noEmit`, `npm run lint -- --max-warnings=999` PASS
- `python3 -m compileall -q blog_publisher`, `quality_selftest`, `verify_public 20`, `status` PASS
- `node --check server/index.mjs`, `functions/index.mjs`, `sync_pipeline_snapshot.mjs` PASS
- 프로덕션 `/api/blog-posts?status=published&limit=100` 중복 제목 없음 확인

---

## 2026-06-15 — 공개 저품질/오프토픽 글 삭제 정리

반복·무이미지·테스트성 공개 글과 현재 블로그명(`비오케이솔루션 학회 운영 사무국 명찰 출력 발행`)에서 벗어난 과거 주제 글을 공개 채널에서 정리했다. 자체 블로그와 티스토리는 삭제 완료 후 로컬 SQLite 상태를 `archived`로 맞췄고, 네이버는 관리자 세션 만료로 삭제가 보류되었다.

| 대상 | 내용 |
|---|---|
| 자체 블로그 | 저품질/반복 후보 14건 및 오프토픽 과거 글 15건 삭제/원격 누락 확인 후 `archived` 처리 |
| 티스토리 | 저품질/반복 후보 16건 및 오프토픽 2건(`#24`, `#25`) 관리자 삭제 후 `archived` 처리 |
| 네이버 | 삭제 후보 11건 남음. `admin.blog.naver.com` 접근이 네이버 로그인으로 리다이렉트되어 `npm run login` 재인증 후 삭제 필요 |
| 운영 스냅샷 | 삭제 후 `sync_snapshot` 반영. 공개 품질은 13/13 통과, 삭제 감사는 네이버 11건만 남음 |

검증:
- `python3 blog_publisher/run.py cleanup_audit 80` → 네이버 11건만 삭제 후보로 남음
- `python3 blog_publisher/run.py verify_public 30` → 13/13 통과
- 티스토리 `https://beoksolution.tistory.com/24`, `/25` 공개 URL 404 확인
- `python3 blog_publisher/run.py backup`, `python3 blog_publisher/run.py sync_snapshot` PASS

---

## 2026-06-15 — 반복·무이미지 운영 글 자동 발행 차단

네이버/티스토리/자체 블로그에 같은 날 같은 본문이 반복 발행되고, 학회·명찰 운영 글이 이미지 없이 공개되는 문제를 발행 직전 게이트로 막았다. 홍커뮤니케이션은 검색/시드/브랜드 맥락 대상에 포함하고, beok 학회 글은 hongcomm.kr의 공개 시스템·현장 이미지를 우선 사용한다. 기존 공개 글은 즉시 삭제하지 않고 URL별 삭제/비공개 후보를 감사 명령으로 산출한다.

| 대상 | 내용 |
|---|---|
| `blog_publisher/tools/content_quality.py` | 운영 글 본문 길이, 이미지 유무, 당일 동일/고유사 본문, 네이버 이미지 자동발행 미검증 차단 규칙 추가 |
| `blog_publisher/pipeline/publish.py` | 발행 직전 품질 게이트에 `publish_blockers` 연결 |
| `blog_publisher/pipeline/generate.py` | SEO 실패 여부와 무관하게 beok/hong 비네이버 글에 이미지 주입 |
| `blog_publisher/tools/image_bank.py` | beok 학회/명찰 문맥에서 로고보다 hongcomm.kr 시스템·현장 이미지 우선 |
| `blog_publisher/config.py`, `tools/auto_seed.py`, `tools/status_report.py` | 홍커뮤니케이션/MICE/국제회의/동시통역/포트폴리오를 기본 검색·시드 대상에 포함, 브랜드 필터 미설정 재고 계산 보정 |
| `blog_publisher/tools/audit_published_cleanup.py`, `run.py` | `python3 blog_publisher/run.py cleanup_audit` 추가. 중복·무이미지·테스트 제목 공개 글 삭제/비공개 후보 출력 |

검증:
- `python3 -m compileall -q blog_publisher`, `python3 blog_publisher/run.py selftest`, `python3 blog_publisher/run.py quality_selftest` PASS
- `python3 blog_publisher/run.py image_audit` 25/25 PASS
- `publish_blockers`가 #115/#116/#117의 짧은 본문·무이미지·당일 중복·네이버 이미지 미검증을 차단 사유로 감지
- `python3 blog_publisher/run.py cleanup_audit 80`에서 공개 삭제/비공개 후보 41건 산출

---

## 2026-06-15 — 관리자 운영 명령 복사 UX 추가

대시보드가 필요한 CLI 명령을 보여주고는 있었지만, 운영자가 긴 명령을 직접 드래그해야 했다. 세션 복구·검색 복구·품질 점검·로컬 큐 조치 명령을 공통 `CommandBlock`으로 통합하고, 각 명령에 복사 버튼을 붙였다.

| 대상 | 내용 |
|---|---|
| `src/spa/pages/DashboardPage.tsx` | `CommandBlock` 추가. 운영 명령 표시와 클립보드 복사 버튼 공통화 |
| `functions/ssr-template.mjs` | `npm run build:spa` 산출물 갱신 |

검증:
- `npx tsc --noEmit`, `npm run build:spa`, `npm run lint -- --max-warnings=999`, `python3 blog_publisher/run.py quality_selftest` PASS

---

## 2026-06-15 — 관리자 세션 복구 UX 분리

네이버 세션 만료가 운영 준비도 한 줄과 `needs_human` 목록에만 보여, 운영자가 어떤 명령을 어떤 순서로 실행해야 하는지 바로 알기 어려웠다. 외부 채널 세션 문제를 별도 패널로 분리하고, 채널별 재로그인·워커 재시작·스냅샷 갱신·대상 확인 명령을 한 화면에 노출했다.

| 대상 | 내용 |
|---|---|
| `src/spa/pages/DashboardPage.tsx` | `SessionRecoveryPanel` 추가. 세션 비정상 채널, 차단 post id, 실패 사유, 재로그인 명령, 워커 재시작/스냅샷 갱신 명령 표시 |
| `functions/ssr-template.mjs` | `npm run build:spa` 산출물 갱신 |

검증:
- `/api/pipeline/stats` 로컬 응답에서 `naver ok=false`, `error_post_id=114`, `action="npm run login 후 워커 재시작"` 확인
- 실제 공개 URL 검증: 자체 블로그 #112 summary/service/flow/comparison/toc/table/img/CTA 유지, 티스토리 #113 h2 12 / h3 11 / table 3 / blockquote 2 / img 2 / strong 10 / 한자 0 확인
- `npx tsc --noEmit`, `npm run build:spa`, `npm run lint -- --max-warnings=999`, `python3 blog_publisher/run.py quality_selftest` PASS

---

## 2026-06-15 — 공개 품질 검증에 목표 주제 이탈 감지 추가

공개 URL 검증이 HTML 구조와 길이만 확인해, 현재 블로그 운영명(`비오케이솔루션 학회 운영 사무국 명찰 출력 발행`)과 맞지 않는 공개 글도 `OK`로 통과하던 문제를 보완했다. 기존 공개 글은 임의 삭제하지 않고, 공개 품질 검증과 관리자 대시보드에서 비공개/삭제 또는 목표 주제 재작성 판단 대상으로 드러나게 했다.

| 대상 | 내용 |
|---|---|
| `blog_publisher/tools/verify_public_posts.py` | 공개 글 제목/주제가 목표 키워드 2개 이상과 맞지 않으면 `목표 주제 이탈` 이슈로 표시 |
| `blog_publisher/tools/sync_pipeline_snapshot.mjs` | 스냅샷 공개 품질 검사에도 동일한 목표 주제 이탈 감지 추가 |
| `server/index.mjs` | `/api/pipeline/stats` 공개 품질 검사에도 동일한 목표 주제 이탈 감지 추가 |

검증:
- `python3 blog_publisher/run.py verify_public 10`에서 #55, #42 목표 주제 이탈 감지 확인
- `python3 blog_publisher/run.py sync_snapshot`에서 최근 20건 중 공개 품질 `14/20`, 이탈 6건 노출 확인
- `node --check server/index.mjs`, `sync_pipeline_snapshot.mjs` PASS
- `python3 -m compileall -q blog_publisher`, `npx tsc --noEmit` PASS

---

## 2026-06-15 — 관리자 채널별 목표 재고 표시

네이버·티스토리 목표 주제 재고가 0이어도 채널 표에는 발행/예약/수동처리만 보여 운영 정책인지 장애인지 구분하기 어려웠다. `focus_inventory_by_channel`과 외부 자동 시드 설정을 관리자 채널 표에 연결해, 외부 채널 재고 0이 현재 `ALLOW_EXTERNAL_AUTO_SEED=false` 정책 때문임을 바로 볼 수 있게 했다.

| 대상 | 내용 |
|---|---|
| `blog_publisher/tools/sync_pipeline_snapshot.mjs` | `ops.external_auto_seed_enabled` 추가 |
| `server/index.mjs` | `/api/pipeline/stats`에 `external_auto_seed_enabled` 추가 |
| `src/spa/pages/DashboardPage.tsx` | 채널별 `목표재고` 열 추가, 네이버/티스토리 `자동시드 off` 배지와 설명 문구 표시 |
| `functions/ssr-template.mjs` | `npm run build:spa` 산출물 갱신 |

검증:
- `node --check server/index.mjs`, `sync_pipeline_snapshot.mjs` PASS
- `npx tsc --noEmit` PASS
- `python3 blog_publisher/run.py sync_snapshot`에서 `external_auto_seed_enabled=false` 확인
- `python3 blog_publisher/run.py quality_selftest`, `verify_public 10` PASS
- `npm run build:spa` PASS

---

## 2026-06-15 — 관리자 대시보드 이미지 자산 제한 노출

Phase C 이미지 제한이 CLI `image_audit`에만 보이고 관리자 대시보드에서는 보이지 않았다. 운영자가 현재 beok 학회/명찰 글의 이미지 상태를 착각하지 않도록 로컬 스냅샷/API와 대시보드 운영 준비도에 이미지 자산 상태를 노출했다.

| 대상 | 내용 |
|---|---|
| `blog_publisher/tools/sync_pipeline_snapshot.mjs` | `ops.image_asset_health` 추가 |
| `server/index.mjs` | `/api/pipeline/stats`의 `ops.image_asset_health` 추가 |
| `src/spa/pages/DashboardPage.tsx` | 운영 준비도에 `beok 이미지` 셀과 제한 사유/조치 문구 표시 |
| `functions/ssr-template.mjs` | `npm run build:spa` 산출물 갱신 |

검증:
- `node --check server/index.mjs`, `sync_pipeline_snapshot.mjs` PASS
- `npx tsc --noEmit` PASS
- `python3 blog_publisher/run.py sync_snapshot`에서 `image_asset_health` 확인
- `python3 blog_publisher/run.py quality_selftest`, `image_audit`, `verify_public 10` PASS
- `npm run build:spa` PASS

---

## 2026-06-15 — Phase C 이미지 자산 감사 정밀화

`beoksolution.com`에서 공개 접근 가능한 이미지 자산을 직접 확인한 결과 실제 이미지 URL은 `https://beoksolution.com/img/logo.png` 1개뿐이었다. 기존 이미지 감사는 중복 URL을 전역으로 제거해 `beok_conference` 그룹이 출력에서 사라졌고, beok 학회 글이 실제로 어떤 이미지를 쓰는지 운영자가 확인하기 어려웠다.

| 대상 | 내용 |
|---|---|
| `blog_publisher/tools/image_bank.py` | beok 학회/명찰 이미지 후보에 `beoksolution.com/img/logo.png`를 명시적으로 추가 |
| `blog_publisher/tools/image_asset_audit.py` | URL 요청은 캐시하되 그룹별 결과는 모두 출력하도록 변경 |
| `blog_publisher/tools/image_asset_audit.py` | beok 학회/명찰 현장 이미지가 `beoksolution.com`에 없으면 Phase C 제한 경고 출력 |

검증:
- `curl`로 `beoksolution.com`, `/references/`, `/sitemap.xml`, `/robots.txt` 확인
- `https://beoksolution.com/img/logo.png` 200 `image/png` 확인
- `python3 blog_publisher/run.py image_audit` PASS, `beok_conference` 그룹 및 Phase C 제한 경고 확인

---

## 2026-06-15 — Phase B 자체/티스토리 실무 점검 범위 보강

학회 명찰 글에서 독자가 바로 확인해야 하는 운영 범위가 본문 끝 CTA에만 묻히지 않도록, 자체 블로그와 티스토리 변환 결과에 “비오케이솔루션 실무 점검 범위” 블록을 deterministic하게 추가했다. 데이터 검수, 출력 기준, 현장 재발행, 사후 정리를 같은 구조로 노출해 광고 문구가 아니라 사무국 운영 기준으로 읽히게 했다.

| 대상 | 내용 |
|---|---|
| `blog_publisher/render/renderer.py` | 학회/명찰/사무국 글에 `service-proof` 섹션 자동 삽입 |
| `blog_publisher/render/style.css` | 자체 블로그용 실무 점검 범위 레이아웃/반응형 스타일 추가 |
| `src/spa/pages/PublicBlogPostPage.tsx` | 공개 상세 화면의 renderer fragment 클래스 매핑에 `service-proof` 스타일 추가 |
| `executors/naver-blog-worker/tistory-html-adapter.mjs` | 티스토리 HTML 변환 시 학회 명찰 글에 실무 점검 범위 인라인 HTML 보강, 검증 기준 추가 |
| `blog_publisher/tools/quality_selftest.py` | selfhosted/tistory 산출물에 실무 점검 범위가 유지되는지 회귀테스트 추가 |
| `functions/ssr-template.mjs` | `npm run build:spa` 산출물 갱신 |

검증:
- `python3 blog_publisher/run.py quality_selftest` PASS
- `node --check executors/naver-blog-worker/tistory-html-adapter.mjs`, `channel-rewriter.mjs` PASS
- `python3 -m compileall -q blog_publisher` PASS
- `npx tsc --noEmit` PASS
- `python3 blog_publisher/run.py verify_public 10` PASS
- `npm run build:spa` PASS

---

## 2026-06-15 — 목표 주제 재고 고정 및 비목표 큐 격리

발행기는 정상 동작했지만 실제 운영 재고가 블로그명(`비오케이솔루션 학회 운영 사무국 명찰 출력 발행`)과 어긋난 주제로 남아 있었다. 자동 시드와 재고 집계를 목표 주제 기준으로 고정하고, 관리자 대시보드가 전체 재고와 목표 주제 재고를 분리해서 보여주도록 보강했다.

| 대상 | 내용 |
|---|---|
| `blog_publisher/tools/keyword_bank.py` | 학회 명찰·사무국·접수·출력 중심 키워드 20개를 자동 시드 우선순위로 추가 |
| `blog_publisher/config.py` | `BLOG_FOCUS_NAME`, `AUTO_SEED_BRAND_FILTER`, `AUTO_SEED_REQUIRED_TERMS` 기본값 추가 |
| `blog_publisher/tools/auto_seed.py` | `stock_seed`가 채널별·목표 주제 재고만 세고, 비목표 키워드는 자동 생성하지 않도록 변경 |
| `blog_publisher/pipeline/schedule_publish.py` | `reviewed` 글 중 목표 주제와 맞는 글만 발행 큐에 넣도록 제한 |
| `blog_publisher/db/db.py`, `archive_local_posts.py` | 미공개 draft/reviewed/queued 글을 삭제하지 않고 `archived`로 격리하는 `--quarantine` 추가 |
| `status_report.py`, `sync_pipeline_snapshot.mjs`, `server/index.mjs`, `DashboardPage.tsx` | 목표 주제 재고(`focus_inventory`)와 채널별 분포를 상태/관리자 UI에 노출 |
| `functions/ssr-template.mjs` | `npm run build:spa` 산출물 갱신 |

운영 상태 정리:
- 비목표 예약 글 #56과 미공개 비목표 draft 19건을 삭제 없이 `archived`로 격리
- 목표 주제 selfhosted draft 15건 신규 시드(#94~#108)
- 네이버/티스토리는 외부 자동 시드 차단 설정 때문에 재고 0 유지

검증:
- `python3 -m compileall -q blog_publisher` PASS
- `node --check server/index.mjs`, `node --check blog_publisher/tools/sync_pipeline_snapshot.mjs` PASS
- `npx tsc --noEmit` PASS
- `python3 blog_publisher/run.py quality_selftest`, `verify_public 10` PASS
- `npm run build:spa` PASS
- `python3 blog_publisher/run.py status`에서 `focus_inventory=15`, `queued=0`, `needs_human=0`, `failed=0` 확인

---

## 2026-06-15 — 관리자 품질 보강 대상 미리보기 정합성 개선

관리자 대시보드의 `quality_items`가 클라우드 스냅샷에서는 본문 excerpt/preview를 포함하지만 로컬 API에서는 빠져 있어 실행 위치에 따라 운영자가 보는 정보가 달랐다. 품질 보강 대상 목록에서 상세를 열기 전에도 실제 본문 일부를 바로 읽고 판단할 수 있도록 로컬 API와 UI를 맞췄다.

| 대상 | 내용 |
|---|---|
| `server/index.mjs` | 로컬 `/api/pipeline/stats`의 `quality_items`에 `body_available`, `body_excerpt`, `preview_html` 추가 |
| `src/spa/pages/DashboardPage.tsx` | 품질 보강 대상 카드에 본문 excerpt와 미리보기 보유 신호 노출 |
| `functions/ssr-template.mjs` | `npm run build:spa` 산출물 갱신 |

검증:
- `npx tsc --noEmit` PASS
- `node --check server/index.mjs`, `node --check functions/index.mjs` PASS
- `python3 blog_publisher/run.py quality_selftest`, `verify_public 10` PASS
- `npm run build:spa` PASS

---

## 2026-06-15 — Phase A 생성 품질 회귀테스트 추가

Phase A의 핵심 변경(섹션 600~1000자 지시, 섹션 1500토큰, thinking ON, 한자 혼입 재시도/제거)이 코드에는 반영돼 있었지만 `quality_selftest`가 이를 직접 검증하지 못했다. 향후 프롬프트/모델 설정을 손대다가 생성 품질 계약이 조용히 후퇴하지 않도록 오프라인 Mock LLM 기반 회귀테스트를 추가했다.

| 대상 | 내용 |
|---|---|
| `blog_publisher/tools/quality_selftest.py` | `compose_article()`를 Mock LLM으로 실행해 섹션 호출의 `thinking=True`, `max_tokens=MAX_TOKENS_SECTION`, 한자 혼입 재시도, 최종 한자 제거, 구조화 출력(`###`, 목록, 굵게, 표)을 검증 |
| `blog_publisher/llm/client.py` | 설계 주석의 본문 thinking 설명을 현재 구현(ON·1500토큰·품질 우선)에 맞게 수정 |
| `blog_publisher/DESIGN.md` | 섹션 생성 단계 설명을 thinking ON·1500토큰·한자 재시도로 갱신 |

검증:
- `python3 blog_publisher/run.py quality_selftest` PASS. 로그에서 `한자 2자 혼입... 재시도` 확인
- `python3 -m compileall -q blog_publisher` PASS
- 오래된 `thinking OFF` 설명 검색 결과 없음

---

## 2026-06-15 — 공개 블로그 대표 이미지 보존

학회/명찰 글이면 공개 블로그 UI가 실제 `featured_image`를 무시하고 hongcomm 대체 이미지를 강제로 보여주던 문제를 수정했다. 발행 원고가 가진 대표 이미지를 사용자 화면, SSR HTML, OG/JSON-LD 메타에서 우선 보존하고, 대표 이미지가 없을 때만 학회 운영 대체 이미지를 사용한다.

| 대상 | 내용 |
|---|---|
| `src/spa/pages/PublicBlogPage.tsx` | 목록 대표 글 이미지 선택을 `{url, alt}` 구조로 변경하고 `featured_image` 우선 적용 |
| `src/spa/pages/PublicBlogPostPage.tsx` | 상세 hero 이미지와 SEO/JSON-LD image가 같은 선택 정책을 쓰도록 보정 |
| `functions/index.mjs` | SSR 목록/상세/OG/BlogPosting JSON-LD에서 `publicDisplayImage()`로 대표 이미지 우선 정책 통일 |
| `functions/ssr-template.mjs` | `npm run build:spa` 산출물 갱신 |

검증:
- `npx tsc --noEmit` PASS
- `node --check functions/index.mjs` PASS
- `npm run build:spa` PASS
- `python3 blog_publisher/run.py quality_selftest` PASS
- `python3 blog_publisher/run.py verify_public 10`, `needs_human`, `status` PASS
- 자체/티스토리/네이버 단건 실발행 후 공개 URL 검증 완료: selfhosted #42, tistory #87, naver #88

---

## 2026-06-15 — 티스토리 재작성 실패 시 원문 발행 차단

Phase B 품질 목표에서 티스토리는 리치 HTML 품질뿐 아니라 자체 블로그와 다른 독립 문서로 재작성되는 것이 중요하다. 기존에는 재작성 AI가 없거나 품질 기준을 통과하지 못하면 원문 폴백을 티스토리 어댑터가 예쁘게 변환해 발행할 수 있었다. 이 경우 보기에는 괜찮아도 중복 문서 회피 목적이 깨지므로 기본값에서 발행을 중단하도록 했다.

| 대상 | 내용 |
|---|---|
| `executors/naver-blog-worker/channel-rewriter.mjs` | 재작성 실패 사유 `rewrite_error` 반환, `channelRewriteEnabled()` export |
| `executors/naver-blog-worker/index.mjs` | `TISTORY_REWRITE_REQUIRED !== false`이고 재작성 실패 시 `TISTORY_REWRITE_REQUIRED` 오류로 발행 중단 |
| `blog_publisher/tools/quality_selftest.py` | AI key 없음/재작성 실패 상태에서 티스토리 원문 발행이 차단되는지 회귀 테스트 추가 |
| `executors/naver-blog-worker/README.md` | 티스토리 재작성 게이트 운영 방법 문서화 |

검증:
- `node --check executors/naver-blog-worker/channel-rewriter.mjs`, `node --check executors/naver-blog-worker/index.mjs` PASS
- `python3 blog_publisher/run.py quality_selftest` PASS (`티스토리 재작성 실패 시 원문 발행 차단` 확인)
- `python3 -m compileall -q blog_publisher`, `selftest`, `verify_public 10`, `needs_human`, `status` PASS
- `com.beok.blog-worker` LaunchAgent 재시작 및 `/health` 응답 확인

---

## 2026-06-15 — 검색 미설정 시 생성 워커 반복 실패 방지

검색 공급자 미설정 상태에서는 근거 기반 신규 원고를 만들 수 없으므로, 생성 워커가 draft를 claim한 뒤 실패·재시도 카운트를 올리는 대신 주기 자체를 조용히 건너뛰도록 했다.

| 대상 | 내용 |
|---|---|
| `blog_publisher/config.py` | `search_health_status()`, `can_generate_with_evidence()` 추가 |
| `blog_publisher/pipeline/generate.py` | 검색/근거 수집 불가 시 DB claim 전 skip. draft attempts를 올리지 않음 |
| `blog_publisher/tools/status_report.py` | `run.py status`에 검색/근거 수집 가능 여부와 중단 사유 표시 |
| `blog_publisher/tools/selftest.py` | mock 검색 환경을 readiness 게이트에 맞게 설정 |

검증:
- 검색 미설정 상태에서 `python3 blog_publisher/run.py generate` → `생성 0건`, attempts 증가 없음
- `python3 blog_publisher/run.py status`에 `[중단] 검색/근거 수집 불가` 표시
- `python3 -m compileall -q blog_publisher` PASS
- `python3 blog_publisher/run.py selftest`, `quality_selftest`, `sync_snapshot`, `verify_public 10`, `needs_human` PASS
- `node --check server/index.mjs`, `node --check blog_publisher/tools/sync_pipeline_snapshot.mjs`, `npx tsc --noEmit` PASS

---

## 2026-06-15 — 근거 0건 자동 생성 차단 및 검색 상태 운영 노출

네이버 신규 실발행 검증 중 검색/근거 수집이 0건인 상태에서 내부 기능을 추정한 원고가 만들어지는 문제가 확인됐다. 해당 원고는 발행하지 않고 보관했으며, 근거 없는 원고가 다시 발행 경로로 들어가지 않도록 생성·팩트체크 게이트를 강화했다.

| 대상 | 내용 |
|---|---|
| `blog_publisher/pipeline/generate.py` | 운영 run tag 제거 범위를 평문 패턴까지 확대하고, 생성 후 title/meta/body 안전망 추가. 개행 보존 버그 수정 |
| `blog_publisher/pipeline/generate.py` | `MIN_GROUNDING_RATIO > 0`에서 검색 출처 0건이면 원고 생성을 중단 |
| `blog_publisher/pipeline/factcheck.py` | evidence facts가 0건이면 LLM 평가 없이 grounding 0.0으로 탈락 |
| `blog_publisher/tools/sync_pipeline_snapshot.mjs`, `server/index.mjs` | `ops.search_health` 추가: 일반 검색/Tavily, 네이버 SERP 키 상태 노출 |
| `src/spa/pages/DashboardPage.tsx` | 운영 준비도에 `검색/근거` 셀 추가 |

운영 정리:
- 네이버 검증용 id 86은 근거 0건으로 발행하지 않고 `archived` 처리
- 패치 전 cron이 만든 근거 0건 draft id 41은 본문 제거 및 재생성 대기 처리
- 패치 전 생성 프로세스 중단 후 stuck 상태 복구

검증:
- `python3 -m compileall -q blog_publisher` PASS
- `python3 blog_publisher/run.py selftest`, `quality_selftest` PASS
- `node --check server/index.mjs`, `node --check blog_publisher/tools/sync_pipeline_snapshot.mjs`, `npx tsc --noEmit` PASS
- `npm run build:spa`, `npm run lint -- .` PASS(0 errors / 기존 warnings)
- `python3 blog_publisher/run.py sync_snapshot`에서 `search_health.ok=false` 및 미설정 사유 확인
- `python3 blog_publisher/run.py verify_public 10`, `needs_human` PASS
- Firebase Hosting/Functions 배포 후 `/api/pipeline/stats`에서 `ops.search_health` 반영 확인

---

## 2026-06-15 — 배포 관리자 품질 항목 상세 미리보기 보강

배포된 관리자 대시보드는 로컬 SQLite를 직접 읽을 수 없기 때문에 품질 항목을 눌렀을 때 본문 원인을 확인하지 못할 수 있었다. 로컬 스냅샷에 제한된 미리보기 HTML을 함께 싣고, Firebase 함수가 스냅샷에서 상세 항목을 찾도록 보강했다.

| 대상 | 내용 |
|---|---|
| `blog_publisher/tools/sync_pipeline_snapshot.mjs` | `quality_items`/`needs_human_posts`에 6KB 이하 안전 HTML 미리보기와 1,200자 본문 excerpt 추가 |
| `functions/index.mjs` | `/api/pipeline/posts/:id`가 Firestore 글/외부 발행 로그에서 못 찾은 경우 `pipeline_snapshots/local`의 품질·수동처리 항목을 조회해 상세 응답 |

검증:
- `node --check functions/index.mjs`, `node --check blog_publisher/tools/sync_pipeline_snapshot.mjs` PASS
- `python3 blog_publisher/run.py sync_snapshot` PASS
- Firestore `pipeline_snapshots/local.quality_items[0]`에 `preview_html`/`body_excerpt` 저장 확인

---

## 2026-06-15 — 관리자 운영 준비도에 채널 세션 헬스 노출

네이버/티스토리 발행 실패의 주요 원인인 세션 만료를 발행 시점이 아니라 대시보드에서 미리 확인할 수 있도록 세션 파일 헬스 상태를 운영 준비도에 추가했다.

| 대상 | 내용 |
|---|---|
| `blog_publisher/tools/sync_pipeline_snapshot.mjs` | 네이버/티스토리 세션 파일 존재 여부, 갱신 시각, age hour, 파일 크기, 72시간 기준 ok 여부를 `ops.session_health`로 동기화 |
| `server/index.mjs` | 로컬 `/api/pipeline/stats`도 같은 세션 헬스 상태 반환 |
| `src/spa/pages/DashboardPage.tsx` | 운영 준비도 카드에 `채널 세션` 셀 추가. 세션 없음/72시간 초과 시 확인 필요 표시 |
| `functions/ssr-template.mjs` | SPA 빌드 산출 템플릿 갱신 |

검증:
- `node --check server/index.mjs`, `node --check blog_publisher/tools/sync_pipeline_snapshot.mjs` PASS
- `npx tsc --noEmit` PASS
- `python3 blog_publisher/run.py sync_snapshot`에서 naver/tistory 세션 `ok: true` 확인
- `npm run lint -- .` 0 errors / 기존 warnings 유지
- `python3 blog_publisher/run.py quality_selftest`, `verify_public 10`, `needs_human` PASS
- `npm run build:spa`, Firebase Hosting 배포 PASS

---

## 2026-06-15 — 관리자 운영 준비도에 품질 게이트 상태 노출

발행 품질 사고의 직접 원인이었던 `MIN_GROUNDING_RATIO`/`MIN_REVIEW_SCORE` 설정을 운영자가 대시보드에서 바로 볼 수 있도록 파이프라인 스냅샷과 로컬 관리자 API에 품질 게이트 상태를 추가했다.

| 대상 | 내용 |
|---|---|
| `blog_publisher/tools/sync_pipeline_snapshot.mjs` | `blog_publisher/.env`에서 품질 게이트 값을 읽어 `ops.quality_gate`에 `min_grounding_ratio`, `min_review_score`, `enforced`, `ok` 저장 |
| `server/index.mjs` | 로컬 `/api/pipeline/stats`도 동일한 품질 게이트 상태를 반환 |
| `src/spa/pages/DashboardPage.tsx` | 운영 준비도 카드에 `품질 게이트` 셀 추가. 0 또는 운영 기준 미달이면 확인 필요로 표시 |
| `functions/ssr-template.mjs` | SPA 빌드 산출 템플릿 갱신 |

검증:
- `node --check server/index.mjs`, `node --check blog_publisher/tools/sync_pipeline_snapshot.mjs` PASS
- `npx tsc --noEmit` PASS
- `python3 blog_publisher/run.py sync_snapshot`에서 `quality_gate: { min_grounding_ratio: 0.9, min_review_score: 80, enforced: true, ok: true }` 확인
- `npm run lint -- .` 0 errors / 기존 warnings 유지
- `python3 blog_publisher/run.py quality_selftest`, `verify_public 10` PASS
- `npm run build:spa`, Firebase Hosting 배포 PASS

---

## 2026-06-15 — 품질 게이트 복구와 네이버 생성 제약 강화

채널별 실발행 검증에서 자체 블로그·티스토리는 발행됐지만 `grounding_ratio=0.0` 글도 통과했고, 네이버는 이미지/마크다운 표가 포함된 원고라 자동 발행이 차단됐다. 발행 전 품질 게이트를 코드에서 강제하고, 네이버 원고는 생성 단계부터 이미지/표를 만들지 않도록 제약을 주입했다.

| 대상 | 내용 |
|---|---|
| `blog_publisher/pipeline/publish.py` | `MIN_GROUNDING_RATIO` 또는 `MIN_REVIEW_SCORE`가 0 이하이면 모든 채널 자동 발행을 `needs_human`으로 차단. 글별 `grounding_ratio`가 기준 미만이어도 발행 금지 |
| `blog_publisher/pipeline/generate.py` | 운영 run tag/실발행 검증 문자열이 본문 소재로 새지 않도록 topic 정리 |
| `blog_publisher/pipeline/generate.py` | 네이버 채널은 이미지/HTML 표/마크다운 표를 만들지 않도록 섹션 프롬프트 규칙 주입, 마크다운 이미지 제거, 마크다운 표를 불릿으로 변환 |
| `blog_publisher/llm/prompts.py` | 섹션 작성 프롬프트에 채널별 작성 규칙 슬롯 추가 |
| `blog_publisher/tools/selftest.py` | mock selftest도 운영 기준(`grounding 0.9`, review 80)으로 통과하도록 고정 |

운영 정리:
- 로컬 `.env`의 `MIN_GROUNDING_RATIO=0.9`, `MIN_REVIEW_SCORE=80` 복구
- 네이버 테스트 산출물 id 83은 실제 발행되지 않았고 `archived` 처리
- 과거 0점 상태로 예약된 id 41, 54는 발행 큐에서 빼고 재생성 대상으로 되돌림

검증:
- `python3 -m compileall -q blog_publisher` PASS
- `python3 blog_publisher/run.py selftest` PASS
- `python3 blog_publisher/run.py quality_selftest` PASS
- 품질 게이트 비활성 발행 차단 재현 PASS
- 네이버 mock 원고에서 이미지/표/run tag 제거 확인
- 운영 상태: inventory=15 이상, `needs_human=0`, `failed=0`, 공개 품질 샘플 20/20 OK

---

## 2026-06-15 — 공개 블로그 글 읽기 경험 보강

사용자 화면 품질 목표에 맞춰 공개 글 상세 화면에 긴 글을 읽기 위한 구조 신호를 추가했다. 글 본문에서 h2/h3를 읽어 목차 anchor를 자동 생성하고, 읽기 시간·이미지·표 개수를 사이드바에 노출해 실제 산출물의 밀도와 구조를 사용자가 바로 판단할 수 있게 했다.

| 대상 | 내용 |
|---|---|
| `src/spa/pages/PublicBlogPostPage.tsx` | 본문 h2/h3 자동 anchor 및 목차 생성, 읽기 시간/소제목/이미지/표 신호 추가 |
| `src/spa/pages/PublicBlogPostPage.tsx` | 데스크톱 사이드바를 `ARTICLE MAP` + 비오케이솔루션 운영 신뢰 패널로 분리 |
| `functions/index.mjs` | 실제 공개 URL을 담당하는 SSR 블로그 글 HTML에도 동일한 읽기 시간/목차/ARTICLE MAP 반영 |
| `server/index.mjs` | Express 5에서 production SPA fallback의 `app.get('*')`가 서버 시작을 깨뜨리는 문제를 `app.use` fallback으로 수정 |
| `functions/ssr-template.mjs` | SPA 빌드 산출 템플릿 갱신 |

검증:
- `npx tsc --noEmit` PASS
- `npm run build:spa` PASS
- `node --check server/index.mjs` PASS
- `node --check functions/index.mjs` PASS
- `npm run lint -- .` 0 errors / 기존 warnings 유지
- 로컬 production 서버에서 실제 공개 글 렌더링 확인: desktop/mobile 모두 H1, 읽기 시간, ARTICLE MAP, 목차 8개 렌더, 수평 overflow 없음

---

## 2026-06-15 — 관리자 needs_human 보관 액션 보강

네이버 id 67처럼 자동 재시도 금지로 격리된 글은 대시보드에서 "왜 막혔는지"뿐 아니라 검토 완료 후 운영 경고에서 제거할 수 있어야 한다. 로컬 관리자 API에 보관 액션을 추가하고, 대시보드가 로컬 SQLite 항목과 외부 발행 결과 로그를 구분해 보관하도록 보강했다.

| 대상 | 내용 |
|---|---|
| `server/index.mjs` | `/api/pipeline/posts/:id/archive` 추가. `needs_human/failed` 로컬 SQLite 글을 `archived`로 전환하며 기존 오류를 보존 |
| `server/index.mjs` | 네이버 `PASTE/SmartEditor/RICH_CONTENT` 오류를 재큐잉 금지 정책에 포함 |
| `blog_publisher/tools/sync_pipeline_snapshot.mjs` | 스냅샷의 `needs_human_posts`에 `can_requeue`, `reason`, `action`, `can_archive` 필드 추가 |
| `src/spa/pages/DashboardPage.tsx` | 상세 패널과 목록에서 로컬/외부 보관 액션 분기 처리 |
| `functions/ssr-template.mjs` | SPA 빌드 산출 템플릿 갱신 |

검증:
- `npx tsc --noEmit` PASS
- `node --check server/index.mjs`, `node --check blog_publisher/tools/sync_pipeline_snapshot.mjs` PASS
- 로컬 `/api/pipeline/stats`에서 id 67이 `can_requeue=false`, `reason=네이버 구조 손실/품질 실패 글은 자동 재발행 금지`, `can_archive=true`로 노출 확인
- `npm run build:spa` PASS
- `npm run lint -- .` 0 errors / 기존 warnings 유지

---

## 2026-06-15 — 채널별 실발행 검증과 네이버 구조손실 재시도 차단

자체 블로그·티스토리·네이버를 각각 1건씩 실제 발행 경로로 실행했다. 자체 블로그와 티스토리는 공개 URL 200 응답과 이미지/표 보존을 확인했고, 네이버는 SmartEditor에 긴 리치 원고를 붙여넣는 과정에서 이미지·표 구조가 깨지는 것을 확인해 자동 발행을 차단했다.

| 대상 | 내용 |
|---|---|
| `blog_publisher/publishers/base.py` | `NeedsHumanError` 추가. 재시도보다 수동 확인이 안전한 실패를 상태머신에서 구분 |
| `blog_publisher/db/db.py` | `mark_needs_human()` 추가 |
| `blog_publisher/pipeline/publish.py` | `NeedsHumanError` 발생 시 즉시 `needs_human` 격리 및 알림 |
| `blog_publisher/publishers/naver.py` | `PASTE_STRUCTURE_LOST`, `NAVER_RICH_CONTENT_UNSUPPORTED`, URL 미회수/공개 품질 실패를 재시도 금지 수동 확인으로 분류 |
| `blog_publisher/publishers/tistory.py` | 저장 후 공개 URL 미확인(`TISTORY_PUBLIC_URL_NOT_FOUND`)은 중복 위험 때문에 수동 확인으로 분류 |
| `executors/naver-blog-worker/index.mjs` | 네이버 자동 발행 전 이미지/HTML 표/마크다운 표 잔존을 감지하면 `NAVER_RICH_CONTENT_UNSUPPORTED`로 조기 중단 |
| `blog_publisher/tools/status_report.py` | 채널별 inventory/queued/published/needs_human/failed 요약 추가 |

실측:
- 자체 블로그 id 43 → `https://beokmkt.web.app/blog/협회-단체-홈페이지-제작-시-필수-고려-사항-및-예산-가이드` HTTP 200, img/table 확인
- 티스토리 id 66 → `https://beoksolution.tistory.com/24` HTTP 200, img/table 확인
- 네이버 id 67 → `PASTE_STRUCTURE_LOST`, 덤프에서 이미지 0개·table 0개·마크다운 표 노출 확인. 자동 재시도 중단 후 `needs_human` 격리
- 현재 채널별 상태: naver inventory=0 queued=0 published=6 needs_human=1, selfhosted inventory=15 queued=3 published=20, tistory published=9 queued=0

검증:
- `python3 -m compileall blog_publisher` PASS
- `node --check` PASS: `index.mjs`, `naver-html-adapter.mjs`, `channel-rewriter.mjs`
- `NeedsHumanError` 분류 런타임 테스트 PASS
- `python3 blog_publisher/run.py quality_selftest` PASS
- `python3 blog_publisher/run.py selftest` PASS

---

## 2026-06-15 — 핵심 파이프라인 LaunchAgent 고정

macOS `crontab` 적용이 반환되지 않는 환경을 다시 확인했다. 이미 품질 점검과 스냅샷 동기화는 LaunchAgent로 안정화했으므로, 생성·팩트체크·검수·스케줄·발행·복구·백업도 LaunchAgent로 분리해 운영 자동화의 주체를 macOS 서비스로 고정했다.

| 대상 | 내용 |
|---|---|
| `blog_publisher/ops/com.beok.blog-generate.plist` | 30분마다 `run.py generate` 실행 |
| `blog_publisher/ops/com.beok.blog-factcheck.plist` | 15분마다 `run.py factcheck` 실행 |
| `blog_publisher/ops/com.beok.blog-review.plist` | 30분마다 `run.py review` 실행 |
| `blog_publisher/ops/com.beok.blog-schedule.plist` | 30분마다 `run.py schedule` 실행 |
| `blog_publisher/ops/com.beok.blog-publish.plist` | 5분마다 `run.py publish` 실행 |
| `blog_publisher/ops/com.beok.blog-recover.plist` | 35분마다 `run.py recover` 실행 |
| `blog_publisher/ops/com.beok.blog-backup.plist` | 매일 04:00 `run.py backup` 실행 |
| `blog_publisher/ops/install-ops.sh` | 핵심 파이프라인 LaunchAgent 설치 대상 추가 |
| `blog_publisher/ops/crontab.example` | LaunchAgent 우선 운영과 crontab 백업 용도를 명확히 정리 |

검증:
- 신규/기존 plist 전체 `plutil -lint` PASS
- `launchctl load` 후 `stock-seed`, `generate`, `factcheck`, `review`, `schedule`, `publish`, `recover`, `backup`, `sync-snapshot` 등록 확인
- 짧은 단계 kickstart 확인: factcheck/review/recover 0건, schedule 1건 큐 등록, snapshot 갱신
- generate는 실제 id 51 생성 작업을 집어가 진행 중(섹션 작성 로그 확인)

---

## 2026-06-15 — 재고 보충과 factcheck/review 큐 조회 버그 수정

실제 운영 상태를 확인한 결과 발행 실패가 아니라 `reviewed` 재고가 모두 예약 큐로 빠진 뒤 새 draft가 없거나, 본문이 있는 draft가 빈 draft 뒤에 밀려 factcheck/review가 계속 0건 처리되는 문제가 있었다. 목표 재고 기반 시드 보충과 본문 보유 draft 직접 조회를 추가해 생성된 글이 실제 `reviewed`까지 올라가게 고쳤다.

| 대상 | 내용 |
|---|---|
| `blog_publisher/tools/auto_seed.py` | `stock_seed`용 `run_stock()` 추가. draft/generating/reviewing/reviewed 전발행 재고가 목표 미만이면 부족분만 시드 |
| `blog_publisher/run.py` | `python3 run.py stock_seed [channel] [target]` 명령 추가 |
| `blog_publisher/db/db.py` | `fetch_factcheck_ready()`, `fetch_review_ready()` 추가. 빈 draft가 앞에 있어도 본문 있는 글을 직접 조회 |
| `blog_publisher/pipeline/factcheck.py`, `pipeline/review.py` | 일반 draft 조회 대신 전용 ready 조회 사용 |
| `blog_publisher/tools/status_report.py` | reviewed 단독 경고 대신 전발행 재고와 검토완료 전환 대기를 분리 표시 |
| `blog_publisher/ops/com.beok.blog-stock-seed.plist` | 30분마다 목표 재고 보충 LaunchAgent 추가 |
| `blog_publisher/ops/com.beok.blog-sync-snapshot.plist` | 5분마다 관리자 대시보드 스냅샷 동기화 LaunchAgent 추가 |
| `server/index.mjs`, `functions/index.mjs`, `DashboardPage.tsx` | `ops.inventory`/`inventory_target` 노출 및 UI 표시 |

검증:
- `python3 blog_publisher/run.py stock_seed selfhosted`로 draft 15건 보충
- 실제 생성 id 50 완료: 7,659자, H2 6개, H3 17개, 표 3개, 한자 0개
- 수정 전 `factcheck/review`는 0건 처리, 수정 후 `factcheck 통과 1`, `review 통과 1`
- 현재 상태: `draft=14`, `reviewed=1`, `queued=3`, `inventory=15/15`, `needs_human=0`, `failed=0`

---

## 2026-06-15 — 로컬 SQLite 운영 상태를 클라우드 관리자 화면에 동기화

배포된 관리자 화면은 Firestore를 읽고, 실제 블로그 자동화 큐는 맥의 로컬 SQLite를 읽는 구조라 `published:0` 같은 상태가 실패인지 예약 대기인지 구분되지 않았다. 로컬 SQLite 상태를 Firestore 스냅샷으로 올리고, 클라우드 `/api/pipeline/stats`가 이 스냅샷을 우선 반영하도록 연결했다.

| 대상 | 내용 |
|---|---|
| `blog_publisher/tools/sync_pipeline_snapshot.mjs` | 로컬 `blog.db`의 상태별/채널별 카운트, 품질 지표, 재고 목표, due 큐, stuck 작업, 최근 글을 `pipeline_snapshots/local`에 업로드 |
| `blog_publisher/run.py` | `python3 run.py sync_snapshot` 명령 추가 |
| `blog_publisher/ops/crontab.example` | 5분마다 스냅샷 동기화 추가 |
| `functions/index.mjs` | Firestore 스냅샷이 있으면 클라우드 대시보드의 `by_status`, `by_channel`, `quality`, `ops`, `recent`에 로컬 상태를 우선 사용. 스냅샷 생성/동기화 시각과 stale 여부 노출 |
| `server/index.mjs` | 로컬 API도 동일한 `ops.snapshot_*` 필드 노출 |
| `src/spa/pages/DashboardPage.tsx` | 운영 준비도에 로컬 동기화 상태, 검토 재고, 예약 대기, 즉시 발행 대상, stuck 작업을 함께 표시 |
| `blog_publisher/tools/status_report.py` | `queued`가 실패인지 예약 대기인지 구분되도록 due 큐와 다음 예약 UTC 표시 |

검증:
- `python3 blog_publisher/run.py sync_snapshot` 실제 Firestore 업로드 성공
- `npx tsc --noEmit`, `npm run build:spa`, `npm run lint -- .`(0 errors), `python3 blog_publisher/run.py quality_selftest` PASS
- 현재 로컬 상태: `reviewed=0`, `queued=3`, `queued_due=0`, 다음 예약 UTC `2026-06-15 00:02:00`

---

## 2026-06-15 — 자체 블로그 CTA/태그 렌더링 품질 보정

queued/reviewed 글을 실제 렌더링해 읽어본 결과, 홈페이지 제작 글에도 학회 명찰 CTA가 붙고 로컬 DB의 JSON 태그 문자열이 글자 단위 태그로 풀릴 수 있는 문제가 있었다. 발행 직전 렌더러가 글의 주제에 맞는 CTA와 태그를 안정적으로 만들도록 보정했다.

| 대상 | 내용 |
|---|---|
| `blog_publisher/render/renderer.py` | `tags`가 JSON 문자열이어도 배열로 파싱. 학회/명찰/사무국 글에만 명찰 CTA를 쓰고, beok 홈페이지·예약·자동화 글에는 운영 시스템 CTA를 사용 |
| `blog_publisher/publishers/selfhosted.py` | 자체 블로그 발행 렌더링 시 `category`, `topic`, `blog_profile`도 전달해 CTA 분기가 실제 발행 경로에서도 동작하게 함 |

검증:
- `python3 blog_publisher/run.py quality_selftest` PASS
- queued id 41, reviewed id 42/43 렌더링에서 홈페이지 글 CTA가 운영 시스템 상담 문구로 변경됨
- id 41/42/43 태그가 글자 단위가 아니라 실제 SEO 태그 배열로 출력됨

---

## 2026-06-15 — 채널별 실발행 검증과 생성 워커 하드 타임아웃

자체 블로그·티스토리·네이버 블로그를 각각 1건씩 실제 발행 경로로 실행해 공개 URL까지 확인했다. 발행기는 세 채널 모두 동작했지만, 운영 재고가 쌓이지 않는 직접 원인은 `generate` 단계였다. 기존 생성 워커는 외부 LLM/SSL 대기에서 멈추면 cron 주기 전체를 붙잡고 `generating` 상태도 남길 수 있었다.

| 대상 | 내용 |
|---|---|
| `blog_publisher/pipeline/generate.py` | 생성 워커에 단일 실행 락 추가. 글 1건 생성을 자식 프로세스로 격리하고, 하드 타임아웃 초과 시 자식 프로세스를 종료한 뒤 `draft`로 재큐잉. 고품질 섹션 생성 시간이 길어 cron 1주기가 과도해지지 않도록 기본 배치를 1건으로 축소 |
| `blog_publisher/pipeline/generate.py` | 생성 단계별 진행 로그(`query_plan`, `outline`, `section n/m`, `seo`) 추가. 표가 하나도 없는 원고는 H2 기반 실행 점검표를 자동 추가 |
| `blog_publisher/research/evidence.py` | 의도/키워드 JSON 단계는 `thinking=false`, `MAX_TOKENS_INTENT`로 분리해 `.env`의 큰 outline 토큰 설정이 첫 단계까지 느리게 만들지 않게 함 |
| `blog_publisher/config.py` | `GENERATE_POST_TIMEOUT_SEC`, `GENERATE_PROCESS_ISOLATION`, `MAX_TOKENS_INTENT`, `MAX_TOKENS_OUTLINE_JSON` 추가 |
| `blog_publisher/tools/image_bank.py` | beok 홈페이지 제작 글에 학회/명찰 이미지가 잘못 들어가지 않도록 학회 이미지 선택 조건을 강한 키워드(`학회`, `명찰`, `사무국`, `참가자`)로 제한 |

검증:
- 자체 블로그 id 44 → `https://beokmkt.web.app/blog/비오케이솔루션-학회-운영-사무국-명찰-출력-안내-selfhosted-점검-20260615-001712` HTTP 200
- 티스토리 id 45 → `https://beoksolution.tistory.com/22` HTTP 200
- 네이버 id 46 → `https://blog.naver.com/PostView.naver?blogId=beoksolution&Redirect=View&logNo=224315889399&categoryNo=1&isAfterWrite=true&isMrblogPost=false&isHappyBeanLeverage=true&contentLength=13886` HTTP 200
- `GENERATE_POST_TIMEOUT_SEC=1 python3 blog_publisher/run.py generate`에서 1초 후 자식 프로세스 종료, `generating=0` 유지 확인
- `python3 blog_publisher/run.py selftest` PASS
- 실제 생성 id 42: 6,310자 생성 후 보정 7,107자, 표 3개, beok 이미지 3개, 한자 0개, `reviewed`
- 실제 생성 id 43: 9,922자, H2 9개, H3 19개, 표 3개, beok 이미지 2개, 한자 0개, `reviewed`
- 현재 남은 문제는 `reviewed=2 < 목표 15` 재고 부족

---

## 2026-06-15 — 운영 품질 점검 LaunchAgent와 공개 블로그 인덱스 이미지 보강

macOS에서 `crontab <file>` 적용이 반환되지 않는 상태를 확인했다. 공개 URL 검증, Phase B 품질 셀프테스트, 이미지 자산 감사는 crontab에만 의존하지 않도록 LaunchAgent로 분리해 실제 로드·강제 실행까지 확인했다. 또한 배포된 `/blog/`는 SPA가 아니라 Cloud Functions SSR 템플릿이 먼저 응답하므로, 사용자 블로그 인덱스의 이미지 0개 문제를 SSR 템플릿에서 직접 보강했다.

| 대상 | 내용 |
|---|---|
| `blog_publisher/ops/com.beok.blog-verify-public.plist` | 매시 17분 `python3 run.py verify_public 20` 실행 |
| `blog_publisher/ops/com.beok.blog-quality-selftest.plist` | 0/6/12/18시 23분 `quality_selftest` 실행 |
| `blog_publisher/ops/com.beok.blog-image-audit.plist` | 매일 05:41 `image_audit` 실행 |
| `blog_publisher/ops/install-ops.sh` | 품질 점검 LaunchAgent 설치/로드 단계 추가 |
| `functions/index.mjs` | SSR `/blog/` 인덱스에 대표 이미지와 카드 썸네일 추가, Blog 구조화 데이터 주제를 학회 명찰 운영으로 정리. 학회/명찰 글 이미지는 검증된 행사·명찰 자산 풀에서 제목 기반으로 분산 |
| `src/spa/pages/PublicBlogPage.tsx`, `src/spa/pages/PublicBlogPostPage.tsx` | 클라이언트 라우팅에서도 같은 대표 이미지 분산 규칙 적용 |

검증:
- 3개 plist `plutil -lint` OK, 실제 `launchctl load` 후 `kickstart` 실행
- `quality_selftest` PASS, `image_audit` 20/20 PASS, `verify_public 20` 20/20 PASS
- Playwright 렌더 기준 `/blog/` desktop/mobile overflow 없음. 기존 배포본은 이미지 0개였고, 이번 보강은 SSR 템플릿에서 직접 처리

---

## 2026-06-14 — 운영 큐 보관과 외부 발행 최종 제목 추적

과거 검증/삭제가 끝난 네이버·티스토리 실패 항목이 계속 `needs_human/failed`로 남아 운영 화면을 오염시키던 문제를 정리했다. 삭제하지 않고 `archived` 상태로 분리해 audit trail을 유지한다. 또한 티스토리/네이버 워커가 채널용 재작성 후 공개 제목을 바꾸는 경우, Python 파이프라인 DB와 클라우드 외부 발행 결과가 최종 공개 제목을 보존하도록 했다.

| 대상 | 내용 |
|---|---|
| `blog_publisher/db/db.py` | `archive_posts()` 추가. 기존 `last_error`를 `previous:`로 보존하며 `archived` 상태로 전환 |
| `blog_publisher/tools/archive_local_posts.py` | `needs_human/failed` 로컬 항목을 검토 완료 사유와 함께 보관하는 CLI 추가 |
| `blog_publisher/run.py` | `python3 run.py archive_local [ids...] [--all-reviewed]` 명령 추가 |
| `blog_publisher/tools/status_report.py` | `archived` 상태 카운트 노출 |
| `executors/naver-blog-worker/index.mjs` | 네이버/티스토리 발행 응답에 최종 제목, 재작성 여부, 티스토리 품질 지표 포함 |
| `blog_publisher/publishers/naver.py`, `blog_publisher/publishers/tistory.py`, `blog_publisher/pipeline/publish.py` | 외부 워커 결과가 dict이면 최종 제목으로 DB `title`을 맞춰 published 처리 |
| `server/index.mjs`, `functions/index.mjs` | 외부 발행 결과에 `title`, `original_title`, `rewritten`, `quality` 저장 |
| `src/spa/pages/DashboardPage.tsx` | 로컬 조치 패널에 `archive_local` 명령 추가 |

운영 처리:
- 로컬 실DB의 오래된 `needs_human/failed` 13건을 `archived` 처리. 현재 `needs_human=0`, `failed=0`, `archived=13`.
- `crontab.example`은 세션 keepalive를 매일 실행으로 조정. 실제 `crontab /tmp/beok-crontab.new` 적용은 macOS에서 명령이 반환되지 않아 중단했고, 기존 crontab은 유지됨.

---

## 2026-06-14 — Phase C 이미지 자산 도달성 감사

beoksolution.com 공개 페이지를 확인한 결과 현재 직접 노출된 이미지 자산은 `https://beoksolution.com/img/logo.png`뿐이었다. 학회/명찰 실사 이미지는 beoksolution.com에 공개되어 있지 않아 기존 검증된 카드/홍커뮤니케이션 명찰 이미지를 유지하되, 깨진 이미지 URL을 발행 전에 잡기 위한 감사 명령을 추가했다.

| 대상 | 내용 |
|---|---|
| `blog_publisher/tools/image_asset_audit.py` | 이미지 뱅크의 공개 URL을 실제 요청해 HTTP 상태, content-type, 응답 가능 여부를 검사 |
| `blog_publisher/run.py` | `python3 run.py image_audit` 명령 추가 |
| `blog_publisher/ops/crontab.example` | 매일 05:41 이미지 자산 감사 실행 |
| `src/spa/pages/DashboardPage.tsx` | 로컬 조치 패널에 `이미지 자산 감사` 명령 추가 |

검증:
- `python3 run.py image_audit` PASS
- beoksolution.com 직접 이미지 후보는 로고 1개만 확인

---

## 2026-06-14 — Phase B 렌더러/티스토리 품질 셀프테스트

티스토리/자체 블로그 디자인 품질은 공개 발행 후에야 드러나는 문제가 많아, 발행 전 회귀 검증 명령을 추가했다. 외부 발행·LLM 호출 없이 실제 렌더러와 티스토리 HTML 어댑터를 돌려 리치 HTML 구성요소가 유지되는지 확인한다.

| 대상 | 내용 |
|---|---|
| `blog_publisher/tools/quality_selftest.py` | 자체 블로그 `render_body()`와 티스토리 `convertForTistory()`/`validateTistoryHtml()`을 실제 실행해 summary/toc/cta/table/image/callout, h2/list/table/blockquote/strong/CTA 유지 여부를 검사 |
| `blog_publisher/run.py` | `python3 run.py quality_selftest` 명령 추가 |
| `blog_publisher/ops/crontab.example` | 6시간마다 `quality_selftest` 실행해 발행 전 렌더러/어댑터 회귀를 로그로 남김 |
| `blog_publisher/ops/newsyslog-blog.conf` | `/tmp/blog-quality.log` 로테이션 추가 |
| `src/spa/pages/DashboardPage.tsx` | 로컬 조치 패널에 `발행 전 품질 셀프테스트` 명령 추가 |

검증:
- `python3 run.py quality_selftest` PASS
- `python3 -m py_compile blog_publisher/tools/quality_selftest.py blog_publisher/run.py` PASS
- `node --check executors/naver-blog-worker/tistory-html-adapter.mjs` PASS

---

## 2026-06-14 — 관리자 대시보드 공개 URL 품질 카드

정기 `verify_public`은 로그/알림으로 동작하지만, 관리자 화면에서도 최근 공개 URL 품질을 바로 볼 수 있도록 Cloud Functions API와 SPA 대시보드를 보강했다.

| 대상 | 내용 |
|---|---|
| `functions/index.mjs` | `/api/pipeline/stats` 응답에 `public_quality` 추가. 최근 공개 URL 최대 8건을 6초 타임아웃으로 실제 조회해 HTTP, 본문 길이, 이미지, h1/h2, 금칙어, 보이는 취소선, 채널별 URL 형식을 검사 |
| `src/spa/pages/DashboardPage.tsx` | 공개 URL 품질 검증 카드 추가. 실패 시 문제 URL, HTTP 상태, 본문/이미지 수, 실패 사유를 관리자 화면에 노출 |

검증:
- `node --check functions/index.mjs`, `npx tsc --noEmit`, `npm run build:spa`, `npm run lint -- .` PASS
- `python3 run.py verify_public 12` → published 공개 글 12/12 통과
- 배포 후 `/api/pipeline/stats`에 `public_quality` 노출 확인. 클라우드 외부 발행 로그의 과거 네이버 취소선 문제는 대시보드에서 실패 항목으로 표시됨

---

## 2026-06-14 — 공개 품질 검증 운영 자동화 연결

`verify_public`이 수동 도구로만 남지 않도록 운영 자동화에 연결했다. published 공개 URL의 실제 HTML 품질이 깨지면 정기 점검 로그와 알림에서 드러나도록 했다.

| 대상 | 내용 |
|---|---|
| `blog_publisher/tools/verify_public_posts.py` | 공개 품질 검증 실패 시 `utils.notify`로 경고 알림 발송 |
| `blog_publisher/ops/crontab.example` | 매시 17분 `python3 run.py verify_public 20` 실행 추가 |
| `blog_publisher/ops/newsyslog-blog.conf` | `/tmp/blog-verify.log` 로테이션 추가 |
| `src/spa/pages/DashboardPage.tsx` | 로컬 큐 조치 패널에 `공개 품질 검증` 명령 추가 |

검증:
- `python3 run.py verify_public 12` → published 공개 글 12/12 통과
- 대시보드 SPA 빌드 후 배포 예정

---

## 2026-06-14 — 공개 URL 검증 도구와 published 품질 재분류

운영자가 "발행 URL이 생겼다"와 "실제 공개 산출물이 품질 기준을 통과했다"를 분리해 볼 수 있도록 로컬 검증 명령을 추가했다. 실제 공개 HTML을 읽어 자체/티스토리/네이버별 최소 품질 신호를 점검한다.

| 대상 | 내용 |
|---|---|
| `blog_publisher/tools/verify_public_posts.py` | 로컬 SQLite의 `published` 글을 공개 URL로 재조회해 HTTP 200, 본문 길이, 이미지, h1/h2, 금칙어, 취소선, 자체 블로그 중복 header를 검사 |
| `blog_publisher/run.py` | `python3 run.py verify_public [limit]` 명령 추가 |
| `functions/index.mjs`, `src/spa/pages/PublicBlogPage.tsx`, `src/spa/pages/PublicBlogPostPage.tsx` | 학회/명찰 글에 검증된 명찰 출력 이미지를 공개 렌더링 fallback으로 표시. 저장 본문 내부 h1은 h2로 낮춤 |
| 실DB | 공개 금칙어가 남아 있던 티스토리 id=18을 `published`에서 `needs_human`으로 격리. 삭제/외부 수정은 하지 않고 수동 확인 대상으로 분리 |

검증:
- `python3 run.py verify_public 12` → published 공개 글 12/12 통과
- 자체 블로그 오래된 학회/명찰 글: h1 1개, 이미지 1개 이상 확인
- 네이버 공개 글: 빈 zero-width 취소선은 실패로 보지 않고, 보이는 취소선만 실패 처리하도록 검사 기준 조정
- Firebase Functions/Hosting 배포 완료

---

## 2026-06-14 — beok 학회/명찰 이미지 풀 보강

Phase C의 막힘 지점이던 beok 실제 이미지 자산을 재점검했다. `beoksolution.com` 공개 사이트와 sitemap 기준으로 수집 가능한 이미지는 로고 1개뿐이었다. 학회/명찰 글에는 이미 공개 도달성이 확인된 hongcomm.kr의 실제 명찰·출력 시스템 이미지를 beok 학회운영 컨텍스트에 연결했다.

| 대상 | 내용 |
|---|---|
| `blog_publisher/tools/image_bank.py` | beok 학회/명찰 컨텍스트용 실제 이미지 풀 추가: 모바일 디지털 명찰, 지류 명찰 자동 출력, 고속 명찰 출력 장비 |
| `blog_publisher/tools/image_bank.py` | `featured_image('beok', ...)`가 학회/명찰/QR/재발행/현장 문맥이면 실제 학회운영 이미지를 우선 선택 |
| `blog_publisher/tools/image_bank.py` | beok 본문 이미지 삽입도 학회운영 문맥에서는 SVG 정보카드 대신 실제 명찰 운영 이미지를 최대 3장 삽입 |
| `blog_publisher/tools/image_bank.py` | 조사 결합(`프린터와` 등)에도 매칭되도록 이미지 점수 계산을 부분 문자열까지 확장 |

검증:
- `beoksolution.com/img/logo.png` 200 image/png
- `hongcomm.kr/img/page/b2.png` 200 image/png
- `hongcomm.kr/img/page/c1.jpg` 200 image/jpeg
- `hongcomm.kr/img/page/2.jpg` 200 image/jpeg
- 샘플 beok 명찰 글: 이미지 3장 삽입(`b2.png`, `c1.jpg`, `2.jpg`)
- `python3 -m py_compile blog_publisher/tools/image_bank.py`, `python3 run.py selftest` PASS

---

## 2026-06-14 — 자체 블로그 본문 구조/카테고리 보정

자체 블로그 공개 상세에서 페이지가 이미 제목/메타를 렌더링하는데, 저장된 `content` 안에도 `<article><header><h1>`이 들어가 중복 제목이 생길 수 있는 구조를 정리했다. 또한 학회·명찰 글이 `홈페이지제작`으로 표시되는 카테고리 매핑 문제를 보정했다.

| 대상 | 내용 |
|---|---|
| `blog_publisher/render/renderer.py` | `render_body()`를 API 저장용 본문 fragment로 분리. 새 자체 블로그 글에는 내부 `<article><header><h1>`을 저장하지 않음 |
| `src/spa/pages/PublicBlogPostPage.tsx`, `functions/index.mjs` | 이미 발행된 글의 저장 본문에 남아 있는 embedded article/header를 공개 렌더링 단계에서 제거 |
| `blog_publisher/tools/category_map.py` | beok 명찰/학회/사무국/QR/재발행/현장 키워드를 `학회운영` 카테고리로 우선 매핑 |
| `src/spa/pages/PublicBlogPage.tsx`, `src/spa/pages/PublicBlogPostPage.tsx`, `functions/index.mjs` | 공개 목록·상세·JSON-LD의 표시 카테고리를 제목/태그 기준으로 `학회운영` 보정 |

검증:
- 렌더러 샘플: `render_body()` h1 0, article 0, summary/toc/cta/table 유지
- 카테고리 샘플: 학회 명찰 제목 → `학회운영`
- `node --check functions/index.mjs`, `python3 -m py_compile`, `npx tsc --noEmit`, `npm run build:spa`, `python3 run.py selftest` PASS
- Firebase Functions/Hosting 배포 후 실제 공개 상세 HTML: h1 1개, embedded article header 0, `학회운영` 표시 확인

---

## 2026-06-14 — 티스토리 rewriter 품질 게이트/GLM thinking 보정

Phase B의 핵심인 티스토리 채널 재작성 품질을 실제 모델 호출 기준으로 보강했다. 기존 rewriter는 품질 지시는 있었지만 GLM reasoning 토큰이 길어지면 최종 `content`가 비어 원문 폴백되는 문제가 있었다.

| 대상 | 내용 |
|---|---|
| `executors/naver-blog-worker/channel-rewriter.mjs` | 재작성 호출에 `thinking: disabled` 기본 적용. `AI_REWRITE_THINKING=true`일 때만 켜도록 분리 |
| `executors/naver-blog-worker/channel-rewriter.mjs` | 티스토리 재작성 품질 함수 추가: 길이, h2, 목록, 표/콜아웃, 강조, 첫머리 요약, 마지막 상담 CTA 검사 |
| `executors/naver-blog-worker/channel-rewriter.mjs` | 1차 재작성 품질 미달 시 실패 사유를 넣어 1회 수리 재작성 후, 그래도 미달이면 폴백 |
| `executors/naver-blog-worker/tistory-html-adapter.mjs` | 발행 직전 HTML 게이트를 1000자, h2 3개, 목록 4개, 표/콜아웃, 요약, CTA 기준으로 강화 |
| `executors/naver-blog-worker/.env.example` | `AI_REWRITE_MAX_TOKENS`, `AI_REWRITE_THINKING`, `TISTORY_AI_THINKING` 운영 설정 추가 |

실측 검증:
- thinking 미설정 상태: 실제 티스토리 재작성 2회 모두 빈 `content` → 원문 폴백 확인
- thinking disabled 적용 후: 실제 공개 글 기준 `rewritten=true`
- 결과 지표: 2614자, h2 4개, 목록 항목 14개, 표 1개, 콜아웃 1개, 이미지 1개, CTA 포함
- 티스토리 변환 HTML 게이트 PASS

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
