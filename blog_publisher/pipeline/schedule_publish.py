"""
발행 스케줄러 — reviewed 재고를 발행 큐에 '시간 분산'으로 넣는다. (기획 03 §3.1~3.2)

안정적 주기 발행의 두 축
  1) 원고 재고 버퍼: reviewed 재고를 항상 일정량 유지(생성이 하루 실패해도 발행은 계속).
  2) 발행 시각 지터 + 허용 시간대: 사람처럼 흩뿌리되 09~21시 같은 윈도우 안에서만.

이 스케줄러는 발행 큐 깊이(queued+publishing)를 DAILY_PUBLISH_TARGET까지 채운다.
"오늘 발행분"을 상한에 세지 않는 것은 여전히 의도다(일일 상한 방식 금지 —
재고 적체 시 물량이 조용히 죽는 회귀가 있었다). 물량 조절은 일일 상한이 아니라
**발행 흐름 간격**으로 한다.

[2026-07-19 결정 — 흐름 간격 보장] 종전에는 보충 배치마다 offset을 now 기준
i*SPACING부터 다시 계산해, SPACING이 "배치 안 간격"일 뿐 발행 흐름 전체 간격을
보장하지 않았다(첫 슬롯 0~SPACING 랜덤 → 실효 간격 평균 SPACING/2 수준 →
실측 13~26건/일). 색인 진단(사이트 단위 scaled-content 억제, sitemap 87% 404)
결과 물량이 색인 실패의 핵심 원인으로 확인되어, 사용자 승인下에 offset 기산점을
"현재 큐의 마지막 run_at"으로 옮겼다. 이제 SPACING=150분이 실제 발행 간격이 되고
일일 총량은 윈도우(09~21) / SPACING ≈ 4~5건으로 수렴한다. 2026-07-04의
"물량 유지" 결정은 이 진단으로 대체됐다(당시 감사는 무결성만 봤고 검색엔진
반응은 보지 않았다). 실제 발행 건수 확인은 `tools/status_report.py`를 쓴다.
실제 발행은 publish 워커가 한다(워커 쪽에도 발행 윈도우 가드가 있다).
"""
from __future__ import annotations

import hashlib
import random
from datetime import datetime, timedelta, timezone

import config
from db import db


def _matches_focus(post) -> bool:
    # 네이버 수기 발행 원고는 봇 발행 큐로 절대 새면 안 된다(기획 14).
    # generate_daily가 reviewed를 건너뛰고 바로 awaiting_manual로 보내지만,
    # cron 겹침 등으로 순간 reviewed에 걸려도 스케줄러가 줍지 않게 이중 방어한다.
    if post["channel"] == config.NAVER_MANUAL_CHANNEL:
        return False
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


def _pillar(post) -> str:
    try:
        from tools.keyword_bank import pillar_of
        return pillar_of(post["topic"] or post["title"] or "", post["category"] or "")
    except Exception:  # noqa: BLE001
        return ""


def _select_diverse(candidates: list, n: int, avoid: set[str]) -> list:
    """후보를 주제축(pillar)→앵커 2단계 라운드로빈으로 뽑되, 회피셋(이미 큐에
    있는 틀)은 뒤로 미룬다. 같은 축·같은 틀의 글이 한 발행 흐름에서 연달아
    나가는 것을 막는다."""
    pillar_groups: dict[str, dict[str, list]] = {}
    pillar_order: list[str] = []
    for c in candidates:
        p = _pillar(c)
        a = _anchor(c["topic"] if c["topic"] else c["title"])
        if p not in pillar_groups:
            pillar_groups[p] = {}
            pillar_order.append(p)
        pillar_groups[p].setdefault(a, []).append(c)

    pillar_queues: dict[str, list] = {}
    for p, anchors in pillar_groups.items():
        anchor_order = sorted(anchors, key=lambda a: 0 if a not in avoid else 1)  # 새로운 틀 우선
        anchor_queues = [list(anchors[a]) for a in anchor_order]
        merged: list = []
        while any(anchor_queues):
            for q in anchor_queues:
                if q:
                    merged.append(q.pop(0))
        pillar_queues[p] = merged

    out: list = []
    while len(out) < n:
        progressed = False
        for p in pillar_order:
            if len(out) >= n:
                break
            if pillar_queues[p]:
                out.append(pillar_queues[p].pop(0))
                progressed = True
        if not progressed:
            break  # 후보 소진
    return out


def _pending_run_at_max() -> datetime | None:
    """현재 큐/발행 중 글의 next_run_at 최댓값(UTC). 흐름 간격 기산점.
    저장 형식은 db._iso의 naive UTC 문자열("%Y-%m-%d %H:%M:%S")."""
    latest: datetime | None = None
    for st in ("queued", "publishing"):
        for r in db.fetch_by_status(st, limit=50):
            raw = r["next_run_at"]
            if not raw:
                continue
            try:
                dt = datetime.strptime(str(raw), "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
            except ValueError:
                continue
            if latest is None or dt > latest:
                latest = dt
    return latest


def _today_start_utc() -> datetime:
    """발행 로컬 타임존(PUBLISH_TZ_OFFSET) 기준 오늘 0시의 UTC 시각.
    count_published_since와 함께 status_report 등 텔레메트리 용도로만 쓴다 —
    run_once의 상한 계산에는 넣지 않는다(아래 모듈 docstring 참고)."""
    tz = timezone(timedelta(hours=config.PUBLISH_TZ_OFFSET))
    local_midnight = datetime.now(tz).replace(hour=0, minute=0, second=0, microsecond=0)
    return local_midnight.astimezone(timezone.utc)


def run_once() -> int:
    """현재 큐 깊이(queued+publishing)가 목표 미만이면 부족분만 채운다. 큐잉 건수 반환.
    의도적으로 '오늘 발행분'은 세지 않는다(모듈 docstring 참고 — 2026-07-04 확정)."""
    already = db.count_by_status("queued") + db.count_by_status("publishing")
    slots = max(0, config.DAILY_PUBLISH_TARGET - already)
    if slots == 0:
        return 0

    # 다양성: 여유분까지 후보를 뽑아 앵커별로 분산 선택한다.
    pool = db.fetch_by_status("reviewed", limit=max(slots * 4, slots + 8))
    candidates = [p for p in pool if _matches_focus(p)]
    avoid = _queued_anchors()
    chosen = _select_diverse(candidates, slots, avoid)

    # 흐름 간격 보장(2026-07-19, 모듈 docstring): 기산점은 now가 아니라
    # 현재 큐의 마지막 run_at. 보충 배치가 이전 배치 위에 겹쳐 실효 간격이
    # SPACING보다 짧아지는 것을 막는다.
    now = datetime.now(timezone.utc)
    pending_max = _pending_run_at_max()
    base = max(now, pending_max) if pending_max else now

    spacing = max(0, config.PUBLISH_SPACING_MIN)
    queued = 0
    for i, post in enumerate(chosen):
        # 슬롯 i는 [i*S + S/2, (i+1)*S] 구간 랜덤 → 연속 발행 최소 간격 S/2,
        # 평균 간격 ≈ S. spacing=0(셀프테스트)이면 즉시 발행.
        lo = i * spacing + spacing // 2
        hi = max(lo, (i + 1) * spacing)
        offset_min = random.randint(lo, hi)
        run_at = _within_window(base + timedelta(minutes=offset_min))
        db.enqueue(post["id"], _idem_key(dict(post)), run_at=run_at)
        queued += 1
    return queued


if __name__ == "__main__":
    n = run_once()
    print(f"[schedule] {n}건 발행 큐 등록")
