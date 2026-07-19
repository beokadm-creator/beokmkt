"""
검색 공급자 인터페이스 (기획 05 §4.1).

엔진은 특정 검색 API에 묶이지 않는다. SearchProvider만 구현하면
Tavily/SerpAPI/Bing/Google CSE 등 무엇으로든 교체할 수 있다.

기본 제공:
- TavilyProvider: 검색+본문추출을 한 번에 주는 API라 가장 손이 적게 든다(키 필요).
- NullProvider: 키 미설정 시 명확한 에러로 안내(조용한 실패 방지).

도메인 신뢰도 필터는 collect 단계에서 적용한다(여기는 순수 검색).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol, runtime_checkable

import config


@dataclass(frozen=True)
class SearchResult:
    title: str
    url: str
    snippet: str
    content: str = ""   # 공급자가 본문까지 주면 채움(없으면 fetch로 보완)


@runtime_checkable
class SearchProvider(Protocol):
    def search(self, query: str, k: int = 10) -> list[SearchResult]: ...
    def fetch(self, url: str) -> str: ...


class NullProvider:
    """검색 공급자 미설정 시. 빈 결과를 반환해 파이프라인이 계속 돌도록 한다."""

    def search(self, query: str, k: int = 10) -> list[SearchResult]:
        return []

    def fetch(self, url: str) -> str:
        return ""


class TavilyProvider:
    """Tavily Search API 구현. 검색 결과에 본문(content)을 함께 받아 fetch 부담을 줄인다."""

    def __init__(self, api_key: str):
        if not api_key:
            raise RuntimeError("TAVILY_API_KEY 필요")
        self.api_key = api_key

    def search(self, query: str, k: int = 10) -> list[SearchResult]:
        import requests

        resp = requests.post(
            "https://api.tavily.com/search",
            json={
                "api_key": self.api_key,
                "query": query,
                "max_results": k,
                "include_raw_content": True,
                "search_depth": "advanced",
            },
            timeout=30,
        )
        resp.raise_for_status()
        out = []
        for r in resp.json().get("results", []):
            out.append(SearchResult(
                title=r.get("title", ""),
                url=r.get("url", ""),
                snippet=r.get("content", "")[:500],
                content=(r.get("raw_content") or r.get("content") or ""),
            ))
        return out

    def fetch(self, url: str) -> str:
        # Tavily는 검색 시 본문을 함께 주므로 보통 불필요. 폴백으로 단순 fetch.
        import requests

        try:
            r = requests.get(url, timeout=20, headers={"User-Agent": "Mozilla/5.0"})
            return r.text if r.status_code == 200 else ""
        except requests.RequestException:
            return ""


class NaverSearchProvider:
    """
    네이버 검색 API(웹문서/블로그) 구현. 기획 07.
    - SERP 분석: 상위 글 제목/요약.
    - 사실 수집(2026-07-19 보강): 종전에는 blog.json 스니펫만 반환하고
      fetch()가 항상 빈 문자열이라, collect의 MIN_SOURCE_TEXT_LEN(300자)
      필터에서 결과가 전부 탈락해 "키를 넣어도 근거가 안 모이는" 상태였다.
      이제 webkr(웹문서) 결과를 우선 섞고, 네이버 블로그(iframe) 외 URL은
      research.extract의 본문 추출로 fetch를 지원해 실제 근거 출처로 쓴다.
    """

    BLOG_URL = "https://openapi.naver.com/v1/search/blog.json"
    WEB_URL = "https://openapi.naver.com/v1/search/webkr.json"

    def __init__(self, client_id: str, client_secret: str):
        if not client_id or not client_secret:
            raise RuntimeError("NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 필요")
        self.headers = {
            "X-Naver-Client-Id": client_id,
            "X-Naver-Client-Secret": client_secret,
        }

    @staticmethod
    def _strip(text: str) -> str:
        # 네이버 응답은 <b> 태그 등이 섞여 있다.
        import re

        return re.sub(r"<[^>]+>", "", text or "").replace("&quot;", '"').strip()

    def _search_one(self, api_url: str, query: str, k: int) -> list[SearchResult]:
        import requests

        out: list[SearchResult] = []
        resp = requests.get(
            api_url,
            headers=self.headers,
            params={"query": query, "display": min(k, 100), "sort": "sim"},
            timeout=20,
        )
        resp.raise_for_status()
        for item in resp.json().get("items", []):
            out.append(SearchResult(
                title=self._strip(item.get("title", "")),
                url=item.get("link", ""),
                snippet=self._strip(item.get("description", "")),
                content=self._strip(item.get("description", "")),
            ))
        return out

    def search(self, query: str, k: int = 10) -> list[SearchResult]:
        # 웹문서(webkr) 우선 — 본문 fetch가 가능한 일반 사이트가 많아 근거로
        # 실제 채택될 확률이 높다. 부족분은 블로그 검색으로 채운다.
        out: list[SearchResult] = []
        seen: set[str] = set()
        for api_url in (self.WEB_URL, self.BLOG_URL):
            if len(out) >= k:
                break
            try:
                results = self._search_one(api_url, query, k)
            except Exception:  # noqa: BLE001 — 한 API 실패해도 다른 쪽은 시도
                continue
            for r in results:
                if not r.url or r.url in seen:
                    continue
                seen.add(r.url)
                out.append(r)
                if len(out) >= k:
                    break
        return out

    def fetch(self, url: str) -> str:
        # 네이버 블로그/포스트 본문은 iframe/JS라 정적 fetch 신뢰 불가 → 스니펫 의존.
        if "blog.naver.com" in url or "post.naver.com" in url or "cafe.naver.com" in url:
            return ""
        try:
            from research.extract import extract
            _, text = extract(url)
            return text
        except Exception:  # noqa: BLE001
            return ""


def get_provider(engine: str = "google") -> SearchProvider:
    """
    엔진별 공급자(기획 07). engine: 'naver' | 'google'.
    - naver  → 네이버 검색 API (SERP 분석용)
    - google → 일반 웹 검색(Tavily 우선, 없으면 네이버 검색 API로 폴백, 그마저 없으면 NullProvider)

    Tavily 없이도(2026-06-15 결정, planning/CHANGELOG.md) 최소한의 독립 출처를
    확보하기 위한 무료 폴백이다. 네이버 검색 API는 본문(fetch)이 아니라 스니펫
    수준이지만, beok/hong 자사 페이지 2개만 반복 재사용되던 상태(evidence
    monoculture, reports/content-quality-audit-20260705.md §2-증상5)보다는
    출처 다양성이 확실히 높다.
    """
    if engine == "naver":
        return NaverSearchProvider(config.NAVER_CLIENT_ID, config.NAVER_CLIENT_SECRET)

    name = (config.SEARCH_PROVIDER or "").lower()
    if name == "tavily":
        return TavilyProvider(config.TAVILY_API_KEY)
    if config.NAVER_CLIENT_ID and config.NAVER_CLIENT_SECRET:
        return NaverSearchProvider(config.NAVER_CLIENT_ID, config.NAVER_CLIENT_SECRET)
    # TODO: serpapi / bing / google_cse 분기 추가
    return NullProvider()
