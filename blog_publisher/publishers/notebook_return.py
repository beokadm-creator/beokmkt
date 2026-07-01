"""
notebook-return(쿠팡 반품 노트북 마켓) 어댑터.

다른 채널과 달리 HTTP API/Playwright가 아니라 Firestore에 직접 글을 쓴다.
실제 사이트(Next.js, Mac 세션 소유)는 이 컬렉션을 읽기만 하므로, 여기서 쓴
published_url은 Mac 쪽이 해당 라우트를 배포하기 전까지는 실제로 열리지 않을 수
있다 — 이는 기록용이며 정상이다.
"""
from __future__ import annotations

import hashlib
import html
import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

import config
from publishers.base import FatalError, RetryableError

ROOT_DIR = Path(__file__).resolve().parents[2]
SCRIPT = Path(__file__).resolve().parents[1] / "tools" / "notebook_return" / "publish_article.mjs"


def _node_exe() -> str:
    return os.environ.get("NODE_EXE") or shutil.which("node") or str(ROOT_DIR / "bin" / "node.cmd")


def _slugify(text: str) -> str:
    s = re.sub(r"[^\w가-힣\s-]", "", text or "").strip().lower()
    s = re.sub(r"\s+", "-", s)[:60]
    digest = hashlib.md5((text or "").encode("utf-8")).hexdigest()[:8]
    return f"{s or 'guide'}-{digest}"


def _related_product_ids(post: dict) -> list[str]:
    raw = post.get("sources") or ""
    return list(dict.fromkeys(re.findall(r"/vp/products/(\d+)", str(raw))))[:6]


def _loads(val):
    if not val:
        return []
    try:
        return json.loads(val) if isinstance(val, str) else val
    except (ValueError, TypeError):
        return []


class NotebookReturnPublisher:
    name = "notebook_return"

    def publish(self, post) -> str:
        from render.renderer import render_body

        body = post.get("body", "")

        # Compute slug and public URL early (before rendering)
        slug = _slugify(post.get("title") or post.get("topic") or f"post-{post.get('id')}")
        public_url = f"{config.NOTEBOOK_RETURN_PUBLIC_URL}/guide/{slug}"

        # Render body with canonical_url for JSON-LD
        body_html = render_body({
            "title": post.get("title", ""),
            "body": body,
            "meta_desc": post.get("meta_desc", ""),
            "tags": _loads(post.get("tags")),
            "lang": post.get("locale", "ko"),
            "canonical_url": public_url,
        })

        # Append visible permalink footer to body_html
        footer_html = (
            f'<footer class="permalink">원문 주소: '
            f'<a href="{html.escape(public_url)}" rel="canonical noopener">'
            f'{html.escape(config.NOTEBOOK_RETURN_PUBLIC_URL)}/guide/{html.escape(slug)}</a></footer>'
        )
        body_html = f"{body_html}\n{footer_html}"

        payload = {
            "slug": slug,
            "title": post.get("title", ""),
            "metaDesc": post.get("meta_desc", ""),
            "bodyHtml": body_html,
            "body": body,
            "tags": _loads(post.get("tags")),
            "relatedProductIds": _related_product_ids(post),
            "contentType": post.get("content_type", "howto"),
            "permalink": public_url,
            "canonicalUrl": public_url,
        }

        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False, encoding="utf-8", dir=str(ROOT_DIR / "blog_publisher" / ".runtime")
        ) as fh:
            json.dump(payload, fh, ensure_ascii=False)
            tmp_path = fh.name

        try:
            result = subprocess.run(
                [_node_exe(), str(SCRIPT), tmp_path],
                cwd=ROOT_DIR,
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=30,
            )
        finally:
            try:
                os.remove(tmp_path)
            except OSError:
                pass

        stdout = (result.stdout or "").strip()
        try:
            data = json.loads(stdout) if stdout else {}
        except ValueError:
            data = {}

        if result.returncode == 0 and data.get("ok"):
            return f"{config.NOTEBOOK_RETURN_PUBLIC_URL}/guide/{data.get('slug') or slug}"

        reason = data.get("reason") or result.stderr or stdout or f"exit={result.returncode}"
        if result.returncode == 3 or data.get("skip"):
            raise RetryableError(f"Firestore 자격증명/일시 오류: {reason}")
        raise FatalError(f"notebook_return 발행 실패: {reason}")
