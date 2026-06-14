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
    네이버 검색 API(블로그/웹) 구현. 기획 07.
    - 네이버 SERP 분석용: 상위 글 제목/요약을 준다(본문은 description 스니펫 수준).
    - 본문이 풍부하지 않으므로 '사실 수집'보다 'SERP/의도 분석'에 쓴다.
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

    def search(self, query: str, k: int = 10) -> list[SearchResult]:
        import requests

        out: list[SearchResult] = []
        resp = requests.get(
            self.BLOG_URL,
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

    def fetch(self, url: str) -> str:
        # 네이버 블로그 본문은 iframe/JS라 정적 fetch로는 신뢰 어려움. 스니펫에 의존.
        return ""


def get_provider(engine: str = "google") -> SearchProvider:
    """
    엔진별 공급자(기획 07). engine: 'naver' | 'google'.
    - naver  → 네이버 검색 API (SERP 분석용)
    - google → 일반 웹 검색(Tavily 등, 사실 수집·구글 SERP)
    """
    if engine == "naver":
        return NaverSearchProvider(config.NAVER_CLIENT_ID, config.NAVER_CLIENT_SECRET)

    name = (config.SEARCH_PROVIDER or "").lower()
    if name == "tavily":
        return TavilyProvider(config.TAVILY_API_KEY)
    # TODO: serpapi / bing / google_cse 분기 추가
    return NullProvider()
