"""
중앙 설정. 모델 등급/임계값/채널 자격증명을 한곳에서 바꾼다.
실제 값은 환경변수로 주입(코드에 키를 박지 않는다).
"""
from __future__ import annotations

import os
from pathlib import Path

# .env 파일이 있으면 자동 로드 (python-dotenv)
try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).parent / ".env")
except ImportError:
    pass

# ---- LLM ----
LLM_API_KEY = os.getenv("LLM_API_KEY", "")
LLM_BASE_URL = os.getenv("LLM_BASE_URL", "https://open.bigmodel.cn/api/paas/v4")

# 단계별 모델: 등급 조정은 여기서만. (운영하며 통과율 보고 낮춰가면 됨)
# 모델 실험 절차는 planning/02-검수게이트-모델운영-정책.md §3.4 참고.
# 개요는 품질 민감 -> 마지막에 건드린다. 본문부터 낮춰 통과율을 본다.
MODEL_OUTLINE = os.getenv("MODEL_OUTLINE", "glm-4.6")   # 개요: 추론 ON, 짧은 출력
MODEL_SECTION = os.getenv("MODEL_SECTION", "glm-4.5")   # 본문: thinking ON, 구조/깊이 우선
MODEL_REVIEW = os.getenv("MODEL_REVIEW", "glm-4.5")     # 검수: 저온, 짧게

# 단계별 출력 토큰 상한(기획 01 §3.1)
MAX_TOKENS_OUTLINE = int(os.getenv("MAX_TOKENS_OUTLINE", "600"))
MAX_TOKENS_INTENT = int(os.getenv("MAX_TOKENS_INTENT", "800"))      # 의도/키워드 JSON은 짧고 빠르게
MAX_TOKENS_OUTLINE_JSON = int(os.getenv("MAX_TOKENS_OUTLINE_JSON", "2200"))  # 개요 JSON 상한
MAX_TOKENS_SECTION = int(os.getenv("MAX_TOKENS_SECTION", "1500"))  # thinking=True 시 thinking+출력 합산 예산(1000은 thinking만 소진돼 빈 응답 반복)
SECTION_TOKEN_CAP = min(int(os.getenv("SECTION_TOKEN_CAP", "1500")), 1500)  # 오래된 .env의 과도한 token 상한 방어
MAX_TOKENS_SEO    = int(os.getenv("MAX_TOKENS_SEO",     "300"))
MAX_TOKENS_REVIEW = int(os.getenv("MAX_TOKENS_REVIEW",  "300"))

# ---- 재시도 / 타임아웃 ----
LLM_TIMEOUT_SEC       = int(os.getenv("LLM_TIMEOUT_SEC",       "120"))  # API 1회 호출 최대 대기
GENERATE_MAX_ATTEMPTS = int(os.getenv("GENERATE_MAX_ATTEMPTS", "5"))    # 생성 최대 시도
GENERATE_POST_TIMEOUT_SEC = int(os.getenv("GENERATE_POST_TIMEOUT_SEC", "900"))  # 글 1건 생성 하드 상한
GENERATE_PROCESS_ISOLATION = os.getenv("GENERATE_PROCESS_ISOLATION", "true").lower() == "true"
GENERATE_BATCH = int(os.getenv("GENERATE_BATCH", "1"))  # 원격 제어 명령 lease 안에서 안전하게 1건씩 생성
SECTION_MIN_LEN       = max(int(os.getenv("SECTION_MIN_LEN",   "180")), 120)  # 섹션 최소 글자. 짧은 운영 글이 900자 하한 밑으로 빠지는 것을 방지.
# 2026-07-05: 260자×4섹션=최대 1040자로 사실상 상한처럼 작동해, 실제 발행글
# 9건 전수가 984~1349자(발행 게이트 900~2600 밴드의 하단)에 몰려 "본문 짧음"
# 감사에 전부 걸렸다(내용도 문장 2~3개 수준으로 실제로 부실했음). 섹션당
# 상한을 늘려 400자×5섹션(SECTION_MAX)까지 여유를 주고 2600 상한 안에서
# 더 채워지게 한다.
SECTION_MAX_LEN       = min(int(os.getenv("SECTION_MAX_LEN",   "400")), 450)  # 섹션 최대 글자. 오래된 .env가 300이어도 운영 글 2600자 상한을 우선한다.
STUCK_THRESHOLD_MIN   = int(os.getenv("STUCK_THRESHOLD_MIN",   "35"))   # stuck 판단 기준(분)

# 번역(기획 11)
MODEL_TRANSLATE = os.getenv("MODEL_TRANSLATE", "glm-4.6")
MAX_TOKENS_TRANSLATE = int(os.getenv("MAX_TOKENS_TRANSLATE", "4000"))
TRANSLATE_ENABLED = os.getenv("TRANSLATE_ENABLED", "false").lower() == "true"
EN_CHANNEL = os.getenv("EN_CHANNEL", "selfhosted")   # 영문 발행 대상 채널

# ---- 생성 기본값 ----
DEFAULT_AUDIENCE = os.getenv("DEFAULT_AUDIENCE", "일반 독자")
DEFAULT_TONE = os.getenv("DEFAULT_TONE", "친근하고 신뢰감 있는")
DEFAULT_REFERENCES = os.getenv("DEFAULT_REFERENCES", "(없음)")

# ---- 검색/리서치 (기획 05 §4) ----
# 사실 수집(근거)은 공식 사이트를 기본으로 사용한다.
# Tavily 같은 유료/외부 검색 API는 설정했을 때만 보조 검색으로 쓴다.
SEARCH_PROVIDER = os.getenv("SEARCH_PROVIDER", "")          # tavily | (비우면 공식 사이트만)
TAVILY_API_KEY = os.getenv("TAVILY_API_KEY", "")
DEFAULT_OFFICIAL_SOURCE_URLS = (
    "https://beoksolution.com/,"
    "https://beoksolution.com/references/,"
    "https://beoksolution.com/ai-search-summary.html,"
    "https://beoksolution.com/llms.txt,"
    "https://hongcomm.kr/,"
    "https://hongcomm.kr/sub/company.php,"
    "https://hongcomm.kr/sub/business.php,"
    "https://hongcomm.kr/sub/offline.php,"
    "https://hongcomm.kr/sub/online.php,"
    "https://hongcomm.kr/sub/solution.php,"
    "https://hongcomm.kr/sub/solution.php?tab=eregi,"
    "https://hongcomm.kr/sub/solution.php?tab=translation,"
    "https://hongcomm.kr/sub/products.php,"
    "https://hongcomm.kr/sub/clients.php,"
    "https://hongcomm.kr/bbs/board.php?bo_table=portfolio"
)
OFFICIAL_SOURCE_URLS = [
    u.strip()
    for u in os.getenv(
        "OFFICIAL_SOURCE_URLS",
        DEFAULT_OFFICIAL_SOURCE_URLS,
    ).split(",")
    if u.strip()
]

# 브랜드(서비스 쇼케이스 축) 전용 근거 출처. 해당 category 글 생성 시
# 기본 공식 출처(beok/hong)에 앞서 근거팩에 투입해 grounding을 확보한다.
BRAND_SOURCE_URLS: dict[str, list[str]] = {
    "racekra": [
        "https://racekra-87ecc.web.app/",
        "https://www.data.go.kr/data/15058559/openapi.do",
        "https://www.data.go.kr/data/15059267/openapi.do",
    ],
    "ncs": [
        "https://ncspj-ba46a.web.app/",
        "https://www.work24.go.kr/cm/main.do",
        "https://www.ncs.go.kr/index.do",
    ],
}


# 2026-06-15 결정("Tavily 비용 의존 제거")은 official_ok만으로 생성을 계속하게
# 했다 — 그 결과 beok/hong 글 전수가 자사 페이지 2개만 근거로 재사용해 왔다
# (reports/content-quality-audit-20260705.md §2-증상5 실측: sources=2,
# facts=7, grounding_ratio=1.0). REQUIRE_EXTERNAL_EVIDENCE=true로 켜면
# 독립 출처(Tavily 또는 네이버 검색 API) 없이는 생성 자체를 멈춘다.
# 기본값은 false — 켜기 전에 아래 중 하나를 먼저 준비해야 재고 고갈 없이 전환된다:
#   SEARCH_PROVIDER=tavily + TAVILY_API_KEY, 또는 NAVER_CLIENT_ID/SECRET(무료 발급 가능).
REQUIRE_EXTERNAL_EVIDENCE = os.getenv("REQUIRE_EXTERNAL_EVIDENCE", "false").lower() == "true"


def search_health_status() -> dict:
    """신규 원고 생성에 필요한 검색/근거 수집 준비 상태."""
    provider = (SEARCH_PROVIDER or "").strip().lower()
    paid_search_ok = provider == "tavily" and bool(TAVILY_API_KEY)
    official_ok = bool(OFFICIAL_SOURCE_URLS)
    naver_serp_ok = bool(NAVER_CLIENT_ID and NAVER_CLIENT_SECRET)
    # "독립 출처"= 브랜드 자사 페이지가 아닌 실제 검색으로 얻는 근거.
    # official_ok는 beoksolution.com/hongcomm.kr 자사 페이지 존재 여부일 뿐,
    # 다른 브랜드/주제와 구분되는 사실을 전혀 보장하지 않는다.
    diversity_ok = paid_search_ok or naver_serp_ok
    ok = (official_ok or paid_search_ok) if not REQUIRE_EXTERNAL_EVIDENCE else diversity_ok
    return {
        "provider": provider or None,
        "official_sources_ok": official_ok,
        "official_source_count": len(OFFICIAL_SOURCE_URLS),
        "general_search_ok": paid_search_ok,
        "naver_serp_ok": naver_serp_ok,
        "evidence_diversity_ok": diversity_ok,
        "require_external_evidence": REQUIRE_EXTERNAL_EVIDENCE,
        "ok": ok,
        "reason": None if ok else (
            "REQUIRE_EXTERNAL_EVIDENCE=true인데 독립 검색 공급자 미설정: 신규 원고 생성 중단"
            if REQUIRE_EXTERNAL_EVIDENCE
            else "공식 출처 또는 검색 공급자 미설정: 신규 원고 근거 수집 불가"
        ),
    }


def can_generate_with_evidence() -> bool:
    """품질 게이트가 켜진 운영 모드에서 생성 워커가 진행 가능한지."""
    return MIN_GROUNDING_RATIO <= 0 or bool(search_health_status()["ok"])

# ---- 검색 노출(SEO) / 채널별 타깃 엔진 (기획 07) ----
# 네이버 블로그→네이버 검색, 티스토리·자체→구글 검색.
CHANNEL_TARGET_ENGINE = {
    "naver": "naver",
    "naver_manual": "naver",   # 수기 발행 원고도 네이버 SEO/문체 규칙을 따른다(기획 14)
    "tistory": "google",
    "selfhosted": "google",
}
NAVER_CLIENT_ID = os.getenv("NAVER_CLIENT_ID", "")
NAVER_CLIENT_SECRET = os.getenv("NAVER_CLIENT_SECRET", "")
SERP_ANALYZE_COUNT = int(os.getenv("SERP_ANALYZE_COUNT", "10"))  # 타깃 SERP 상위 분석 수


def target_engine(channel: str) -> str:
    """채널의 타깃 검색엔진. 미정 채널은 google."""
    return CHANNEL_TARGET_ENGINE.get(channel, "google")


# ---- 블로그 주제 일관 운영 (기획 08) ----
# 네이버 C-Rank: 블로그=분야 집중. 블로그별 분야/키워드 정의.
BLOG_PROFILES: dict[str, dict] = {
    # "naver_tech": {"channel": "naver", "blog_id": "", "category": "IT/가전",
    #                "keywords": ["이어폰", "노트북", "가전"]},
}


def profile_for(category: str = "", topic: str = "") -> str | None:
    """카테고리/주제로 블로그 프로필 키를 찾는다. 없으면 None."""
    for key, prof in BLOG_PROFILES.items():
        if category and prof.get("category") == category:
            return key
        if topic and any(kw in topic for kw in prof.get("keywords", [])):
            return key
    return None
SEARCH_RESULTS_PER_QUERY = int(os.getenv("SEARCH_RESULTS_PER_QUERY", "6"))
MAX_SUBQUERIES = int(os.getenv("MAX_SUBQUERIES", "4"))      # 하위질문 검색 상한
MAX_SOURCES = int(os.getenv("MAX_SOURCES", "16"))           # 근거팩에 모을 출처 상한
MIN_SOURCE_TEXT_LEN = int(os.getenv("MIN_SOURCE_TEXT_LEN", "300"))
MAX_SOURCE_TEXT_LEN = int(os.getenv("MAX_SOURCE_TEXT_LEN", "6000"))
EVIDENCE_SRC_SNIPPET = int(os.getenv("EVIDENCE_SRC_SNIPPET", "3000"))  # 추출 입력 길이
# 출처 신뢰도 필터(쉼표구분 도메인). allowlist는 high로, blocklist는 제외.
SOURCE_ALLOWLIST = [d for d in os.getenv("SOURCE_ALLOWLIST", "").split(",") if d]
SOURCE_BLOCKLIST = [d for d in os.getenv("SOURCE_BLOCKLIST", "").split(",") if d]

# 사실검증(기획 05 §6)
MIN_GROUNDING_RATIO = float(os.getenv("MIN_GROUNDING_RATIO", "0.9"))

# ---- URL 재작성(기획 10) ----
# 원문 대비 n-gram 유사도가 이 값 이상이면 발행 보류(=충분히 달라져야 통과).
MAX_SIMILARITY = float(os.getenv("MAX_SIMILARITY", "0.3"))
REWRITE_MAX_RETRIES = int(os.getenv("REWRITE_MAX_RETRIES", "2"))
REWRITE_EXTRA_RESEARCH = os.getenv("REWRITE_EXTRA_RESEARCH", "true").lower() == "true"

# ---- 검수 게이트 임계값 ----
MIN_BODY_LEN = int(os.getenv("MIN_BODY_LEN", "800"))    # 가시 본문 최소 길이
MAX_DUP_RATIO = float(os.getenv("MAX_DUP_RATIO", "0.18"))
MIN_HEADINGS = int(os.getenv("MIN_HEADINGS", "3"))
MIN_REVIEW_SCORE = int(os.getenv("MIN_REVIEW_SCORE", "80"))
REVIEW_HARD_FAIL_SCORE = int(os.getenv("REVIEW_HARD_FAIL_SCORE", "50"))
# filler 밀도 상한(utils/text.py::filler_density, 문장 수 대비 비율이 아니라
# 1,000자당 매칭 건수 — 실측 발행분 10건은 60~180문장짜리 장문이라 문장 비율로는
# 절대 8%를 못 넘겨 게이트가 이론상으로만 존재하는 문제가 있었다. 실측 exhibit
# post id=51/56/55/99/94의 밀도가 0.70~1.28/1000자였으므로 그 아래인 0.6을
# 1차 임계값으로 둔다. reports/content-quality-audit-20260705.md §2-증상5 참고.
MAX_FILLER_DENSITY = float(os.getenv("MAX_FILLER_DENSITY", "0.6"))
# LLM 검수(review.py evaluate())가 매기는 generic/repetitive/thin_for_intent는
# 주관적 판단이라 기본은 advisory로 둔다(quality_selftest.py가 이 기본 동작을
# 회귀 테스트로 고정하고 있다 — 재고를 0%로 만드는 사고를 이미 겪었음).
# true로 켜면 위 세 이슈도 hard fail 대상이 된다. 켜기 전에
# tools/measure_passrate.py 등으로 통과율 하락폭을 먼저 관찰할 것
# (reports/content-quality-audit-20260705.md §6 — 2단계 롤아웃 권장).
STRICT_SUBJECTIVE_ISSUES = os.getenv("STRICT_SUBJECTIVE_ISSUES", "false").lower() == "true"
_REVIEW_CRITICAL_BASE = "factual_doubt,off_topic,banned_words,unsafe,hallucination,privacy_risk"
_REVIEW_CRITICAL_STRICT_EXTRA = "generic,repetitive,thin_for_intent"
REVIEW_CRITICAL_ISSUES = [
    issue.strip()
    for issue in os.getenv(
        "REVIEW_CRITICAL_ISSUES",
        _REVIEW_CRITICAL_BASE + ("," + _REVIEW_CRITICAL_STRICT_EXTRA if STRICT_SUBJECTIVE_ISSUES else ""),
    ).split(",")
    if issue.strip()
]
BANNED_WORDS = [w for w in os.getenv("BANNED_WORDS", "").split(",") if w]

# ---- 발행 스케줄 ----
DAILY_PUBLISH_TARGET = int(os.getenv("DAILY_PUBLISH_TARGET", "5"))   # 발행 큐 깊이 목표(일일 총량 아님 — schedule_publish docstring 참고)
PUBLISH_SPACING_MIN = int(os.getenv("PUBLISH_SPACING_MIN", "90"))    # 글 간 분산 간격(분)
STOCK_BUFFER_DAYS = int(os.getenv("STOCK_BUFFER_DAYS", "3"))         # 유지할 재고 일수
ALLOW_EXTERNAL_AUTO_SEED = os.getenv("ALLOW_EXTERNAL_AUTO_SEED", "false").lower() == "true"
# 주제 다양성: 조합 생성 시 하나의 '앵커'(예: 교육기관 홈페이지, 명찰 재발행)별로
# 허용할 변형 주제 수. 템플릿 양산으로 비슷한 글이 몰리는 것을 막는다.
# 3이면 확장 풀이 129개로 줄어 소진 후 편중 마커가 재유입되므로(모노토니 재발),
# 기본 6으로 풀 250+를 유지한다. 배치 편중은 pillar 라운드로빈+테마 캡이 막는다.
SEED_MAX_PER_ANCHOR = int(os.getenv("SEED_MAX_PER_ANCHOR", "6"))

# 주제 다양성: 서로 다른 앵커에 걸쳐 있어도(예: '학회 명찰', '명찰 재발행',
# 'QR 명찰 출력') 하나의 테마 키워드가 최근 재고를 과점하는 것을 막는다.
# 최근 AUTO_SEED_THEME_LOOKBACK건 중 마커 포함 비율이 CAP_RATIO 이상이면
# 이번 시드 배치에서 해당 마커가 들어간 후보를 제외한다(다른 후보가 없으면 예외 허용).
AUTO_SEED_THEME_MARKERS = [
    m.strip() for m in os.getenv(
        "AUTO_SEED_THEME_MARKERS",
        "명찰,홍커뮤니케이션,학회,학술대회,MICE,행사,참가자,초록,등록비,홈페이지,반품",
    ).split(",") if m.strip()
]
AUTO_SEED_THEME_CAP_RATIO = float(os.getenv("AUTO_SEED_THEME_CAP_RATIO", "0.2"))
AUTO_SEED_THEME_LOOKBACK = int(os.getenv("AUTO_SEED_THEME_LOOKBACK", "40"))

# ---- 운영 주제 축 ----
# 블로그는 단일 명찰 키워드가 아니라 홈페이지 제작, 시스템 개발, 학회 운영,
# 홍커뮤니케이션/MICE 레퍼런스를 함께 다룬다.
BLOG_FOCUS_NAME = os.getenv("BLOG_FOCUS_NAME", "비오케이솔루션 · 홍커뮤니케이션 블로그")
AUTO_SEED_BRAND_FILTER = os.getenv("AUTO_SEED_BRAND_FILTER", "")
AUTO_SEED_REQUIRED_TERMS = [
    term.strip()
    for term in os.getenv(
        "AUTO_SEED_REQUIRED_TERMS",
        "학회,학술대회,명찰,사무국,참가자,접수,등록,출력,발행,재발행,QR,바코드,체크인,초록,심사,홈페이지,웹사이트,반응형,SEO,신청폼,문의폼,예약,결제,SSL,시스템,개발,관리자,대시보드,백오피스,자동화,알림톡,DB,데이터,솔루션,연동,홍커뮤니케이션,MICE,국제회의,컨퍼런스,행사,동시통역,포트폴리오,레퍼런스",
    ).split(",")
    if term.strip()
]

# 발행 허용 시간대(현지시각 기준, 기획 03 §3.2). 이 시간 밖이면 다음 윈도우로 이월.
PUBLISH_TZ_OFFSET = int(os.getenv("PUBLISH_TZ_OFFSET", "9"))         # KST=+9
PUBLISH_WINDOW_START = int(os.getenv("PUBLISH_WINDOW_START", "9"))   # 09시
PUBLISH_WINDOW_END = int(os.getenv("PUBLISH_WINDOW_END", "21"))      # 21시

# ---- 알림 (기획 03 §3.3) ----
NOTIFY_WEBHOOK_URL = os.getenv("NOTIFY_WEBHOOK_URL", "")  # 슬랙 등 incoming webhook
NOTIFY_MIN_LEVEL = os.getenv("NOTIFY_MIN_LEVEL", "warn")  # info|warn|error

# ---- 자체 블로그 ----
SELFHOST_API_URL = os.getenv("SELFHOST_API_URL", "")      # 예: https://beoksolution.com
SELFHOST_PUBLIC_URL = os.getenv("SELFHOST_PUBLIC_URL", "https://beoksolution.com")
SELFHOST_POST_PATH = os.getenv("SELFHOST_POST_PATH", "/api/blog-posts")  # POST 엔드포인트
SELFHOST_API_KEY = os.getenv("SELFHOST_API_KEY", "")
SELFHOST_RENDER_HTML = os.getenv("SELFHOST_RENDER_HTML", "true").lower() == "true"  # 기획 09

# ---- 네이버/티스토리 워커 (executors/naver-blog-worker) ----
# Python→Node.js HTTP 사이드카 URL. 워커가 이 포트로 Playwright를 실행한다.
NAVER_WORKER_URL = os.getenv("NAVER_WORKER_URL", "http://localhost:8788")
EXTERNAL_PUBLISH_TIMEOUT_SEC = int(os.getenv("EXTERNAL_PUBLISH_TIMEOUT_SEC", "900"))

# ---- 네이버 수기 발행 원고 엔진 (기획 14) ----
# 봇 발행이 아니라 사람이 복사-붙여넣기로 올리는 고품질 원고를 만든다.
# 채널 'naver_manual'은 스케줄러/발행 워커가 절대 건드리지 않는다(온디맨드 생성).
NAVER_MANUAL_CHANNEL = "naver_manual"
NAVER_MANUAL_STATE = "awaiting_manual"            # 사람 발행 대기 종착 상태
NAVER_MANUAL_OUT_DIR = os.getenv(
    "NAVER_MANUAL_OUT_DIR",
    str(Path(__file__).parent / "out" / "naver"),
)
# 본문 길이 밴드(공백 제외 글자 수). 네이버 최적 구간.
NAVER_MANUAL_MIN_LEN = int(os.getenv("NAVER_MANUAL_MIN_LEN", "1200"))
NAVER_MANUAL_MAX_LEN = int(os.getenv("NAVER_MANUAL_MAX_LEN", "2200"))
# 주 키워드 자연 반복 허용 구간(기계적 반복=과최적화 차단).
NAVER_MANUAL_KW_MIN = int(os.getenv("NAVER_MANUAL_KW_MIN", "3"))
NAVER_MANUAL_KW_MAX = int(os.getenv("NAVER_MANUAL_KW_MAX", "6"))
# 사진 슬롯 권장 수(하드 게이트 아님 — 사용자가 사진을 직접 넣으므로 위치 힌트용).
NAVER_MANUAL_PHOTO_SLOTS = int(os.getenv("NAVER_MANUAL_PHOTO_SLOTS", "4"))
# humanize→factcheck 재검증 실패 시 재시도 횟수.
NAVER_MANUAL_MAX_RETRIES = int(os.getenv("NAVER_MANUAL_MAX_RETRIES", "2"))
# 경험담 원고의 grounding 하한. 1인칭 익명 현장 서사는 웹 근거로 100% 뒷받침될 수
# 없다(기획 14 §1.1이 오히려 장면 디테일을 D.I.A.+ 신호로 권장). 하드 조작 방지는
# 결정론적 local_unsupported_claims(수치·고유명사)가 맡고, 이 값은 서사 색채를
# 허용하는 완화된 기준이다. 데이터 기사용 MIN_GROUNDING_RATIO(0.9)와 별개.
NAVER_MANUAL_MIN_GROUNDING = float(os.getenv("NAVER_MANUAL_MIN_GROUNDING", "0.6"))
# 하루 소프트 상한(0=무제한). 온디맨드라 하드락은 없고, 초과 시 경고만 한다.
NAVER_MANUAL_SOFT_DAILY_CAP = int(os.getenv("NAVER_MANUAL_SOFT_DAILY_CAP", "2"))
MODEL_HUMANIZE = os.getenv("MODEL_HUMANIZE", MODEL_SECTION)
MAX_TOKENS_HUMANIZE = int(os.getenv("MAX_TOKENS_HUMANIZE", "3200"))

# ---- 네이버 ----
NAVER_BLOG_ID = os.getenv("NAVER_BLOG_ID", "")
NAVER_HEADLESS = os.getenv("NAVER_HEADLESS", "false").lower() == "true"
NAVER_USER_AGENT = os.getenv(
    "NAVER_USER_AGENT",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
)

# ---- 티스토리 ----
TISTORY_BLOG = os.getenv("TISTORY_BLOG", "")
TISTORY_HEADLESS = os.getenv("TISTORY_HEADLESS", "false").lower() == "true"
TISTORY_USER_AGENT = os.getenv("TISTORY_USER_AGENT", NAVER_USER_AGENT)

# ---- notebook-return (쿠팡 반품 노트북 마켓, 별도 Firebase 프로젝트) ----
# 2026-07-05: 발행 자체는 selfhosted(beoksolution.com)로 통합됐고(*.web.app 서브도메인
# 검색 권위 0 문제), 이 프로젝트는 이제 "근거 수집 전용"으로만 쓴다 — 실제 크롤된
# 상품 데이터(가격/등급/재고)를 generate 단계의 grounding 근거로 읽어온다
# (research/product_sources.py -> tools/notebook_return/fetch_products.mjs).
NOTEBOOK_RETURN_FIREBASE_PROJECT_ID = os.getenv("NOTEBOOK_RETURN_FIREBASE_PROJECT_ID", "notebook-return")
NOTEBOOK_RETURN_PRODUCTS_COLLECTION = os.getenv("NOTEBOOK_RETURN_PRODUCTS_COLLECTION", "products")
# 서비스계정 키 경로. 없으면 ADC로 폴백(이 PC는 이미 coupang 크롤러가 ADC로
# notebook-return에 쓰고 있어 별도 키 없이도 동작할 가능성이 높음).
NOTEBOOK_RETURN_FIREBASE_CREDENTIALS = os.getenv(
    "NOTEBOOK_RETURN_FIREBASE_CREDENTIALS", ".secrets/firebase-admin-notebook-return.json"
)
