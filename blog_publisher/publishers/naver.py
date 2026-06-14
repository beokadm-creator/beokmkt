"""
네이버 블로그 어댑터 — Node.js 워커(executors/naver-blog-worker)로 위임.

Python에서 Playwright를 직접 돌리지 않고 HTTP 사이드카에 요청한다.
워커가 미실행 중이면 RetryableError → 다음 발행 주기에 재시도.
"""
from __future__ import annotations

import json

import requests

import config
from publishers.base import FatalError, NeedsHumanError, RetryableError


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

        from tools.category_map import naver_theme

        payload = {
            "post_id": post.get("id"),          # 멱등성: 워커가 중복 발행 방지
            "title": post["title"],
            "content_html": content_html,
            "tags": tags,
            # 네이버 고정 주제(검색 분류 신호) — 브랜드 키 기준
            "topic_theme": naver_theme(post.get("category", "")),
            "canonical_url": post.get("canonical_url", ""),
            "link": post.get("canonical_url", ""),
        }

        try:
            resp = requests.post(
                f"{worker_url}/publish-naver",
                json=payload,
                timeout=config.EXTERNAL_PUBLISH_TIMEOUT_SEC,
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
            return {
                "url": data.get("url") or "",
                "title": data.get("title") or post["title"],
                "rewritten": bool(data.get("rewritten")),
            }
        code = data.get("code", "")
        msg = data.get("error", f"HTTP {resp.status_code}")
        if code == "LOGIN_REQUIRED":
            raise FatalError(
                f"네이버 세션 만료. executors/naver-blog-worker 에서 "
                f"npm run login 으로 재로그인 후 워커를 재시작하세요."
            )
        if code in {
            "PASTE_STRUCTURE_LOST",
            "PASTE_CONTENT_INCOMPLETE",
            "PASTE_IMAGE_LOST",
            "PASTE_TABLE_MARKDOWN_LEAK",
            "NAVER_RICH_CONTENT_UNSUPPORTED",
            "NAVER_PUBLIC_QUALITY_FAILED",
            "PUBLISH_URL_NOT_FOUND",
            "NAVER_PUBLIC_CHECK_FAILED",
        }:
            raise NeedsHumanError(
                f"네이버 자동 발행 중단[{code}]: {msg}. "
                "같은 원고를 재시도하면 중복 발행 또는 구조가 깨진 글이 나갈 수 있어 수동 확인으로 격리합니다."
            )
        raise RetryableError(f"네이버 발행 실패[{code}]: {msg}")
