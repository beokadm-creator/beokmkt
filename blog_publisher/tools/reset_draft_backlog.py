"""
미공개 draft 병목을 격리하고 다양한 새 주제를 다시 시드한다.

공개 글은 건드리지 않는다. 삭제 대신 status='archived'로 운영 큐에서 분리해
추적 가능성을 남긴다. 기본은 dry-run이며 --apply 때만 DB를 변경한다.
"""
from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

from db import db
from tools.auto_seed import _brand_allowed_for_channel, _select_spread
from tools.keyword_bank import KEYWORDS, pillar_of

ACTIVE_STATUSES = ("draft", "generating", "factchecking", "reviewing")
DEFAULT_CHANNELS = ("selfhosted",)
DEFAULT_SEED_TARGET = 24


def _utcnow() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def _normalize(value: str | None) -> str:
    return re.sub(r"[^가-힣a-z0-9]", "", (value or "").lower())


def _parse_channels(value: str) -> tuple[str, ...]:
    channels = tuple(part.strip() for part in value.split(",") if part.strip())
    unknown = [channel for channel in channels if channel not in {"selfhosted", "tistory", "naver"}]
    if not channels or unknown:
        raise argparse.ArgumentTypeError(f"unknown channel: {', '.join(unknown) or value}")
    return channels


def _candidate_rows(channels: Iterable[str], statuses: Iterable[str]):
    channels = tuple(channels)
    statuses = tuple(statuses)
    channel_marks = ",".join("?" for _ in channels)
    status_marks = ",".join("?" for _ in statuses)
    with db.connect() as conn:
        return conn.execute(
            f"""
            SELECT *
            FROM posts
            WHERE channel IN ({channel_marks})
              AND status IN ({status_marks})
            ORDER BY updated_at, id
            """,
            (*channels, *statuses),
        ).fetchall()


def _protected_topic_keys(channels: Iterable[str], archive_ids: Iterable[int]) -> set[str]:
    channels = tuple(channels)
    channel_marks = ",".join("?" for _ in channels)
    params: list = [*channels]
    with db.connect() as conn:
        rows = conn.execute(
            f"""
            SELECT topic, title
            FROM posts
            WHERE channel IN ({channel_marks})
              AND status != 'archived'
            """,
            params,
        ).fetchall()
    return {_normalize(row["topic"] or row["title"]) for row in rows if (row["topic"] or row["title"])}


def replacement_topics(limit: int, channel: str, archive_ids: Iterable[int]) -> list[tuple[str, str, str, str]]:
    """새 draft 시드 후보를 뽑는다.

    앵커/주제축 분산은 keyword_bank.pillar_of() + auto_seed._select_spread를
    그대로 재사용한다(단일 기준 유지 — 이 도구만 별도 4축 분류를 쓰면 auto_seed가
    적용하는 pillar 다양성 규칙과 어긋나 다시 편중이 생길 수 있다)."""
    protected = _protected_topic_keys((channel,), archive_ids)
    seen: set[str] = set()
    candidates: list[tuple[str, str, str]] = []
    for topic, content_type, brand_key in KEYWORDS:
        if not _brand_allowed_for_channel(channel, brand_key):
            continue
        key = _normalize(topic)
        if key in protected or key in seen:
            continue
        seen.add(key)
        candidates.append((topic, content_type, brand_key))

    chosen = _select_spread(candidates, limit)
    return [(topic, content_type, brand_key, pillar_of(topic, brand_key)) for topic, content_type, brand_key in chosen]


def _insert_replacements(channel: str, topics: list[tuple[str, str, str, str]]) -> list[dict]:
    created: list[dict] = []
    for topic, content_type, brand_key, axis in topics:
        new_id = db.insert_draft(
            channel=channel,
            topic=topic,
            content_type=content_type,
            category=brand_key,
        )
        created.append({"id": new_id, "channel": channel, "topic": topic, "axis": axis, "category": brand_key})
    return created


def _write_report(report: dict) -> Path:
    report_dir = Path(__file__).resolve().parents[1] / "reports"
    report_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    path = report_dir / f"draft-backlog-reset-{stamp}.json"
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def _row_summary(row) -> dict:
    body = row["body"] or ""
    return {
        "id": row["id"],
        "channel": row["channel"],
        "status": row["status"],
        "category": row["category"],
        "topic": row["topic"],
        "title": row["title"],
        "body_chars": len(body),
        "grounding_ratio": row["grounding_ratio"],
        "review_issues": row["review_issues"],
        "updated_at": row["updated_at"],
    }


def run(argv: list[str] | None = None) -> bool:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--channels", type=_parse_channels, default=DEFAULT_CHANNELS)
    parser.add_argument("--statuses", type=lambda value: tuple(part.strip() for part in value.split(",") if part.strip()), default=ACTIVE_STATUSES)
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED_TARGET, help="새로 생성할 draft 수")
    parser.add_argument("--reason", default="reset_low_quality_draft_backlog")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args(argv)

    rows = _candidate_rows(args.channels, args.statuses)
    archive_ids = [int(row["id"]) for row in rows]
    replacements = replacement_topics(args.seed, "selfhosted", archive_ids)
    report = {
        "ok": True,
        "mode": "apply" if args.apply else "dry-run",
        "generated_at": _utcnow(),
        "channels": list(args.channels),
        "statuses": list(args.statuses),
        "matched": len(rows),
        "archive_candidates": [_row_summary(row) for row in rows],
        "replacement_plan": [
            {"channel": "selfhosted", "topic": topic, "content_type": ctype, "category": brand, "axis": axis}
            for topic, ctype, brand, axis in replacements
        ],
        "archived": 0,
        "created": [],
    }

    if args.apply:
        report["archived"] = db.quarantine_posts(archive_ids, args.reason)
        report["created"] = _insert_replacements("selfhosted", replacements)

    path = _write_report(report)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    print(f"report={path}")
    return True


if __name__ == "__main__":
    import sys

    raise SystemExit(0 if run(sys.argv[1:]) else 1)
