"""
상태별 건수 리포트 (기획 03 §3.5).

파이프라인 어디에 글이 쌓여있는지/막혔는지 한눈에 본다.
재고(reviewed)가 버퍼 이하면 경고, needs_human이 있으면 경고.

사용: python tools/status_report.py
"""
from __future__ import annotations

from datetime import datetime, timezone

import config
from db import db

STATUSES = [
    "draft", "generating", "factchecking", "reviewing", "reviewed",
    "queued", "publishing", "published", "needs_human", "failed", "archived",
]
INVENTORY_STATUSES = ("draft", "generating", "factchecking", "reviewing", "reviewed")


def _focus_inventory_by_channel() -> dict[str, int]:
    terms = config.AUTO_SEED_REQUIRED_TERMS
    if not terms:
        return {}
    placeholders = ",".join("?" for _ in INVENTORY_STATUSES)
    like_clause = " OR ".join("topic LIKE ?" for _ in terms)
    where = [f"status IN ({placeholders})", f"({like_clause})"]
    params: list = [*INVENTORY_STATUSES, *[f"%{term}%" for term in terms]]
    brand_filter = (config.AUTO_SEED_BRAND_FILTER or "").strip()
    if brand_filter:
        where.insert(1, "category = ?")
        params.insert(len(INVENTORY_STATUSES), brand_filter)
    with db.connect() as conn:
        rows = conn.execute(
            f"""
            SELECT channel, COUNT(*) AS n
            FROM posts
            WHERE {' AND '.join(where)}
            GROUP BY channel
            """,
            params,
        ).fetchall()
    return {row["channel"]: int(row["n"]) for row in rows}


def report() -> dict[str, int]:
    counts = {s: db.count_by_status(s) for s in STATUSES}
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    with db.connect() as conn:
        queued_due = conn.execute(
            "SELECT COUNT(*) AS n FROM posts WHERE status = 'queued' AND next_run_at <= ?",
            (now,),
        ).fetchone()["n"]
        next_queued = conn.execute(
            "SELECT MIN(next_run_at) AS next_run_at FROM posts WHERE status = 'queued'",
        ).fetchone()["next_run_at"]
        channel_rows = conn.execute(
            """
            SELECT channel, status, COUNT(*) AS n
            FROM posts
            WHERE status IN (
              'draft', 'generating', 'factchecking', 'reviewing', 'reviewed',
              'queued', 'publishing', 'published', 'needs_human', 'failed'
            )
            GROUP BY channel, status
            ORDER BY channel, status
            """
        ).fetchall()

    print("=== 파이프라인 상태 ===")
    for s in STATUSES:
        print(f"  {s:12} {counts[s]:>5}")

    by_channel: dict[str, dict[str, int]] = {}
    for row in channel_rows:
        by_channel.setdefault(row["channel"], {})[row["status"]] = int(row["n"])
    focus_inventory = _focus_inventory_by_channel()

    print("\n=== 채널별 현황 ===")
    for channel in sorted(by_channel):
        row = by_channel[channel]
        inventory = sum(row.get(s, 0) for s in INVENTORY_STATUSES)
        active_queue = row.get("queued", 0) + row.get("publishing", 0)
        policy = ""
        if channel in {"naver", "tistory"} and not config.ALLOW_EXTERNAL_AUTO_SEED:
            policy = " auto_seed=off"
        print(
            f"  {channel:10} inventory={inventory:>3} "
            f"focus={focus_inventory.get(channel, 0):>3} "
            f"queued={active_queue:>3} published={row.get('published', 0):>3} "
            f"needs_human={row.get('needs_human', 0):>3} failed={row.get('failed', 0):>3}"
            f"{policy}"
        )

    buffer_target = config.DAILY_PUBLISH_TARGET * config.STOCK_BUFFER_DAYS
    inventory = sum(counts[s] for s in INVENTORY_STATUSES)
    print("\n=== 점검 ===")
    search_health = config.search_health_status()
    if search_health["ok"]:
        provider = search_health["provider"] or "unknown"
        naver_serp = "on" if search_health["naver_serp_ok"] else "off"
        print(f"  [정상] 검색/근거 수집 가능: provider={provider}, naver_serp={naver_serp}")
    else:
        print(f"  [중단] 검색/근거 수집 불가: {search_health['reason']}")

    if inventory < buffer_target:
        print(f"  [경고] 전발행 재고 부족: inventory={inventory} < 목표 {buffer_target} "
              f"(stock_seed/generate 확인)")
    else:
        print(f"  [정상] 전발행 재고 충분: inventory={inventory} (목표 {buffer_target})")

    focus_total = sum(focus_inventory.values())
    if focus_total < buffer_target:
        print(
            f"  [경고] 허용 콘텐츠 축 재고 부족: focus_inventory={focus_total} < 목표 {buffer_target} "
            f"({config.BLOG_FOCUS_NAME})"
        )
    else:
        print(f"  [정상] 허용 콘텐츠 축 재고 충분: focus_inventory={focus_total} (목표 {buffer_target})")

    if counts["reviewed"] < buffer_target:
        print(f"  [진행] reviewed 전환 대기: reviewed={counts['reviewed']} < 목표 {buffer_target} "
              f"(factcheck/review 주기에 따라 보충)")
    else:
        print(f"  [정상] 재고 충분: reviewed={counts['reviewed']} (목표 {buffer_target})")

    if counts["queued"]:
        if queued_due:
            print(f"  [확인] 즉시 발행 대상: queued_due={queued_due} (publish 실행 대상)")
        else:
            print(f"  [대기] 예약 글 {counts['queued']}건, 다음 예약 UTC={next_queued}")

    external_channels = {"naver", "tistory"}
    if not config.ALLOW_EXTERNAL_AUTO_SEED:
        missing = [
            channel for channel in sorted(external_channels)
            if focus_inventory.get(channel, 0) == 0
            and by_channel.get(channel, {}).get("queued", 0) == 0
            and by_channel.get(channel, {}).get("publishing", 0) == 0
        ]
        if missing:
            print(
                "  [정책] 외부 채널 자동시드 비활성: "
                f"{', '.join(missing)} 재고 0은 설정값(ALLOW_EXTERNAL_AUTO_SEED=false)에 따른 상태"
            )

    if counts["needs_human"]:
        print(f"  [경고] 수동 처리 대기: needs_human={counts['needs_human']}")
    if counts["failed"]:
        print(f"  [주의] 실패 누적: failed={counts['failed']}")
    return counts


if __name__ == "__main__":
    report()
