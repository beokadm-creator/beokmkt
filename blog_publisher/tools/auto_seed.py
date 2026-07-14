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
    """시드 중복 차단용 topic 정규화 집합.

    published/진행 중 상태는 항상 차단한다. archived는 냉각기간
    (ARCHIVED_TOPIC_RESEED_COOLDOWN_DAYS)이 지나면 차단에서 제외해 재작성
    시드를 허용한다 — archived까지 영구 차단하면 품질 리부트 한 번에
    키워드 풀이 통째로 소진돼 시드가 0이 되고 발행이 멈춘다.
    """
    cooldown = config.ARCHIVED_TOPIC_RESEED_COOLDOWN_DAYS
    with db.connect() as conn:
        if cooldown < 0:
            rows = conn.execute(
                "SELECT topic FROM posts WHERE topic IS NOT NULL"
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT topic FROM posts WHERE topic IS NOT NULL "
                "AND (status != 'archived' OR updated_at >= datetime('now', ?))",
                (f"-{cooldown} days",),
            ).fetchall()
    return {_normalize(r["topic"]) for r in rows}


# AUTO_SEED_REQUIRED_TERMS는 beoksolution/hongcomm 블로그의 주제 일관성(C-Rank 단일
# 분야 집중, 기획 08)을 위한 필터다. 완전히 다른 브랜드/사이트(예: notebook_return)의
# 키워드는 이 용어 목록과 무관하므로 이 필터에서 제외한다.
_FOCUS_GATED_BRANDS = {"beok", "hong", ""}

# 채널별로 시드 가능한 brand_key. beoksolution 채널(selfhosted/naver/tistory)은
# beok/hong 두 브랜드를 함께 발행해 왔으므로 그대로 유지하고, 새 브랜드 채널은
# 자기 브랜드 키만 허용한다(다른 브랜드 콘텐츠가 엉뚱한 채널로 새는 것을 막는다).
_CHANNEL_ALLOWED_BRANDS = {
    # racekra/ncs는 자체 블로그에서만 소량 쇼케이스로 발행한다(외부 채널 금지 —
    # 네이버/티스토리는 beok/hong 주제 일관성을 유지).
    # notebook_return(반품 노트북)은 원래 별도 Firestore 사이트
    # (notebook-return.web.app) 채널로 발행했지만, *.web.app 서브도메인은 검색
    # 권위가 0이라 색인이 사실상 안 된다. 2026-07-02부터 beoksolution.com
    # 블로그(selfhosted)로 통합 발행한다 — 렌더러가 category=notebook_return이면
    # 쿠팡 파트너스 고지·전용 CTA를 자동 삽입하고, 발행 게이트
    # (is_operational_post)도 beok/hong 전용 규칙을 건너뛴다.
    "selfhosted": {"beok", "hong", "racekra", "ncs", "notebook_return"},
    "naver": {"beok", "hong"},
    "tistory": {"beok", "hong"},
    # 빈 집합 = notebook_return 전용 채널 시드 중단(두 사이트 중복 발행 방지).
    "notebook_return": set(),
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


def _inventory_count(channel: str, brand_key: str = "") -> int:
    """channel의 발행 전 재고 수. brand_key를 주면 해당 브랜드(category)만 센다."""
    placeholders = ",".join("?" for _ in INVENTORY_STATUSES)
    where = [
        "channel = ?",
        f"status IN ({placeholders})",
    ]
    params: list = [channel, *INVENTORY_STATUSES]
    if brand_key:
        where.append("category = ?")
        params.append(brand_key)
        with db.connect() as conn:
            row = conn.execute(
                f"SELECT COUNT(*) AS n FROM posts WHERE {' AND '.join(where)}",
                params,
            ).fetchone()
        return int(row["n"])
    brand_filter = (config.AUTO_SEED_BRAND_FILTER or "").strip()
    if brand_filter:
        where.append("category = ?")
        params.append(brand_filter)
    # REQUIRED_TERMS는 beok/hong 브랜드의 주제 일관성 필터다. selfhosted 채널에
    # 함께 발행하는 비게이트 브랜드(notebook_return/racekra/ncs) 글은 이 용어와
    # 무관하므로 category로 통과시킨다(안 그러면 해당 재고를 항상 0으로 잘못
    # 세어 매번 목표치만큼 과다 시드하게 됨).
    if channel in {"selfhosted", "naver", "tistory"} and config.AUTO_SEED_REQUIRED_TERMS:
        like_clause = " OR ".join("topic LIKE ?" for _ in config.AUTO_SEED_REQUIRED_TERMS)
        where.append(
            "((category IS NOT NULL AND category NOT IN ('beok', 'hong', '')) "
            f"OR {like_clause})"
        )
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


def run(channel: str = "selfhosted", max_seeds: int = 3, brand_key: str = "") -> int:
    """
    아직 다루지 않은 키워드에서 최대 max_seeds개의 draft를 생성.
    매 실행마다 후보를 섞고, 같은 틀(앵커) 주제가 한 배치에 몰리지 않게 분산한다.
    brand_key를 주면 해당 브랜드 키워드만 시드한다(run_stock의 비율 배분용).
    반환: 생성된 시드 수.
    """
    if channel in {"naver", "tistory"} and not config.ALLOW_EXTERNAL_AUTO_SEED:
        print(f"  {channel} auto_seed 보류 — ALLOW_EXTERNAL_AUTO_SEED=true 설정 후 재개")
        return 0

    existing = _existing_topics()
    candidates = [
        (topic, content_type, kw_brand)
        for topic, content_type, kw_brand in KEYWORDS
        if (not brand_key or kw_brand == brand_key)
        and _brand_allowed_for_channel(channel, kw_brand)
        and _matches_focus(topic, kw_brand)
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
        elif candidates:
            # 모든 후보가 포화 마커를 포함하면, 마커가 적은 후보 순으로
            # AUTO_SEED_THEME_FALLBACK_MAX개까지만 시드한다. 전량 시드하면
            # 캡이 무력화돼 편중이 오히려 강화된다(반품 노트북 독점 사고).
            fallback_max = max(0, config.AUTO_SEED_THEME_FALLBACK_MAX)
            print(
                f"  테마 편중 경고: {saturated} 외 후보 없음 — "
                f"이번 배치는 최대 {fallback_max}건만 시드(캡 우회 방지)"
            )
            candidates = sorted(
                candidates,
                key=lambda c: sum(1 for marker in saturated if marker in c[0]),
            )
            max_seeds = min(max_seeds, fallback_max)

    chosen = _select_spread(candidates, max_seeds)

    created = 0
    for topic, content_type, kw_brand in chosen:
        pid = db.insert_draft(
            channel=channel,
            topic=topic,
            content_type=content_type,
            category=kw_brand,   # 브랜드 구분자로 사용
        )
        print(f"  시드 생성: id={pid} [{kw_brand}] ({content_type}) {topic!r}")
        created += 1

    if created == 0:
        print("  새 키워드 없음 — 모든 키워드가 이미 DB에 있거나 keyword_bank에 추가 필요.")
    return created


def run_stock(channel: str = "selfhosted", target: int | None = None) -> int:
    """
    발행 전 재고(draft~reviewed)가 목표 미만이면 부족분만 시드한다.
    queued는 이미 발행 예약으로 빠져나간 물량이므로 새 재고 계산에서 제외한다.

    SEED_BRAND_RATIOS가 있으면 목표 재고를 브랜드별로 배분해 각각 채운다 —
    채널 총량만 맞추면 잔여 키워드 풀이 큰 브랜드가 발행을 독점한다
    (beok/hong 소진 후 notebook_return이 90%를 차지했던 사고).
    """
    target = target or (config.DAILY_PUBLISH_TARGET * config.STOCK_BUFFER_DAYS)

    ratios = {
        brand: ratio
        for brand, ratio in config.SEED_BRAND_RATIOS.items()
        if _brand_allowed_for_channel(channel, brand)
    }
    if not ratios:
        # 비율 미설정: 과거 동작(채널 총량만 맞춤)
        current = _inventory_count(channel)
        missing = max(0, target - current)
        if missing == 0:
            print(f"  허용 콘텐츠 축 재고 충분: channel={channel} inventory={current} / target={target}")
            return 0
        print(f"  허용 콘텐츠 축 재고 보충 필요: channel={channel} inventory={current} / target={target}, seed={missing}")
        return run(channel=channel, max_seeds=missing)

    ratio_sum = sum(ratios.values())
    created_total = 0
    for brand, ratio in ratios.items():
        brand_target = max(1, round(target * ratio / ratio_sum))
        current = _inventory_count(channel, brand_key=brand)
        missing = max(0, brand_target - current)
        if missing == 0:
            print(
                f"  브랜드 재고 충분: channel={channel} brand={brand} "
                f"inventory={current} / target={brand_target}"
            )
            continue
        print(
            f"  브랜드 재고 보충: channel={channel} brand={brand} "
            f"inventory={current} / target={brand_target}, seed={missing}"
        )
        created_total += run(channel=channel, max_seeds=missing, brand_key=brand)
    return created_total
