"""
브랜드별 키워드 뱅크.

beoksolution.com / hongcomm.kr 서비스를 검색 유입으로 소개해 문의를 만드는 것이 목적.
각 키워드는 (주제, content_type, channel) 튜플.
"""
from __future__ import annotations

import random

import config

# ---------------------------------------------------------------------------
# 브랜드 메타데이터
# ---------------------------------------------------------------------------
BRANDS: dict[str, dict] = {
    "beok": {
        "name": "비오케이솔루션",
        "url": "https://beoksolution.com",
        "service_summary": (
            "홈페이지 제작, 맞춤형 업무 시스템 개발, 관리자 대시보드, "
            "예약·결제·문자·이메일 API 연동을 다루는 개발 솔루션. "
            "학회·학술대회에서는 참가자 등록, 초록 접수, 결제, QR 체크인, "
            "명찰 출력과 현장 재발행 흐름까지 하나의 운영 데이터로 연결한다."
        ),
        "cta": "카카오톡 상담 또는 beoksolution.com 방문",
        "contact": "카카오톡 채널: 비오케이솔루션",
    },
    "hong": {
        "name": "홍커뮤니케이션",
        "url": "https://hongcomm.kr",
        "service_summary": (
            "국제학술대회·기업행사·전시회 기획 전문 MICE 대행사. "
            "38개국 AI 실시간 동시통역, 학회 홈페이지·논문투고·결제 시스템 포함 "
            "Society Portal Solution 제공. 1,000건 이상 행사 운영 경험."
        ),
        "cta": "홍커뮤니케이션 문의",
        "contact": "TEL: 02-6959-3871~3 / info@hongcomm.kr",
    },
    # 상담 유도가 아니라 실제 상품 구매 결정을 돕는 소비자 콘텐츠(쿠팡 파트너스 제휴).
    # cta/contact는 "문의"가 아니라 "지금 시세 확인" 성격으로 다르게 쓴다.
    "notebook_return": {
        "name": "반품노트북 큐레이션",
        "url": "https://notebook-return.web.app",
        "service_summary": (
            "쿠팡 반품·리퍼 노트북 매물을 등급(최상/상/중/리퍼)과 실시간 가격/재고로 "
            "큐레이션하는 사이트. 삼성·LG·HP·레노버 등 브랜드별 반품마켓 직링크와 "
            "SRP 반품배지 매물을 비교해 보여준다."
        ),
        "cta": "지금 시세·재고 확인하기",
        "contact": "",
    },
}

# 쿠팡 파트너스 활동 고지(공정위 표시광고법 대응, 반드시 본문에 포함).
NOTEBOOK_RETURN_DISCLOSURE = (
    "이 포스팅은 쿠팡 파트너스 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받습니다."
)

# ---------------------------------------------------------------------------
# 키워드 목록 (주제, content_type, brand_key)
# ---------------------------------------------------------------------------
KEYWORDS: list[tuple[str, str, str]] = [
    # ── beoksolution.com 핵심 서비스: 운영형 홈페이지 구축 ───────────────
    ("초기 제작비 0원 홈페이지 구독 서비스가 맞는 사업자 유형", "niche", "beok"),
    ("월 5만원 홈페이지 제작 운영에서 서버 SSL SEO까지 포함해야 하는 이유", "howto", "beok"),
    ("예약 결제 알림톡 관리자 페이지까지 확장하는 운영형 홈페이지 설계", "howto", "beok"),
    ("홈페이지 제작 후 Search Console과 기본 SEO를 먼저 세팅해야 하는 이유", "howto", "beok"),
    ("AI 상담 콘텐츠 견적 보조를 홈페이지 운영에 연결하는 방법", "howto", "beok"),
    ("학회 기관 홈페이지 솔루션에서 회원 행사 자료실 결제를 함께 설계하는 기준", "howto", "beok"),

    # ── 복합 우선 주제: MICE/학술대회 운영 × 홈페이지/시스템 개발 ─────────
    ("학술대회 홈페이지 구축 시 등록 결제 초록 접수 명찰 출력까지 함께 설계하는 방법", "howto", "beok"),
    ("MICE 행사 등록 시스템 구축 체크리스트 홈페이지 관리자 QR 체크인 명찰 연동", "howto", "beok"),
    ("학회 사무국 참가자 관리 시스템 설계 초록 접수 결제 명찰 데이터 연결", "howto", "beok"),
    ("홍커뮤니케이션 MICE 운영 사례로 보는 학술대회 IT 시스템 구성", "niche", "hong"),
    ("국제학술대회 AI 동시통역과 참가자 등록 시스템을 함께 준비하는 방법", "howto", "hong"),
    ("학회 명찰 출력 문제를 줄이는 등록 페이지 데이터 구조 설계", "howto", "beok"),
    ("MICE 대행사와 개발사가 함께 봐야 할 행사 홈페이지 요구사항", "niche", "hong"),
    ("국제회의 참가자 등록 결제 QR 체크인 관리자 대시보드 구축 기준", "howto", "beok"),
    ("학회 초록 접수 심사 발표 확정까지 운영하는 관리자 시스템 설계", "howto", "beok"),
    ("학술대회 사무국 업무를 줄이는 홈페이지와 백오피스 기능 설계", "howto", "beok"),
    ("홍커뮤니케이션 학술대회 운영 레퍼런스를 시스템 요구사항으로 바꾸는 방법", "niche", "hong"),
    ("학회 홈페이지 제작에서 논문 투고 결제 관리자 권한을 설계하는 기준", "howto", "beok"),
    ("하이브리드 학술대회 운영에 필요한 신청 페이지 통역 안내 체크인 시스템", "howto", "hong"),
    ("행사 등록 엑셀을 관리자 시스템으로 옮길 때 사무국이 확인할 항목", "howto", "beok"),
    ("학술대회 접수대 혼잡을 줄이는 QR 체크인 명찰 출력 운영 설계", "howto", "beok"),
    ("MICE 행사 사후 보고서를 위해 등록 결제 참석 데이터를 남기는 방법", "howto", "hong"),

    # ── beoksolution: 학회 운영 사무국 명찰 출력 발행 ───────────────────
    # 주의: 이 축은 과거 20개 주제가 몰려 블로그 전체가 명찰 글로 도배되는
    # 단조로움의 주 원인이었다(발행 214건 중 명찰 계열 과점). 대표 주제만 남기고
    # 나머지는 다른 서비스 축(홈페이지/시스템/MICE)에 지면을 양보한다.
    ("학회 명찰 출력 전 사무국 데이터 검수 체크리스트", "howto", "beok"),
    ("QR 바코드 명찰 발행 전 사무국이 확인할 항목", "howto", "beok"),
    ("사전등록 현장등록 참가자를 나누는 명찰 운영 방식", "howto", "beok"),
    ("국제학회 영문 이름 소속 명찰 표기 검수 방법", "howto", "beok"),
    ("현장 등록자가 많은 학회 명찰 재발행 대응 방법", "howto", "beok"),
    ("학회 명찰 출력과 접수 시스템을 함께 점검해야 하는 이유", "niche", "beok"),

    # ── beoksolution: 기존 홈페이지 주제(자동 시드 기본값에서는 제외) ───
    ("소상공인 홈페이지 제작 비용 절약하는 방법", "howto", "beok"),
    ("홈페이지 구독 서비스란 무엇인가", "niche", "beok"),
    ("학원 홈페이지 만드는 방법", "howto", "beok"),
    ("병원 홈페이지 제작 업체 고르는 기준", "review", "beok"),
    ("홈페이지 제작 후 유지관리가 중요한 이유", "niche", "beok"),
    ("소규모 사업자 홈페이지 SEO 기초", "howto", "beok"),
    ("예약·결제 연동 홈페이지 만드는 방법", "howto", "beok"),
    ("홈페이지 월 구독 vs 일회성 제작 비교", "review", "beok"),
    ("카카오 알림톡 홈페이지 연동 방법", "howto", "beok"),
    ("AI 자동화 홈페이지 도입 절차", "howto", "beok"),
    ("모바일 반응형 홈페이지가 필요한 이유", "niche", "beok"),
    ("서비스 소개 홈페이지 필수 구성 요소", "howto", "beok"),
    ("Google Search Console 홈페이지 등록 방법", "howto", "beok"),
    ("스타트업 홈페이지 예산 최소화 방법", "howto", "beok"),
    ("홈페이지 없는 사업자가 겪는 문제", "niche", "beok"),
    ("협회·단체 홈페이지 제작 시 고려 사항", "howto", "beok"),
    ("홈페이지 SSL 보안 인증이 필요한 이유", "niche", "beok"),
    ("온라인 신청폼·문의폼 홈페이지에 붙이는 방법", "howto", "beok"),
    ("AI 고객 상담 챗봇 홈페이지 연동 방법", "howto", "beok"),
    ("헤어샵·네일샵 홈페이지 예약 시스템 구축", "howto", "beok"),

    # ── beoksolution: 홈페이지·시스템 개발 서비스 홍보(브랜드 지면 보강) ──
    ("비오케이솔루션 홈페이지 제작 프로세스 상담부터 오픈까지 단계별 정리", "niche", "beok"),
    ("맞춤형 업무 시스템 개발 외주 견적을 받기 전 정리할 요구사항", "howto", "beok"),
    ("관리자 대시보드 개발에서 사업자가 매일 보는 화면을 먼저 정하는 이유", "niche", "beok"),
    ("문자 이메일 알림톡 API 연동 개발 범위와 비용 산정 기준", "howto", "beok"),
    ("엑셀로 운영하던 업무를 웹 시스템으로 옮기는 단계별 로드맵", "howto", "beok"),
    ("홈페이지 리뉴얼 시 기존 검색 노출을 잃지 않는 이전 체크리스트", "howto", "beok"),
    ("쇼핑몰이 아닌 서비스업 결제 페이지 개발에서 확인할 것", "howto", "beok"),
    ("개발사 선정 시 유지보수 계약 범위를 먼저 확인해야 하는 이유", "review", "beok"),
    ("사업 초기 웹사이트와 랜딩페이지 중 무엇부터 만들어야 하나", "review", "beok"),
    ("업무 자동화 개발 사례로 보는 반복 업무 줄이는 방법", "niche", "beok"),

    # ── hongcomm: 솔루션·서비스 홍보(Society Portal / e-Regi / AI 통역) ──
    ("학회 통합 운영 솔루션 Society Portal로 해결되는 사무국 업무", "niche", "hong"),
    ("e-Regi 스마트 행사 등록 시스템 도입 전 확인할 운영 조건", "howto", "hong"),
    ("38개국 AI 실시간 동시통역 서비스가 필요한 행사 유형", "niche", "hong"),
    ("학술대회 대행 견적 문의 전 사무국이 정리할 행사 정보", "howto", "hong"),
    ("1000건 행사 운영 경험에서 나온 국제행사 리스크 관리 기준", "niche", "hong"),
    ("모바일 디지털 명찰 시스템이 기존 종이 명찰과 다른 점", "review", "hong"),
    ("학회 온라인 결제 시스템 도입 시 카드 계좌이체 영수증 처리 기준", "howto", "hong"),
    ("전시회와 학술대회를 함께 여는 행사의 운영 대행 범위", "niche", "hong"),

    # ── hongcomm ─────────────────────────────────────────────────────────
    ("국제학술대회 기획사 선택 방법", "review", "hong"),
    ("MICE 행사 대행사란 무엇인가", "niche", "hong"),
    ("AI 동시통역 서비스 도입 방법", "howto", "hong"),
    ("학술대회 IT 시스템 구축 방법", "howto", "hong"),
    ("기업 컨퍼런스 기획 체크리스트", "howto", "hong"),
    ("국제회의 동시통역 준비 방법", "howto", "hong"),
    ("학회 홈페이지 솔루션 선택 가이드", "review", "hong"),
    ("MICE 산업의 4대 요소 M·I·C·E 완전 정리", "niche", "hong"),
    ("포상여행(인센티브 투어) 기획 단계별 가이드", "howto", "hong"),
    ("온라인 학술대회 운영 방법", "howto", "hong"),
    ("기업 세미나 행사 기획 단계 정리", "howto", "hong"),
    ("전시회 부스 운영 성공 방법", "howto", "hong"),
    ("컨벤션 행사 예산 산정 방법", "howto", "hong"),
    ("글로벌 학술대회 준비 체크리스트", "howto", "hong"),
    ("AI 실시간 통역 서비스 기존 동시통역과 비교", "review", "hong"),
    ("논문 투고 시스템 학회 홈페이지에 구축하는 법", "howto", "hong"),
    ("국제회의 참가자 등록·결제 시스템 구축", "howto", "hong"),
    ("기업 시상식·어워드 행사 기획 방법", "howto", "hong"),
    ("하이브리드 학술대회 운영 방법", "howto", "hong"),
    ("MICE 행사 사후 보고서 작성 방법", "howto", "hong"),

    # ── notebook_return: 쿠팡 반품 노트북 구매 가이드(소비자 콘텐츠, 상담 유도 아님) ──
    ("반품 노트북 등급(최상/상/중/리퍼) 차이와 고르는 기준", "howto", "notebook_return"),
    ("쿠팡 반품마켓 직링크와 SRP 반품배지 차이 이해하기", "niche", "notebook_return"),
    ("반품 노트북과 중고 노트북, 무엇이 다른가", "niche", "notebook_return"),
    ("삼성 갤럭시북·그램 반품 노트북 시세 비교", "review", "notebook_return"),
    ("LG 그램 반품 노트북 싸게 사는 법", "howto", "notebook_return"),
    ("HP 반품 노트북 재고와 가격 확인하는 법", "howto", "notebook_return"),
    ("레노버 씽크패드 반품 노트북 시세 비교", "review", "notebook_return"),
    ("예산 50만원대 반품 노트북 브랜드별 비교", "review", "notebook_return"),
    ("예산 100만원대 반품 노트북 브랜드별 비교", "review", "notebook_return"),
    ("반품 노트북 구매 전 꼭 확인할 체크리스트", "howto", "notebook_return"),
    ("리퍼 노트북 구매 시 주의할 점", "howto", "notebook_return"),
    ("반품 노트북 로켓배송 여부가 구매에 미치는 영향", "niche", "notebook_return"),
    ("사무용·인강용 반품 노트북 고르는 기준", "howto", "notebook_return"),
    ("대학생 자취용 반품 노트북 예산별 추천 기준", "howto", "notebook_return"),
    ("반품 노트북 A/S와 보증 확인하는 방법", "howto", "notebook_return"),
    ("반품 노트북 매물이 자주 바뀌는 이유와 확인 주기", "niche", "notebook_return"),
    ("게이밍 노트북도 반품마켓에서 저렴하게 살 수 있을까", "niche", "notebook_return"),
    ("신제품 대신 반품 노트북을 고려해야 하는 이유", "niche", "notebook_return"),
    ("반품 노트북 가격이 정가 대비 얼마나 저렴한지 확인하는 법", "howto", "notebook_return"),
    ("직장인 재택근무용 반품 노트북 선택 기준", "howto", "notebook_return"),
]

_BASE_KEYWORD_COUNT = len(KEYWORDS)

# ---------------------------------------------------------------------------
# 주제축(pillar) 분류 — 시드/생성/발행 다양성 쿼터의 공통 기준
# ---------------------------------------------------------------------------
# 순서 중요: 구체적 축(badge_ops)을 일반 축(conference_system)보다 먼저 검사한다.
PILLARS: tuple[str, ...] = (
    "notebook_return",     # 반품 노트북 구매 가이드(별도 브랜드)
    "badge_ops",           # 명찰 출력·재발행 운영
    "hong_mice",           # MICE·행사 기획 운영(홍커뮤니케이션)
    "hong_solution",       # 등록/통역/포털 솔루션(홍커뮤니케이션)
    "conference_system",   # 학회 등록·초록·체크인 시스템(비오케이)
    "beok_homepage",       # 홈페이지 제작·운영(비오케이)
    "beok_system",         # 맞춤 업무 시스템·연동 개발(비오케이)
)

_PILLAR_TERMS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("badge_ops", ("명찰",)),
    ("hong_solution", ("동시통역", "통역", "Society Portal", "e-Regi", "논문 투고", "논문투고", "디지털 명찰", "결제 시스템 도입")),
    ("hong_mice", ("MICE", "홍커뮤니케이션", "컨퍼런스", "전시", "포상여행", "인센티브", "세미나", "시상식", "포럼", "총회", "행사 기획", "행사 대행", "대행사", "기획사", "부스")),
    ("conference_system", ("학회", "학술대회", "국제회의", "초록", "심사", "참가자", "체크인", "사무국", "등록 시스템", "등록비", "접수")),
    ("beok_homepage", ("홈페이지", "웹사이트", "랜딩페이지", "SEO", "Search Console", "SSL", "도메인", "반응형", "구독 서비스")),
    ("beok_system", ("시스템", "대시보드", "백오피스", "관리자", "자동화", "연동", "API", "알림톡", "챗봇", "예약", "결제", "데이터")),
)


def pillar_of(topic: str, brand_key: str = "") -> str:
    """주제를 서비스 축으로 분류한다. 시드·생성·발행이 같은 기준을 쓴다."""
    if brand_key == "notebook_return":
        return "notebook_return"
    text = topic or ""
    for pillar, terms in _PILLAR_TERMS:
        if pillar.startswith("hong") and brand_key == "beok":
            continue  # 브랜드가 명시된 경우 상대 브랜드 축으로 새지 않게 한다
        if any(term in text for term in terms):
            return pillar
    if brand_key == "hong":
        return "hong_mice"
    return "beok_homepage"


def _append_unique(topic: str, content_type: str, brand_key: str, seen: set[str]) -> None:
    key = "".join(ch for ch in topic.lower() if ch.isalnum() or "가" <= ch <= "힣")
    if not key or key in seen:
        return
    seen.add(key)
    KEYWORDS.append((topic, content_type, brand_key))


def _expand_operational_keywords() -> None:
    """운영 PC가 topic을 모두 소진하지 않도록 서비스 축별 조합 주제를 확장한다."""
    seen = {
        "".join(ch for ch in topic.lower() if ch.isalnum() or "가" <= ch <= "힣")
        for topic, _ctype, _brand in KEYWORDS
    }
    buckets: dict[str, list[tuple[str, str, str]]] = {
        "homepage": [],
        "system": [],
        "conference": [],
        "mice": [],
    }

    def add(bucket: str, topic: str, content_type: str, brand_key: str) -> None:
        key = "".join(ch for ch in topic.lower() if ch.isalnum() or "가" <= ch <= "힣")
        if not key or key in seen:
            return
        seen.add(key)
        buckets[bucket].append((topic, content_type, brand_key))

    homepage_services = [
        "학원", "병원", "협회", "학회", "교육기관", "B2B 서비스", "전문 서비스업",
        "예약제 매장", "상담형 사업", "지역 기반 사업", "행사 운영사", "단체·기관",
    ]
    homepage_flows = [
        "문의폼과 관리자 확인 화면", "예약 접수와 변경 요청", "결제 확인과 알림톡 안내",
        "자료실과 회원 권한", "검색 노출 기본 세팅", "모바일 신청폼", "상담 전 체크리스트",
        "운영자 대시보드", "고객 데이터 내보내기", "SSL과 도메인 운영",
    ]
    # 템플릿당(앵커당) 양산을 막기 위해 변형은 무작위로 섞고 cap개까지만 만든다.
    # add()가 실제로 새 항목을 추가한 경우에만 카운트(중복 스킵 고려).
    cap = max(1, config.SEED_MAX_PER_ANCHOR)

    for service in homepage_services:
        flows = list(homepage_flows); random.shuffle(flows)
        made = 0
        for flow in flows:
            if made >= cap: break
            n0 = len(buckets["homepage"])
            add("homepage", f"{service} 홈페이지 제작에서 {flow} 항목을 먼저 설계하는 기준", "howto", "beok")
            if len(buckets["homepage"]) > n0: made += 1

    system_domains = [
        "참가자 등록", "초록 접수", "심사 배정", "등록비 결제", "현장 체크인",
        "사후 보고", "회원 관리", "문의 응대", "자료 제출",
        "권한 관리", "데이터 정산",
    ]
    system_decisions = [
        "관리자 권한을 나누는 방법", "엑셀 업무를 줄이는 화면 설계",
        "상태값을 정리하는 기준", "검색과 필터를 먼저 정해야 하는 이유",
        "알림톡과 이메일 발송 기준", "API 연동 전에 확인할 항목",
        "운영 로그를 남기는 기준", "담당자 인수인계를 쉽게 하는 구조",
    ]
    for domain in system_domains:
        decisions = list(system_decisions); random.shuffle(decisions)
        made = 0
        for decision in decisions:
            if made >= cap: break
            n0 = len(buckets["system"])
            add("system", f"{domain} 시스템 개발에서 {decision}", "howto", "beok")
            if len(buckets["system"]) > n0: made += 1

    conference_ops = [
        "사전등록", "현장등록", "초록 접수", "발표자 관리", "좌장·연자 표기",
        "QR 체크인", "등록비 확인", "참가자 안내",
        "세션 참석 확인", "행사 후 데이터 정리",
    ]
    conference_contexts = [
        "학회 사무국이 행사 전 확인할 체크리스트", "학술대회 홈페이지와 연결하는 방법",
        "접수대 혼잡을 줄이는 운영 기준", "관리자 화면에 꼭 필요한 항목",
        "홍커뮤니케이션 MICE 운영 관점에서 보는 준비 기준",
        "비오케이솔루션 개발 범위로 정리하는 방법",
    ]
    for op in conference_ops:
        contexts = list(conference_contexts); random.shuffle(contexts)
        made = 0
        for context in contexts:
            if made >= cap: break
            brand = "hong" if "홍커뮤니케이션" in context else "beok"
            n0 = len(buckets["conference"])
            add("conference", f"{op} 운영: {context}", "howto", brand)
            if len(buckets["conference"]) > n0: made += 1

    mice_events = [
        "국제학술대회", "기업 컨퍼런스", "산업 세미나", "전시 부대행사",
        "협회 정기총회", "교육 워크숍", "포럼", "시상식", "하이브리드 행사",
        "해외 연자 초청 행사",
    ]
    mice_services = [
        "등록 페이지", "참가자 안내", "현장 체크인", "통역 안내",
        "세션 운영", "스폰서 노출", "포트폴리오 레퍼런스 정리",
        "운영 사후보고", "클라이언트 커뮤니케이션", "행사 데이터 관리",
    ]
    for event in mice_events:
        services = list(mice_services); random.shuffle(services)
        made = 0
        for service in services:
            if made >= cap: break
            n0 = len(buckets["mice"])
            add("mice", f"홍커뮤니케이션 {event} 운영에서 {service} 항목을 설계하는 기준", "niche", "hong")
            if len(buckets["mice"]) > n0: made += 1

    order = ("homepage", "system", "conference", "mice")
    max_len = max(len(items) for items in buckets.values())
    for idx in range(max_len):
        for bucket in order:
            if idx < len(buckets[bucket]):
                topic, content_type, brand_key = buckets[bucket][idx]
                _append_unique(topic, content_type, brand_key, set())


def _expand_notebook_return_keywords() -> None:
    """반품 노트북(쿠팡 파트너스) 소비자 주제 확장.

    정적 20개만으로는 4시간 주기 stock_seed(10건 목표)가 이틀이면 소진돼
    같은 글이 재생산되거나 시드가 멈춘다. 브랜드×관점, 용도×예산 조합으로
    풀을 넓히되 앵커당 cap을 걸어 템플릿 양산을 막는다."""
    seen = {
        "".join(ch for ch in topic.lower() if ch.isalnum() or "가" <= ch <= "힣")
        for topic, _ctype, _brand in KEYWORDS
    }
    cap = max(1, config.SEED_MAX_PER_ANCHOR)
    out: list[tuple[str, str, str]] = []

    def add(topic: str, content_type: str) -> bool:
        key = "".join(ch for ch in topic.lower() if ch.isalnum() or "가" <= ch <= "힣")
        if not key or key in seen:
            return False
        seen.add(key)
        out.append((topic, content_type, "notebook_return"))
        return True

    brands = ["삼성", "LG", "HP", "레노버", "델", "에이수스", "MSI", "애플 맥북"]
    brand_angles = [
        ("반품 노트북 등급별 상태 확인 포인트", "howto"),
        ("반품 노트북 정가 대비 할인율 확인하는 법", "howto"),
        ("반품 노트북과 리퍼 제품 보증 차이", "niche"),
        ("반품 노트북 인기 모델 시세 흐름", "review"),
        ("반품 노트북 구매 후 초기 점검 체크리스트", "howto"),
        ("반품 노트북 재고가 풀리는 시점과 확인 주기", "niche"),
    ]
    for brand in brands:
        angles = list(brand_angles); random.shuffle(angles)
        made = 0
        for angle, ctype in angles:
            if made >= cap:
                break
            if add(f"{brand} {angle}", ctype):
                made += 1

    uses = ["대학생 과제용", "직장인 재택근무용", "영상 편집용", "개발 공부용",
            "사무용 세컨드", "아이 온라인 수업용", "휴대용 서브", "게이밍 입문용"]
    use_angles = [
        ("반품 노트북 고르는 스펙 기준", "howto"),
        ("반품 노트북 예산별 추천 기준", "review"),
        ("반품 노트북에서 확인할 필수 옵션", "howto"),
        ("신품 대신 반품 노트북이 유리한 이유", "niche"),
    ]
    for use in uses:
        angles = list(use_angles); random.shuffle(angles)
        made = 0
        for angle, ctype in angles:
            if made >= cap:
                break
            if add(f"{use} {angle}", ctype):
                made += 1

    KEYWORDS.extend(out)


_expand_operational_keywords()
_expand_notebook_return_keywords()
