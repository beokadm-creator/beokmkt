"""
네이버 블로그 어댑터 — Node.js 워커(executors/naver-blog-worker)로 위임.

Python에서 Playwright를 직접 돌리지 않고 HTTP 사이드카에 요청한다.
워커가 미실행 중이면 RetryableError → 다음 발행 주기에 재시도.
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


class NaverPublisher:
    name = "naver"

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
                f"{worker_url}/publish-naver",
                json=payload,
                timeout=300,
            )
        except requests.ConnectionError as e:
            raise RetryableError(
                f"네이버 워커 연결 실패(미실행?). "
                f"cd executors/naver-blog-worker && node index.mjs 로 워커를 먼저 시작하세요: {e}"
            ) from e
        except requests.RequestException as e:
            raise RetryableError(f"네이버 워커 요청 오류: {e}") from e

        data = resp.json()
        if resp.status_code == 200 and data.get("ok"):
            return data.get("url") or ""
        code = data.get("code", "")
        msg = data.get("error", f"HTTP {resp.status_code}")
        if code == "LOGIN_REQUIRED":
            raise FatalError(
                f"네이버 세션 만료. executors/naver-blog-worker 에서 "
                f"npm run login 으로 재로그인 후 워커를 재시작하세요."
            )
        raise RetryableError(f"네이버 발행 실패[{code}]: {msg}")
