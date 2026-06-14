"""
자동 시드 생성기.

keyword_bank.py의 키워드 목록에서 아직 DB에 없는 주제를 골라
draft 시드를 자동으로 생성한다.

cron 예시:
  0 */6 * * *  cd /path && python3 run.py auto_seed
"""
from __future__ import annotations

import re

from db import db
from tools.keyword_bank import KEYWORDS


def _normalize(text: str) -> str:
    """비교용 정규화 — 공백·특수문자 제거, 소문자."""
    return re.sub(r"[^가-힣a-z0-9]", "", text.lower())


def _existing_topics() -> set[str]:
    """DB에 있는 모든 topic의 정규화 집합."""
    with db.connect() as conn:
        rows = conn.execute("SELECT topic FROM posts WHERE topic IS NOT NULL").fetchall()
    return {_normalize(r["topic"]) for r in rows}


def run(channel: str = "selfhosted", max_seeds: int = 3) -> int:
    """
    아직 다루지 않은 키워드에서 최대 max_seeds개의 draft를 생성.
    반환: 생성된 시드 수.
    """
    existing = _existing_topics()
    created = 0

    for topic, content_type, brand_key in KEYWORDS:
        if created >= max_seeds:
            break
        if _normalize(topic) in existing:
            continue

        pid = db.insert_draft(
            channel=channel,
            topic=topic,
            content_type=content_type,
            category=brand_key,   # 브랜드 구분자로 사용
        )
        print(f"  시드 생성: id={pid} [{brand_key}] ({content_type}) {topic!r}")
        created += 1

    if created == 0:
        print("  새 키워드 없음 — 모든 키워드가 이미 DB에 있거나 keyword_bank에 추가 필요.")
    return created
