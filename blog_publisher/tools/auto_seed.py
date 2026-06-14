"""
자동 시드 생성기.

keyword_bank.py의 키워드 목록에서 아직 DB에 없는 주제를 골라
draft 시드를 자동으로 생성한다.

cron 예시:
  0 */6 * * *  cd /path && python3 run.py auto_seed
"""
from __future__ import annotations

import re

import config
from db import db
from tools.keyword_bank import KEYWORDS

INVENTORY_STATUSES = (
    "draft",
    "generating",
    "factchecking",
    "reviewing",
    "reviewed",
)


def _normalize(text: str) -> str:
    """비교용 정규화 — 공백·특수문자 제거, 소문자."""
    return re.sub(r"[^가-힣a-z0-9]", "", text.lower())


def _existing_topics() -> set[str]:
    """DB에 있는 모든 topic의 정규화 집합."""
    with db.connect() as conn:
        rows = conn.execute("SELECT topic FROM posts WHERE topic IS NOT NULL").fetchall()
    return {_normalize(r["topic"]) for r in rows}


def _matches_focus(topic: str = "", brand_key: str = "") -> bool:
    brand_filter = (config.AUTO_SEED_BRAND_FILTER or "").strip()
    if brand_filter and brand_key != brand_filter:
        return False
    terms = config.AUTO_SEED_REQUIRED_TERMS
    if not terms:
        return True
    return any(term in (topic or "") for term in terms)


def _inventory_count(channel: str) -> int:
    placeholders = ",".join("?" for _ in INVENTORY_STATUSES)
    where = [
        "channel = ?",
        f"status IN ({placeholders})",
    ]
    params: list = [channel, *INVENTORY_STATUSES]
    brand_filter = (config.AUTO_SEED_BRAND_FILTER or "").strip()
    if brand_filter:
        where.append("category = ?")
        params.append(brand_filter)
    if config.AUTO_SEED_REQUIRED_TERMS:
        where.append(f"({' OR '.join(['topic LIKE ?' for _ in config.AUTO_SEED_REQUIRED_TERMS])})")
        params.extend(f"%{term}%" for term in config.AUTO_SEED_REQUIRED_TERMS)
    with db.connect() as conn:
        row = conn.execute(
            f"""
            SELECT COUNT(*) AS n
            FROM posts
            WHERE {' AND '.join(where)}
            """,
            params,
        ).fetchone()
    return int(row["n"])


def run(channel: str = "selfhosted", max_seeds: int = 3) -> int:
    """
    아직 다루지 않은 키워드에서 최대 max_seeds개의 draft를 생성.
    반환: 생성된 시드 수.
    """
    if channel in {"naver", "tistory"} and not config.ALLOW_EXTERNAL_AUTO_SEED:
        print(f"  {channel} auto_seed 보류 — ALLOW_EXTERNAL_AUTO_SEED=true 설정 후 재개")
        return 0

    existing = _existing_topics()
    created = 0

    for topic, content_type, brand_key in KEYWORDS:
        if created >= max_seeds:
            break
        if not _matches_focus(topic, brand_key):
            continue
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


def run_stock(channel: str = "selfhosted", target: int | None = None) -> int:
    """
    발행 전 재고(draft~reviewed)가 목표 미만이면 부족분만 시드한다.
    queued는 이미 발행 예약으로 빠져나간 물량이므로 새 재고 계산에서 제외한다.
    """
    target = target or (config.DAILY_PUBLISH_TARGET * config.STOCK_BUFFER_DAYS)
    current = _inventory_count(channel)
    missing = max(0, target - current)
    if missing == 0:
        print(f"  목표 주제 재고 충분: channel={channel} inventory={current} / target={target}")
        return 0
    print(f"  목표 주제 재고 보충 필요: channel={channel} inventory={current} / target={target}, seed={missing}")
    return run(channel=channel, max_seeds=missing)
