"""
블로그 렌더러 (기획 09): post → 가독성+SEO HTML.

경량 마크다운 변환(H2/H3/문단/목록/링크/이미지/강조) + 자동 목차(TOC) +
JSON-LD(Article) + OG/Twitter 메타. 외부 의존 없이 동작.
markdown 패키지가 있으면 그걸 우선 사용한다.
"""
from __future__ import annotations

import html
import json
import re
from datetime import datetime, timezone
from pathlib import Path

_DIR = Path(__file__).parent
_TEMPLATE = (_DIR / "template.html").read_text(encoding="utf-8")
_CSS = (_DIR / "style.css").read_text(encoding="utf-8")


def _slug(text: str) -> str:
    s = re.sub(r"[^\w가-힣\s-]", "", text).strip().lower()
    return re.sub(r"\s+", "-", s)[:60] or "section"


def _inline(text: str) -> str:
    """인라인 마크다운: 링크/이미지/굵게/코드. 입력은 평문(이스케이프 후 패턴 복원)."""
    text = html.escape(text)
    text = re.sub(r"!\[([^\]]*)\]\(([^)]+)\)",
                  r'<img src="\2" alt="\1" loading="lazy">', text)
    text = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r'<a href="\2">\1</a>', text)
    text = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", text)
    text = re.sub(r"`([^`]+)`", r"<code>\1</code>", text)
    return text


def _markdown_to_html(md: str) -> tuple[str, list[tuple[str, str]]]:
    """경량 변환. (html, toc[(id,title)]) 반환. H2만 목차에 넣는다."""
    try:
        import markdown as _md  # 있으면 고품질 변환

        headings: list[tuple[str, str]] = []
        for m in re.finditer(r"^##\s+(.+)$", md, flags=re.MULTILINE):
            headings.append((_slug(m.group(1)), m.group(1).strip()))
        body = _md.markdown(md, extensions=["tables", "fenced_code"])
        # H2에 id 부여
        for hid, htext in headings:
            body = body.replace(f"<h2>{html.escape(htext)}</h2>",
                                f'<h2 id="{hid}">{html.escape(htext)}</h2>', 1)
            body = body.replace(f"<h2>{htext}</h2>", f'<h2 id="{hid}">{htext}</h2>', 1)
        return body, headings
    except ImportError:
        pass

    # 경량 폴백 변환
    lines = md.split("\n")
    out: list[str] = []
    toc: list[tuple[str, str]] = []
    para: list[str] = []
    in_list = False

    def flush_para():
        nonlocal para
        if para:
            out.append("<p>" + _inline(" ".join(para)) + "</p>")
            para = []

    def close_list():
        nonlocal in_list
        if in_list:
            out.append("</ul>")
            in_list = False

    for ln in lines:
        s = ln.rstrip()
        if not s.strip():
            flush_para(); close_list(); continue
        if s.startswith("## "):
            flush_para(); close_list()
            t = s[3:].strip(); hid = _slug(t); toc.append((hid, t))
            out.append(f'<h2 id="{hid}">{_inline(t)}</h2>')
        elif s.startswith("### "):
            flush_para(); close_list()
            out.append(f"<h3>{_inline(s[4:].strip())}</h3>")
        elif re.match(r"^[-*]\s+", s):
            flush_para()
            if not in_list:
                out.append("<ul>"); in_list = True
            out.append("<li>" + _inline(re.sub(r"^[-*]\s+", "", s)) + "</li>")
        else:
            close_list(); para.append(s.strip())
    flush_para(); close_list()
    return "\n".join(out), toc


def _toc_html(toc: list[tuple[str, str]]) -> str:
    if len(toc) < 2:
        return ""
    items = "".join(f'<li><a href="#{hid}">{html.escape(t)}</a></li>' for hid, t in toc)
    return f'<nav class="toc"><strong>목차</strong><ol>{items}</ol></nav>'


def _build_article_html(post: dict) -> tuple[str, str, str]:
    """(article_html, tags_html, json_ld_json) 반환."""
    title = post.get("title", "")
    content_html, toc = _markdown_to_html(post.get("body", ""))
    published = post.get("published_at") or datetime.now(timezone.utc)
    tags = post.get("tags", []) or []

    tags_html = "".join(
        f'<a href="/tag/{html.escape(t)}">#{html.escape(t)}</a>' for t in tags
    )
    source_footer = ""
    if post.get("source_url"):
        u = html.escape(post["source_url"])
        source_footer = (
            f'<footer class="src">참고 출처: '
            f'<a href="{u}" rel="nofollow noopener" target="_blank">{u}</a></footer>'
        )

    article_html = (
        f'<article>\n'
        f'  <header>\n'
        f'    <h1>{html.escape(title)}</h1>\n'
        f'    <div class="meta">\n'
        f'      <time datetime="{published.isoformat()}">{published.strftime("%Y-%m-%d")}</time>'
        f' · {html.escape(post.get("author", "BEOK"))}\n'
        f'    </div>\n'
        f'  </header>\n'
        f'  {_toc_html(toc)}\n'
        f'  <div class="content">\n{content_html}\n  </div>\n'
        f'  <div class="tags">{tags_html}</div>\n'
        f'  {source_footer}\n'
        f'</article>'
    )

    json_ld = json.dumps({
        "@context": "https://schema.org",
        "@type": "Article",
        "headline": title,
        "description": post.get("meta_desc", ""),
        "datePublished": published.isoformat(),
        "author": {"@type": "Person", "name": post.get("author", "BEOK")},
        "mainEntityOfPage": post.get("canonical_url", ""),
        "keywords": ", ".join(tags),
    }, ensure_ascii=False)

    return article_html, tags_html, json_ld


def render_body(post: dict) -> str:
    """Firebase처럼 content를 innerHTML로 주입하는 시스템용 — <article> HTML만 반환."""
    article_html, _, _ = _build_article_html(post)
    return article_html


def render(post: dict) -> str:
    """완전한 HTML 페이지 반환 (독립 배포용)."""
    article_html, _, json_ld = _build_article_html(post)
    t = html.escape(post.get("title", ""))
    desc = html.escape(post.get("meta_desc", ""))
    canonical = html.escape(post.get("canonical_url", ""))
    og_image = html.escape(post.get("og_image", ""))
    lang = post.get("lang", "ko")

    return (
        f'<!DOCTYPE html>\n<html lang="{lang}">\n<head>\n'
        f'<meta charset="utf-8">\n'
        f'<meta name="viewport" content="width=device-width, initial-scale=1">\n'
        f'<title>{t}</title>\n'
        f'<meta name="description" content="{desc}">\n'
        f'<link rel="canonical" href="{canonical}">\n'
        f'<meta name="robots" content="index,follow">\n'
        f'<meta property="og:type" content="article">\n'
        f'<meta property="og:title" content="{t}">\n'
        f'<meta property="og:description" content="{desc}">\n'
        f'<meta property="og:url" content="{canonical}">\n'
        f'<meta property="og:image" content="{og_image}">\n'
        f'<meta name="twitter:card" content="summary_large_image">\n'
        f'<meta name="twitter:title" content="{t}">\n'
        f'<meta name="twitter:description" content="{desc}">\n'
        f'<script type="application/ld+json">\n{json_ld}\n</script>\n'
        f'<style>\n{_CSS}\n</style>\n'
        f'</head>\n<body>\n<div class="wrap">\n'
        f'{article_html}\n'
        f'</div>\n</body>\n</html>'
    )
