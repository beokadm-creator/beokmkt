"""
티스토리 어댑터 — Node.js 워커(executors/naver-blog-worker)로 위임.

티스토리 세션 경로와 발행 로직 모두 워커에서 처리한다.
"""
from __future__ import annotations

import json

import requests

import config
from publishers.base import FatalError, RetryableError


def _loads(val):
    if not val:
        return []
    try:
        return json.loads(val) if isinstance(val, str) else val
    except (ValueError, TypeError):
        return []


class TistoryPublisher:
    name = "tistory"

    def publish(self, post) -> str:
        worker_url = config.NAVER_WORKER_URL.rstrip("/")
        content_html = post.get("body", "")
        tags = _loads(post.get("tags"))

        payload = {
            "post_id": post.get("id"),          # 멱등성: 워커가 중복 발행 방지
            "title": post["title"],
            "content_html": content_html,
            "tags": tags,
            "canonical_url": post.get("canonical_url", ""),
            "link": post.get("canonical_url", ""),
        }

        try:
            resp = requests.post(
                f"{worker_url}/publish-tistory",
                json=payload,
                timeout=120,
            )
        except requests.ConnectionError as e:
            raise RetryableError(
                f"티스토리 워커 연결 실패(미실행?). "
                f"cd executors/naver-blog-worker && node index.mjs 로 워커를 먼저 시작하세요: {e}"
            ) from e
        except requests.RequestException as e:
            raise RetryableError(f"티스토리 워커 요청 오류: {e}") from e

        data = resp.json()
        if resp.status_code == 200 and data.get("ok"):
            return data.get("url") or ""
        code = data.get("code", "")
        msg = data.get("error", f"HTTP {resp.status_code}")
        if code in ("LOGIN_REQUIRED", "AUTH_REQUIRED",
                    "TISTORY_LOGIN_REQUIRED", "TISTORY_NOT_AUTHED"):
            raise FatalError(
                f"티스토리 세션 만료. executors/naver-blog-worker 에서 "
                f"npm run tistory-auth 으로 재인증 후 워커를 재시작하세요."
            )
        raise RetryableError(f"티스토리 발행 실패[{code}]: {msg}")
