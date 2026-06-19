"""
자체 블로그 어댑터 — 가장 안정적인 채널.

API/DB로 직접 넣으므로 거의 깨지지 않는다. '신뢰 채널'로 취급한다.
Firebase 블로그 API 기준: POST {SELFHOST_API_URL}{SELFHOST_POST_PATH}
인증: X-API-Key 헤더.
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


class SelfHostedPublisher:
    name = "selfhosted"

    def publish(self, post) -> str:
        content = post["body"]
        if config.SELFHOST_RENDER_HTML:
            from render.renderer import render_body

            content = render_body({
                "title": post["title"],
                "body": post["body"],
                "meta_desc": post.get("meta_desc", ""),
                "tags": _loads(post.get("tags")),
                "canonical_url": post.get("canonical_url", ""),
                "lang": post.get("locale", "ko"),
                "source_url": post.get("source_url", ""),
                "category": post.get("category", ""),
                "topic": post.get("topic", ""),
                "blog_profile": post.get("blog_profile", ""),
            })

        tags = _loads(post.get("tags"))
        from tools.category_map import pick_category
        from tools.image_bank import featured_image, image_urls, recent_published_image_urls

        avoid_images = recent_published_image_urls(limit=18, exclude_id=post.get("id"))
        avoid_images.update(image_urls(content))
        image = featured_image(
            post.get("category", ""),
            f"{post.get('topic', '')} {post.get('title', '')}",
            avoid=avoid_images,
            salt=str(post.get("id") or post.get("topic") or post.get("title") or ""),
        )

        payload = {
            "title": post["title"],
            "content": content,
            "status": "published",
            "tags": tags,
            "featured_image": image.get("url") or None,
            # posts.category는 브랜드 키 → 검색용 세분 카테고리로 변환해 발행
            "category": pick_category(post.get("category", ""), post.get("topic", "")),
            "seo_title": post.get("seo_title") or post["title"],
            "seo_description": post.get("meta_desc", ""),
            "language": post.get("locale", "ko"),
            "ai_generate": False,
        }

        endpoint = f"{config.SELFHOST_API_URL}{config.SELFHOST_POST_PATH}"
        try:
            resp = requests.post(
                endpoint,
                headers={"X-API-Key": config.SELFHOST_API_KEY},
                json=payload,
                timeout=30,
            )
        except requests.RequestException as e:
            raise RetryableError(f"네트워크 오류: {e}") from e

        if resp.status_code in (200, 201):
            data = resp.json().get("data", {})
            slug = data.get("slug") or data.get("id", "")
            return f"{config.SELFHOST_API_URL}/blog/{slug}" if slug else ""
        if resp.status_code in (401, 403):
            raise FatalError(f"인증 실패: {resp.status_code}")
        if resp.status_code >= 500:
            raise RetryableError(f"서버 오류: {resp.status_code}")
        raise FatalError(f"발행 거부: {resp.status_code} {resp.text[:200]}")
