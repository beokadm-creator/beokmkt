"""
브랜드별 키워드 뱅크.

beoksolution.com / hongcomm.kr 서비스를 검색 유입으로 소개해 문의를 만드는 것이 목적.
각 키워드는 (주제, content_type, channel) 튜플.
"""
from __future__ import annotations

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
}

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
    ("학회 명찰 출력 전 사무국 데이터 검수 체크리스트", "howto", "beok"),
    ("학회 운영 사무국 명찰 발행 절차와 현장 접수 기준", "howto", "beok"),
    ("학회 참가자 명단 정리부터 명찰 재발행까지 운영 방법", "howto", "beok"),
    ("학술대회 명찰 제작 시 소속 직책 표기 오류 줄이는 방법", "howto", "beok"),
    ("학회 현장 접수대 명찰 출력 장비와 인력 배치 기준", "howto", "beok"),
    ("QR 바코드 명찰 발행 전 사무국이 확인할 항목", "howto", "beok"),
    ("학회 명찰 재출력 요청 처리 기준과 승인 흐름", "howto", "beok"),
    ("사전등록 현장등록 참가자를 나누는 명찰 운영 방식", "howto", "beok"),
    ("학회 좌장 연자 스태프 명찰 구분 표기 기준", "niche", "beok"),
    ("학회 사무국 명찰 출력 대행 업체 선정 기준", "review", "beok"),
    ("참가자 데이터 엑셀 파일을 명찰 출력용으로 정리하는 방법", "howto", "beok"),
    ("학회 접수 혼잡을 줄이는 명찰 가나다순 분류 방법", "howto", "beok"),
    ("국제학회 영문 이름 소속 명찰 표기 검수 방법", "howto", "beok"),
    ("학회 명찰 목걸이 봉투 배포 동선까지 함께 설계하는 이유", "niche", "beok"),
    ("명찰 출력 후 행사 종료 정산 자료를 남기는 방법", "howto", "beok"),
    ("학회 운영 사무국이 명찰 발행 일정을 역산하는 방법", "howto", "beok"),
    ("참가자 역할 변경이 많은 학회 명찰 운영 리스크", "niche", "beok"),
    ("학회 명찰 출력 샘플 검수에서 꼭 봐야 할 요소", "howto", "beok"),
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
]

_BASE_KEYWORD_COUNT = len(KEYWORDS)


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
    for service in homepage_services:
        for flow in homepage_flows:
            add("homepage", f"{service} 홈페이지 제작에서 {flow} 항목을 먼저 설계하는 기준", "howto", "beok")

    system_domains = [
        "참가자 등록", "초록 접수", "심사 배정", "등록비 결제", "현장 체크인",
        "명찰 재발행", "사후 보고", "회원 관리", "문의 응대", "자료 제출",
        "권한 관리", "데이터 정산",
    ]
    system_decisions = [
        "관리자 권한을 나누는 방법", "엑셀 업무를 줄이는 화면 설계",
        "상태값을 정리하는 기준", "검색과 필터를 먼저 정해야 하는 이유",
        "알림톡과 이메일 발송 기준", "API 연동 전에 확인할 항목",
        "운영 로그를 남기는 기준", "담당자 인수인계를 쉽게 하는 구조",
    ]
    for domain in system_domains:
        for decision in system_decisions:
            add("system", f"{domain} 시스템 개발에서 {decision}", "howto", "beok")

    conference_ops = [
        "사전등록", "현장등록", "초록 접수", "발표자 관리", "좌장·연자 표기",
        "QR 체크인", "명찰 출력", "명찰 재발행", "등록비 확인", "참가자 안내",
        "세션 참석 확인", "행사 후 데이터 정리",
    ]
    conference_contexts = [
        "학회 사무국이 행사 전 확인할 체크리스트", "학술대회 홈페이지와 연결하는 방법",
        "접수대 혼잡을 줄이는 운영 기준", "관리자 화면에 꼭 필요한 항목",
        "홍커뮤니케이션 MICE 운영 관점에서 보는 준비 기준",
        "비오케이솔루션 개발 범위로 정리하는 방법",
    ]
    for op in conference_ops:
        for context in conference_contexts:
            brand = "hong" if "홍커뮤니케이션" in context else "beok"
            add("conference", f"{op} 운영: {context}", "howto", brand)

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
        for service in mice_services:
            add("mice", f"홍커뮤니케이션 {event} 운영에서 {service} 항목을 설계하는 기준", "niche", "hong")

    order = ("homepage", "system", "conference", "mice")
    max_len = max(len(items) for items in buckets.values())
    for idx in range(max_len):
        for bucket in order:
            if idx < len(buckets[bucket]):
                topic, content_type, brand_key = buckets[bucket][idx]
                _append_unique(topic, content_type, brand_key, set())


_expand_operational_keywords()
