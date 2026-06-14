"""
발행 스케줄러 — reviewed 재고를 발행 큐에 '시간 분산'으로 넣는다. (기획 03 §3.1~3.2)

안정적 주기 발행의 두 축
  1) 원고 재고 버퍼: reviewed 재고를 항상 일정량 유지(생성이 하루 실패해도 발행은 계속).
  2) 발행 시각 지터 + 허용 시간대: 사람처럼 흩뿌리되 09~21시 같은 윈도우 안에서만.

이 스케줄러는 '하루에 N건'만 큐에 올린다. 실제 발행은 publish 워커가 한다.
"""
from __future__ import annotations

import hashlib
import random
from datetime import datetime, timedelta, timezone

import config
from db import db


def _idem_key(post) -> str:
    raw = f"{post['channel']}|{post['title']}|{post['id']}"
    return hashlib.sha256(raw.encode()).hexdigest()[:32]


def _within_window(run_at_utc: datetime) -> datetime:
    """
    UTC 시각을 발행 허용 시간대(현지 START~END) 안으로 밀어 넣는다.
    윈도우보다 이르면 오늘 START로, 늦으면 다음날 START로 이월.
    윈도우 내 분/지터는 보존한다.
    """
    tz = timezone(timedelta(hours=config.PUBLISH_TZ_OFFSET))
    local = run_at_utc.astimezone(tz)
    start, end = config.PUBLISH_WINDOW_START, config.PUBLISH_WINDOW_END

    if local.hour < start:
        local = local.replace(hour=start, minute=local.minute, second=0, microsecond=0)
    elif local.hour >= end:
        local = (local + timedelta(days=1)).replace(
            hour=start, minute=local.minute, second=0, microsecond=0
        )
    return local.astimezone(timezone.utc)


def run_once() -> int:
    """오늘 이미 큐에 올린/발행한 양을 고려해 부족분만 채운다. 큐잉 건수 반환."""
    already = db.count_by_status("queued") + db.count_by_status("publishing")
    slots = max(0, config.DAILY_PUBLISH_TARGET - already)
    if slots == 0:
        return 0

    reviewed = db.fetch_by_status("reviewed", limit=slots)
    now = datetime.now(timezone.utc)
    queued = 0
    for i, post in enumerate(reviewed):
        # 글 간 간격 + 지터로 분산
        offset_min = random.randint(
            i * config.PUBLISH_SPACING_MIN,
            (i + 1) * config.PUBLISH_SPACING_MIN,
        )
        run_at = _within_window(now + timedelta(minutes=offset_min))
        db.enqueue(post["id"], _idem_key(dict(post)), run_at=run_at)
        queued += 1
    return queued


if __name__ == "__main__":
    n = run_once()
    print(f"[schedule] {n}건 발행 큐 등록")
