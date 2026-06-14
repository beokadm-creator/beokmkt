"""
공개 글 삭제/비공개 후보 감사.

실제 삭제는 하지 않는다. 공개 URL별로 사람이 확인해야 할 후보를 우선순위로 보여준다.
"""
from __future__ import annotations

import collections
import json

from db import db
from tools.content_quality import image_count, normalized_text, plain_text


def _body_sig(body: str | None) -> str:
    return normalized_text(body, limit=1400)


def _issues(row, duplicates: dict[str, list[int]]) -> list[str]:
    issues: list[str] = []
    chars = len(plain_text(row["body"]))
    images = image_count(row["body"])
    title = row["title"] or row["topic"] or ""
    sig = _body_sig(row["body"])

    if chars < 1000:
        issues.append(f"본문 매우 짧음({chars}자)")
    elif chars < 1800:
        issues.append(f"본문 짧음({chars}자)")
    if images == 0 and any(term in title for term in ("학회", "명찰", "홍커뮤니케이션", "MICE", "국제회의")):
        issues.append("운영 주제 이미지 없음")
    if sig and len(duplicates[sig]) >= 3:
        issues.append(f"동일 본문 반복({len(duplicates[sig])}건: {duplicates[sig][:8]})")
    if any(term in title for term in ("점검", "검증", "테스트", "0614", "0615", "운영 기준")):
        issues.append("테스트/운영 메타 제목")
    return issues


def run(limit: int = 80) -> bool:
    with db.connect() as conn:
        rows = conn.execute(
            """
            SELECT id, channel, title, topic, body, published_url, updated_at
            FROM posts
            WHERE status = 'published'
            ORDER BY updated_at DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()

    sigs: dict[str, list[int]] = collections.defaultdict(list)
    for row in rows:
        sig = _body_sig(row["body"])
        if sig:
            sigs[sig].append(int(row["id"]))

    candidates = []
    for row in rows:
        issues = _issues(row, sigs)
        if not issues:
            continue
        candidates.append({
            "id": row["id"],
            "channel": row["channel"],
            "title": row["title"] or row["topic"],
            "url": row["published_url"],
            "updated_at": row["updated_at"],
            "issues": issues,
        })

    print("=== 공개 글 삭제/비공개 후보 ===")
    if not candidates:
        print("후보 없음")
        return True
    for item in candidates:
        print(json.dumps(item, ensure_ascii=False))
    print(f"\n후보 {len(candidates)}건 / 검사 {len(rows)}건")
    return False


if __name__ == "__main__":
    import sys

    arg_limit = int(sys.argv[1]) if len(sys.argv) > 1 else 80
    raise SystemExit(0 if run(arg_limit) else 1)
