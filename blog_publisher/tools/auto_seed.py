"""
자동 시드 생성기.

keyword_bank.py의 키워드 목록에서 아직 DB에 없는 주제를 골라
draft 시드를 자동으로 생성한다.

cron 예시:
  0 */6 * * *  cd /path && python3 run.py auto_seed
"""
from __future__ import annotations

import random
import re

import config
from db import db
from tools.keyword_bank import KEYWORDS, pillar_of

INVENTORY_STATUSES = (
    "draft",
    "generating",
    "factchecking",
    "reviewing",
    "reviewed",
)


def _normalize(text: str) -> str:
    """비교용 정규화 — 공백·특수문자 제거, 소문자."""
    return re.sub(r"[^가-힣a-z0-9]", "", text.lower())


def _existing_topics() -> set[str]:
    """DB에 있는 모든 topic의 정규화 집합."""
    with db.connect() as conn:
        rows = conn.execute("SELECT topic FROM posts WHERE topic IS NOT NULL").fetchall()
    return {_normalize(r["topic"]) for r in rows}


# AUTO_SEED_REQUIRED_TERMS는 beoksolution/hongcomm 블로그의 주제 일관성(C-Rank 단일
# 분야 집중, 기획 08)을 위한 필터다. 완전히 다른 브랜드/사이트(예: notebook_return)의
# 키워드는 이 용어 목록과 무관하므로 이 필터에서 제외한다.
_FOCUS_GATED_BRANDS = {"beok", "hong", ""}

# 채널별로 시드 가능한 brand_key. beoksolution 채널(selfhosted/naver/tistory)은
# beok/hong 두 브랜드를 함께 발행해 왔으므로 그대로 유지하고, 새 브랜드 채널은
# 자기 브랜드 키만 허용한다(다른 브랜드 콘텐츠가 엉뚱한 채널로 새는 것을 막는다).
_CHANNEL_ALLOWED_BRANDS = {
    "selfhosted": {"beok", "hong"},
    "naver": {"beok", "hong"},
    "tistory": {"beok", "hong"},
}


def _brand_allowed_for_channel(channel: str, brand_key: str) -> bool:
    allowed = _CHANNEL_ALLOWED_BRANDS.get(channel)
    if allowed is not None:
        return brand_key in allowed
    return brand_key == channel


def _matches_focus(topic: str = "", brand_key: str = "") -> bool:
    brand_filter = (config.AUTO_SEED_BRAND_FILTER or "").strip()
    if brand_filter and brand_key != brand_filter:
        return False
    if brand_key not in _FOCUS_GATED_BRANDS:
        return True
    terms = config.AUTO_SEED_REQUIRED_TERMS
    if not terms:
        return True
    return any(term in (topic or "") for term in terms)


def _inventory_count(channel: str) -> int:
    placeholders = ",".join("?" for _ in INVENTORY_STATUSES)
    where = [
        "channel = ?",
        f"status IN ({placeholders})",
    ]
    params: list = [channel, *INVENTORY_STATUSES]
    brand_filter = (config.AUTO_SEED_BRAND_FILTER or "").strip()
    if brand_filter:
        where.append("category = ?")
        params.append(brand_filter)
    # REQUIRED_TERMS는 beoksolution/hongcomm 원 채널의 주제 일관성 필터다.
    # 다른 브랜드용 채널(예: notebook_return)의 재고 집계에는 적용하지 않는다
    # (적용하면 실제 재고를 항상 0으로 잘못 세어 매번 목표치만큼 과다 시드하게 됨).
    if channel in {"selfhosted", "naver", "tistory"} and config.AUTO_SEED_REQUIRED_TERMS:
        where.append(f"({' OR '.join(['topic LIKE ?' for _ in config.AUTO_SEED_REQUIRED_TERMS])})")
        params.extend(f"%{term}%" for term in config.AUTO_SEED_REQUIRED_TERMS)
    with db.connect() as conn:
        row = conn.execute(
            f"""
            SELECT COUNT(*) AS n
            FROM posts
            WHERE {' AND '.join(where)}
            """,
            params,
        ).fetchone()
    return int(row["n"])


def _anchor(topic: str) -> str:
    """같은 틀 주제(예: '교육기관 홈페이지…', '명찰 재발행…') 끼리 묶는 키.
    앞 2단어를 정규화해 사용 — 한 배치에서 같은 앵커가 몰리지 않게 한다."""
    toks = [t for t in (topic or "").split() if t]
    return _normalize("".join(toks[:2]))


def _recent_topics(limit: int) -> list[str]:
    """channel 무관, 최근 갱신된 topic 목록(테마 편중 판단용)."""
    with db.connect() as conn:
        rows = conn.execute(
            "SELECT topic FROM posts WHERE topic IS NOT NULL "
            "ORDER BY updated_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return [r["topic"] for r in rows]


def _saturated_markers(recent: list[str]) -> set[str]:
    """최근 재고에서 이미 상한 비율 이상을 차지한 테마 마커 집합."""
    if not recent:
        return set()
    saturated = set()
    for marker in config.AUTO_SEED_THEME_MARKERS:
        ratio = sum(1 for t in recent if marker in t) / len(recent)
        if ratio >= config.AUTO_SEED_THEME_CAP_RATIO:
            saturated.add(marker)
    return saturated


def _select_spread(candidates: list, max_seeds: int) -> list:
    """후보를 주제축(pillar)→앵커 2단계로 그룹화한 뒤 라운드로빈으로 뽑는다.

    1단계(pillar): 한 배치가 홈페이지/시스템/학회/MICE/솔루션 축을 고르게 돌게 한다
    — 같은 축(예: 명찰 운영)이 배치를 독점하는 것을 구조적으로 차단.
    2단계(anchor): 같은 축 안에서도 같은 틀 주제가 연달아 들어가지 않게 한다."""
    pillar_groups: dict[str, dict[str, list]] = {}
    pillar_order: list[str] = []
    for c in candidates:
        p = pillar_of(c[0], c[2])
        a = _anchor(c[0])
        if p not in pillar_groups:
            pillar_groups[p] = {}
            pillar_order.append(p)
        pillar_groups[p].setdefault(a, []).append(c)

    # pillar별 앵커 라운드로빈 큐를 만든다
    pillar_queues: dict[str, list] = {}
    for p, anchors in pillar_groups.items():
        anchor_queues = [list(q) for q in anchors.values()]
        merged: list = []
        while any(anchor_queues):
            for q in anchor_queues:
                if q:
                    merged.append(q.pop(0))
        pillar_queues[p] = merged

    out: list = []
    while len(out) < max_seeds:
        progressed = False
        for p in pillar_order:
            if len(out) >= max_seeds:
                break
            if pillar_queues[p]:
                out.append(pillar_queues[p].pop(0))
                progressed = True
        if not progressed:
            break  # 모든 큐 소진
    return out


def run(channel: str = "selfhosted", max_seeds: int = 3) -> int:
    """
    아직 다루지 않은 키워드에서 최대 max_seeds개의 draft를 생성.
    매 실행마다 후보를 섞고, 같은 틀(앵커) 주제가 한 배치에 몰리지 않게 분산한다.
    반환: 생성된 시드 수.
    """
    if channel in {"naver", "tistory"} and not config.ALLOW_EXTERNAL_AUTO_SEED:
        print(f"  {channel} auto_seed 보류 — ALLOW_EXTERNAL_AUTO_SEED=true 설정 후 재개")
        return 0

    existing = _existing_topics()
    candidates = [
        (topic, content_type, brand_key)
        for topic, content_type, brand_key in KEYWORDS
        if _brand_allowed_for_channel(channel, brand_key)
        and _matches_focus(topic, brand_key)
        and _normalize(topic) not in existing
    ]

    random.shuffle(candidates)

    saturated = _saturated_markers(_recent_topics(config.AUTO_SEED_THEME_LOOKBACK))
    if saturated:
        filtered = [
            c for c in candidates
            if not any(marker in c[0] for marker in saturated)
        ]
        if filtered:
            candidates = filtered
        else:
            # 모든 후보가 포화 마커를 포함하면 전면 허용(과거 동작) 대신
            # 포화 마커 포함 개수가 적은 후보부터 쓴다 — 편중이 가장 덜한 쪽 우선.
            print(f"  테마 편중 경고: {saturated} 외 후보 없음 — 편중 마커가 적은 후보 우선 사용")
            candidates = sorted(
                candidates,
                key=lambda c: sum(1 for marker in saturated if marker in c[0]),
            )

    chosen = _select_spread(candidates, max_seeds)

    created = 0
    for topic, content_type, brand_key in chosen:
        pid = db.insert_draft(
            channel=channel,
            topic=topic,
            content_type=content_type,
            category=brand_key,   # 브랜드 구분자로 사용
        )
        print(f"  시드 생성: id={pid} [{brand_key}] ({content_type}) {topic!r}")
        created += 1

    if created == 0:
        print("  새 키워드 없음 — 모든 키워드가 이미 DB에 있거나 keyword_bank에 추가 필요.")
    return created


def run_stock(channel: str = "selfhosted", target: int | None = None) -> int:
    """
    발행 전 재고(draft~reviewed)가 목표 미만이면 부족분만 시드한다.
    queued는 이미 발행 예약으로 빠져나간 물량이므로 새 재고 계산에서 제외한다.
    """
    target = target or (config.DAILY_PUBLISH_TARGET * config.STOCK_BUFFER_DAYS)
    current = _inventory_count(channel)
    missing = max(0, target - current)
    if missing == 0:
        print(f"  허용 콘텐츠 축 재고 충분: channel={channel} inventory={current} / target={target}")
        return 0
    print(f"  허용 콘텐츠 축 재고 보충 필요: channel={channel} inventory={current} / target={target}, seed={missing}")
    return run(channel=channel, max_seeds=missing)
