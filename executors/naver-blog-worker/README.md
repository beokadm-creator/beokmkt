# Blog Publisher Worker (네이버 + 티스토리)

네이버 블로그와 티스토리에 발행하는 HTTP 워커. 메인 서버와 **같은 맥**에서 실행합니다.

## 흐름

```
SPA (localhost:5173) 에서 글 작성 → "네이버 발행" 클릭
    ↓ POST http://localhost:8788/publish-naver
이 워커 (localhost:8788)
    ↓ Playwright/API로 발행
    ↓ POST http://localhost:8787/api/blog-posts/:id/external-publish-result
메인 서버에 결과 저장 → SPA 상태 갱신
```

## 지원 플랫폼

| 플랫폼 | 방식 | 인증 |
|---|---|---|
| **네이버 블로그** | Playwright | 세션 쿠키 (`npm run login`) |
| **티스토리** | 공식 OAuth 2.0 API | access_token (`npm run tistory-auth`) |

## 설치 (맥에서 한 번만)

```bash
cd executors/naver-blog-worker
npm install
npm run setup    # Playwright Chromium 설치
cp .env.example .env
```

## 최초 1회 인증

### 네이버

```bash
npm run login
```

브라우저 열림 → 직접 로그인 (2FA 포함) → 터미널에서 Enter → `.session/naver-session.json` 저장.

💡 **로그인 상태 유지** 체크박스 꼭 체크 (세션 수명 연장).

### 티스토리

1. https://www.tistory.com/guide/api/manage/register 에서 앱 등록
2. `.env`에 `TISTORY_CLIENT_ID`, `TISTORY_CLIENT_SECRET`, `TISTORY_BLOG_NAME` 입력
3. 실행:

```bash
npm run tistory-auth
```

## 실행

```bash
npm start
```

HTTP 서버가 `localhost:8788`에 열림. 메인 서버(`npm run dev:api`)와 SPA(`npm run dev:spa`)는 별도 터미널에서 이미 실행 중이어야 함.

## 한 번에 3개 띄우기 (메인 프로젝트 루트에서)

```bash
npm run dev:api &        # :8787
cd executors/naver-blog-worker && npm start &   # :8788
cd .. && npm run dev:spa   # :5173
```

또는 `concurrently` 등 사용.

## 엔드포인트

| Method | Path | 용도 |
|---|---|---|
| `POST` | `/publish-naver` | 네이버 1건 |
| `POST` | `/publish-tistory` | 티스토리 1건 |
| `POST` | `/publish` | 다중 (body: `platforms`) |
| `GET` | `/health` | 상태 확인 |

요청 body:

```json
{
  "post_id": "abc123",
  "title": "제목",
  "content_html": "<p>본문</p>",
  "tags": ["태그1", "태그2"]
}
```

## SPA 설정 (이미 되어있음)

`.env`:

```bash
VITE_BLOG_WORKER_URL="http://localhost:8788"
```

## 세션 유지

발행시마다 갱신된 쿠키 자동 저장. 유휴 기간 길면:

```bash
npm run keepalive
```

macOS launchd로 매일 새벽 자동 실행 권장 (예: `~/Library/LaunchAgents/com.beokmkt.blog-worker-keepalive.plist`).

## 세션 만료시

`LOGIN_REQUIRED` 또는 `TISTORY_NOT_AUTHED` 에러시:

```bash
npm run login          # 네이버
npm run tistory-auth   # 티스토리
```
