# 페이퍼클립 직원용 블로그 API 문서

이 문서는 페이퍼클립 직원이 운영 블로그 글을 등록, 수정, 발행할 때 사용하는 API 안내서입니다.

## 운영 주소

- 사이트: `https://beokmkt.web.app`
- API Base URL: `https://beokmkt.web.app/api`
- 공개 블로그 목록: `https://beokmkt.web.app/blog`
- 사이트맵: `https://beokmkt.web.app/sitemap.xml`

## 인증 방식

직원 업로드는 Firebase 로그인 대신 `X-API-Key` 헤더로 처리합니다.

필수 헤더:

```http
Content-Type: application/json
X-API-Key: YOUR_BLOG_API_KEY
```

주의:

- `BLOG_API_KEY`는 브라우저 공개 코드에 넣으면 안 됩니다.
- 사내 백엔드, 자동화 서버, 비공개 도구, Postman 환경변수 등 안전한 위치에만 보관하세요.
- 키가 없으면 공개 조회 API만 사용할 수 있고, 생성/수정/삭제/발행은 실패합니다.

## 응답 형식

성공:

```json
{
  "data": {},
  "meta": {}
}
```

실패:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "title is required",
    "details": {}
  }
}
```

## 기본 워크플로우

1. 글 초안을 생성합니다.
2. 필요하면 AI로 본문을 생성합니다.
3. 제목, 요약, slug, 대표이미지 등을 수정합니다.
4. 발행합니다.
5. 공개 블로그 URL에서 노출 여부를 확인합니다.

## 주요 엔드포인트

### 1) 글 생성

- `POST /api/blog-posts`

최소 요청 예시:

```bash
curl -X POST 'https://beokmkt.web.app/api/blog-posts' \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: YOUR_BLOG_API_KEY' \
  -d '{
    "title": "행사 운영 체크리스트",
    "content": "<p>본문 내용</p>",
    "status": "draft"
  }'
```

자주 쓰는 필드:

- `title`: 필수
- `content`: HTML 본문
- `excerpt`: 요약
- `category`: 예: `mice`
- `tags`: 문자열 배열
- `slug`: 선택 입력, 비우면 자동 생성
- `featured_image`: 대표 이미지 URL
- `status`: `draft` 또는 `published`
- `language`: 예: `ko`
- `tone`: 예: `professional`
- `seo_title`
- `seo_description`

참고:

- `content`를 비우고 `ai_generate`를 생략하면 서버가 AI 본문 생성을 시도할 수 있습니다.
- slug는 자동으로 고유화됩니다.

### 2) 글 수정

- `PATCH /api/blog-posts/{id}`

예시:

```bash
curl -X PATCH 'https://beokmkt.web.app/api/blog-posts/POST_ID' \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: YOUR_BLOG_API_KEY' \
  -d '{
    "title": "수정된 제목",
    "excerpt": "수정된 요약",
    "slug": "custom-event-guide",
    "featured_image": "https://example.com/image.jpg"
  }'
```

참고:

- `slug`를 보내면 중복 시 자동으로 `-2`, `-3` 등이 붙습니다.
- `slug`를 보내지 않으면 기존 slug를 유지합니다.

### 3) 글 발행

- `POST /api/blog-posts/{id}/publish`

예시:

```bash
curl -X POST 'https://beokmkt.web.app/api/blog-posts/POST_ID/publish' \
  -H 'X-API-Key: YOUR_BLOG_API_KEY'
```

참고:

- 본문이 비어 있으면 발행되지 않습니다.
- 발행 후 공개 블로그 및 slug URL에서 조회됩니다.

### 4) 글 삭제

- `DELETE /api/blog-posts/{id}`

예시:

```bash
curl -X DELETE 'https://beokmkt.web.app/api/blog-posts/POST_ID' \
  -H 'X-API-Key: YOUR_BLOG_API_KEY'
```

참고:

- 삭제는 soft delete 방식입니다.
- 삭제된 글은 공개 목록과 slug 조회에서 제외됩니다.

### 5) AI 본문 생성

- `POST /api/blog-posts/{id}/generate-content`

예시:

```bash
curl -X POST 'https://beokmkt.web.app/api/blog-posts/POST_ID/generate-content' \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: YOUR_BLOG_API_KEY' \
  -d '{
    "topic": "전시회 부스 운영 팁",
    "tone": "professional",
    "language": "ko",
    "target_length": "medium"
  }'
```

자주 쓰는 필드:

- `topic`
- `tone`
- `keywords`
- `source_text`
- `language`
- `target_length`

## 조회 엔드포인트

### 공개 글 목록

- `GET /api/blog-posts?status=published&limit=50`

예시:

```bash
curl 'https://beokmkt.web.app/api/blog-posts?status=published&limit=50'
```

### 공개 글 상세 by slug

- `GET /api/blog-posts/slug/{slug}`

예시:

```bash
curl 'https://beokmkt.web.app/api/blog-posts/slug/event-guide'
```

### 상세 by id

- `GET /api/blog-posts/{id}`

예시:

```bash
curl 'https://beokmkt.web.app/api/blog-posts/POST_ID'
```

## 공개 확인 URL

발행 후 직원이 최종 확인할 주소:

- 목록: `https://beokmkt.web.app/blog`
- 상세: `https://beokmkt.web.app/blog/{slug}`

예:

```text
https://beokmkt.web.app/blog/event-guide
```

## slug 규칙

- 제목 또는 입력값을 바탕으로 slug를 생성합니다.
- 영문 소문자, 숫자, 한글을 기준으로 정리됩니다.
- 공백과 특수문자는 `-`로 치환됩니다.
- 중복되면 `slug-2`, `slug-3`처럼 자동 조정됩니다.

예:

- `행사 운영 체크리스트` -> `행사-운영-체크리스트`
- 같은 제목이 하나 더 있으면 -> `행사-운영-체크리스트-2`

## 추천 운영 방식

- 직원은 먼저 `draft`로 저장합니다.
- 내부 검수 후 `publish` API를 호출합니다.
- 대표 이미지와 `seo_title`, `seo_description`을 함께 넣는 것을 권장합니다.
- 자동화 도구를 만들 경우 `Idempotency-Key` 헤더를 함께 쓰면 중복 생성 방지에 도움이 됩니다.

예:

```http
Idempotency-Key: paperclip-post-20260504-001
```

## 빠른 점검용 엔드포인트

- Health Check: `GET https://beokmkt.web.app/api/health`
- Sitemap: `GET https://beokmkt.web.app/sitemap.xml`

## 운영 메모

- API 원본 Functions URL도 존재하지만, 실사용은 Hosting 경유 주소를 기준으로 맞추는 것을 권장합니다.
- 권장 Base URL은 항상 `https://beokmkt.web.app/api` 입니다.
