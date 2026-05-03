# Open Claw Endpoint Map

This document is the endpoint map for an external agent such as `open claw`.

It focuses on:

- Which base URLs to call
- Which endpoints matter for the AI shorts pipeline
- What minimum payloads are required
- How to recover failed and dead-lettered jobs
- Which executor endpoints exist behind the main API

## Base URLs

Local development defaults:

- API server: `http://localhost:8787`
- API health: `GET http://localhost:8787/api/health`
- Local render executor example: `http://localhost:8788`
- Local render executor health example: `GET http://localhost:8788/health`
- Web render executor example: `http://localhost:8791`
- Web render executor health example: `GET http://localhost:8791/health`

Production / Firebase Functions should expose the same `/api/ai/*` path shapes.

Important notes:

- The API server default comes from `process.env.PORT` or falls back to `8787`.
- The render executor URL is not fixed in source. The API reads it from `RENDER_EXECUTOR_URL` unless a per-request webhook override is supplied.
- The `8788` and `8791` executor URLs are reference defaults for local development, not guaranteed runtime bindings.

## Response Shapes

Main API success shape:

```json
{
  "data": {},
  "meta": {}
}
```

Main API error shape:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "script_id is required",
    "details": {}
  }
}
```

Render executor success shape:

```json
{
  "status": "rendered",
  "external_job_id": "rnd_123",
  "qc_status": "passed",
  "output": {
    "asset_url": "https://cdn.example.com/video.mp4",
    "thumbnail_url": "https://cdn.example.com/video.jpg",
    "duration_sec": 30,
    "render_provider": "local-ffmpeg",
    "executed_at": "2026-05-03T12:00:00.000Z"
  }
}
```

Render executor failure shape:

```json
{
  "status": "failed",
  "error_code": "TEMPORARY",
  "error_message": "ffmpeg render failed",
  "next_retry_at": null
}
```

## Idempotency

Most mutating AI endpoints support the `Idempotency-Key` header.

Recommended rule for `open claw`:

- Always send `Idempotency-Key` on `POST /api/ai/*`
- Reuse the same key only when intentionally retrying the exact same operation
- Use a new key for a logically new attempt

Example:

```http
Idempotency-Key: open-claw-run-20260503-001
```

## Recommended Call Paths

Recommended shortest path:

1. `POST /api/ai/execute-pipeline`
2. If publish fails, inspect `execution`
3. If jobs fail later, use failed/dead-letter recovery endpoints

Recommended staged path:

1. `POST /api/ai/generate-ideas`
2. `POST /api/ai/generate-script`
3. `POST /api/ai/create-render-job`
4. `POST /api/ai/execute-render-job`
5. `POST /api/ai/create-publish-job`
6. `POST /api/ai/execute-publish-job`

## Core AI Pipeline Endpoints

### 1) Generate ideas

- Method: `POST`
- Path: `/api/ai/generate-ideas`
- Purpose: create short-form content ideas from one eligible source item
- Minimum body:

```json
{
  "source_item_id": "src_123"
}
```

- Useful options:
  - `count`
  - `target_duration_sec`
  - `platform_targets`
  - `auto_approve_lead`
  - `ai_provider`
  - `ai_api_key`
  - `ai_model`

- Returns:
  - `idea_ids`
  - `lead_idea_id`

### 2) Generate script

- Method: `POST`
- Path: `/api/ai/generate-script`
- Purpose: create a script from one approved short idea
- Minimum body:

```json
{
  "short_idea_id": "idea_123"
}
```

- Useful options:
  - `duration_sec`
  - `approve_idea`
  - `auto_approve`
  - `script_text`
  - `subtitle_text`
  - `caption_text`
  - `hashtags`

- Returns:
  - `script_id`
  - resulting script `status`

### 3) Create render job

- Method: `POST`
- Path: `/api/ai/create-render-job`
- Purpose: create a queued render job from an approved script
- Minimum body:

```json
{
  "script_id": "script_123"
}
```

- Useful options:
  - `approve_script`
  - `auto_approve`
  - `template_id`
  - `render_profile`

- Returns:
  - `render_job_id`
  - `qc_status`

### 4) Execute render job

- Method: `POST`
- Path: `/api/ai/execute-render-job`
- Purpose: call the configured render executor and update render job state
- Minimum body:

```json
{
  "render_job_id": "render_123"
}
```

- Useful options passed through to executor:
  - `render_webhook_url`
  - `render_webhook_token`
  - `render_webhook_headers`
  - `options`

- Typical render `options`:

```json
{
  "options": {
    "tts_text": "short voiceover text",
    "background_image_url": "https://example.com/bg.jpg",
    "duration_sec": 30,
    "web_generator": {
      "provider": "my-web-tool",
      "prompt": "Create a cinematic 9:16 short",
      "negative_prompt": "blurry, distorted text",
      "aspect_ratio": "9:16",
      "style_preset": "cinematic",
      "login_hint": "workspace-a"
    }
  }
}
```

- Returns:
  - render execution result
  - final job `status`
  - executor trace may be stored in job execution metadata

### 5) Create publish job

- Method: `POST`
- Path: `/api/ai/create-publish-job`
- Purpose: create a publish job from a render job and platform account
- Minimum body:

```json
{
  "render_job_id": "render_123",
  "platform_account_id": "acct_123"
}
```

- Useful options:
  - `platform`
  - `approve_render`
  - `auto_approve`
  - `title`
  - `description`
  - `hashtags`
  - `visibility`

- Returns:
  - `publish_job_id`
  - publish job `status`

### 6) Execute publish job

- Method: `POST`
- Path: `/api/ai/execute-publish-job`
- Purpose: publish a rendered asset through the configured publish executor
- Minimum body:

```json
{
  "publish_job_id": "publish_123"
}
```

- Useful options:
  - `publish_webhook_url`
  - `publish_webhook_token`
  - `publish_webhook_headers`
  - `execute_render_first`

- Returns:
  - publish execution result
  - final `status`
  - possible `platform_media_id` or `permalink`

### 7) Run pipeline without execution

- Method: `POST`
- Path: `/api/ai/run-pipeline`
- Purpose: generate ideas, script, render job, publish job in one request
- Minimum body:

```json
{
  "source_item_id": "src_123",
  "platform_account_id": "acct_123"
}
```

- Important:
  - creates jobs
  - does not perform the final publish execution step

- Useful options:
  - `idea_count`
  - `duration_sec`
  - `platform`
  - `auto_approve_render`
  - `auto_approve_publish`
  - `publish_title`
  - `publish_description`
  - `hashtags`
  - `visibility`

### 8) Execute full pipeline

- Method: `POST`
- Path: `/api/ai/execute-pipeline`
- Purpose: create the full pipeline and immediately execute publish flow
- Minimum body:

```json
{
  "source_item_id": "src_123",
  "platform_account_id": "acct_123"
}
```

- This is the best endpoint for `open claw` when it wants one-shot automation.
- Returns:
  - `idea_ids`
  - `lead_idea_id`
  - `script_id`
  - `render_job_id`
  - `publish_job_id`
  - `statuses`
  - `execution`

## Failure Management Endpoints

### Failed jobs list

- Method: `GET`
- Path: `/api/ai/failed-jobs`
- Query:
  - `job_type=all|render|publish`
  - `limit`
  - `only_due=true|false`
  - `provider`
  - `platform`

- Use this to find retryable failures that are not dead-lettered.

### Dead-letter jobs list

- Method: `GET`
- Path: `/api/ai/dead-letter-jobs`
- Query:
  - `job_type=all|render|publish`
  - `limit`
  - `provider`
  - `platform`

- Use this to find permanently blocked jobs.

### Retry failed jobs

- Method: `POST`
- Path: `/api/ai/retry-failed-jobs`
- Body example:

```json
{
  "job_type": "all",
  "limit": 10,
  "only_due": true
}
```

- Optional nested overrides:
  - `render`
  - `publish`

### Restore dead-letter jobs

- Method: `POST`
- Path: `/api/ai/restore-dead-letter-jobs`
- Body example:

```json
{
  "job_type": "all",
  "limit": 10,
  "job_ids": ["render_123", "publish_123"]
}
```

- Restores dead-letter state but does not execute immediately.

### Restore and retry dead-letter jobs

- Method: `POST`
- Path: `/api/ai/restore-and-retry-dead-letter-jobs`
- Body example:

```json
{
  "job_type": "all",
  "limit": 10,
  "job_ids": ["render_123", "publish_123"]
}
```

- Best recovery endpoint when the agent wants restore plus immediate execution.

### Run retry sweep

- Method: `POST`
- Path: `/api/ai/run-retry-sweep`
- Body example:

```json
{
  "job_type": "all",
  "limit": 20,
  "only_due": true
}
```

- Use this as an operator endpoint to process due retries in batch.

## Platform Account Endpoints

### Set platform account status

- Method: `POST`
- Path: `/api/ai/platform-accounts/:id/set-status`
- Purpose: reconnect or disconnect a platform account so AI can recover publish failures
- Body example:

```json
{
  "status": "connected",
  "access_token_expires_at": "2026-05-10T00:00:00.000Z"
}
```

- Valid `status` values:
  - `connected`
  - `disconnected`

### Run platform account sweep

- Method: `POST`
- Path: `/api/ai/run-platform-account-sweep`
- Body example:

```json
{
  "limit": 50,
  "warning_window_minutes": 60
}
```

- Purpose:
  - detect expired accounts
  - detect soon-to-expire accounts
  - auto-mark expired accounts as `disconnected`

### Ops metrics

- Method: `GET`
- Path: `/api/ai/ops-metrics`
- Query:
  - `limit`
  - `warning_window_minutes`

- Purpose:
  - summarize render job status distribution
  - summarize publish job status distribution
  - summarize error code distribution
  - summarize dead-letter counts
  - summarize platform account expiry risk

## Supporting Read Endpoints

These are useful when `open claw` wants to inspect created entities after a pipeline step.

- `GET /api/short-ideas`
- `GET /api/short-ideas/:id`
- `GET /api/scripts`
- `GET /api/scripts/:id`
- `GET /api/render-jobs`
- `GET /api/render-jobs/:id`
- `GET /api/publish-jobs`
- `GET /api/publish-jobs/:id`
- `GET /api/platform-accounts`
- `GET /api/audit-logs`

## Executor Map

The main API does not render directly. It calls an external render executor through webhook configuration.

### Local render executor

- Base URL source: `RENDER_EXECUTOR_URL`
- Example base URL: `http://localhost:8788`
- Health: `GET /health`
- Render: `POST /`
- Purpose:
  - TTS
  - subtitles
  - optional background image
  - FFmpeg output

### Web render executor

- Base URL source: environment-specific deployment
- Example base URL: `http://localhost:8791`
- Health: `GET /health`
- Render: `POST /`
- Purpose:
  - front door for future browser automation renderers
  - fallback to local render executor if upstream web generation fails

### Render executor request contract

Main fields sent from API to executor:

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

Executor must return a non-empty `output.asset_url` when successful.

## Recommended Agent Behaviors

For `open claw`, the safest operational pattern is:

1. Check `GET /api/health`
2. Check executor health if rendering is involved
3. Prefer `POST /api/ai/execute-pipeline` for one-shot execution
4. If the result includes a failed execution, inspect related job IDs
5. Query `GET /api/ai/failed-jobs`
6. Use `POST /api/ai/run-retry-sweep` for normal retry handling
7. Use `POST /api/ai/restore-and-retry-dead-letter-jobs` for dead-letter recovery
8. If publish failures mention platform connectivity, call `POST /api/ai/platform-accounts/:id/set-status`
9. Use `GET /api/ai/ops-metrics` before and after recovery actions

## Minimal One-Shot Example

```bash
curl -X POST http://localhost:3001/api/ai/execute-pipeline \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: open-claw-execute-pipeline-001' \
  --data '{
    "source_item_id": "src_123",
    "platform_account_id": "acct_123",
    "idea_count": 3,
    "duration_sec": 30,
    "platform": "youtube",
    "visibility": "private"
  }'
```

## Minimal Recovery Example

```bash
curl -X POST http://localhost:3001/api/ai/restore-and-retry-dead-letter-jobs \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: open-claw-restore-dead-letter-001' \
  --data '{
    "job_type": "all",
    "limit": 10
  }'
```
