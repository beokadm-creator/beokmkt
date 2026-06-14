"""
상태별 건수 리포트 (기획 03 §3.5).

파이프라인 어디에 글이 쌓여있는지/막혔는지 한눈에 본다.
재고(reviewed)가 버퍼 이하면 경고, needs_human이 있으면 경고.

사용: python tools/status_report.py
"""
from __future__ import annotations

import config
from db import db

STATUSES = [
    "draft", "generating", "reviewing", "reviewed",
    "queued", "publishing", "published", "needs_human", "failed", "archived",
]


def report() -> dict[str, int]:
    counts = {s: db.count_by_status(s) for s in STATUSES}

    print("=== 파이프라인 상태 ===")
    for s in STATUSES:
        print(f"  {s:12} {counts[s]:>5}")

    buffer_target = config.DAILY_PUBLISH_TARGET * config.STOCK_BUFFER_DAYS
    print("\n=== 점검 ===")
    if counts["reviewed"] < buffer_target:
        print(f"  [경고] 재고 부족: reviewed={counts['reviewed']} < 목표 {buffer_target} "
              f"(생성량↑/시드 보충 필요)")
    else:
        print(f"  [정상] 재고 충분: reviewed={counts['reviewed']} (목표 {buffer_target})")

    if counts["needs_human"]:
        print(f"  [경고] 수동 처리 대기: needs_human={counts['needs_human']}")
    if counts["failed"]:
        print(f"  [주의] 실패 누적: failed={counts['failed']}")
    return counts


if __name__ == "__main__":
    report()
