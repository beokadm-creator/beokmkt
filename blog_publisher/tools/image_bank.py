"""
브랜드 이미지 뱅크.

이미지는 직접 다운로드하지 않고 원본 공개 경로를 참조한다.
블로그 본문 H2 섹션마다 컨텍스트에 맞는 이미지를 자동 삽입.
"""
from __future__ import annotations

import hashlib
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

_HONG_PORTFOLIO_URLS: list[str] = [
    "https://hongcomm.kr/data/file/portfolio/thumb-1893359140_d5enziOm_87302a566d3ee90c05f2bbd089925995547392a7_640x400.jpg",
    "https://hongcomm.kr/data/file/portfolio/thumb-1893359140_cEz0pwlo_eca151a6d417ba4c67aa0219d039ee6c844b7558_640x400.jpg",
    "https://hongcomm.kr/data/file/portfolio/thumb-1893359140_xkSPUYRC_2dbfb04bc08a8cc3b048d54482078495ce32bb76_640x400.jpg",
    "https://hongcomm.kr/data/file/portfolio/thumb-1893359140_dY5IKA41_fc0b672c1483e7f7f8e861e5decc6f890a54ac46_640x400.jpg",
    "https://hongcomm.kr/data/file/portfolio/thumb-1846156130_RY0bVlOv_b1245ee9369ce00968fa994e6e66700dd283fa2b_640x400.jpg",
    "https://hongcomm.kr/data/file/portfolio/thumb-1930951907_Xyzixkop_bf0edc10dbefefb051f495809553a7482d47a3b9_640x400.jpg",
    "https://hongcomm.kr/data/file/portfolio/thumb-2041025217_9fhzVstC_5ecc46e423b5cbf773e6222712f5326796d1131b_640x400.jpg",
    "https://hongcomm.kr/data/file/portfolio/thumb-2041025217_cAK9SFmk_5dc85838e3f01ed7625059783c347b0b92b73cc8_640x400.jpg",
    "https://hongcomm.kr/data/file/portfolio/thumb-1846156130_jEBfo5OG_953f4cf1ebd45b14b6aa592e184bc2556a5ee0ea_640x400.jpg",
    "https://hongcomm.kr/data/file/portfolio/thumb-1995137011_dIvG0xgy_92490c4aa2bb74408b5fe204f95572501becc4c6_640x400.jpg",
    "https://hongcomm.kr/data/file/portfolio/thumb-32866438_VBOnHq56_e322086c5d298a57fc87fc0307f7df4afddcf352_640x400.jpg",
    "https://hongcomm.kr/data/file/portfolio/thumb-1846156130_gaAFn4Qi_cf2e30c7ae9e8753eff54ebcfd2a0125b7f3cca7_640x400.jpg",
    "https://hongcomm.kr/data/file/portfolio/thumb-1846156130_tcMl5Uzh_01ed48114c1fb09e9061d6182bb9a4d2c3b00e67_640x400.jpg",
    "https://hongcomm.kr/data/file/portfolio/thumb-2041025217_Op7mDZhU_b47e0afcac3579d67448fb226554440842ba8961_640x400.jpg",
    "https://hongcomm.kr/data/file/portfolio/thumb-2469365064_3AF4cCHq_83ae93450c0fbfd7d9452d796fdfd8205924ffec_640x400.jpg",
    "https://hongcomm.kr/data/file/portfolio/thumb-2041025217_lPfAyCku_2210a22486a50906dcb24d123cf49991e3765a08_640x400.jpg",
    "https://hongcomm.kr/data/file/portfolio/thumb-3695957831_PXdeKHNI_f917f1da25a18cb2fb80c76f28803bd44545096f_640x400.jpg",
    "https://hongcomm.kr/data/file/portfolio/thumb-3556421916_0j3Kv4w6_274851d6a87da37c5adb07fa2bca0a54c01416f2_640x400.jpg",
    "https://hongcomm.kr/data/file/portfolio/thumb-2041025217_Koz0bAjs_349349e5cecd1d506927120718168cc4ef785cfc_640x400.jpg",
    "https://hongcomm.kr/data/file/portfolio/thumb-2041025217_gN3v5yfj_561ecfb381e973a809fb7325bebfec89a1b79be4_640x400.jpg",
    "https://hongcomm.kr/data/file/portfolio/thumb-1846156130_Aqpw2E9y_0267479b8fc9d75daf80db14b923ea557138b9fb_640x400.jpg",
    "https://hongcomm.kr/data/file/portfolio/thumb-2041025217_jvGnZR4M_36ea3cb5cbdcb76c65d4237ea8732cc0a296e214_640x400.jpg",
    "https://hongcomm.kr/data/file/portfolio/thumb-2041025217_PwITC6Qv_ac08c70a71c232ae3709f84612b407927885a5dc_640x400.jpg",
    "https://hongcomm.kr/data/file/portfolio/thumb-32866438_PNgmBAMp_8f9f91d9f76ea36d926fce97421671dd0e265580_640x400.jpg",
    "https://hongcomm.kr/data/file/portfolio/thumb-2041025217_92nQ5Xlf_ed6ce67ee16dd8338be451bb5f960a847e7bf3a1_640x400.jpg",
    "https://hongcomm.kr/data/file/portfolio/thumb-2041025217_dqDrUIZ9_d4b1974cfe0c608e9ff20850acb0e9ec82dcc1e6_640x400.jpg",
    "https://hongcomm.kr/data/file/portfolio/thumb-2041025217_6SXZrzRx_9d9d46930a3a3ac9bd6db974c8e96e3fddc6ec70_640x400.jpg",
    "https://hongcomm.kr/data/file/portfolio/thumb-2041025217_qPrU8YzX_8143c2661043ad5af752cc52a988a35625a6c764_640x400.jpg",
    "https://hongcomm.kr/data/file/portfolio/thumb-2041025217_KcemGUIF_87315845035e543902aedabe43a387c990dc3590_640x400.jpg",
    "https://hongcomm.kr/data/file/portfolio/thumb-2041025217_GlQebhaL_22dd36e4ff91fe3ecca6a9d38aec052035ba2860_640x400.jpg",
    "https://hongcomm.kr/data/file/portfolio/thumb-2041025217_E3u94OsL_cb482c6b807f2508d5d5a28dda25bc23f12d9569_640x400.jpg",
    "https://hongcomm.kr/data/file/portfolio/thumb-2041025217_MTfQ1PBg_475c4ee56ee650e731627b735f28fc3a13831ba2_640x400.jpg",
    "https://hongcomm.kr/data/file/portfolio/thumb-2041025217_SGp9UYrZ_fd06bb51c6dbcc2fb5da667153cecccfd57fe37d_640x400.jpg",
    "https://hongcomm.kr/data/file/portfolio/thumb-2041025217_28xPOQCf_783b6c8ec18eebfb3081b7d9afb0591f87a1706c_640x400.jpg",
    "https://hongcomm.kr/data/file/portfolio/thumb-2041025217_pHCmJtWY_ca75f593611ebe1e5d852066ebf1d56a04e1a69a_640x400.jpg",
    "https://hongcomm.kr/data/file/portfolio/thumb-2041025217_eECgmN6P_5f1ddd39ca7063073cc171242dbf1ef4e819bc9b_640x400.jpg",
    "https://hongcomm.kr/data/file/portfolio/thumb-2041025217_UHZtqidg_9ac0e224989a3ecae304e211d55bb99f15172695_640x400.jpg",
    "https://hongcomm.kr/data/file/portfolio/thumb-2041025217_fmPcTMdC_2d05eabb6efef3689bb77d3e9f6453fa22a48cb6_640x400.jpg",
    "https://hongcomm.kr/data/file/portfolio/thumb-2041025217_TVYRbv2Q_172957d5cc4fe2d150d1887da741d0ef599c0092_640x400.jpg",
    "https://hongcomm.kr/data/file/portfolio/thumb-2041025217_UAsdeXqc_dddab48ab08315ae822508ff7ccef6acef5f5229_640x400.jpg",
    "https://hongcomm.kr/data/file/portfolio/thumb-2041025217_jJfFS0oW_2cc6bceacb3cb3c9c6b3218fdc6aec06199a29ef_640x400.jpg",
    "https://hongcomm.kr/data/file/portfolio/thumb-2041025217_zN9LRPXG_329180ebc6c1815daae8c71d1265b4ef21fa6217_640x400.jpg",
    "https://hongcomm.kr/data/file/portfolio/thumb-2041025217_vW301sVY_b37afcf01f42fe6efdf58a7f3363e1b1a2dc3105_640x400.jpg",
    "https://hongcomm.kr/data/file/portfolio/thumb-2041025217_APJcUehy_bc4fe7ca4936fcbd50ebec5fbf7e90b2fb6fb37a_640x400.jpg",
    "https://hongcomm.kr/data/file/portfolio/thumb-2041025217_grTD60Yi_8a555d89ee7822b0261e7bc9401752ed8724ea66_640x400.jpg",
    "https://hongcomm.kr/data/file/portfolio/thumb-2041025217_Lves9kKJ_c1861660394fb40b5eb8fcad1e4a7666726cd6e3_640x400.jpg",
    "https://hongcomm.kr/data/file/portfolio/thumb-2041025217_xR4zU78P_d509c8f43bf559f2b47272bc485dfd20cc44d356_640x400.jpg",
    "https://hongcomm.kr/data/file/portfolio/thumb-2041025217_ILWY4cDP_b30e54ded548139cfdae89f4a19b375b839fff15_640x400.jpg",
]

_HONG_PORTFOLIO_KEYWORDS = {
    "홍커뮤니케이션", "MICE", "포트폴리오", "레퍼런스", "행사", "학회",
    "학술대회", "컨퍼런스", "세미나", "기업", "대학", "국제회의", "운영",
}

_HONG_PORTFOLIO: list[dict] = [
    {
        "url": url,
        "alt": f"홍커뮤니케이션 MICE 포트폴리오 현장 레퍼런스 {idx}",
        "keywords": _HONG_PORTFOLIO_KEYWORDS,
    }
    for idx, url in enumerate(_HONG_PORTFOLIO_URLS, start=1)
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
        "url": "https://beoksolution.com/assets/blog/beok/workflow-card.svg",
        "alt": "비오케이솔루션 홈페이지 운영 흐름 카드",
        "keywords": {"운영", "흐름", "제작", "문의", "개선", "관리", "서비스"},
    },
    {
        "url": "https://beoksolution.com/assets/blog/beok/seo-card.svg",
        "alt": "비오케이솔루션 검색 노출 기본 세팅 카드",
        "keywords": {"SEO", "검색", "노출", "구글", "서치콘솔", "사이트맵", "색인", "메타"},
    },
    {
        "url": "https://beoksolution.com/assets/blog/beok/automation-card.svg",
        "alt": "비오케이솔루션 예약 결제 알림 자동화 카드",
        "keywords": {"예약", "결제", "알림톡", "AI", "자동화", "문의", "응대", "폼"},
    },
    {
        "url": "https://beoksolution.com/assets/blog/beok/checklist-card.svg",
        "alt": "비오케이솔루션 홈페이지 운영 체크리스트 카드",
        "keywords": {"체크리스트", "준비", "주의", "필수", "방법", "단계", "확인", "운영"},
    },
]

_BEOK_CONFERENCE: list[dict] = [
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
    {
        "url": "https://hongcomm.kr/img/page/a1.png",
        "alt": "학술대회 등록 시스템 화면",
        "keywords": {"학회", "학술대회", "등록", "접수", "참가자", "시스템"},
    },
    {
        "url": "https://hongcomm.kr/img/page/6.jpg",
        "alt": "행사 마스터 컨트롤러 통합 운영 시스템",
        "keywords": {"학회", "행사", "운영", "관리", "현장", "시스템"},
    },
]

# ---------------------------------------------------------------------------
# 공개 API
# ---------------------------------------------------------------------------

_SOLUTION_KW = {kw for img in _HONG_SOLUTION for kw in img["keywords"]}
_CONF_KW = {kw for img in (_HONG_CONFERENCE + _HONG_PORTFOLIO) for kw in img["keywords"]}
_BEOK_KW = {kw for img in (_BEOK_BRAND + _BEOK_CONFERENCE) for kw in img["keywords"]}
_BEOK_CONFERENCE_KW = {kw for img in _BEOK_CONFERENCE for kw in img["keywords"]}


def _score(img: dict, text: str) -> int:
    words = set(re.findall(r"[가-힣A-Za-z]+", text))
    return sum(1 for kw in img["keywords"] if kw in words or kw in (text or ""))


def image_urls(value: str | None) -> list[str]:
    """본문 HTML/마크다운에서 이미지 URL을 추출한다."""
    text = str(value or "")
    urls = re.findall(r"<img\b[^>]*\bsrc=[\"']([^\"']+)[\"']", text, flags=re.I)
    urls.extend(re.findall(r"!\[[^\]]*]\(([^)\s]+)\)", text))
    return [url.strip() for url in urls if url.strip()]


def _is_trusted_url(url: str) -> bool:
    return any(host in url for host in ("hongcomm.kr/", "beoksolution.com/"))


def recent_published_image_urls(limit: int = 18, exclude_id: int | None = None) -> set[str]:
    """최근 공개 글 본문 이미지 URL. 발행 직전 대표/본문 이미지 반복 회피용."""
    try:
        from db import db

        params: list[object] = []
        where = "status = 'published'"
        if exclude_id is not None:
            where += " AND id != ?"
            params.append(exclude_id)
        params.append(limit)
        with db.connect() as conn:
            rows = conn.execute(
                f"SELECT body FROM posts WHERE {where} ORDER BY updated_at DESC LIMIT ?",
                params,
            ).fetchall()
    except Exception:  # noqa: BLE001 - 이미지 회피 실패가 발행 자체를 막으면 안 된다.
        return set()

    urls: set[str] = set()
    for row in rows:
        urls.update(image_urls(row["body"]))
    return urls


def pick_image(
    pool: list[dict],
    context_text: str = "",
    used: set[str] | None = None,
    avoid: set[str] | None = None,
    salt: str = "",
) -> dict:
    """pool에서 context_text에 어울리는 이미지를 반환하되 반복을 피하고 salt로 회전한다."""
    if not pool:
        return {}
    used = used or set()
    avoid = avoid or set()
    candidates = [img for img in pool if img["url"] not in used and img["url"] not in avoid]
    if not candidates and avoid:
        candidates = [img for img in pool if img["url"] not in used]
    if not candidates:
        return {}
    scored = [(img, _score(img, context_text)) for img in candidates]
    top_score = max(score for _img, score in scored)
    # 최고점 하나에 매번 고정되면 글 간 대표 이미지가 반복된다.
    # 최고점권(최고점-1 이상)을 후보로 두고 post id/topic salt로 회전한다.
    threshold = max(0, top_score - 1)
    top = sorted([img for img, score in scored if score >= threshold], key=lambda img: img["url"])
    if len(top) == 1:
        return top[0]
    digest = hashlib.sha1(f"{context_text or ''}|{salt or ''}".encode("utf-8")).hexdigest()
    return top[int(digest[:8], 16) % len(top)]


def _is_beok_conference_context(context_text: str = "") -> bool:
    text = context_text or ""
    strong = {"학회", "명찰", "사무국", "참가자"}
    if any(kw in text for kw in strong):
        return True
    # "현장", "출력" 같은 약한 단어만으로는 홈페이지 제작 글에도 오탐된다.
    return False


def featured_image(
    brand_key: str,
    context_text: str = "",
    avoid: set[str] | None = None,
    salt: str = "",
) -> dict:
    """브랜드 대표 이미지. 없으면 {}."""
    if brand_key == "beok":
        if _is_beok_conference_context(context_text):
            return pick_image(_BEOK_CONFERENCE + _HONG_PORTFOLIO, context_text, avoid=avoid, salt=salt)
        return pick_image(_BEOK_BRAND + _HONG_PORTFOLIO, context_text, avoid=avoid, salt=salt)
    if brand_key == "hong":
        pool = _HONG_SOLUTION + _HONG_CONFERENCE + _HONG_PORTFOLIO
        return pick_image(pool, context_text, avoid=avoid, salt=salt)
    return {}


def inject_images(
    body: str,
    brand_key: str = "hong",
    avoid: set[str] | None = None,
    salt: str = "",
) -> str:
    """
    본문 H2 섹션 직후에 브랜드 이미지를 삽입한다.
    hong은 섹션별 컨텍스트 이미지, beok은 실제 공개 자산(로고) 1회를 대표 이미지로 삽입.
    """
    def top_up_minimum(out: list[str], pool: list[dict], used: set[str], minimum: int = 2) -> None:
        current = set(image_urls("\n\n".join(out)))
        used.update(current)
        attempts = 0
        while len([url for url in current if _is_trusted_url(url)]) < minimum and attempts < len(pool) + 4:
            img = pick_image(
                pool,
                body,
                used=used,
                avoid=avoid,
                salt=f"{salt}:minimum:{attempts}",
            )
            attempts += 1
            if not img:
                continue
            url = img["url"]
            if url in current or url in body:
                used.add(url)
                continue
            out.append(f"![{img['alt']}]({url})")
            current.add(url)
            used.add(url)

    if brand_key == "beok":
        blocks = body.split("\n\n")
        out: list[str] = []
        used: set[str] = set()
        inserted = 0
        conference_context = _is_beok_conference_context(body)
        card_pool = (
            _BEOK_CONFERENCE + _HONG_PORTFOLIO
            if conference_context
            else [img for img in _BEOK_BRAND if img["url"].endswith(".svg")] + _HONG_PORTFOLIO
        )
        max_images = min(5 if conference_context else 4, len(card_pool))
        for index, blk in enumerate(blocks):
            out.append(blk)
            if not blk.startswith("## ") or inserted >= max_images:
                continue
            # h2와 첫 문단이 같은 블록이면 현재 블록만 사용한다.
            # 다음 h2까지 섞으면 다음 섹션 키워드가 현재 이미지 선택을 오염시킨다.
            next_text = "" if "\n" in blk else (blocks[index + 1] if index + 1 < len(blocks) else "")
            img = pick_image(card_pool, f"{blk} {next_text}", used=used, avoid=avoid, salt=f"{salt}:{index}")
            if not img or img["url"] in used or img["url"] in body:
                continue
            out.append(f"![{img['alt']}]({img['url']})")
            used.add(img["url"])
            inserted += 1
        if inserted == 0:
            img = featured_image("beok", body, avoid=avoid, salt=salt)
            if img and img["url"] not in body:
                out.insert(0, f"![{img['alt']}]({img['url']})")
        top_up_minimum(out, card_pool, used)
        return "\n\n".join(out)

    blocks = body.split("\n\n")
    out: list[str] = []
    used: set[str] = set()
    pool = _HONG_SOLUTION + _HONG_CONFERENCE + _HONG_PORTFOLIO
    max_images = min(6, len(pool))

    for index, blk in enumerate(blocks):
        out.append(blk)
        if not blk.startswith("## ") or len(used) >= max_images:
            continue

        next_text = blocks[index + 1] if index + 1 < len(blocks) else ""
        section_text = f"{blk} {next_text}"
        img = pick_image(pool, section_text, used=used, avoid=avoid, salt=f"{salt}:{index}")
        if not img or img["url"] in body:
            continue

        out.append(f"![{img['alt']}]({img['url']})")
        used.add(img["url"])

    top_up_minimum(out, pool, used)
    return "\n\n".join(out)
