"""
홍커뮤니케이션(hong) 브랜드 이미지 뱅크.

이미지는 직접 다운로드하지 않고 hongcomm.kr 원본 경로를 참조한다.
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

# ---------------------------------------------------------------------------
# 공개 API
# ---------------------------------------------------------------------------

_SOLUTION_KW = {kw for img in _HONG_SOLUTION for kw in img["keywords"]}
_CONF_KW = {kw for img in _HONG_CONFERENCE for kw in img["keywords"]}


def _score(img: dict, text: str) -> int:
    words = set(re.findall(r"[가-힣A-Za-z]+", text))
    return sum(1 for kw in img["keywords"] if kw in words)


def pick_image(pool: list[dict], context_text: str = "") -> dict:
    """pool에서 context_text에 가장 어울리는 이미지 반환. 빈 풀이면 {}."""
    if not pool:
        return {}
    scored = sorted(pool, key=lambda img: _score(img, context_text), reverse=True)
    return scored[0]


def inject_images(body: str) -> str:
    """
    본문 H2 섹션 직후에 hongcomm.kr 이미지를 삽입한다.
    솔루션/시스템 키워드 섹션 → solution 이미지, 나머지 → conference 이미지.
    """
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
