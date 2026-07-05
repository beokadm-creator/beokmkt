"""
네이버 수기 발행 원고 전용 품질 게이트 (기획 14 §3.4).

기존 게이트(grounding/filler/markdown/유사도)를 재사용하고, 네이버 특성에 맞는
신규 검사를 더한다. 미달이면 humanize부터 재시도한다 — 억지 발행하지 않는다.

설계 원칙(advisor 반영): 사진 슬롯 '개수'는 하드 게이트가 아니다(사용자가 사진을
직접 넣으므로 위치 힌트일 뿐). 대신 사실성·문체·과최적화만 강하게 막는다.
"""
from __future__ import annotations

import re

import config
from utils import markdown_guard
from utils import text as text_utils

# 1인칭 경험 표지(D.I.A.+ 경험 신호). 최소 개수 이상이어야 "사람이 쓴 글".
_EXPERIENCE_MARKERS = (
    "직접", "제가", "저는", "저희", "현장에서", "해보니", "해 보니", "하더라고",
    "했어요", "봤어요", "느꼈", "겪", "경험", "실제로",
)

# 실제 학회/단체 실명 리스크 패턴(허구 사례 방지). "○○학회/대학교/재단/협회" 형태.
_REAL_ORG_RE = re.compile(
    r"(?:대한|한국|국제|세계|아시아)\s?[가-힣]{1,10}(?:학회|학술원|협회|재단|연구회)"
)

# 네이버 본문에 남으면 안 되는 마크다운/HTML 흔적(붙여넣기 사고 방지).
_MARKDOWN_TABLE_RE = re.compile(r"\|\s*:?-{3,}:?\s*\|")


def _visible_len(body_md: str) -> int:
    # 사진 슬롯 마커는 본문 길이 계산에서 제외(실제 붙여넣기 텍스트가 아님)
    without_slots = re.sub(r"\[사진:[^\]]*\]", "", body_md)
    return text_utils.visible_len(without_slots)


def _keyword_count(body_md: str, primary_keyword: str) -> int:
    if not primary_keyword:
        return 0
    return body_md.count(primary_keyword)


def _experience_hits(body_md: str) -> int:
    return sum(1 for m in _EXPERIENCE_MARKERS if m in body_md)


def _photo_slots(body_md: str) -> int:
    return len(re.findall(r"\[사진:[^\]]*\]", body_md))


def _external_links(body_md: str) -> list[str]:
    urls = re.findall(r"https?://[^\s)\]]+", body_md)
    # beoksolution.com 1회는 허용(맺음 CTA). 그 외 도메인은 위반.
    return [u for u in urls if "beoksolution.com" not in u]


def _long_paragraph_ratio(body_md: str) -> float:
    """3문장 초과 문단 비율(모바일 리듬). 너무 높으면 보고서체."""
    paras = [p.strip() for p in body_md.split("\n\n") if p.strip()]
    body_paras = [
        p for p in paras
        if not p.startswith("#") and not p.startswith("[사진:") and not p.startswith("- ")
    ]
    if not body_paras:
        return 0.0
    long_count = sum(1 for p in body_paras if len(re.findall(r"[.!?…]", p)) > 3)
    return long_count / len(body_paras)


def evaluate(
    *,
    title: str,
    body_md: str,
    primary_keyword: str,
    grounding: float,
    local_unsupported: list[str],
) -> dict:
    """네이버 수기 원고를 검사한다. 반환: {ok, issues, metrics}."""
    issues: list[str] = []
    vlen = _visible_len(body_md)
    kw_count = _keyword_count(body_md, primary_keyword)
    exp_hits = _experience_hits(body_md)
    slots = _photo_slots(body_md)
    ext_links = _external_links(body_md)
    long_ratio = _long_paragraph_ratio(body_md)
    filler = text_utils.filler_density(body_md)

    # 1) 사실성 — 최우선.
    # 하드 조작(근거 없는 수치·고유명사)은 local_unsupported가 결정론적으로 막는다.
    # LLM grounding은 서사 색채까지 감점하므로 경험담용 완화 기준을 쓴다(기획 14 §1.1).
    if grounding < config.NAVER_MANUAL_MIN_GROUNDING:
        issues.append(f"grounding {grounding:.2f} < {config.NAVER_MANUAL_MIN_GROUNDING} "
                      "(humanize가 사실을 왜곡했을 수 있음)")
    if local_unsupported:
        issues.append(f"근거 없는 구체 주장 {len(local_unsupported)}건: {local_unsupported[:3]}")

    # 2) 붙여넣기 안전 — 마크다운/HTML 흔적
    if markdown_guard.has_html_tags(body_md):
        issues.append(f"HTML 태그 혼입: {markdown_guard.find_html_tags(body_md)[:3]}")
    if _MARKDOWN_TABLE_RE.search(body_md):
        issues.append("마크다운 표 구분선(|---|) 잔재 — 목록으로 풀어야 함")

    # 3) 실명 리스크(허구 사례 방지)
    orgs = _REAL_ORG_RE.findall(body_md)
    if orgs:
        issues.append(f"실제 단체명으로 보이는 표현 {orgs[:3]} — 익명 일반화 필요")

    # 4) 길이 밴드
    if vlen < config.NAVER_MANUAL_MIN_LEN:
        issues.append(f"본문 {vlen}자 < 최소 {config.NAVER_MANUAL_MIN_LEN}")
    elif vlen > config.NAVER_MANUAL_MAX_LEN:
        issues.append(f"본문 {vlen}자 > 최대 {config.NAVER_MANUAL_MAX_LEN}")

    # 5) 제목 — 키워드 포함 + 길이
    if primary_keyword and primary_keyword not in title:
        # 부분 일치도 허용(공백 제거 비교)
        if primary_keyword.replace(" ", "") not in title.replace(" ", ""):
            issues.append(f"제목에 주 키워드('{primary_keyword}') 없음")
    if not (12 <= len(title) <= 40):
        issues.append(f"제목 길이 {len(title)}자 (권장 15~30, 허용 12~40 밖)")

    # 6) 키워드 밀도 — 과최적화 차단
    if primary_keyword:
        if kw_count < config.NAVER_MANUAL_KW_MIN:
            issues.append(f"주 키워드 {kw_count}회 < 최소 {config.NAVER_MANUAL_KW_MIN}")
        elif kw_count > config.NAVER_MANUAL_KW_MAX:
            issues.append(f"주 키워드 {kw_count}회 > 최대 {config.NAVER_MANUAL_KW_MAX} (과최적화)")

    # 7) 경험 신호(D.I.A.+)
    if exp_hits < 3:
        issues.append(f"1인칭 경험 표지 {exp_hits}회 < 3 (보고서체 의심)")

    # 8) 외부 링크
    if ext_links:
        issues.append(f"외부 링크 {len(ext_links)}개 — beoksolution.com 외 금지: {ext_links[:2]}")

    # 9) 문단 리듬
    if long_ratio > 0.20:
        issues.append(f"긴 문단(3문장 초과) 비율 {long_ratio:.0%} > 20%")

    # 10) filler(AI 문어체)
    if filler > 0.6:
        issues.append(f"filler 밀도 {filler:.2f}/1000자 > 0.6")

    metrics = {
        "visible_len": vlen, "keyword_count": kw_count, "experience_hits": exp_hits,
        "photo_slots": slots, "external_links": len(ext_links),
        "long_paragraph_ratio": round(long_ratio, 2), "filler_density": round(filler, 2),
        "grounding": round(grounding, 2),
    }
    return {"ok": not issues, "issues": issues, "metrics": metrics}
