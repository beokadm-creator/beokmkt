"""
SQLite DB 백업 (감사 J3).

`sqlite3`의 온라인 백업 API로 일관된 스냅샷을 뜬다(WAL 중에도 안전).
오래된 백업은 보관 개수만큼만 유지.

cron 예시:
  0 4 * * *  cd /path && python3 run.py backup
"""
from __future__ import annotations

import shutil
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from db import db

KEEP = 14   # 최근 N개 보관


def run(backup_dir: str | None = None) -> str:
    src = db.DB_PATH
    if not Path(src).exists():
        raise FileNotFoundError(f"DB 없음: {src}")

    out_dir = Path(backup_dir) if backup_dir else Path(src).parent / "backups"
    out_dir.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    dest = out_dir / f"blog-{ts}.db"

    try:
        with sqlite3.connect(src) as s, sqlite3.connect(dest) as d:
            s.backup(d)   # 온라인 백업(락 최소화)
    except sqlite3.OperationalError:
        # 일부 파일시스템에서 .backup이 disk I/O error를 낼 수 있음 → WAL 체크포인트 후 파일 복사
        try:
            with sqlite3.connect(src) as s:
                s.execute("PRAGMA wal_checkpoint(TRUNCATE);")
        except sqlite3.OperationalError:
            pass
        shutil.copy2(src, dest)

    # 오래된 백업 정리
    backups = sorted(out_dir.glob("blog-*.db"))
    for old in backups[:-KEEP]:
        old.unlink(missing_ok=True)

    return str(dest)


if __name__ == "__main__":
    print(run())
