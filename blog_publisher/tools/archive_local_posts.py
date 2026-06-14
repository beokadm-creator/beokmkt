"""
로컬 SQLite 실패/수동 처리 항목 보관.

삭제하지 않고 status='archived'로 바꿔 운영 경고와 워커 대상에서 분리한다.
"""
from __future__ import annotations

import argparse

from db import db


def _candidate_ids() -> list[int]:
    rows = db.fetch_by_status("needs_human", limit=1000)
    rows += db.fetch_by_status("failed", limit=1000)
    return [int(row["id"]) for row in rows]


def run(argv: list[str] | None = None) -> bool:
    parser = argparse.ArgumentParser(description="수동 검토 완료 글을 로컬 운영 큐에서 보관 처리")
    parser.add_argument("ids", nargs="*", type=int, help="보관할 post id")
    parser.add_argument("--all-reviewed", action="store_true", help="현재 needs_human/failed 전체 보관")
    parser.add_argument("--reason", default="operator_reviewed", help="보관 사유")
    args = parser.parse_args(argv)

    ids = _candidate_ids() if args.all_reviewed else args.ids
    if not ids:
        print("보관할 id가 없습니다.")
        return True

    n = db.archive_posts(ids, args.reason)
    print(f"보관 완료: {n}/{len(ids)}건")
    if n:
        print("ids:", ", ".join(str(i) for i in ids))
    return n == len(ids)


if __name__ == "__main__":
    import sys

    raise SystemExit(0 if run(sys.argv[1:]) else 1)
