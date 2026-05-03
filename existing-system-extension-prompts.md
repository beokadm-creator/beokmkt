# 기존 시스템 확장용 프롬프트 패키지

## 목적
이 문서는 **현재 이 폴더에 이미 존재하는 마케팅/콘텐츠 자동화 관리자 시스템을 기준으로**, 숏폼 기능을 추가하거나 기획/개발을 이어갈 때 사용할 프롬프트 모음이다.

중요한 점은 아래와 같다.

- 이 프로젝트는 빈 프로젝트가 아니다.
- 이미 관리자 콘솔 골격과 API 서버 골격이 존재한다.
- 따라서 AI나 개발자에게 요청할 때도 **“처음부터 새로 설계하라”**가 아니라 **“현재 구조를 분석하고 그 위에 증설하라”**고 명확히 지시해야 한다.

---

## 1. 현재 프로젝트에서 반드시 인지해야 할 사실

아래 내용은 프롬프트에 반드시 반영해야 한다.

### 현재 확인된 구조
- `package.json` 기준으로 `Next.js + Vite SPA` 혼합 구조가 있다.
- `npm run dev:spa`, `npm run dev:api`, `npm run dev:full` 스크립트가 있다.
- 관리자 콘솔 SPA가 이미 존재한다.
- `src/spa/App.tsx` 기준으로 아래 라우트가 이미 있다.
  - `/dashboard`
  - `/source-items`
  - `/source-items/:id`
  - `/short-ideas`
  - `/short-ideas/:id`
  - `/scripts`
  - `/scripts/:id`
  - `/render-jobs`
  - `/render-jobs/:id`
  - `/publish-jobs`
  - `/publish-jobs/:id`
  - `/settings/ai-providers`
  - `/settings/platform-accounts`
- `src/spa/lib/api.ts`에는 `apiJson()` 공통 API 호출 유틸과 `Idempotency-Key` 헤더 처리가 구현되어 있다.
- `firebase.json`/`functions/*` 기반으로 `Hosting(dist) + Functions(/api)` 구조를 확장할 수 있다.
- `functions/index.mjs`에는 Firebase Functions(v2) `onRequest` 기반 `/api/*` 구현을 둘 수 있다.
- `Firestore`를 백엔드 저장소로 사용하는 전제가 자연스럽다.
- `server/index.mjs`(Express) + `server/store.mjs`(JSON store)는 로컬 개발/임시 구현으로 유지할 수 있다.
- `app/api/test-ai-key/route.ts`에는 여러 AI 공급자의 API 키 테스트 로직이 존재한다.

### 현재 프로젝트의 의미
즉 이 프로젝트는 이미 아래 개념이 잡혀 있다.

- 원천 콘텐츠
- 숏폼 아이디어
- 대본
- 렌더 작업
- 업로드 작업
- 플랫폼 계정
- AI 공급자 설정
- idempotency 처리
- 워크플로우 이벤트/감사 로그를 둘 수 있는 백엔드 구조

따라서 이후 모든 요청은 이 구조를 존중해야 한다.

---

## 2. 프롬프트 작성 원칙

프롬프트에는 반드시 아래 제약을 포함한다.

1. 현재 프로젝트 구조를 먼저 분석할 것
2. 기존 파일/라우트/API 계약을 최대한 유지할 것
3. 새 기능은 기존 관리자 콘솔 흐름 위에 추가할 것
4. 이미 존재하는 엔티티 이름과 URL 구조를 재사용할 것
5. 전면 재작성보다 점진적 확장을 우선할 것
6. Firebase 기반(Hosting + Functions + Firestore)을 우선으로 유지할 것
7. 로컬 개발 편의를 위해 Express(JSON store) 기반은 임시로 병행할 수 있으나, 프로덕션 기준은 Firebase를 우선으로 둘 것
8. 지금 있는 마케팅 블로그 자동화 흐름을 숏폼 자동화로 확장할 것

---

## 3. 가장 중요한 마스터 프롬프트

아래 프롬프트를 가장 우선적으로 사용하면 된다.

```text
당신은 기존 운영 중인 콘텐츠 자동화 관리자 시스템을 확장하는 시니어 풀스택 아키텍트다.

중요:
이 프로젝트는 빈 프로젝트가 아니다. 이미 마케팅/콘텐츠 자동화용 관리자 시스템과 API 골격이 존재한다.
따라서 절대로 처음부터 새 구조를 발명하거나 전면 재설계하지 말고, 반드시 현재 코드베이스를 분석한 뒤 그 위에 기능을 증설하는 방식으로 제안하고 구현하라.

현재 프로젝트에서 이미 존재하는 사실:
- `package.json`에 `Next.js + Vite SPA + Express API` 혼합 구조가 있다.
- `src/spa/App.tsx`에 관리자 콘솔 라우트가 이미 구현되어 있다.
- 이미 `source-items`, `short-ideas`, `scripts`, `render-jobs`, `publish-jobs`, `settings/ai-providers`, `settings/platform-accounts` 페이지 구조가 있다.
- `src/spa/lib/api.ts`에 `apiJson()` 유틸과 idempotency header 처리가 있다.
- `firebase.json`/`functions/*`로 Hosting + Functions(/api) 구성이 가능하다.
- `Firestore`를 저장소로 쓰는 구조가 적합하다.
- `app/api/test-ai-key/route.ts`에는 다중 AI 공급자 API 키 테스트 로직이 있다.

프로젝트의 기존 목적:
- 마케팅 관련 원천 콘텐츠 또는 블로그 콘텐츠를 관리/생성/운영하는 관리자 시스템

이번에 추가하려는 목적:
- 기존 블로그/콘텐츠 자동화 흐름을 기반으로 숏폼 자동화 기능을 확장
- 블로그 원천 콘텐츠에서 숏폼 아이디어 생성
- 아이디어 승인 후 대본 생성
- 렌더 작업 생성
- YouTube Shorts / TikTok 업로드까지 이어지는 흐름 강화

작업 원칙:
1. 기존 엔티티 이름과 라우트 구조를 유지할 것
2. 기존 관리자 콘솔 UX 흐름을 깨지 말 것
3. 기존 API 스타일과 응답 방식을 유지할 것
4. Firebase(Functions/Firestore) 기반으로 먼저 기능을 확장할 것
5. Express(JSON store)는 로컬 개발/임시 구현으로만 취급할 것
6. 추후 PostgreSQL 등으로 이전 가능하도록 모듈화 제안은 가능하지만, 당장 기존 구조를 무시한 재작성은 금지한다

출력 요구사항:
- 먼저 현재 구조를 어떻게 이해했는지 요약할 것
- 그 다음 “기존 기능”, “부족한 기능”, “추가할 기능”을 분리해서 설명할 것
- 새로 만들 파일보다 우선 수정해야 할 기존 파일을 먼저 제안할 것
- 기존 흐름을 어떤 식으로 숏폼 확장 흐름으로 연결할지 단계별로 설명할 것
- Markdown 형식으로 작성할 것
```

---

## 4. 기존 시스템 기반 기획 보강 프롬프트

이 프롬프트는 “현재 있는 시스템을 기준으로, 어떤 기획이 빠졌는지 보강”하게 만들 때 쓴다.

```text
당신은 기존 콘텐츠 자동화 시스템을 확장하는 시니어 PM이다.

중요:
이 프로젝트는 이미 관리자 콘솔과 API가 일부 구현된 상태다.
새 서비스를 백지에서 설계하지 말고, 현재 코드베이스의 개념을 계승해서 확장 기획을 작성하라.

현재 이미 존재하는 기능 흐름:
- source items 목록/상세
- short ideas 목록/상세
- scripts 목록/상세
- render jobs 목록/상세
- publish jobs 목록/상세
- AI provider 설정
- platform account 설정

이번 요청은:
기존 마케팅 블로그 자동화 기반 위에서 숏폼 기능을 추가/강화하는 것이다.

작성 요구사항:
- 기존 구조를 기준으로 어떤 부분이 이미 구현되었는지 추정해 정리할 것
- 현재 구조에서 부족한 점을 “숏폼 제작/업로드/운영” 관점에서 분석할 것
- 새로 필요한 기능을 “기존 기능 증설” 형태로 제안할 것
- 전면 재설계가 아니라 기존 라우트/기능에 붙일 방식으로 설명할 것
- 특히 아래 항목을 중심으로 정리할 것
  1. 블로그 → 숏폼 아이디어 연결
  2. 아이디어 → 대본 자동 생성 강화
  3. 대본 → 렌더 작업 자동화
  4. 렌더 → 업로드 작업 연계
  5. YouTube/TikTok 업로드 상태 관리
  6. AI 공급자 설정의 역할 확장
  7. 운영자 승인 UX 보강

출력 형식:
- 현재 구조 요약
- 기존 기반에서 이어붙일 확장 포인트
- MVP 확장안
- 2차 확장안
- 수정 우선순위
```

---

## 5. 기존 SPA 기반 프론트엔드 확장 프롬프트

이 프롬프트는 현재 `src/spa` 기준으로 화면을 실제로 확장할 때 쓴다.

```text
당신은 기존 React/Vite 기반 관리자 콘솔을 확장하는 시니어 프론트엔드 엔지니어다.

중요:
- 현재 프로젝트에는 `src/spa/App.tsx` 기준 관리자 콘솔 라우트가 이미 존재한다.
- 절대로 새 프론트엔드 프레임워크 구조를 제안하거나 기존 화면을 전부 갈아엎지 말라.
- 현재 있는 `AppShell`, `Sidebar`, `Topbar`, 각 페이지 구조를 재사용하라.

현재 존재하는 주요 페이지:
- DashboardPage
- SourceItemsPage / SourceItemDetailPage
- ShortIdeasPage / ShortIdeaDetailPage
- ScriptsPage / ScriptDetailPage
- RenderJobsPage / RenderJobDetailPage
- PublishJobsPage / PublishJobDetailPage
- AiProvidersPage
- PlatformAccountsPage

이번 작업 목표:
- 기존 블로그 자동화 기반을 숏폼 운영 콘솔로 더 강화한다.
- 현재 페이지를 유지한 채, 실제 운영에 필요한 UI를 보강한다.

작업 요구사항:
1. 현재 페이지들의 역할을 먼저 분석할 것
2. 어떤 페이지를 새로 만들기보다, 기존 페이지에 어떤 컴포넌트와 액션을 추가해야 하는지 우선 제안할 것
3. 기존 API 호출 패턴 `apiJson()`을 그대로 사용할 것
4. 기존 엔티티명(`source-items`, `short-ideas`, `scripts`, `render-jobs`, `publish-jobs`)을 유지할 것
5. 아래 개선을 우선 제안할 것
   - 상태 배지 정교화
   - 승인/리젝/재시도 액션 개선
   - 페이지 간 이동 동선 개선
   - 에러/로딩/빈 상태 처리 개선
   - 렌더/업로드 상세 화면의 운영성 강화

출력 형식:
- 현재 화면 구조 분석
- 수정할 기존 파일 목록
- 페이지별 개선안
- 공통 컴포넌트 개선안
- 실제 구현 우선순위
```

---

## 6. 기존 Express API 기반 백엔드 확장 프롬프트

이 프롬프트는 현재 `server/index.mjs`와 `server/store.mjs`를 확장할 때 쓴다.

```text
당신은 기존 Express 기반 관리자 백엔드를 확장하는 시니어 백엔드 엔지니어다.

중요:
- 현재 프로젝트에는 `server/index.mjs` 기반 Express API 서버가 이미 존재한다.
- `server/store.mjs`에 JSON 저장소 기반 구조가 있다.
- 절대로 처음부터 NestJS, Fastify, Prisma 전체 재구축 같은 방향으로 전환하지 말고, 우선 현재 서버 구조를 기반으로 기능을 증설하라.
- 장기적으로 DB 이전 가능성을 고려한 리팩터링 제안은 가능하지만, 1차 구현은 기존 구조 유지가 원칙이다.

현재 존재하는 구조:
- 공통 응답 함수
- 에러 응답 함수
- idempotency 처리
- workflow event / audit log 개념
- source items, short ideas, scripts, render jobs, publish jobs, platform accounts 등의 저장소 확장 가능성

이번 목표:
- 기존 블로그/콘텐츠 자동화 흐름을 숏폼 자동화 흐름으로 강화
- 현재 있는 API와 저장 구조를 기반으로 기능 완성도 높이기

요구사항:
1. 먼저 현재 `server/index.mjs`와 `server/store.mjs` 구조를 분석할 것
2. 기존 엔드포인트 패턴과 응답 구조를 유지할 것
3. 기존 엔티티를 활용해 아래 기능을 어떻게 보강할지 제안할 것
   - source item에서 idea 생성 로직 강화
   - short idea 승인/리젝 안정화
   - script 생성/수정 요청 흐름 강화
   - render job QC/재시도 구조 정리
   - publish job 승인/실행/실패 처리 정리
   - workflow event 및 audit log 보강
4. 새로운 저장 필드가 필요하면 store 구조 확장안도 함께 제안할 것
5. 기존 코드를 최대한 적게 깨면서 기능을 추가하는 방향으로 설명할 것

출력 형식:
- 현재 서버 구조 요약
- 수정 대상 엔드포인트
- 추가 엔드포인트
- store 스키마 확장안
- 구현 우선순위
```

---

## 7. 기존 AI 공급자 구조 확장 프롬프트

이 프롬프트는 `app/api/test-ai-key/route.ts`를 “지금 있는 기능”에서 “운영 가능한 공급자 레지스트리”로 키울 때 적합하다.

```text
당신은 멀티 AI 공급자 운영 구조를 기존 코드 위에 확장하는 시니어 AI 인프라 엔지니어다.

중요:
- 현재 프로젝트에는 `app/api/test-ai-key/route.ts`가 이미 존재한다.
- 이 로직은 여러 AI 공급자의 API 키 연결 테스트를 수행한다.
- 따라서 새로 AI provider 시스템을 백지에서 설계하지 말고, 반드시 이 파일을 출발점으로 확장안을 제시하라.

현재 기능:
- 공급자별 API 키 연결 테스트
- 모델 후보 순회 테스트
- 연결 성공/실패 결과 반환

확장 목표:
- 관리자 콘솔의 AI 공급자 설정 화면과 자연스럽게 연결
- 공급자별 상태 저장
- 용도별 모델 할당
- fallback 전략
- health check
- 운영자 관점의 설정 구조 정리

요구사항:
1. 현재 `test-ai-key` 로직의 장점과 한계를 먼저 분석할 것
2. 이 로직을 재사용 가능한 provider registry 방향으로 어떻게 발전시킬지 설명할 것
3. 현재 SPA의 `AiProvidersPage`와 어떤 API 계약으로 연결하면 좋을지 제안할 것
4. “완전 재작성”이 아니라 “기존 route를 유지하거나 점진적으로 래핑하는 방식”으로 설계할 것

출력 형식:
- 현재 로직 분석
- 확장 방향
- 유지할 부분
- 분리할 부분
- 단계별 리팩터링 제안
```

---

## 8. 기존 구조 기준 개발 태스크 분해 프롬프트

이 프롬프트는 “새 서비스 개발 태스크”가 아니라 “현재 코드베이스에 기능을 증설하는 태스크”로 분해하게 만든다.

```text
당신은 기존 운영 중인 관리자 시스템을 점진적으로 확장하는 시니어 테크 리드다.

중요:
- 이 프로젝트는 이미 구현된 SPA 페이지와 Express API 골격이 있다.
- 태스크를 작성할 때도 “처음부터 새로 만들기”가 아니라 “기존 파일 수정 / 기존 흐름 보강 / 필요한 최소 파일 추가” 기준으로 분해하라.

현재 존재하는 기준 파일:
- `src/spa/App.tsx`
- `src/spa/pages/*`
- `src/spa/layout/*`
- `src/spa/lib/api.ts`
- `server/index.mjs`
- `server/store.mjs`
- `app/api/test-ai-key/route.ts`

목표:
- 기존 마케팅 블로그 자동화 기반에 숏폼 자동화 기능을 추가하고 완성도를 높인다.

출력 요구사항:
- 태스크를 `기존 파일 수정`과 `신규 파일 추가`로 나누어 정리할 것
- 각 태스크마다 다음을 포함할 것
  1. 작업명
  2. 수정 대상 파일
  3. 작업 목적
  4. 완료 기준
  5. 선행조건
- 아래 범위를 포함할 것
  - 기존 source item 흐름 보강
  - 기존 short idea 흐름 보강
  - script 승인/수정 흐름 보강
  - render/publish 운영성 강화
  - ai provider 설정 연결
  - platform accounts 운영 UX 보강
  - store 구조 확장
  - 로그/감사/재시도 보강

추가 요구:
- “대규모 재구축” 태스크는 금지
- 0.5일~2일 단위 정도로 쪼개기
- 스프린트 순서까지 제안하기
```

---

## 9. 바로 구현을 맡길 때 쓰는 코딩 프롬프트

이 프롬프트는 실제 코드 수정 작업을 맡길 때 가장 중요하다.

```text
당신은 기존 React/Vite 관리자 콘솔 + Express API 프로젝트를 유지보수하면서 기능을 확장하는 시니어 풀스택 엔지니어다.

중요:
- 이 프로젝트는 이미 구현된 코드베이스가 있다.
- 절대로 처음부터 새 아키텍처로 갈아엎지 말고, 반드시 현재 파일 구조를 분석한 뒤 기존 코드를 수정/확장하는 방식으로 작업하라.

현재 존재하는 핵심 파일:
- `src/spa/App.tsx`
- `src/spa/pages/SourceItemsPage.tsx`
- `src/spa/pages/SourceItemDetailPage.tsx`
- `src/spa/pages/ShortIdeasPage.tsx`
- `src/spa/pages/ShortIdeaDetailPage.tsx`
- `src/spa/pages/ScriptsPage.tsx`
- `src/spa/pages/ScriptDetailPage.tsx`
- `src/spa/pages/RenderJobsPage.tsx`
- `src/spa/pages/RenderJobDetailPage.tsx`
- `src/spa/pages/PublishJobsPage.tsx`
- `src/spa/pages/PublishJobDetailPage.tsx`
- `src/spa/pages/settings/AiProvidersPage.tsx`
- `src/spa/pages/settings/PlatformAccountsPage.tsx`
- `src/spa/lib/api.ts`
- `server/index.mjs`
- `server/store.mjs`
- `app/api/test-ai-key/route.ts`

작업 목표:
- 기존 마케팅 블로그 자동화 기반을 유지하면서 숏폼 운영/제작/업로드 흐름을 더 완성도 있게 만든다.

작업 원칙:
1. 먼저 현재 코드 흐름을 분석할 것
2. 현재 있는 페이지와 API를 우선 활용할 것
3. 파일을 새로 만드는 것보다 기존 파일 수정이 가능한지 먼저 판단할 것
4. 기존 URL, 상태값, API 유틸 패턴을 유지할 것
5. 변경 범위를 최소화하면서 기능을 개선할 것

반드시 출력할 것:
- 현재 구조 분석 요약
- 어떤 기존 파일을 왜 수정하는지
- 필요한 신규 파일이 있다면 왜 필요한지
- 실제 코드 변경
- 마지막에 변경 파일 목록 요약
```

---

## 10. 가장 추천하는 전달 방식

다른 AI나 개발자에게 전달할 때는 아래 순서가 가장 좋다.

### 1단계
이 문서와 함께 아래 문서를 같이 넘긴다.

- `shortform-automation-plan.md`
- `db-schema-state-machine.md`
- `admin-console-ui-plan.md`
- `rest-api-spec.md`

### 2단계
먼저 `마스터 프롬프트`를 사용한다.

### 3단계
그 다음 목적에 따라 아래 중 하나를 추가로 사용한다.

- 기획 보강: `기존 시스템 기반 기획 보강 프롬프트`
- 프론트 확장: `기존 SPA 기반 프론트엔드 확장 프롬프트`
- 백엔드 확장: `기존 Express API 기반 백엔드 확장 프롬프트`
- AI 공급자 확장: `기존 AI 공급자 구조 확장 프롬프트`
- 태스크 분해: `기존 구조 기준 개발 태스크 분해 프롬프트`
- 바로 구현: `바로 구현을 맡길 때 쓰는 코딩 프롬프트`

---

## 11. 핵심 한 줄

앞으로 이 프로젝트 관련 프롬프트의 핵심 문장은 아래다.

`이 프로젝트는 이미 구현된 마케팅/콘텐츠 자동화 관리자 시스템이므로, 기존 구조를 분석하고 그 위에 숏폼 기능을 확장하라. 처음부터 새로 설계하거나 갈아엎지 말라.`
