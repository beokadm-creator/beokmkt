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


def _matches_focus(post) -> bool:
    brand_filter = (config.AUTO_SEED_BRAND_FILTER or "").strip()
    if brand_filter and post["category"] != brand_filter:
        return False
    # REQUIRED_TERMS는 beoksolution/hongcomm 채널의 주제 일관성 필터다. 다른
    # 브랜드로 명시 태그된 글(예: notebook_return)은 이 용어와 무관하므로 제외한다
    # (그렇지 않으면 스케줄러가 해당 브랜드 글을 영원히 큐에 올리지 못한다).
    category = post["category"] or ""
    if category and category not in {"beok", "hong"}:
        return True
    terms = config.AUTO_SEED_REQUIRED_TERMS
    if not terms:
        return True
    text = f"{post['topic'] or ''} {post['title'] or ''}"
    return any(term in text for term in terms)


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


def _anchor(topic: str) -> str:
    """같은 틀 주제(예: '교육기관 홈페이지…', '명찰 재발행…') 끼리 묶는 키.
    발행 시 연달아 같은 틀이 나가지 않게 분산하는 데 쓴다."""
    raw = topic or ""
    toks = [t for t in raw.split() if t][:2]
    return "".join(ch for ch in "".join(toks).lower() if ch.isalnum() or "가" <= ch <= "힣")


def _queued_anchors() -> set[str]:
    """현재 발행 큐/진행 중인 글의 앵커 집합. 이미 대기 중인 틀은 피해서 섞는다."""
    out: set[str] = set()
    for st in ("queued", "publishing"):
        for r in db.fetch_by_status(st, limit=50):
            out.add(_anchor(r["topic"] if r["topic"] else r["title"]))
    return out


def _select_diverse(candidates: list, n: int, avoid: set[str]) -> list:
    """후보를 앵커별 라운드로빈으로 뽑되, 회피셋(이미 큐에 있는 틀)은 뒤로 미룬다.
    같은 틀의 글이 한 발행 흐름에서 연달아 나가는 것을 막는다."""
    groups: dict[str, list] = {}
    order: list[str] = []
    for c in candidates:
        a = _anchor(c["topic"] if c["topic"] else c["title"])
        if a not in groups:
            groups[a] = []
            order.append(a)
        groups[a].append(c)
    order.sort(key=lambda a: 0 if a not in avoid else 1)  # 새로운 틀 우선
    queues = [list(groups[a]) for a in order]
    out: list = []
    while len(out) < n:
        progressed = False
        for q in queues:
            if len(out) >= n:
                break
            if q:
                out.append(q.pop(0))
                progressed = True
        if not progressed:
            break  # 후보 소진
    return out


def run_once() -> int:
    """오늘 이미 큐에 올린/발행한 양을 고려해 부족분만 채운다. 큐잉 건수 반환."""
    already = db.count_by_status("queued") + db.count_by_status("publishing")
    slots = max(0, config.DAILY_PUBLISH_TARGET - already)
    if slots == 0:
        return 0

    # 다양성: 여유분까지 후보를 뽑아 앵커별로 분산 선택한다.
    pool = db.fetch_by_status("reviewed", limit=max(slots * 4, slots + 8))
    candidates = [p for p in pool if _matches_focus(p)]
    avoid = _queued_anchors()
    chosen = _select_diverse(candidates, slots, avoid)

    now = datetime.now(timezone.utc)
    queued = 0
    for i, post in enumerate(chosen):
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
