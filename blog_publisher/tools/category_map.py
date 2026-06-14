"""
검색 최적화용 카테고리 매핑.

두 가지를 제공한다.
1) 자체 블로그/티스토리용 '주제별 세분 카테고리' — topic 키워드 스코어링으로 선택.
2) 네이버 고정 '주제(theme)' — 브랜드 단위 매핑(네이버 검색 분류 신호).

posts.category 필드는 브랜드 키(beok/hong)를 담는다(이미지뱅크·브랜드힌트용).
실제 발행 카테고리는 발행 시점에 topic으로부터 파생한다.
"""
from __future__ import annotations

import re

# ---------------------------------------------------------------------------
# 브랜드별 세분 카테고리 (라벨, 키워드셋). 첫 항목이 기본값.
# ---------------------------------------------------------------------------
_GRANULAR: dict[str, list[tuple[str, set[str]]]] = {
    # '홈페이지'는 거의 모든 beok 주제에 들어가 변별력이 없으므로 제외.
    # 더 구체적인 토큰으로 SEO/AI/예약결제가 제대로 잡히게 한다.
    "beok": [
        ("학회운영", {"학회", "명찰", "사무국", "참가자", "QR", "바코드", "재발행", "출력", "현장"}),
        ("홈페이지제작", {"제작", "사이트", "반응형", "디자인", "구축", "구독", "만들"}),
        ("SEO", {"SEO", "검색", "노출", "search", "console", "키워드", "유입", "상위"}),
        ("AI자동화", {"AI", "자동화", "챗봇", "알림톡", "자동", "봇", "gpt"}),
        ("예약결제", {"예약", "결제", "신청", "문의폼", "폼", "쇼핑", "주문", "장바구니"}),
    ],
    "hong": [
        ("학술대회", {"학술", "학회", "논문", "국제회의", "컨퍼런스", "심포지엄", "포스터"}),
        ("기업행사", {"기업", "세미나", "컨벤션", "시상식", "어워드", "포상", "인센티브", "행사"}),
        ("전시회", {"전시", "부스", "엑스포", "박람회", "쇼"}),
        ("동시통역", {"통역", "동시통역", "번역", "다국어", "언어", "AI통역"}),
    ],
}

# 네이버 고정 주제(theme) — 브랜드 단위.
_NAVER_THEME: dict[str, str] = {
    "beok": "IT·컴퓨터",
    "hong": "비즈니스·경제",
}

_DEFAULT_THEME = "비즈니스·경제"
_DEFAULT_CATEGORY = "일반"


def _tokens(text: str) -> set[str]:
    return set(re.findall(r"[가-힣A-Za-z]+", text or ""))


def pick_category(brand_key: str, topic: str) -> str:
    """brand_key 안에서 topic에 가장 잘 맞는 세분 카테고리 라벨을 반환."""
    table = _GRANULAR.get(brand_key)
    if not table:
        return _DEFAULT_CATEGORY
    words = _tokens(topic)

    def score(item: tuple[str, set[str]]) -> int:
        _label, kws = item
        return sum(1 for kw in kws if kw in words or kw in (topic or ""))

    best = max(table, key=score)
    # 매칭 0이면 해당 브랜드 기본(첫 항목) 사용
    return best[0] if score(best) > 0 else table[0][0]


def naver_theme(brand_key: str) -> str:
    """네이버 발행용 고정 주제(theme)."""
    return _NAVER_THEME.get(brand_key, _DEFAULT_THEME)
