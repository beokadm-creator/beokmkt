"""
브랜드 이미지 뱅크.

이미지는 직접 다운로드하지 않고 원본 공개 경로를 참조한다.
블로그 본문 H2 섹션마다 컨텍스트에 맞는 이미지를 자동 삽입.
"""
from __future__ import annotations

import itertools
import re

# ---------------------------------------------------------------------------
# 이미지 카탈로그
# ---------------------------------------------------------------------------

_HONG_SOLUTION: list[dict] = [
    {
        "url": "https://hongcomm.kr/img/page/a1.png",
        "alt": "홍커뮤니케이션 e-Regi 스마트 행사 등록 시스템 화면",
        "keywords": {"등록", "시스템", "접수", "참가자"},
    },
    {
        "url": "https://hongcomm.kr/img/page/a5.png",
        "alt": "학술대회 온라인 결제 시스템 화면",
        "keywords": {"결제", "온라인", "등록비", "수수료"},
    },
    {
        "url": "https://hongcomm.kr/img/page/b2.png",
        "alt": "모바일 디지털 명찰 시스템 화면",
        "keywords": {"명찰", "디지털", "모바일", "QR"},
    },
    {
        "url": "https://hongcomm.kr/img/page/b1.png",
        "alt": "행사 바우처 발급 시스템 화면",
        "keywords": {"바우처", "쿠폰", "발급"},
    },
    {
        "url": "https://hongcomm.kr/img/page/c1.jpg",
        "alt": "현장 지류 명찰 자동 출력 시스템",
        "keywords": {"명찰", "현장", "출력", "지류"},
    },
    {
        "url": "https://hongcomm.kr/img/page/2.jpg",
        "alt": "고속 명찰 자동 출력 장비 운영 현장",
        "keywords": {"장비", "출력기", "프린터"},
    },
    {
        "url": "https://hongcomm.kr/img/page/6.jpg",
        "alt": "행사 마스터 컨트롤러 통합 운영 시스템",
        "keywords": {"마스터", "컨트롤", "통합", "운영"},
    },
    {
        "url": "https://hongcomm.kr/img/page/3.jpg",
        "alt": "수강 출입 인증 대기 화면",
        "keywords": {"출입", "인증", "입장", "대기"},
    },
    {
        "url": "https://hongcomm.kr/img/page/4.jpg",
        "alt": "수강 출입 인증 완료 화면",
        "keywords": {"인증", "완료", "확인", "출입"},
    },
]

_HONG_CONFERENCE: list[dict] = [
    {
        "url": "https://hongcomm.kr/data/file/portfolio/thumb-1846156130_RY0bVlOv_b1245ee9369ce00968fa994e6e66700dd283fa2b_480x300.jpg",
        "alt": "홍커뮤니케이션 대학교 창학 기념 행사 운영 현장",
        "keywords": {"대학", "기념", "학술", "전야제"},
    },
    {
        "url": "https://hongcomm.kr/data/file/portfolio/thumb-2041025217_9fhzVstC_5ecc46e423b5cbf773e6222712f5326796d1131b_480x300.jpg",
        "alt": "홍커뮤니케이션 대규모 동문 행사 운영 사례",
        "keywords": {"동문", "졸업", "행사", "홈커밍"},
    },
    {
        "url": "https://hongcomm.kr/data/file/portfolio/thumb-1846156130_Aqpw2E9y_0267479b8fc9d75daf80db14b923ea557138b9fb_480x300.jpg",
        "alt": "홍커뮤니케이션 기업 CxO Summit 행사 진행",
        "keywords": {"기업", "CxO", "Summit", "임원"},
    },
    {
        "url": "https://hongcomm.kr/data/file/portfolio/thumb-1846156130_jEBfo5OG_953f4cf1ebd45b14b6aa592e184bc2556a5ee0ea_480x300.jpg",
        "alt": "홍커뮤니케이션 IT 인프라 전략 세미나 운영",
        "keywords": {"IT", "세미나", "기업", "전략"},
    },
    {
        "url": "https://hongcomm.kr/data/file/portfolio/thumb-1846156130_gaAFn4Qi_cf2e30c7ae9e8753eff54ebcfd2a0125b7f3cca7_480x300.jpg",
        "alt": "홍커뮤니케이션 글로벌 기업 그린 서밋 행사",
        "keywords": {"글로벌", "Summit", "파트너", "행사"},
    },
    {
        "url": "https://hongcomm.kr/data/file/portfolio/thumb-1846156130_tcMl5Uzh_01ed48114c1fb09e9061d6182bb9a4d2c3b00e67_480x300.jpg",
        "alt": "홍커뮤니케이션 기업 세일즈 세미나 운영 현장",
        "keywords": {"세일즈", "파트너", "기업", "세미나"},
    },
]

_BEOK_BRAND: list[dict] = [
    {
        "url": "https://beoksolution.com/img/logo.png",
        "alt": "비오케이솔루션 홈페이지 제작 운영 서비스 로고",
        "keywords": {
            "홈페이지", "제작", "구독", "운영", "SEO", "예약", "결제",
            "알림톡", "AI", "자동화", "문의폼", "반응형", "서비스",
        },
    },
    {
        "url": "https://beokmkt.web.app/assets/blog/beok/workflow-card.svg",
        "alt": "비오케이솔루션 홈페이지 운영 흐름 카드",
        "keywords": {"운영", "흐름", "제작", "문의", "개선", "관리", "서비스"},
    },
    {
        "url": "https://beokmkt.web.app/assets/blog/beok/seo-card.svg",
        "alt": "비오케이솔루션 검색 노출 기본 세팅 카드",
        "keywords": {"SEO", "검색", "노출", "구글", "서치콘솔", "사이트맵", "색인", "메타"},
    },
    {
        "url": "https://beokmkt.web.app/assets/blog/beok/automation-card.svg",
        "alt": "비오케이솔루션 예약 결제 알림 자동화 카드",
        "keywords": {"예약", "결제", "알림톡", "AI", "자동화", "문의", "응대", "폼"},
    },
    {
        "url": "https://beokmkt.web.app/assets/blog/beok/checklist-card.svg",
        "alt": "비오케이솔루션 홈페이지 운영 체크리스트 카드",
        "keywords": {"체크리스트", "준비", "주의", "필수", "방법", "단계", "확인", "운영"},
    },
]

_BEOK_CONFERENCE: list[dict] = [
    {
        "url": "https://beoksolution.com/img/logo.png",
        "alt": "비오케이솔루션 학회 운영 사무국 명찰 출력 지원 로고",
        "keywords": {"비오케이솔루션", "학회", "명찰", "사무국", "출력", "발행", "접수", "재발행"},
    },
    {
        "url": "https://hongcomm.kr/img/page/b2.png",
        "alt": "학회 현장 모바일 디지털 명찰 시스템 화면",
        "keywords": {"학회", "명찰", "디지털", "모바일", "QR", "바코드", "현장", "체크인"},
    },
    {
        "url": "https://hongcomm.kr/img/page/c1.jpg",
        "alt": "학회 현장 지류 명찰 자동 출력 시스템",
        "keywords": {"학회", "명찰", "현장", "출력", "지류", "재발행", "사무국"},
    },
    {
        "url": "https://hongcomm.kr/img/page/2.jpg",
        "alt": "고속 명찰 자동 출력 장비 운영 현장",
        "keywords": {"학회", "명찰", "장비", "출력기", "프린터", "재발행", "현장"},
    },
]

# ---------------------------------------------------------------------------
# 공개 API
# ---------------------------------------------------------------------------

_SOLUTION_KW = {kw for img in _HONG_SOLUTION for kw in img["keywords"]}
_CONF_KW = {kw for img in _HONG_CONFERENCE for kw in img["keywords"]}
_BEOK_KW = {kw for img in (_BEOK_BRAND + _BEOK_CONFERENCE) for kw in img["keywords"]}
_BEOK_CONFERENCE_KW = {kw for img in _BEOK_CONFERENCE for kw in img["keywords"]}


def _score(img: dict, text: str) -> int:
    words = set(re.findall(r"[가-힣A-Za-z]+", text))
    return sum(1 for kw in img["keywords"] if kw in words or kw in (text or ""))


def pick_image(pool: list[dict], context_text: str = "") -> dict:
    """pool에서 context_text에 가장 어울리는 이미지 반환. 빈 풀이면 {}."""
    if not pool:
        return {}
    scored = sorted(pool, key=lambda img: _score(img, context_text), reverse=True)
    return scored[0]


def _is_beok_conference_context(context_text: str = "") -> bool:
    text = context_text or ""
    strong = {"학회", "명찰", "사무국", "참가자"}
    if any(kw in text for kw in strong):
        return True
    # "현장", "출력" 같은 약한 단어만으로는 홈페이지 제작 글에도 오탐된다.
    return False


def featured_image(brand_key: str, context_text: str = "") -> dict:
    """브랜드 대표 이미지. 없으면 {}."""
    if brand_key == "beok":
        if _is_beok_conference_context(context_text):
            return pick_image(_BEOK_CONFERENCE, context_text)
        return pick_image(_BEOK_BRAND, context_text)
    if brand_key == "hong":
        pool = _HONG_SOLUTION + _HONG_CONFERENCE
        return pick_image(pool, context_text)
    return {}


def inject_images(body: str, brand_key: str = "hong") -> str:
    """
    본문 H2 섹션 직후에 브랜드 이미지를 삽입한다.
    hong은 섹션별 컨텍스트 이미지, beok은 실제 공개 자산(로고) 1회를 대표 이미지로 삽입.
    """
    if brand_key == "beok":
        blocks = body.split("\n\n")
        out: list[str] = []
        used: set[str] = set()
        inserted = 0
        conference_context = _is_beok_conference_context(body)
        card_pool = _BEOK_CONFERENCE if conference_context else [img for img in _BEOK_BRAND if img["url"].endswith(".svg")]
        for index, blk in enumerate(blocks):
            out.append(blk)
            if not blk.startswith("## ") or inserted >= 3:
                continue
            # h2와 첫 문단이 같은 블록이면 현재 블록만 사용한다.
            # 다음 h2까지 섞으면 다음 섹션 키워드가 현재 이미지 선택을 오염시킨다.
            next_text = "" if "\n" in blk else (blocks[index + 1] if index + 1 < len(blocks) else "")
            img = pick_image(card_pool, f"{blk} {next_text}")
            if not img or img["url"] in used or img["url"] in body:
                continue
            out.append(f"![{img['alt']}]({img['url']})")
            used.add(img["url"])
            inserted += 1
        if inserted == 0:
            img = featured_image("beok", body)
            if img and img["url"] not in body:
                out.insert(0, f"![{img['alt']}]({img['url']})")
        return "\n\n".join(out)

    solution_cycle = itertools.cycle(_HONG_SOLUTION)
    conference_cycle = itertools.cycle(_HONG_CONFERENCE)

    blocks = body.split("\n\n")
    out: list[str] = []

    for blk in blocks:
        out.append(blk)
        if not blk.startswith("## "):
            continue

        # 섹션 제목 + 바로 다음 블록 텍스트로 컨텍스트 판단
        section_text = blk[3:].strip()
        sol_score = sum(1 for kw in _SOLUTION_KW if kw in section_text)
        con_score = sum(1 for kw in _CONF_KW if kw in section_text)

        if sol_score >= con_score:
            img = next(solution_cycle)
        else:
            img = next(conference_cycle)

        out.append(f"![{img['alt']}]({img['url']})")

    return "\n\n".join(out)
