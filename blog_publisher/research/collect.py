"""
자료 수집 (기획 05 §4.2).

주 키워드 + 하위질문들로 검색하고, 신뢰 도메인 위주로 본문을 모은다.
과수집을 막기 위해 결과 수·본문 길이에 상한을 둔다.
"""
from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import urlparse

import config
from research.provider import SearchResult, get_provider


def analyze_serp(engine: str, keyword: str) -> list[dict]:
    """
    타깃 엔진(네이버/구글)의 상위 노출 제목·요약을 분석용으로 수집(기획 07 §3).
    노출 최적화의 입력이며, 사실 수집(collect)과는 분리한다.
    실패하면 빈 목록(생성은 계속).
    """
    try:
        provider = get_provider(engine)
        results = provider.search(keyword, k=config.SERP_ANALYZE_COUNT)
    except Exception as e:  # noqa: BLE001
        print(f"[serp] {engine} 분석 실패(무시): {e}")
        return []
    return [{"title": r.title, "snippet": r.snippet, "url": r.url} for r in results]


@dataclass
class CollectedSource:
    title: str
    url: str
    text: str
    trust: str   # high|med|low


def _domain(url: str) -> str:
    try:
        return urlparse(url).netloc.lower().removeprefix("www.")
    except Exception:  # noqa: BLE001
        return ""


def _trust_of(url: str) -> str | None:
    """allowlist/blocklist 기반 신뢰도. blocklist면 None(제외)."""
    d = _domain(url)
    if any(b in d for b in config.SOURCE_BLOCKLIST):
        return None
    if any(a in d for a in config.SOURCE_ALLOWLIST):
        return "high"
    return "med"


def collect(queries: list[str]) -> list[CollectedSource]:
    """여러 쿼리로 검색·수집해 중복 제거된 출처 목록을 반환."""
    from research.official_sources import collect_official_sources

    provider = get_provider()
    seen: set[str] = set()
    sources: list[CollectedSource] = []

    for source in collect_official_sources():
        if source.url in seen:
            continue
        seen.add(source.url)
        sources.append(source)
        if len(sources) >= config.MAX_SOURCES:
            return sources

    for q in queries:
        for r in provider.search(q, k=config.SEARCH_RESULTS_PER_QUERY):
            if not r.url or r.url in seen:
                continue
            trust = _trust_of(r.url)
            if trust is None:        # blocklist
                continue
            seen.add(r.url)

            text = r.content or provider.fetch(r.url)
            text = (text or "").strip()
            if len(text) < config.MIN_SOURCE_TEXT_LEN:
                continue
            sources.append(CollectedSource(
                title=r.title,
                url=r.url,
                text=text[: config.MAX_SOURCE_TEXT_LEN],
                trust=trust,
            ))
            if len(sources) >= config.MAX_SOURCES:
                return sources
    return sources
