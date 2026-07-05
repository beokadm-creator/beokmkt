"""
파이프라인 stall(정체) 감지. run-healthcheck.ps1 에서 호출.

출력 계약(healthcheck가 파싱):
  - 항상 첫 줄을 `active=N draft_ready=N stall_hours=N.N` 형태로 출력.
  - 정체 조건(active==0 and draft_ready>0 and stall_hours>6)이면 추가로 `STALL_DETECTED` 출력.

주의: run-healthcheck.ps1 에서 인라인 `python -c @'...'@` heredoc으로 실행하면
PowerShell 5.1이 외부 exe 인자로 넘기며 SQL의 이중따옴표를 삼켜 SyntaxError가 났다.
이 파일을 별도 스크립트로 분리해 그 버그를 회피한다.
"""
from __future__ import annotations

import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(os.environ.get("REPO_ROOT", r"C:\beokmkt"))
DB_PATH = REPO_ROOT / "blog_publisher" / "db" / "blog.db"

STALL_HOURS_THRESHOLD = 6.0


def main() -> None:
    conn = sqlite3.connect(str(DB_PATH))
    try:
        c = conn.cursor()
        c.execute(
            "SELECT COUNT(*) FROM posts "
            "WHERE status='queued' OR status='reviewing' "
            "OR status='reviewed' OR status='publishing'"
        )
        active = c.fetchone()[0]
        c.execute(
            "SELECT COUNT(*) FROM posts "
            "WHERE status='draft' AND (body IS NULL OR body='')"
        )
        draft_ready = c.fetchone()[0]
        c.execute("SELECT MAX(updated_at) FROM posts WHERE status='published'")
        last_pub = c.fetchone()[0]
    finally:
        conn.close()

    # updated_at 은 naive UTC 로 저장되므로 naive UTC 와 비교한다.
    # (datetime.utcnow() 대신 timezone-aware 생성 후 tz 제거 → DeprecationWarning 회피)
    now_utc = datetime.now(timezone.utc).replace(tzinfo=None)
    stall_hours = 0.0
    if last_pub:
        try:
            dt = datetime.strptime(last_pub, "%Y-%m-%d %H:%M:%S")
            stall_hours = (now_utc - dt).total_seconds() / 3600
        except ValueError:
            stall_hours = 0.0

    print(f"active={active} draft_ready={draft_ready} stall_hours={stall_hours:.1f}")
    if active == 0 and draft_ready > 0 and stall_hours > STALL_HOURS_THRESHOLD:
        print("STALL_DETECTED")


if __name__ == "__main__":
    main()
