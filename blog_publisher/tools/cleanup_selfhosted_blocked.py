"""
selfhosted 발행 불가 미공개 글을 운영 큐에서 격리한다.

공개 글은 건드리지 않는다. 발행 게이트에 걸린 queued/needs_human/failed 글만
archived로 분리해 다음 publish 주기를 막지 않게 한다.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from db import db
from tools.content_quality import publish_blockers


TARGET_STATUSES = ("queued", "needs_human", "failed")


def _utcnow() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def _report_path() -> Path:
    report_dir = Path(__file__).resolve().parents[1] / "reports"
    report_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return report_dir / f"selfhosted-blocked-cleanup-{stamp}.json"


def _candidates() -> list[dict]:
    marks = ",".join("?" for _ in TARGET_STATUSES)
    with db.connect() as conn:
        rows = conn.execute(
            f"""
            SELECT *
            FROM posts
            WHERE channel = 'selfhosted'
              AND status IN ({marks})
            ORDER BY updated_at, id
            """,
            TARGET_STATUSES,
        ).fetchall()

    candidates: list[dict] = []
    for row in rows:
        blockers = publish_blockers(row)
        last_error = row["last_error"] or ""
        if blockers or "발행 전 품질 게이트 차단" in last_error or "본문 과다" in last_error:
            candidates.append({
                "id": int(row["id"]),
                "status": row["status"],
                "topic": row["topic"] or row["title"] or "",
                "title": row["title"] or row["topic"] or "",
                "body_chars": len(row["body"] or ""),
                "last_error": last_error,
                "blockers": blockers,
            })
    return candidates


def run() -> bool:
    candidates = _candidates()
    queued_ids = [item["id"] for item in candidates if item["status"] == "queued"]
    terminal_ids = [
        item["id"]
        for item in candidates
        if item["status"] in {"needs_human", "failed"}
    ]
    reason = "cleanup_selfhosted_publish_blockers"
    quarantined = db.quarantine_posts(queued_ids, reason)
    archived = db.archive_posts(terminal_ids, reason)
    report = {
        "ok": True,
        "generated_at": _utcnow(),
        "matched": len(candidates),
        "quarantined": quarantined,
        "archived": archived,
        "candidates": candidates,
    }
    path = _report_path()
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    print(f"report={path}")
    return True


if __name__ == "__main__":
    import sys

    raise SystemExit(0 if run() else 1)
