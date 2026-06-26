"""
공개 블로그 전략 감사.

실제 공개 API의 published 글을 기준으로 삭제/리라이트/유지 후보를 분류한다.
목표는 hongcomm.kr의 MICE·학술대회 운영 맥락과 beoksolution의 개발 솔루션
맥락에서 벗어난 글, 또는 너무 일반론인 글을 빨리 찾아내는 것이다.
"""
from __future__ import annotations

import json
import re
import urllib.parse
import urllib.request
from collections import Counter
from typing import Any

import config
from tools.content_quality import (
    generic_title_risk,
    has_composite_service_fit,
    image_count,
    plain_text,
    service_anchor_count,
    title_signature,
)

DEFAULT_PUBLIC_BASE = "https://beoksolution.com"

REMOVE_PATTERNS = (
    "테스트", "무선이어폰", "가성비", "마케팅 트렌드", "콘텐츠 생태계",
)

RELEVANT_TERMS = (
    "비오케이솔루션", "홍커뮤니케이션", "hongcomm", "학회", "학술대회",
    "MICE", "국제회의", "컨퍼런스", "행사", "사무국", "홈페이지",
    "웹사이트", "시스템", "관리자", "대시보드", "개발", "솔루션",
    "접수", "등록", "결제", "초록", "심사", "QR", "체크인",
    "명찰", "동시통역", "API", "연동", "데이터", "백오피스",
)


def _api_base() -> str:
    return (config.SELFHOST_API_URL or DEFAULT_PUBLIC_BASE).rstrip("/")


def _fetch_public_posts(limit: int) -> list[dict[str, Any]]:
    query = urllib.parse.urlencode({"status": "published", "limit": str(limit)})
    url = f"{_api_base()}/api/blog-posts?{query}"
    with urllib.request.urlopen(url, timeout=20) as response:
        payload = json.loads(response.read().decode("utf-8"))
    data = payload.get("data") or {}
    return list(data.get("items") or [])


def _text(post: dict[str, Any]) -> str:
    return " ".join(
        str(post.get(key) or "")
        for key in ("title", "category", "excerpt", "seo_description", "slug", "body")
    )


def _has_relevant_term(text: str) -> bool:
    return any(term in text for term in RELEVANT_TERMS)


def _classification(post: dict[str, Any]) -> tuple[str, list[str]]:
    title = str(post.get("title") or "")
    body = str(post.get("body") or post.get("content") or "")
    text = _text(post)
    delete_signal_text = " ".join(
        str(post.get(key) or "")
        for key in ("title", "category", "slug")
    )
    visible = plain_text(body)
    issues: list[str] = []

    if any(pattern in delete_signal_text for pattern in REMOVE_PATTERNS):
        return "remove", ["공개 블로그 서비스 축에서 벗어난 제목/본문"]

    if not _has_relevant_term(text):
        return "remove", ["MICE/학회/개발 솔루션 관련 앵커 없음"]

    if generic_title_risk(title):
        issues.append("포괄적 제목")
    if service_anchor_count(f"{title} {visible[:1800]}") < 4:
        issues.append("서비스/운영 앵커 부족")
    if any(term in text for term in ("학회", "학술대회", "MICE", "국제회의", "컨퍼런스", "행사")):
        if not has_composite_service_fit(f"{title} {visible[:2200]}"):
            issues.append("학회/MICE 운영과 시스템·홈페이지 해법 연결 부족")
    if len(visible) < 1200:
        issues.append(f"본문 짧음({len(visible)}자)")
    if image_count(body) == 0 and any(term in text for term in ("학회", "학술대회", "MICE", "국제회의", "명찰")):
        issues.append("운영 주제 이미지 없음")

    if issues:
        return "rewrite", issues
    return "keep", []


def _signature(post: dict[str, Any]) -> str:
    title = str(post.get("title") or "")
    return " ".join(sorted(title_signature(title)))


def run(limit: int = 100) -> bool:
    posts = _fetch_public_posts(limit)
    by_status: Counter[str] = Counter()
    by_signature: dict[str, list[dict[str, Any]]] = {}
    rows: list[dict[str, Any]] = []

    for post in posts:
        status, issues = _classification(post)
        by_status[status] += 1
        sig = _signature(post)
        if sig:
            by_signature.setdefault(sig, []).append(post)
        if status != "keep":
            rows.append({
                "action": status,
                "id": post.get("id"),
                "title": post.get("title"),
                "category": post.get("category"),
                "slug": post.get("slug"),
                "issues": issues,
            })

    for sig, duplicates in by_signature.items():
        if len(duplicates) < 2:
            continue
        titles = [str(item.get("title") or "") for item in duplicates]
        if len({re.sub(r"\s+", "", title) for title in titles}) == len(titles):
            continue
        rows.append({
            "action": "rewrite",
            "id": ",".join(str(item.get("id")) for item in duplicates),
            "title": " / ".join(titles[:3]),
            "category": "duplicate-title",
            "slug": None,
            "issues": ["제목 시그니처 중복"],
        })
        by_status["rewrite"] += 1

    print("=== 공개 블로그 전략 감사 ===")
    print(json.dumps({"checked": len(posts), "summary": dict(by_status)}, ensure_ascii=False))
    for row in rows:
        print(json.dumps(row, ensure_ascii=False))

    if rows:
        print(f"\n조치 후보 {len(rows)}건 / 검사 {len(posts)}건")
    else:
        print("조치 후보 없음")
    return by_status["remove"] == 0


if __name__ == "__main__":
    import sys

    arg_limit = int(sys.argv[1]) if len(sys.argv) > 1 else 100
    raise SystemExit(0 if run(arg_limit) else 1)
