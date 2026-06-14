"""
발행 직전/운영 감사용 콘텐츠 품질 규칙.

목표는 좋은 글을 점수화하는 것이 아니라, 명백히 저품질인 공개 발행을 막는 것이다.
- 같은 날 같은 본문 반복 발행 차단
- 운영 주제(beok/hong) 무이미지 발행 차단
- 이미지 자동 업로드가 검증되지 않은 네이버 글은 수동 확인으로 격리
"""
from __future__ import annotations

import difflib
import re

from db import db

OPERATIONAL_TERMS = (
    "비오케이솔루션", "홍커뮤니케이션", "hongcomm", "학회", "학술대회",
    "명찰", "사무국", "MICE", "국제회의", "컨퍼런스", "동시통역",
    "포트폴리오", "레퍼런스", "행사", "접수", "등록",
)


def plain_text(value: str | None) -> str:
    text = str(value or "")
    text = re.sub(r"!\[[^\]]*]\([^)\s]+\)", " ", text)
    text = re.sub(r"<script[\s\S]*?</script>", " ", text, flags=re.I)
    text = re.sub(r"<style[\s\S]*?</style>", " ", text, flags=re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def normalized_text(value: str | None, limit: int = 2600) -> str:
    text = plain_text(value).lower()
    text = re.sub(r"[^가-힣a-z0-9]+", "", text)
    return text[:limit]


def image_count(value: str | None) -> int:
    text = str(value or "")
    return len(re.findall(r"<img\b", text, flags=re.I)) + len(
        re.findall(r"!\[[^\]]*]\([^)\s]+\)", text)
    )


def is_operational_post(post) -> bool:
    text = f"{post['category'] or ''} {post['title'] or ''} {post['topic'] or ''} {post['body'] or ''}"
    return (post["category"] in {"beok", "hong"}) or any(term in text for term in OPERATIONAL_TERMS)


def similar_today_published(post, threshold: float = 0.82) -> tuple[bool, dict | None, float]:
    """
    같은 KST 날짜에 이미 공개된 글과 본문이 지나치게 유사하면 True.
    채널이 달라도 같은 날 같은 내용이면 검색 품질 리스크이므로 막는다.
    """
    current = normalized_text(post["body"])
    if len(current) < 400:
        return False, None, 0.0

    with db.connect() as conn:
        rows = conn.execute(
            """
            SELECT id, channel, title, body, published_url, updated_at
            FROM posts
            WHERE status = 'published'
              AND id != ?
              AND date(updated_at, '+9 hours') = date(?, '+9 hours')
            ORDER BY updated_at DESC
            LIMIT 80
            """,
            (post["id"], post["updated_at"]),
        ).fetchall()

    best_row = None
    best_ratio = 0.0
    for row in rows:
        other = normalized_text(row["body"])
        if len(other) < 400:
            continue
        ratio = difflib.SequenceMatcher(None, current, other).ratio()
        if ratio > best_ratio:
            best_ratio = ratio
            best_row = dict(row)
    return best_ratio >= threshold, best_row, best_ratio


def publish_blockers(post) -> list[str]:
    issues: list[str] = []
    body = post["body"] or ""
    chars = len(plain_text(body))
    images = image_count(body)

    if is_operational_post(post):
        if chars < 1800:
            issues.append(f"운영 글 본문 부족({chars}/1800자)")
        if images < 1:
            issues.append("운영 글 이미지 없음")

    if post["channel"] == "naver":
        issues.append(
            "네이버 자동 발행은 이미지 업로드 보존이 아직 검증되지 않아 수동 확인 필요"
        )

    is_dup, matched, ratio = similar_today_published(post)
    if is_dup and matched:
        issues.append(
            f"당일 공개 글과 본문 중복 위험({ratio:.2f}) "
            f"matched=#{matched['id']} {matched['channel']}"
        )
    return issues
