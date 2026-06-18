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
GENERATE_BATCH = int(os.getenv("GENERATE_BATCH", "2"))  # generate 1회 처리 건수. 빈 draft 적체 해소용
SECTION_MIN_LEN       = int(os.getenv("SECTION_MIN_LEN",       "100"))  # 섹션 최소 글자
SECTION_MAX_LEN       = int(os.getenv("SECTION_MAX_LEN",       "380"))  # 섹션 최대 글자(문단 단위 압축) — 5섹션 기준 운영 글 발행 상한(2600자)을 넘지 않도록 설정(여유 마진 포함)
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
OFFICIAL_SOURCE_URLS = [
    u.strip()
    for u in os.getenv(
        "OFFICIAL_SOURCE_URLS",
        "https://beoksolution.com/,https://hongcomm.kr/",
    ).split(",")
    if u.strip()
]


def search_health_status() -> dict:
    """신규 원고 생성에 필요한 검색/근거 수집 준비 상태."""
    provider = (SEARCH_PROVIDER or "").strip().lower()
    paid_search_ok = provider == "tavily" and bool(TAVILY_API_KEY)
    official_ok = bool(OFFICIAL_SOURCE_URLS)
    naver_serp_ok = bool(NAVER_CLIENT_ID and NAVER_CLIENT_SECRET)
    return {
        "provider": provider or None,
        "official_sources_ok": official_ok,
        "official_source_count": len(OFFICIAL_SOURCE_URLS),
        "general_search_ok": paid_search_ok,
        "naver_serp_ok": naver_serp_ok,
        "ok": official_ok or paid_search_ok,
        "reason": None if (official_ok or paid_search_ok) else "공식 출처 또는 검색 공급자 미설정: 신규 원고 근거 수집 불가",
    }


def can_generate_with_evidence() -> bool:
    """품질 게이트가 켜진 운영 모드에서 생성 워커가 진행 가능한지."""
    return MIN_GROUNDING_RATIO <= 0 or bool(search_health_status()["ok"])

# ---- 검색 노출(SEO) / 채널별 타깃 엔진 (기획 07) ----
# 네이버 블로그→네이버 검색, 티스토리·자체→구글 검색.
CHANNEL_TARGET_ENGINE = {
    "naver": "naver",
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
MAX_SOURCES = int(os.getenv("MAX_SOURCES", "10"))           # 근거팩에 모을 출처 상한
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
REVIEW_HARD_FAIL_SCORE = int(os.getenv("REVIEW_HARD_FAIL_SCORE", "60"))
REVIEW_CRITICAL_ISSUES = [
    issue.strip()
    for issue in os.getenv(
        "REVIEW_CRITICAL_ISSUES",
        "factual_doubt,off_topic,unnatural_ko,banned_words,unsafe,hallucination,privacy_risk",
    ).split(",")
    if issue.strip()
]
BANNED_WORDS = [w for w in os.getenv("BANNED_WORDS", "").split(",") if w]

# ---- 발행 스케줄 ----
DAILY_PUBLISH_TARGET = int(os.getenv("DAILY_PUBLISH_TARGET", "5"))   # 하루 발행 목표
PUBLISH_SPACING_MIN = int(os.getenv("PUBLISH_SPACING_MIN", "90"))    # 글 간 분산 간격(분)
STOCK_BUFFER_DAYS = int(os.getenv("STOCK_BUFFER_DAYS", "3"))         # 유지할 재고 일수
ALLOW_EXTERNAL_AUTO_SEED = os.getenv("ALLOW_EXTERNAL_AUTO_SEED", "false").lower() == "true"

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
SELFHOST_API_URL = os.getenv("SELFHOST_API_URL", "")      # 예: https://beokmkt.web.app
SELFHOST_POST_PATH = os.getenv("SELFHOST_POST_PATH", "/api/blog-posts")  # POST 엔드포인트
SELFHOST_API_KEY = os.getenv("SELFHOST_API_KEY", "")
SELFHOST_RENDER_HTML = os.getenv("SELFHOST_RENDER_HTML", "true").lower() == "true"  # 기획 09

# ---- 네이버/티스토리 워커 (executors/naver-blog-worker) ----
# Python→Node.js HTTP 사이드카 URL. 워커가 이 포트로 Playwright를 실행한다.
NAVER_WORKER_URL = os.getenv("NAVER_WORKER_URL", "http://localhost:8788")
EXTERNAL_PUBLISH_TIMEOUT_SEC = int(os.getenv("EXTERNAL_PUBLISH_TIMEOUT_SEC", "900"))

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
