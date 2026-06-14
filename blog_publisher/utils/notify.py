"""
알림 모듈 (기획 03 §3.3).

- 기본은 콘솔 출력. NOTIFY_WEBHOOK_URL이 있으면 슬랙 등 incoming webhook으로도 전송.
- 레벨 필터(NOTIFY_MIN_LEVEL)로 소음 조절.
- 네트워크 실패가 워커를 죽이면 안 되므로 알림 오류는 삼킨다.
"""
from __future__ import annotations

import config

_LEVELS = {"info": 10, "warn": 20, "error": 30}


def notify(message: str, level: str = "warn") -> None:
    if _LEVELS.get(level, 20) < _LEVELS.get(config.NOTIFY_MIN_LEVEL, 20):
        return

    line = f"[{level.upper()}] {message}"
    print(line)

    url = config.NOTIFY_WEBHOOK_URL
    if not url:
        return
    try:
        import requests

        requests.post(url, json={"text": line}, timeout=10)
    except Exception as e:  # noqa: BLE001  알림 실패가 본작업을 막지 않게
        print(f"[notify] webhook 전송 실패(무시): {e}")
