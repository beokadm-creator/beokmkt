"""
트위터(X) 어댑터 — Node.js 워커(/publish-twitter)로 위임.

워커가 content_html을 요약해 트윗을 게시한다. 본문/요약 생성은 워커 책임.
감사 후속(MEDIUM): 워커는 twitter를 지원하지만 Python 라우팅이 없어 단절돼 있던 것을 연결.
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


class TwitterPublisher:
    name = "twitter"

    def publish(self, post) -> str:
        worker_url = config.NAVER_WORKER_URL.rstrip("/")
        payload = {
            "post_id": post.get("id"),          # 멱등성
            "title": post["title"],
            "content_html": post.get("body", ""),
            "tags": _loads(post.get("tags")),
            "link": post.get("canonical_url", ""),
        }
        try:
            resp = requests.post(f"{worker_url}/publish-twitter", json=payload, timeout=120)
        except requests.ConnectionError as e:
            raise RetryableError(f"트위터 워커 연결 실패(미실행?): {e}") from e
        except requests.RequestException as e:
            raise RetryableError(f"트위터 워커 요청 오류: {e}") from e

        data = resp.json()
        if resp.status_code == 200 and data.get("ok"):
            return data.get("url") or ""
        code = data.get("code", "")
        msg = data.get("error", f"HTTP {resp.status_code}")
        if code in ("TWITTER_LOGIN_REQUIRED",):
            raise FatalError(
                "트위터 세션 만료. executors/naver-blog-worker 에서 "
                "node twitter-auth.mjs 로 재로그인하세요."
            )
        raise RetryableError(f"트위터 발행 실패[{code}]: {msg}")
