# beokmkt AI Pipeline

AI-first short-form operations console and API.

## Core AI Endpoints

- `POST /api/ai/generate-ideas`
- `POST /api/ai/generate-script`
- `POST /api/ai/create-render-job`
- `POST /api/ai/create-publish-job`
- `POST /api/ai/run-pipeline`
- `POST /api/ai/execute-render-job`
- `POST /api/ai/execute-publish-job`
- `POST /api/ai/execute-pipeline`
- `GET /api/ai/failed-jobs`
- `GET /api/ai/dead-letter-jobs`
- `POST /api/ai/retry-failed-jobs`
- `POST /api/ai/restore-dead-letter-jobs`
- `POST /api/ai/restore-and-retry-dead-letter-jobs`
- `POST /api/ai/run-retry-sweep`
- `POST /api/ai/platform-accounts/:id/set-status`
- `POST /api/ai/run-platform-account-sweep`
- `GET /api/ai/ops-metrics`

## AI Model Configuration

Request body can override:

```json
{
  "ai_provider": "openai",
  "ai_api_key": "sk-...",
  "ai_model": "gpt-4o-mini"
}
```

Environment fallback:

```env
AI_PROVIDER=""
AI_API_KEY=""
AI_MODEL=""
```

## External Executor Webhooks

Render executor request settings:

```env
RENDER_EXECUTOR_URL=""
RENDER_EXECUTOR_TOKEN=""
RENDER_EXECUTOR_HEADERS_JSON="{}"
```

Optional web-render adapter settings:

```env
WEB_RENDER_EXECUTOR_PORT="8791"
WEB_RENDER_UPSTREAM_URL=""
WEB_RENDER_UPSTREAM_TOKEN=""
WEB_RENDER_PROVIDER="web-automation"
WEB_RENDER_FALLBACK_URL="http://localhost:8788/"
WEB_RENDER_FALLBACK_TOKEN=""
WEB_RENDER_ALLOW_FALLBACK="true"
WEB_RENDER_TIMEOUT_MS="120000"
```

Publish executor request settings:

```env
PUBLISH_EXECUTOR_URL=""
PUBLISH_EXECUTOR_TOKEN=""
PUBLISH_EXECUTOR_HEADERS_JSON="{}"
```

Google OAuth settings for YouTube:

```env
APP_BASE_URL="http://localhost:8787"
SPA_BASE_URL="http://localhost:5173"
GOOGLE_CLIENT_ID=""
GOOGLE_CLIENT_SECRET=""
GOOGLE_REDIRECT_URI=""
GOOGLE_OAUTH_DEFAULT_RETURN_TO="http://localhost:5173/settings/platform-accounts"
```

## Local Render Executor (TTS + Captions)

This repo includes a local render executor that can synthesize a simple short video using:

- TTS (macOS `say` when available)
- SRT subtitles burned into the video
- Optional background image (`options.background_image_url`)

Run:

```bash
npm run dev:render-executor
```

Then set:

```env
RENDER_EXECUTOR_URL="http://localhost:8788/"
```

Expected render webhook response always returns `output.asset_url`.

## Web Render Executor (Browser Automation Adapter)

This repo now also includes a `web-render-executor` that keeps the same render webhook contract but is designed for web-only generation tools.

It does not hardcode a specific website yet. Instead, it works as a stable adapter layer for:

- A future browser automation worker or hosted web generator (`WEB_RENDER_UPSTREAM_URL`)
- Standardized web-specific failure codes such as `AUTH_ERROR`, `UI_CHANGED`, `DOWNLOAD_FAILED`, `TIMEOUT`
- Automatic fallback to the local FFmpeg renderer when the web path fails

Run:

```bash
npm run dev:web-render-executor
```

Recommended local setup:

```env
WEB_RENDER_UPSTREAM_URL=""
WEB_RENDER_FALLBACK_URL="http://localhost:8788/"
RENDER_EXECUTOR_URL="http://localhost:8791/"
```

With that setup:

- `beokmkt` calls the web executor first
- The web executor tries the upstream browser/web generation path
- If the upstream path is not configured or returns a retryable failure, it can fall back to the existing local render executor

Per-request web generation options can be passed inside `options.web_generator`, for example:

```json
{
  "options": {
    "web_generator": {
      "provider": "my-web-tool",
      "prompt": "Create a cinematic 9:16 short about startup growth",
      "negative_prompt": "blurry, distorted text",
      "aspect_ratio": "9:16",
      "style_preset": "cinematic",
      "login_hint": "workspace-a"
    }
  }
}
```

The current goal is to keep `beokmkt` stable while allowing a future dedicated browser automation worker to be attached behind the same `output.asset_url` contract.

Per-request override keys:

- `render_webhook_url`
- `render_webhook_token`
- `render_webhook_headers`
- `publish_webhook_url`
- `publish_webhook_token`
- `publish_webhook_headers`

## Platform Accounts

`platform_accounts` should maintain token state such as `access_token_expires_at`.

For Google OAuth YouTube accounts:

- `access_token` and `refresh_token` are stored on the server
- `GET /api/auth/google` returns a Google OAuth redirect URL
- `GET /api/auth/google/callback` exchanges the code and stores channel-linked tokens
- `POST /api/auth/google/refresh/:account_id` refreshes a YouTube account token
- `POST /api/platform-accounts/:id/disconnect` clears stored tokens and disconnects the account
- publish execution refreshes tokens automatically before YouTube upload when needed

Expired accounts with a refresh token are treated as refreshable, not immediately disconnected.

AI can update account connectivity state:

```http
POST /api/ai/platform-accounts/:id/set-status
```

AI can also scan for expired or soon-to-expire accounts:

```http
POST /api/ai/run-platform-account-sweep
```

### Local OAuth Flow

1. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`
2. In Google Cloud Console, configure redirect URI:

```text
http://localhost:8787/api/auth/google/callback
```

3. Start API and SPA:

```bash
npm run dev:api
npm run dev:spa
```

4. Open the SPA platform account settings page and click `YouTube 연동`
5. After Google consent, the API stores tokens in `platform_accounts`
6. Publish jobs for connected YouTube accounts upload through the YouTube Data API when no publish webhook override is supplied

## Blog Posts

The console now includes a blog workspace at:

- `/blog-posts`
- `/blog-posts/:id`

Authenticated API endpoints:

- `GET /api/blog-posts`
- `GET /api/blog-posts/:id`
- `POST /api/blog-posts`
- `PATCH /api/blog-posts/:id`
- `DELETE /api/blog-posts/:id`
- `POST /api/blog-posts/:id/publish`
- `POST /api/blog-posts/:id/generate-content`

Query filters for `GET /api/blog-posts`:

- `limit`
- `offset`
- `q`
- `status`
- `category`

Create payload supports both manual and AI-assisted drafts:

```json
{
  "title": "2026 마케팅 자동화 전략",
  "content": "",
  "status": "draft",
  "category": "marketing",
  "tags": ["automation", "seo"],
  "ai_generate": true,
  "topic": "마케팅 자동화",
  "tone": "professional",
  "keywords": ["마케팅 자동화", "콘텐츠 운영"],
  "source_text": "참고 자료 본문",
  "target_length": "medium"
}
```

Notes:

- If `content` is empty and `ai_generate !== false`, the server attempts AI generation.
- Publish requires non-empty `content`.
- Delete is soft-delete based and marks the post as `archived`.
- The SPA detail page supports HTML editing, preview, AI generation, publish, and delete actions.

## Render Executor Contract

Request payload shape:

```json
{
  "kind": "render",
  "render_job_id": "render_123",
  "script_id": "script_123",
  "short_idea_id": "idea_123",
  "render_profile": "shorts_1080x1920",
  "script": {
    "script_text": "...",
    "subtitle_text": "...",
    "duration_sec": 30
  },
  "options": {}
}
```

Success response example:

```json
{
  "status": "rendered",
  "external_job_id": "rnd_123",
  "qc_status": "passed",
  "output": {
    "asset_url": "https://cdn.example.com/video.mp4",
    "thumbnail_url": "https://cdn.example.com/video.jpg",
    "duration_sec": 30,
    "render_provider": "runway",
    "executed_at": "2026-05-03T12:00:00.000Z"
  }
}
```

Failure response example:

```json
{
  "status": "failed",
  "error_code": "RENDER_TIMEOUT",
  "error_message": "render worker timeout",
  "next_retry_at": "2026-05-03T12:10:00.000Z"
}
```

Validation rules:

- If `status` is not `failed`, the response must include `output.asset_url` (or top-level `asset_url`).
- If required fields are missing, the job fails with `INVALID_PAYLOAD` and follows the normal retry/dead-letter policy.

## Publish Executor Contract

Request payload shape:

```json
{
  "kind": "publish",
  "publish_job_id": "publish_123",
  "platform": "youtube",
  "publish_job": {},
  "render_job": {},
  "account": {},
  "options": {}
}
```

Success response example:

```json
{
  "status": "published",
  "external_job_id": "pub_123",
  "result": {
    "platform_media_id": "yt_abc",
    "permalink": "https://youtube.com/shorts/yt_abc",
    "uploaded_at": "2026-05-03T12:05:00.000Z",
    "publish_provider": "youtube-direct",
    "render_asset_url": "https://cdn.example.com/video.mp4"
  }
}
```

Failure response example:

```json
{
  "status": "failed",
  "error_code": "RATE_LIMIT",
  "error_message": "quota exceeded",
  "next_retry_at": "2026-05-03T12:15:00.000Z"
}
```

Validation rules:

- If `status` is not `failed`, the response must include at least one of: `result.platform_media_id` or `result.permalink`.
- If required fields are missing, the job fails with `INVALID_PAYLOAD` and follows the normal retry/dead-letter policy.

## Execution Traces

Jobs store minimal executor traces in `execution.traces` (bounded list) to support debugging without storing full payloads.

Trace fields include: `at`, `kind`, `adapter`, `duration_ms`, `http_status`, `status`, `error_code`, `error_message`, `external_job_id`.

## Ops Metrics

Use `GET /api/ai/ops-metrics` to get compact operational counts for render jobs, publish jobs, dead-letter jobs, and platform account expiry risk.

Useful query params:

- `limit`
- `warning_window_minutes`

## Retry APIs

Get failed jobs:

```http
GET /api/ai/failed-jobs?job_type=all&only_due=true&limit=20
```

`failed-jobs` excludes dead-lettered jobs so the retry loop only sees active retry candidates.

Retry failed jobs:

```json
{
  "job_type": "all",
  "only_due": true,
  "limit": 10
}
```

Run a single automated retry sweep (same selection rules as the scheduler) via `POST /api/ai/run-retry-sweep`:

```json
{
  "job_type": "all",
  "only_due": true,
  "limit": 20
}
```

Run a platform account expiry sweep:

```json
{
  "limit": 50,
  "warning_window_minutes": 60
}
```

Available retry filters:

- `job_type`: `all` | `render` | `publish`
- `provider`
- `platform`
- `only_due`
- `limit`

Get dead-letter jobs:

```http
GET /api/ai/dead-letter-jobs?job_type=all&limit=20
```

Restore dead-letter jobs back into the retry queue:

```json
{
  "job_type": "all",
  "limit": 10,
  "next_retry_at": "2026-05-03T13:00:00.000Z",
  "reset_attempts": false
}
```

Restore filters:

- `job_type`: `all` | `render` | `publish`
- `job_ids`
- `provider`
- `platform`
- `limit`
- `next_retry_at`
- `max_attempts`
- `reset_attempts`

Restore and execute dead-letter jobs immediately:

```json
{
  "job_type": "all",
  "limit": 5,
  "reset_attempts": true
}
```

Executor error handling notes:

- External `error_code` values are normalized into internal retry classes before backoff is computed.
- Recommended stable codes: `RATE_LIMIT`, `AUTH_ERROR`, `INVALID_PAYLOAD`, `NETWORK_ERROR`, `RENDER_TIMEOUT`, `UNSUPPORTED_PLATFORM`, `PLATFORM_ACCOUNT_NOT_CONNECTED`, `NOT_FOUND`, `TEMPORARY`.
- Unknown executor codes fall back to `TEMPORARY`.
