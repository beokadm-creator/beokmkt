"""
Archive pre-quality-adjustment pipeline rows and queue replacement drafts.

This is intended to run on the Windows operations PC, where blog.db is the
source of truth. Self-hosted public posts are also soft-deleted through the
blog API when their published URL can be resolved.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable
from urllib.parse import quote, urlparse

import requests

import config
from db import db

DEFAULT_CUTOFF_UTC = "2026-06-15 10:19:51"  # 80b4ec8, compact output/image diversity
DEFAULT_CHANNELS = ("selfhosted", "tistory")
RESET_STATUSES = (
    "draft",
    "generating",
    "factchecking",
    "reviewing",
    "reviewed",
    "queued",
    "publishing",
    "published",
    "needs_human",
    "failed",
)


@dataclass
class PublicDeleteResult:
    post_id: int
    url: str
    ok: bool
    reason: str
    remote_id: str | None = None


def _utcnow() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def _normalize_topic(value: str | None) -> str:
    text = value or ""
    return re.sub(r"[^가-힣a-z0-9]", "", text.lower())


def _parse_channels(value: str) -> tuple[str, ...]:
    channels = tuple(part.strip() for part in value.split(",") if part.strip())
    if not channels:
        raise argparse.ArgumentTypeError("at least one channel is required")
    unknown = [channel for channel in channels if channel not in {"selfhosted", "tistory", "naver"}]
    if unknown:
        raise argparse.ArgumentTypeError(f"unknown channel: {', '.join(unknown)}")
    return channels


def _slug_from_public_url(url: str | None) -> str | None:
    if not url:
        return None
    path = urlparse(url).path.rstrip("/")
    marker = "/blog/"
    if marker not in path:
        return None
    return path.rsplit(marker, 1)[-1] or None


def _api_base() -> str:
    return config.SELFHOST_API_URL.rstrip("/")


def _delete_selfhosted_public(row) -> PublicDeleteResult:
    url = str(row["published_url"] or "")
    slug = _slug_from_public_url(url)
    if not slug:
        return PublicDeleteResult(row["id"], url, False, "published_url에서 slug를 찾지 못함")
    if not config.SELFHOST_API_KEY:
        return PublicDeleteResult(row["id"], url, False, "SELFHOST_API_KEY 미설정")

    headers = {"X-API-Key": config.SELFHOST_API_KEY}
    try:
        lookup = requests.get(
            f"{_api_base()}/api/blog-posts/slug/{quote(slug, safe='')}",
            headers=headers,
            timeout=20,
        )
        if lookup.status_code == 404:
            return PublicDeleteResult(row["id"], url, True, "이미 공개 블로그에서 없음")
        if lookup.status_code != 200:
            return PublicDeleteResult(row["id"], url, False, f"slug 조회 실패 HTTP {lookup.status_code}")
        remote = lookup.json().get("data", {})
        remote_id = remote.get("id")
        if not remote_id:
            return PublicDeleteResult(row["id"], url, False, "slug 조회 응답에 id 없음")

        deleted = requests.delete(
            f"{_api_base()}/api/blog-posts/{quote(str(remote_id), safe='')}",
            headers=headers,
            timeout=20,
        )
        if deleted.status_code not in {200, 204}:
            return PublicDeleteResult(
                row["id"],
                url,
                False,
                f"삭제 실패 HTTP {deleted.status_code}: {deleted.text[:160]}",
                str(remote_id),
            )
        return PublicDeleteResult(row["id"], url, True, "삭제 완료", str(remote_id))
    except requests.RequestException as exc:
        return PublicDeleteResult(row["id"], url, False, f"네트워크 오류: {exc}")


def _select_rows(channels: Iterable[str], before: str):
    channels = tuple(channels)
    channel_marks = ",".join("?" for _ in channels)
    status_marks = ",".join("?" for _ in RESET_STATUSES)
    with db.connect() as conn:
        return conn.execute(
            f"""
            SELECT *
            FROM posts
            WHERE channel IN ({channel_marks})
              AND status IN ({status_marks})
              AND created_at < ?
            ORDER BY channel, created_at, id
            """,
            (*channels, *RESET_STATUSES, before),
        ).fetchall()


def _archive_rows(post_ids: list[int], reason: str) -> int:
    if not post_ids:
        return 0
    placeholders = ",".join("?" for _ in post_ids)
    now = _utcnow()
    message = f"ARCHIVED: {reason}"
    with db.connect() as conn:
        cur = conn.execute(
            f"""
            UPDATE posts
            SET status = 'archived',
                last_error = CASE
                  WHEN last_error IS NULL OR last_error = '' THEN ?
                  ELSE ? || ' | previous: ' || substr(last_error, 1, 800)
                END,
                updated_at = ?
            WHERE id IN ({placeholders})
            """,
            (message, message, now, *post_ids),
        )
        return cur.rowcount


def _insert_replacements(rows) -> list[dict]:
    created: list[dict] = []
    seen: set[tuple[str, str]] = set()
    for row in rows:
        topic = (row["topic"] or row["title"] or "").strip()
        if not topic:
            continue
        key = (row["channel"], _normalize_topic(topic))
        if key in seen:
            continue
        seen.add(key)
        new_id = db.insert_draft(
            channel=row["channel"],
            topic=topic,
            content_type=row["content_type"] or "howto",
            category=row["category"] or "",
            blog_profile=row["blog_profile"] or "",
        )
        created.append(
            {
                "old_id": row["id"],
                "new_id": new_id,
                "channel": row["channel"],
                "topic": topic,
            }
        )
    return created


def _write_report(report: dict) -> Path:
    report_dir = Path(__file__).resolve().parents[1] / "reports"
    report_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    path = report_dir / f"quality-reset-{stamp}.json"
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def run(argv: list[str] | None = None) -> bool:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--before", default=DEFAULT_CUTOFF_UTC, help="UTC cutoff, default: %(default)s")
    parser.add_argument("--channels", type=_parse_channels, default=DEFAULT_CHANNELS)
    parser.add_argument("--apply", action="store_true", help="archive/delete/insert changes")
    args = parser.parse_args(argv)

    rows = _select_rows(args.channels, args.before)
    published = [row for row in rows if row["status"] == "published"]
    selfhosted_published = [row for row in published if row["channel"] == "selfhosted"]
    tistory_published = [row for row in published if row["channel"] == "tistory"]

    report = {
        "ok": True,
        "mode": "apply" if args.apply else "dry-run",
        "before_utc": args.before,
        "channels": list(args.channels),
        "matched": len(rows),
        "matched_ids": [row["id"] for row in rows],
        "published": {
            "selfhosted": len(selfhosted_published),
            "tistory": len(tistory_published),
        },
        "selfhosted_public_deletes": [],
        "tistory_manual_delete_urls": [
            {"post_id": row["id"], "url": row["published_url"], "title": row["title"]}
            for row in tistory_published
            if row["published_url"]
        ],
        "archived": 0,
        "replacement_drafts": [],
    }

    if args.apply:
        delete_results = [_delete_selfhosted_public(row) for row in selfhosted_published]
        report["selfhosted_public_deletes"] = [asdict(result) for result in delete_results]
        failed_deletes = [result for result in delete_results if not result.ok]
        if failed_deletes:
            report["ok"] = False
            path = _write_report(report)
            print(json.dumps(report, ensure_ascii=False, indent=2))
            print(f"report={path}", file=sys.stderr)
            return False
        report["archived"] = _archive_rows([row["id"] for row in rows], "pre_quality_reset_before_80b4ec8")
        report["replacement_drafts"] = _insert_replacements(rows)

    path = _write_report(report)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    print(f"report={path}")
    return bool(report["ok"])


if __name__ == "__main__":
    raise SystemExit(0 if run() else 1)
