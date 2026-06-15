"""
티스토리 세션 상태 + 워커 health 검사 -> status/health.json 기록.
Cowork 모니터링이 이 파일을 읽어 매일 아침 알림한다.
"""
from __future__ import annotations

import json
import os
import urllib.request
from datetime import datetime, timezone, timedelta
from pathlib import Path

KST = timezone(timedelta(hours=9))

REPO_ROOT = Path(os.environ.get("REPO_ROOT", r"C:\beokmkt"))
STATUS_DIR = Path(os.environ.get("SESSION_STATUS_DIR",
    r"C:\Users\Aaron\Claude\Projects\beokmkt\status"))
SESSION_FILE = REPO_ROOT / r"executors\naver-blog-worker\.session\tistory-session.json"
KEEPALIVE_FILE = STATUS_DIR / "keepalive.json"
HEALTH_FILE = STATUS_DIR / "health.json"
WORKER_URL = os.environ.get("WORKER_URL", "http://127.0.0.1:8788/health")


def check_worker() -> dict:
    try:
        with urllib.request.urlopen(WORKER_URL, timeout=5) as r:
            return json.loads(r.read())
    except Exception as e:
        return {"ok": False, "error": str(e)}


def check_tistory_session() -> dict:
    base: dict = {"session_file": str(SESSION_FILE)}
    if not SESSION_FILE.exists():
        return {**base, "valid": False, "days_to_expiry": None,
                "min_cookie_expiry": None, "session_file_mtime": None}
    try:
        mtime = datetime.fromtimestamp(SESSION_FILE.stat().st_mtime, tz=KST).isoformat()
        data = json.loads(SESSION_FILE.read_text(encoding="utf-8"))
        cookies = data.get("cookies", [])
        expiries = [
            c["expires"] for c in cookies
            if isinstance(c.get("expires"), (int, float)) and c["expires"] > 0
        ]
        if not expiries:
            return {**base, "valid": False, "days_to_expiry": None,
                    "min_cookie_expiry": None, "session_file_mtime": mtime}
        min_exp = min(expiries)
        min_exp_dt = datetime.fromtimestamp(min_exp, tz=KST)
        days = (min_exp_dt - datetime.now(tz=KST)).total_seconds() / 86400
        return {
            **base,
            "valid": days > 0,
            "days_to_expiry": round(days, 2),
            "min_cookie_expiry": min_exp_dt.isoformat(),
            "session_file_mtime": mtime,
        }
    except Exception as e:
        return {**base, "valid": False, "error": str(e),
                "days_to_expiry": None, "min_cookie_expiry": None, "session_file_mtime": None}


def read_keepalive() -> tuple[str | None, bool | None]:
    try:
        data = json.loads(KEEPALIVE_FILE.read_text(encoding="utf-8"))
        return data.get("ran_at"), data.get("ok")
    except Exception:
        return None, None


def main() -> None:
    STATUS_DIR.mkdir(parents=True, exist_ok=True)
    keepalive_last, keepalive_ok = read_keepalive()
    health = {
        "checked_at": datetime.now(tz=KST).isoformat(),
        "worker_health": check_worker(),
        "tistory_session": check_tistory_session(),
        "keepalive_last_run": keepalive_last,
        "keepalive_ok": keepalive_ok,
        "notes": "",
    }
    HEALTH_FILE.write_text(json.dumps(health, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(health, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
