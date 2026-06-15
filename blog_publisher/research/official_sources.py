"""
공식 사이트 기반 근거 수집.

Tavily 같은 비용형 검색 API 없이도 beoksolution.com / hongcomm.kr 공개 페이지를
근거팩의 1차 출처로 사용한다. 외부 검색은 선택 보조 수단이다.
"""
from __future__ import annotations

import re
from html import unescape
from urllib.parse import urlparse

import config
from research.collect import CollectedSource


def _strip_html(html: str) -> str:
    text = re.sub(r"<script[\s\S]*?</script>", " ", html, flags=re.I)
    text = re.sub(r"<style[\s\S]*?</style>", " ", text, flags=re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    text = unescape(text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def _title(html: str, url: str) -> str:
    match = re.search(r"<title[^>]*>([\s\S]*?)</title>", html, flags=re.I)
    if match:
        title = _strip_html(match.group(1))
        if title:
            return title
    host = urlparse(url).netloc.removeprefix("www.")
    return host or url


def collect_official_sources() -> list[CollectedSource]:
    import requests

    sources: list[CollectedSource] = []
    seen: set[str] = set()
    for url in config.OFFICIAL_SOURCE_URLS:
        if not url or url in seen:
            continue
        seen.add(url)
        try:
            resp = requests.get(
                url,
                timeout=20,
                headers={"User-Agent": "Mozilla/5.0 (compatible; BEOKBlogBot/1.0)"},
            )
            if resp.status_code != 200:
                continue
            text = _strip_html(resp.text)
            if len(text) < config.MIN_SOURCE_TEXT_LEN:
                continue
            sources.append(CollectedSource(
                title=_title(resp.text, url),
                url=resp.url or url,
                text=text[: config.MAX_SOURCE_TEXT_LEN],
                trust="high",
            ))
        except requests.RequestException as exc:
            print(f"[official_sources] 수집 실패(무시): {url} — {exc}", flush=True)
    return sources
