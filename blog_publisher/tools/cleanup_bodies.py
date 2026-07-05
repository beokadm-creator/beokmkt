"""
기존 DB 게시물 정리 마이그레이션.

LLM이 삽입한 HTML 래퍼 태그 제거, 테스트/검증용 게시물 아카이브,
채널 간 중복 게시물 보고.

용법:
  python3 tools/cleanup_bodies.py           # 드라이런 (변경 없음)
  python3 tools/cleanup_bodies.py --apply    # 실제 적용
"""
from __future__ import annotations

import argparse
import re
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

# tools/ 하위 스크립트가 blog_publisher/ 패키지 경로에서 임포트되게 함
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from db.db import TEST_MARKER_RE  # noqa: E402  (sys.path 조정 이후 임포트, 단일 소스)
from utils import markdown_guard  # noqa: E402

_ARCHIVEABLE_STATUSES = (
    "published", "queued", "reviewed", "reviewing",
    "factchecking", "draft", "generating",
)


def _normalize_topic(topic: str) -> str:
    return re.sub(r"[^가-힣a-z0-9]", "", (topic or "").lower())


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def _scan_posts(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT id, status, channel, topic, title, body FROM posts ORDER BY id",
    ).fetchall()


def _find_span_dirty(rows: list[sqlite3.Row]) -> list[sqlite3.Row]:
    return [r for r in rows if r["body"] and markdown_guard.has_html_tags(r["body"])]


def _find_test_posts(rows: list[sqlite3.Row]) -> list[sqlite3.Row]:
    return [
        r for r in rows
        if r["topic"] and TEST_MARKER_RE.search(r["topic"])
        and r["status"] in _ARCHIVEABLE_STATUSES
    ]


def _find_cross_channel_duplicates(
    rows: list[sqlite3.Row],
) -> list[list[sqlite3.Row]]:
    published = [r for r in rows if r["status"] == "published" and r["topic"]]
    groups: dict[str, list[sqlite3.Row]] = {}
    for r in published:
        key = _normalize_topic(r["topic"])
        groups.setdefault(key, []).append(r)
    return [
        g for g in groups.values()
        if len(g) >= 2 and len({r["channel"] for r in g}) >= 2
    ]


def run(apply: bool = False) -> None:
    from db import db

    with db.connect() as conn:
        rows = _scan_posts(conn)
        span_dirty = _find_span_dirty(rows)
        test_posts = _find_test_posts(rows)
        dup_groups = _find_cross_channel_duplicates(rows)

        print(f"전체 게시물: {len(rows)}건")
        print(f"LLM HTML 래퍼 태그 포함: {len(span_dirty)}건")
        print(f"테스트/검증 아카이브 대상: {len(test_posts)}건")
        print(f"채널 간 중복 그룹: {len(dup_groups)}건")
        print()

        if not apply:
            print("DRY RUN — 변경 없음 (--apply 로 실제 적용)")
            print()

        # 1) 본문 HTML 래퍼 태그 제거
        bodies_changed = 0
        for r in span_dirty:
            new_body = markdown_guard.strip_html_tags(r["body"])
            if apply:
                conn.execute(
                    "UPDATE posts SET body = ?, updated_at = ? WHERE id = ?",
                    (new_body, _utcnow_iso(), r["id"]),
                )
                bodies_changed += 1
                delta = len(r["body"]) - len(new_body)
                print(f"  본문 정리: id={r['id']} (태그 {delta}바이트 제거)")
            else:
                delta = len(r["body"]) - len(new_body)
                print(f"  [DRY] 본문 정리 예정: id={r['id']} (태그 {delta}바이트 제거 예정)")

        # 2) 테스트/검증 게시물 아카이브
        archived = 0
        for r in test_posts:
            if apply:
                conn.execute(
                    "UPDATE posts SET status = 'archived', updated_at = ? WHERE id = ?",
                    (_utcnow_iso(), r["id"]),
                )
                archived += 1
                print(
                    f"  아카이브: id={r['id']} "
                    f"[{r['status']}→archived] {r['topic'][:60]}"
                )
            else:
                print(
                    f"  [DRY] 아카이브 예정: id={r['id']} "
                    f"[{r['status']}→archived] {r['topic'][:60]}"
                )

        # 3) 채널 간 중복 보고 (자동 변경 없음)
        if dup_groups:
            print()
            print("채널 간 중복 게시물 (보고 전용, 자동 변경 없음):")
            for g in dup_groups:
                channels = ", ".join(f"{r['channel']}#{r['id']}" for r in g)
                print(f"  중복: {g[0]['topic'][:60]} → {channels}")

    # 요약 (conn 블록 밖에서 출력 — 커밋 후)
    print()
    print("=" * 60)
    effective_bodies = bodies_changed if apply else len(span_dirty)
    effective_archived = archived if apply else len(test_posts)
    print(
        f"요약: scanned={len(rows)}, bodies_changed={effective_bodies}, "
        f"archived={effective_archived}, duplicate_groups={len(dup_groups)}"
    )
    if not apply:
        print("(DRY RUN — 실제 변경 없음. --apply 로 적용하세요)")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="기존 DB 게시물 정리 (HTML 태그 제거 + 테스트 아카이브)",
    )
    parser.add_argument(
        "--apply", action="store_true",
        help="실제 DB에 적용 (기본: 드라이런)",
    )
    args = parser.parse_args()
    run(apply=args.apply)


if __name__ == "__main__":
    main()
