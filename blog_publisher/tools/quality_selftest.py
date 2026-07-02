"""
Phase A/B 품질 셀프테스트.

외부 발행이나 LLM 호출 없이, 실제 렌더러/티스토리 어댑터를 실행해
생성 품질 계약과 리치 HTML 구성요소가 사라지지 않는지 확인한다.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
WORKER_DIR = ROOT / "executors" / "naver-blog-worker"


def _subprocess_env(**overrides: str) -> dict[str, str]:
    env = os.environ.copy()
    env.update({key: value for key, value in overrides.items() if value is not None})
    return env


SAMPLE_MD = """학회 운영 사무국의 명찰 출력은 참가자 응대 품질과 바로 연결됩니다.

![학회 명찰 출력 체크리스트](https://beoksolution.com/assets/blog/beok/checklist-card.svg)

## 핵심 요약

- **명단 확정**은 출력 전 마지막 기준 파일 하나로 관리합니다.
- **출력 검수**는 건수, 표기, 코드, 샘플 순서로 반복합니다.
- **현장 재발행**은 승인 기준과 출력 로그를 함께 둡니다.

## 명단 확정 기준

사무국은 이름, 소속, 직함, 등록 구분, 식별 코드, 수령 여부를 같은 형식으로 정리해야 합니다.
이 단계에서 중요한 것은 담당자마다 다른 파일을 보지 않도록 기준 파일을 하나로 고정하는 일입니다.
행사 전날에는 추가 등록자와 취소자가 함께 들어오므로, 원본 명단과 출력 명단을 따로 관리하면 현장에서 재발행 요청이 늘어납니다.
따라서 최종 출력 전에는 파일명, 수정 시각, 담당자, 반영 범위를 기록하고 같은 기준으로 샘플을 확인해야 합니다.

| 점검 항목 | 확인 기준 | 담당 |
| --- | --- | --- |
| 전체 건수 | 등록 완료자 수와 출력 수 일치 | 사무국 |
| 코드 검수 | QR 또는 바코드 스캔 정상 | 운영 담당 |

## 출력 전 확인 순서

1. 최종 명단 파일을 고정합니다.
2. 필수 컬럼 누락을 확인합니다.
3. 긴 소속명의 줄바꿈을 샘플 출력으로 확인합니다.
4. 여분 용지와 케이스 수량을 점검합니다.

출력 검수는 빠르게 훑는 방식보다 같은 순서를 반복하는 방식이 안정적입니다.
전체 건수가 맞더라도 이름 표기, 소속 약칭, 직함 줄바꿈, 코드 스캔 값이 어긋나면 현장 접수대에서 바로 문의로 이어집니다.
운영 담당자는 실제 프린터로 몇 장을 먼저 뽑아 색상, 여백, 절단선, 케이스 삽입 상태를 확인하고 나서 전체 출력에 들어가는 편이 좋습니다.

> 현장 재발행은 빠른 처리보다 같은 기준을 유지하는 것이 중요합니다.

## 현장 운영과 상담

비오케이솔루션은 학회 운영 사무국의 명찰 출력, 현장 재발행, 참가자 데이터 정리 흐름을 함께 점검합니다. 명찰 운영 상담이 필요하면 행사 전 데이터 구조부터 확인해 주세요.
현장 재발행 창구에는 노트북, 프린터, 여분 용지, 케이스, 목걸이 줄을 함께 배치하고 승인 담당자와 출력 담당자를 구분하는 것이 좋습니다.
재발행 사유와 출력 시간을 남기면 행사 후 미수령 명단, 당일 등록자, 변경 요청을 정리할 때도 기준이 분명해집니다.
이 기록은 다음 학회 운영에서 접수 인력 배치와 명찰 제작 수량을 조정하는 근거가 됩니다.
"""


def _assert_contains(name: str, html: str, required: list[str]) -> list[str]:
    return [f"{name}: {token} 누락" for token in required if token not in html]


def _test_phase_a_generation_contract() -> list[str]:
    """섹션 생성 품질 계약(토큰/구조/thinking/한자 방어)이 깨지면 즉시 잡는다."""
    import config
    from pipeline import generate
    from llm import prompts

    issues: list[str] = []
    if generate._section_max_tokens() > 1500:
        issues.append(f"phase-a: 섹션 유효 토큰 상한 > 1500 ({generate._section_max_tokens()})")
    if config.SECTION_MAX_LEN > 260:
        issues.append(f"phase-a: SECTION_MAX_LEN > 260 ({config.SECTION_MAX_LEN})")
    if config.SECTION_MIN_LEN < 120:
        issues.append(f"phase-a: SECTION_MIN_LEN < 120 ({config.SECTION_MIN_LEN})")
    for token in ["200~260자", "운영 장면 1개", "판단 기준 1개", "독자 행동 1개", "### 소소제목", "`**굵게**`", "마크다운 표", "한자"]:
        if token not in prompts.SECTION_SYSTEM:
            issues.append(f"phase-a: SECTION_SYSTEM 품질 지시 누락: {token}")

    class MockLLM:
        def __init__(self):
            self.calls: list[dict] = []
            self.section_calls = 0

        def chat(self, system: str, user: str, **kw) -> str:
            self.calls.append({"system": system, "user": user, **kw})
            if "한국어 블로그 편집장" in system:
                return """{
                  "title": "학회 명찰 출력 운영 기준",
                  "meta_description": "학회 명찰 출력 전 사무국이 확인할 운영 기준입니다.",
                  "sections": [
                    {"h2": "명단 기준 파일을 먼저 고정합니다", "point": "최종 명단 기준을 하나로 통일한다"},
                    {"h2": "현장 재발행 기준을 분리합니다", "point": "재발행 승인과 출력 기록을 남긴다"}
                  ]
                }"""
            if "구글 SEO 에디터" in system or "네이버 블로그 상위노출 에디터" in system:
                return """{"seo_title":"학회 명찰 출력 운영 기준","meta_description":"학회 명찰 출력과 현장 재발행 기준을 정리합니다.","tags":["학회 운영","명찰 출력"]}"""
            if "한국어 블로그 전문 작가" in system:
                self.section_calls += 1
                if self.section_calls == 1:
                    return (
                        "명단 기준은 信信 과정에서 흔들리면 안 됩니다. "
                        "사무국은 이름, 소속, 등록 구분, 식별 코드를 같은 기준으로 확인해야 합니다. "
                        "출력 직전에 기준 파일이 여러 개로 나뉘면 현장 재발행 요청이 늘어납니다."
                    )
                return """
### 사무국이 먼저 맞춰야 할 기준

최종 명단은 여러 담당자가 나누어 들고 있는 파일이 아니라 **하나의 기준 파일**이어야 합니다. 같은 참가자를 서로 다른 파일에서 수정하면 출력 직전에 이름, 소속, 등록 구분이 엇갈립니다.

- 이름과 소속 표기를 같은 규칙으로 맞춥니다.
- 등록 구분과 식별 코드를 같은 행에서 확인합니다.
- 수정 시각과 담당자를 남겨 재출력 근거를 보존합니다.

| 항목 | 확인 기준 |
| --- | --- |
| 명단 | 최종 파일 하나 |
| 코드 | 스캔 정상 |
"""
            raise AssertionError("unexpected mock prompt")

    mock = MockLLM()
    result = generate.compose_article(
        mock,
        "학회 명찰 출력 운영 기준",
        "howto",
        "google",
        {
            "intent": "학회 명찰 출력 전 사무국 운영 기준 확인",
            "coverage_targets": ["명단 기준", "현장 재발행"],
            "facts": [
                {"statement": "최종 명단 기준을 하나로 관리해야 한다", "source_title": "운영 문서"},
                {"statement": "재발행 요청은 승인과 출력 기록을 남겨야 한다", "source_title": "운영 문서"},
            ],
            "sources": [{"title": "운영 문서", "url": "https://example.com"}],
        },
        serp=[],
        brand_key="",
    )
    section_calls = [c for c in mock.calls if "한국어 블로그 전문 작가" in c["system"]]
    if len(section_calls) < 3:
        issues.append(f"phase-a: 한자 혼입 섹션 재시도 미작동(section_calls={len(section_calls)})")
    for call in section_calls:
        if call.get("thinking") is not True:
            issues.append("phase-a: 섹션 thinking=True 미적용")
            break
        if call.get("max_tokens") != generate._section_max_tokens():
            issues.append(
                f"phase-a: 섹션 max_tokens 불일치({call.get('max_tokens')} != {generate._section_max_tokens()})"
            )
            break
    body = result["body"]
    if generate._count_hanzi(body) != 0:
        issues.append("phase-a: 최종 본문에 한자 잔존")
    for token in ["###", "- ", "**", "| 점검 | 기준 |"]:
        if token not in body:
            issues.append(f"phase-a: 구조화 출력 누락: {token}")
    return issues


def _test_generate_rejects_empty_article() -> list[str]:
    from pipeline import generate

    try:
        generate._validate_generated_article({
            "title": "빈 본문 테스트",
            "meta_description": "본문이 비면 저장하면 안 됩니다.",
            "body": "",
        })
    except ValueError:
        return []
    return ["generate: 빈 본문 결과를 성공으로 처리함"]


def _test_generate_hard_compacts_long_section() -> list[str]:
    import config
    from pipeline import generate

    body = "이 문장은 매우 길게 생성된 첫 문단입니다. " + ("가" * 1600)
    compacted = generate._compact_section_body(body)
    if len(compacted) > config.SECTION_MAX_LEN:
        return [f"generate: 긴 섹션 hard cap 미작동({len(compacted)}/{config.SECTION_MAX_LEN})"]
    return []


def _test_generate_all_failures_stop_runbook() -> list[str]:
    from contextlib import contextmanager
    from pipeline import generate

    class FakeDb:
        def __init__(self):
            self.requeued = 0

        def fetch_generate_ready(self, limit=10):
            return [{"id": 1, "topic": "LLM 과부하 테스트", "attempts": 0}]

        def claim(self, _post_id, _from_status, _to_status):
            return True

        def requeue_draft(self, _post_id, _attempts, _error, max_attempts=5):
            self.requeued += 1
            return "draft"

    @contextmanager
    def fake_lock():
        yield True

    original_db = generate.db
    original_lock = generate._generate_lock
    original_generate = generate._generate_one_with_timeout
    original_can_generate = generate.config.can_generate_with_evidence
    fake_db = FakeDb()
    try:
        generate.db = fake_db
        generate._generate_lock = fake_lock
        generate._generate_one_with_timeout = lambda _post: (_ for _ in ()).throw(RuntimeError("LLM 429"))
        generate.config.can_generate_with_evidence = lambda: True
        try:
            generate.run_once(batch=1)
        except RuntimeError:
            return []
        return ["generate: 모든 생성 대상 실패를 성공 명령으로 처리함"]
    finally:
        generate.db = original_db
        generate._generate_lock = original_lock
        generate._generate_one_with_timeout = original_generate
        generate.config.can_generate_with_evidence = original_can_generate


def _test_operational_generation_length_contract_queues() -> list[str]:
    """운영 글은 생성 직후 발행 게이트 길이 계약을 만족하고 queued까지 가야 한다."""
    import config
    from db import db
    from pipeline import factcheck, generate, review, schedule_publish
    from research import collect
    from research.collect import CollectedSource
    from tools.content_quality import external_image_count, image_count, plain_text, publish_blockers

    issues: list[str] = []
    if config.SECTION_MAX_LEN > 260:
        issues.append(f"ops-length: SECTION_MAX_LEN이 260을 초과함({config.SECTION_MAX_LEN})")
    if config.SECTION_MIN_LEN < 120:
        issues.append(f"ops-length: SECTION_MIN_LEN이 120 미만임({config.SECTION_MIN_LEN})")
    if generate.SECTION_MAX > 4:
        issues.append(f"ops-length: 운영 글 섹션 상한이 4를 초과함({generate.SECTION_MAX})")

    class MockLLM:
        section_calls = 0

        def chat(self, system: str, user: str, **_kw) -> str:
            if "SEO 콘텐츠 전략가" in system or "검색 의도를 분석" in system:
                return json.dumps({
                    "intent": "서비스업 홈페이지 제작 전 예약과 결제 흐름 검토",
                    "primary_keyword": "서비스업 홈페이지 제작",
                    "secondary_keywords": ["예약 시스템", "결제 연동", "알림톡"],
                    "subquestions": ["예약 접수", "결제 확인", "관리자 화면"],
                }, ensure_ascii=False)
            if "사실 추출기" in system:
                return json.dumps({
                    "facts": [
                        {"id": "f1", "statement": "비오케이솔루션은 홈페이지 제작과 맞춤형 시스템 개발을 제공한다", "source_id": "s1", "confidence": "high"},
                        {"id": "f2", "statement": "홍커뮤니케이션은 MICE 행사 운영과 학술대회 운영 레퍼런스를 보유한다", "source_id": "s2", "confidence": "high"},
                        {"id": "f3", "statement": "서비스업 홈페이지는 예약, 결제, 고객 응대 흐름을 함께 설계해야 한다", "source_id": "s1", "confidence": "med"},
                    ],
                    "entities": [{"name": "비오케이솔루션", "type": "brand", "note": "홈페이지 제작", "source_id": "s1"}],
                }, ensure_ascii=False)
            if "콘텐츠 기획자" in system:
                return json.dumps({"coverage_targets": ["홈페이지 목적", "예약 접수", "결제 연동", "관리자 화면", "상담 전 체크"]}, ensure_ascii=False)
            if "한국어 블로그 편집장" in system or "개요를 짠다" in system:
                return json.dumps({
                    "title": "예약과 결제를 함께 보는 서비스업 홈페이지 제작 기준",
                    "meta_description": "예약, 결제, 알림톡, 관리자 화면을 함께 고려하는 홈페이지 제작 기준입니다.",
                    "sections": [
                        {"h2": "홈페이지 목적을 먼저 운영 흐름으로 정리합니다", "point": "문의, 예약, 결제 중 어떤 흐름이 핵심인지 정한다"},
                        {"h2": "예약 접수는 관리자 화면과 같이 설계합니다", "point": "신청폼과 관리자 확인 화면을 같은 데이터로 연결한다"},
                        {"h2": "결제와 알림톡은 고객 응대 기준까지 포함합니다", "point": "결제 확인과 안내 메시지 기준을 함께 정한다"},
                        {"h2": "학술대회와 MICE 운영처럼 데이터 흐름을 남깁니다", "point": "홍커뮤니케이션 레퍼런스처럼 접수와 사후 데이터를 운영 자산으로 남긴다"},
                        {"h2": "상담 전 체크리스트를 준비합니다", "point": "비오케이솔루션 상담 전 필요한 화면과 권한을 정리한다"},
                    ],
                }, ensure_ascii=False)
            if "한국어 블로그 전문 작가" in system:
                MockLLM.section_calls += 1
                variants = [
                    (
                        "서비스업 홈페이지는 예쁜 화면보다 **운영 흐름**을 먼저 정해야 합니다. "
                        "문의, 예약, 결제 중 어느 지점이 실제 매출과 응대 시간을 좌우하는지 정리해야 화면 구성이 흔들리지 않습니다.\n\n"
                        "- 첫 화면의 문의 버튼과 예약 버튼을 분리합니다.\n"
                        "- 고객이 남기는 필수 정보와 선택 정보를 구분합니다.\n"
                        "- 담당자가 확인할 관리자 항목을 먼저 정합니다.\n\n"
                        "비오케이솔루션은 홈페이지 제작 단계에서 신청폼과 관리자 화면을 함께 검토합니다. "
                        "이렇게 해야 방문자가 남긴 정보가 운영자가 바로 처리할 수 있는 데이터로 이어집니다."
                    ),
                    (
                        "예약 접수는 단순한 달력 기능이 아니라 **관리자 확인 화면**과 같이 설계해야 합니다. "
                        "예약 시간, 신청자 정보, 변경 요청, 취소 상태가 따로 관리되면 현장 응대가 늦어집니다.\n\n"
                        "- 예약 가능 시간과 마감 기준을 정합니다.\n"
                        "- 중복 신청과 변경 요청을 표시합니다.\n"
                        "- 관리자에게 필요한 검색 조건을 먼저 고릅니다.\n\n"
                        "학술대회 접수처럼 참가자 유형이 나뉘는 업무도 같은 원리입니다. "
                        "접수 데이터가 정리되어야 결제 확인과 안내 발송이 자연스럽게 이어집니다."
                    ),
                    (
                        "결제 연동은 결제 버튼을 붙이는 일에서 끝나지 않습니다. "
                        "**완료, 취소, 미입금, 환불** 상태를 운영자가 같은 화면에서 구분할 수 있어야 문의 대응이 빨라집니다.\n\n"
                        "- 결제 완료 후 자동 안내 문구를 준비합니다.\n"
                        "- 미입금 고객에게 보낼 알림 기준을 정합니다.\n"
                        "- 환불과 변경 요청의 담당 권한을 나눕니다.\n\n"
                        "알림톡이나 이메일은 고객에게 보이는 운영 품질입니다. "
                        "홈페이지 제작 전에 안내 시점과 문구를 정하면 반복 문의를 줄일 수 있습니다."
                    ),
                    (
                        "홍커뮤니케이션의 MICE 운영처럼 행사는 접수 이후의 데이터가 중요합니다. "
                        "참가자, 세션, 결제, 체크인 기록이 남아야 사후 보고와 다음 행사 기획에 쓸 수 있습니다.\n\n"
                        "- 참가자 구분과 참석 상태를 남깁니다.\n"
                        "- QR 체크인이나 현장 확인 기준을 정합니다.\n"
                        "- 행사 후 집계할 항목을 미리 고릅니다.\n\n"
                        "이 관점은 일반 서비스업 홈페이지에도 적용됩니다. "
                        "고객 신청 데이터를 운영 자산으로 남기면 관리자 대시보드와 마케팅 개선까지 연결됩니다."
                    ),
                    (
                        "상담 전에는 디자인 취향보다 **운영자가 매일 확인할 화면**을 먼저 정리하는 편이 좋습니다. "
                        "필요한 화면과 권한이 정리되면 홈페이지와 맞춤형 시스템의 경계도 분명해집니다.\n\n"
                        "- 고객이 입력할 항목을 정리합니다.\n"
                        "- 담당자가 수정할 수 있는 범위를 나눕니다.\n"
                        "- 결제, 알림, 통계가 필요한지 확인합니다.\n\n"
                        "비오케이솔루션 상담에서는 이 기준을 바탕으로 홈페이지 제작, 관리자 시스템, API 연동 범위를 나눠 검토할 수 있습니다."
                    ),
                ]
                return variants[(MockLLM.section_calls - 1) % len(variants)]
            if "구글 SEO 에디터" in system or "네이버 블로그 상위노출 에디터" in system:
                return json.dumps({
                    "seo_title": "서비스업 홈페이지 제작 기준",
                    "meta_description": "예약, 결제, 관리자 화면을 함께 설계하는 홈페이지 제작 기준입니다.",
                    "tags": ["홈페이지 제작", "예약 시스템", "결제 연동"],
                }, ensure_ascii=False)
            if "팩트체커" in system:
                return json.dumps({"claims": [{"claim": "홈페이지 제작", "status": "supported"}], "grounding_ratio": 0.95, "unsupported": []}, ensure_ascii=False)
            if "품질 검수자" in system:
                return json.dumps({"score": 55, "issues": ["unnatural_ko", "generic"], "verdict": "fail"}, ensure_ascii=False)
            return "{}"

    original_db_path = db.DB_PATH
    originals = {
        "section_max_len": config.SECTION_MAX_LEN,
        "generate_process_isolation": config.GENERATE_PROCESS_ISOLATION,
        "min_body_len": config.MIN_BODY_LEN,
        "min_grounding_ratio": config.MIN_GROUNDING_RATIO,
        "min_review_score": config.MIN_REVIEW_SCORE,
        "publish_spacing_min": config.PUBLISH_SPACING_MIN,
        "publish_window_start": config.PUBLISH_WINDOW_START,
        "publish_window_end": config.PUBLISH_WINDOW_END,
        "auto_seed_required_terms": list(config.AUTO_SEED_REQUIRED_TERMS),
        "search_provider": config.SEARCH_PROVIDER,
        "tavily_api_key": config.TAVILY_API_KEY,
        "collect": collect.collect,
        "analyze_serp": collect.analyze_serp,
        "generate_llm": generate.LLMClient,
        "factcheck_llm": factcheck.LLMClient,
        "review_llm": review.LLMClient,
    }
    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            db.DB_PATH = Path(tmpdir) / "blog.db"
            db.init_db()
            config.GENERATE_PROCESS_ISOLATION = False
            config.MIN_BODY_LEN = 800
            config.MIN_GROUNDING_RATIO = 0.9
            config.MIN_REVIEW_SCORE = 80
            config.PUBLISH_SPACING_MIN = 0
            config.PUBLISH_WINDOW_START = 0
            config.PUBLISH_WINDOW_END = 24
            config.AUTO_SEED_REQUIRED_TERMS = []
            config.SEARCH_PROVIDER = "tavily"
            config.TAVILY_API_KEY = "mock"
            collect.collect = lambda _queries, category="", topic="": [
                CollectedSource("비오케이솔루션", "https://beoksolution.com/", "비오케이솔루션은 홈페이지 제작과 맞춤형 시스템 개발을 제공한다.", "high"),
                CollectedSource("홍커뮤니케이션", "https://hongcomm.kr/", "홍커뮤니케이션은 MICE 행사 운영과 학술대회 운영 레퍼런스를 보유한다.", "high"),
            ]
            collect.analyze_serp = lambda _engine, _keyword: [
                {"title": "서비스업 홈페이지 제작 기준", "snippet": "예약 결제 관리자 화면", "url": "https://example.com"}
            ]
            generate.LLMClient = MockLLM
            factcheck.LLMClient = MockLLM
            review.LLMClient = MockLLM

            post_id = db.insert_draft(
                "selfhosted",
                "예약, 결제, 알림톡이 필요한 서비스업 홈페이지 설계 기준",
                "howto",
                category="beok",
            )
            generated = generate.run_once(batch=1)
            row = db.fetch_by_id(post_id)
            blockers = publish_blockers(row)
            body_chars = len(plain_text(row["body"]))
            body_images = image_count(row["body"])
            body_trusted_images = external_image_count(row["body"])
            if generated != 1:
                issues.append(f"ops-flow: generate 처리 수 불일치({generated})")
            if body_chars > 2600:
                issues.append(f"ops-flow: 생성 본문 길이 계약 위반({body_chars}/2600자)")
            if body_images < 2 or body_trusted_images < 2:
                issues.append(
                    f"ops-flow: 생성 이미지 계약 위반(images={body_images}, trusted={body_trusted_images})"
                )
            if blockers:
                issues.append(f"ops-flow: 생성 직후 발행 게이트 차단({body_chars}자): {blockers}")
            try:
                factcheck.run_once(batch=1)
                review.run_once(batch=1)
            except RuntimeError as exc:
                failed_row = db.fetch_by_id(post_id)
                issues.append(f"ops-flow: factcheck/review 통과 실패: {exc}; review_issues={failed_row['review_issues']}")
                queued = 0
            else:
                queued = schedule_publish.run_once()
            final = db.fetch_by_id(post_id)
            if final["status"] != "queued":
                issues.append(f"ops-flow: reviewed→queued 실패(status={final['status']}, queued={queued})")
    finally:
        db.DB_PATH = original_db_path
        config.SECTION_MAX_LEN = originals["section_max_len"]
        config.GENERATE_PROCESS_ISOLATION = originals["generate_process_isolation"]
        config.MIN_BODY_LEN = originals["min_body_len"]
        config.MIN_GROUNDING_RATIO = originals["min_grounding_ratio"]
        config.MIN_REVIEW_SCORE = originals["min_review_score"]
        config.PUBLISH_SPACING_MIN = originals["publish_spacing_min"]
        config.PUBLISH_WINDOW_START = originals["publish_window_start"]
        config.PUBLISH_WINDOW_END = originals["publish_window_end"]
        config.AUTO_SEED_REQUIRED_TERMS = originals["auto_seed_required_terms"]
        config.SEARCH_PROVIDER = originals["search_provider"]
        config.TAVILY_API_KEY = originals["tavily_api_key"]
        collect.collect = originals["collect"]
        collect.analyze_serp = originals["analyze_serp"]
        generate.LLMClient = originals["generate_llm"]
        factcheck.LLMClient = originals["factcheck_llm"]
        review.LLMClient = originals["review_llm"]
    return issues


def _test_generate_final_image_contract() -> list[str]:
    """compose_article 최종 후처리 뒤에도 운영 글 이미지와 길이 계약이 유지되어야 한다."""
    from pipeline import generate
    from tools.content_quality import external_image_count, image_count, image_urls, plain_text, publish_blockers

    issues: list[str] = []
    portfolio_url = (
        "https://hongcomm.kr/data/file/portfolio/"
        "thumb-2041025217_92nQ5Xlf_ed6ce67ee16dd8338be451bb5f960a847e7bf3a1_640x400.jpg"
    )
    protected = generate._strip_run_meta_text(  # noqa: SLF001 - 생성 최종 후처리 회귀테스트
        f"## 운영 기준\n\n![홍커뮤니케이션 MICE 포트폴리오 현장 레퍼런스 26]({portfolio_url})"
    )
    if portfolio_url not in protected:
        issues.append(f"generate-final-image: run-meta 제거가 이미지 URL을 훼손함({image_urls(protected)})")

    class MockLLM:
        section_calls = 0

        def chat(self, system: str, user: str, **_kw) -> str:
            if "한국어 블로그 편집장" in system or "개요를 짠다" in system:
                return json.dumps({
                    "title": "학회 사무국 운영과 홈페이지 시스템 연결 기준",
                    "meta_description": "학회 사무국 운영과 홈페이지 시스템을 함께 보는 기준입니다.",
                    "sections": [
                        {"h2": "사무국 접수 기준을 먼저 정합니다", "point": "접수 항목과 관리자 확인 기준을 맞춘다"},
                        {"h2": "명찰 출력 데이터는 하나로 관리합니다", "point": "참가자 정보와 QR 확인 기준을 연결한다"},
                        {"h2": "홈페이지 신청폼과 운영 화면을 연결합니다", "point": "비오케이솔루션 개발 범위를 데이터 흐름으로 나눈다"},
                        {"h2": "홍커뮤니케이션 레퍼런스를 운영 기준으로 봅니다", "point": "MICE 현장 운영 경험을 사전 준비 기준에 반영한다"},
                    ],
                }, ensure_ascii=False)
            if "한국어 블로그 전문 작가" in system:
                MockLLM.section_calls += 1
                return (
                    "학회 사무국은 접수, 결제, 명찰, 현장 확인을 따로 보지 않아야 합니다. "
                    "**홈페이지 신청폼과 관리자 화면**이 같은 데이터를 사용해야 운영자가 수정 기준을 빠르게 잡을 수 있습니다.\n\n"
                    "- 참가자 이름과 소속 표기 기준을 정합니다.\n"
                    "- 현장 변경 요청을 기록할 담당자를 나눕니다.\n"
                    "- QR 체크인과 명찰 재발행 로그를 함께 남깁니다."
                )
            if "구글 SEO 에디터" in system or "네이버 블로그 상위노출 에디터" in system:
                return json.dumps({
                    "seo_title": "학회 사무국 운영과 홈페이지 시스템 기준",
                    "meta_description": "학회 사무국 운영과 홈페이지 시스템 연결 기준입니다.",
                    "tags": ["학회 사무국", "홈페이지 시스템", "홍커뮤니케이션"],
                }, ensure_ascii=False)
            return "{}"

    result = generate.compose_article(
        MockLLM(),
        "학회 사무국 운영과 홈페이지 시스템 연결 기준",
        "howto",
        "google",
        {
            "intent": "학회 사무국 운영과 홈페이지 시스템 연결",
            "coverage_targets": ["접수", "명찰", "홈페이지", "MICE"],
            "facts": [
                {"statement": "비오케이솔루션은 홈페이지 제작과 맞춤형 시스템 개발을 제공한다", "source_title": "비오케이솔루션"},
                {"statement": "홍커뮤니케이션은 MICE 행사 운영과 학술대회 운영 레퍼런스를 보유한다", "source_title": "홍커뮤니케이션"},
            ],
            "sources": [{"title": "홍커뮤니케이션", "url": "https://hongcomm.kr/"}],
        },
        serp=[],
        brand_key="conference",
    )
    body = result["body"]
    post = {
        "id": 999991,
        "channel": "selfhosted",
        "category": "conference",
        "title": result["title"],
        "topic": "학회 사무국 운영과 홈페이지 시스템 연결 기준",
        "body": body,
        "updated_at": "2099-01-01 00:00:00",
    }
    body_chars = len(plain_text(body))
    if body_chars > 2600:
        issues.append(f"generate-final-image: 최종 본문 길이 초과({body_chars}/2600자)")
    if image_count(body) < 2 or external_image_count(body) < 2:
        issues.append(
            f"generate-final-image: 최종 이미지 부족(images={image_count(body)}, trusted={external_image_count(body)}, urls={image_urls(body)})"
        )
    blockers = publish_blockers(post)
    if blockers:
        issues.append(f"generate-final-image: 최종 발행 게이트 차단({body_chars}자): {blockers}")
    if re.search(r"^## .+!\[[^\]]*]\(", body, flags=re.M):
        issues.append("generate-final-image: 이미지 마크다운이 H2 제목 줄에 붙어 있음")
    return issues


def _test_grounding_specific_claim_contract() -> list[str]:
    """근거팩 밖 가격·기간·규모 수치는 생성/팩트체크 단계에서 남기지 않는다."""
    from pipeline import factcheck, generate

    evidence = {
        "facts": [
            {"statement": "비오케이솔루션은 홈페이지 제작과 맞춤형 시스템 개발을 제공한다"},
            {"statement": "홍커뮤니케이션은 MICE 행사 운영과 학술대회 운영 레퍼런스를 보유한다"},
            {"statement": "홍커뮤니케이션은 e-Regi 스마트 행사 등록 시스템을 제공한다"},
        ],
    }
    unsupported_body = (
        "## 운영 기준\n\n"
        "관리자형은 월 20만원부터 시작하고 최단 3일 안에 1차 시안을 볼 수 있습니다. "
        "38개국 언어 실시간 AI 동시통역과 프리미엄 운영형 월 50만원도 선택할 수 있습니다.\n\n"
        "비오케이솔루션은 홈페이지 제작과 맞춤형 시스템 개발을 제공합니다."
    )
    cleaned = generate._remove_unsupported_specific_claims(unsupported_body, evidence)  # noqa: SLF001
    issues: list[str] = []
    for token in ["월 20만원", "최단 3일", "38개국", "월 50만원"]:
        if token in cleaned:
            issues.append(f"grounding-contract: 근거 없는 구체 수치가 생성 본문에 잔존({token})")

    unsupported = factcheck.local_unsupported_claims(unsupported_body, evidence)
    if not any("월 20만원" in item for item in unsupported):
        issues.append(f"grounding-contract: 근거 없는 가격 claim 미검출({unsupported})")
    if not any("최단 3일" in item for item in unsupported):
        issues.append(f"grounding-contract: 근거 없는 기간 claim 미검출({unsupported})")
    if not any("38개국" in item for item in unsupported):
        issues.append(f"grounding-contract: 근거 없는 규모 claim 미검출({unsupported})")

    supported_body = (
        "## 운영 기준\n\n"
        "비오케이솔루션은 홈페이지 제작과 맞춤형 시스템 개발을 제공하고, "
        "홍커뮤니케이션은 MICE 행사 운영과 학술대회 운영 레퍼런스를 보유합니다. "
        "홍커뮤니케이션은 e-Regi 스마트 행사 등록 시스템을 제공합니다."
    )
    false_positive = factcheck.local_unsupported_claims(supported_body, evidence)
    if false_positive:
        issues.append(f"grounding-contract: 근거 안 사실 오탐({false_positive})")
    return issues


def _test_generate_final_length_band_contract() -> list[str]:
    """운영 글 최종 plain text는 900~2600자 밴드에 안정적으로 들어와야 한다."""
    from pipeline import generate
    from tools.content_quality import plain_text, publish_blockers

    evidence = {
        "intent": "학회 운영과 홈페이지 시스템 연결",
        "coverage_targets": ["접수", "명찰", "홈페이지", "관리자"],
        "facts": [
            {"statement": "비오케이솔루션은 홈페이지 제작과 맞춤형 시스템 개발을 제공한다", "source_title": "비오케이솔루션"},
            {"statement": "홍커뮤니케이션은 MICE 행사 운영과 학술대회 운영 레퍼런스를 보유한다", "source_title": "홍커뮤니케이션"},
            {"statement": "홍커뮤니케이션은 e-Regi 스마트 행사 등록 시스템을 제공한다", "source_title": "홍커뮤니케이션"},
        ],
        "sources": [{"title": "홍커뮤니케이션", "url": "https://hongcomm.kr/"}],
    }

    class ShortLLM:
        def chat(self, system: str, user: str, **_kw) -> str:
            if "한국어 블로그 편집장" in system or "개요를 짠다" in system:
                return json.dumps({
                    "title": "학회 접수와 홈페이지 운영 기준",
                    "meta_description": "학회 접수와 홈페이지 운영을 함께 보는 기준입니다.",
                    "sections": [
                        {"h2": "접수 기준을 맞춥니다", "point": "신청 항목과 확인 화면을 맞춘다"},
                        {"h2": "명찰 데이터를 정리합니다", "point": "참가자 표기와 재발행 기준을 정한다"},
                        {"h2": "관리자 화면을 나눕니다", "point": "수정 권한과 조회 항목을 나눈다"},
                        {"h2": "운영 기록을 남깁니다", "point": "행사 후 확인할 데이터를 남긴다"},
                    ],
                }, ensure_ascii=False)
            if "한국어 블로그 전문 작가" in system:
                return "접수 항목, 관리자 확인, 명찰 표기 기준을 같은 데이터로 맞춥니다."
            if "구글 SEO 에디터" in system or "네이버 블로그 상위노출 에디터" in system:
                return json.dumps({"seo_title": "학회 접수와 홈페이지 운영 기준", "meta_description": "학회 접수와 홈페이지 운영 기준입니다.", "tags": ["학회", "홈페이지"]}, ensure_ascii=False)
            return "{}"

    result = generate.compose_article(
        ShortLLM(),
        "학회 접수와 홈페이지 운영 기준",
        "howto",
        "google",
        evidence,
        serp=[],
        brand_key="conference",
    )
    body = result["body"]
    chars = len(plain_text(body))
    post = {
        "id": 999992,
        "channel": "selfhosted",
        "category": "conference",
        "title": result["title"],
        "topic": "학회 접수와 홈페이지 운영 기준",
        "body": body,
        "updated_at": "2099-01-01 00:00:00",
    }
    issues: list[str] = []
    if not (900 <= chars <= 2600):
        issues.append(f"generate-length-band: 최종 본문 길이 밴드 이탈({chars}/900~2600자)")
    blockers = publish_blockers(post)
    if any("본문 부족" in blocker or "본문 과다" in blocker for blocker in blockers):
        issues.append(f"generate-length-band: 발행 길이 게이트 차단({chars}자): {blockers}")

    long_body = (
        "## 접수 기준\n\n" + ("학회 접수와 관리자 화면은 같은 데이터를 기준으로 운영해야 합니다. " * 80)
        + "\n\n## 명찰 기준\n\n" + ("명찰 출력과 재발행 기록은 사무국 확인 흐름에 맞춰 남깁니다. " * 80)
        + "\n\n## 실행 전 점검표\n\n| 점검 | 기준 |\n|---|---|\n| 접수 | 관리자 확인 |\n"
    )
    fitted = generate._fit_operational_length_band(long_body, evidence, topic="학회 접수와 홈페이지 운영 기준")  # noqa: SLF001
    fitted_chars = len(plain_text(fitted))
    if not (900 <= fitted_chars <= 2200):
        issues.append(f"generate-length-band: 과긴 본문 보정 실패({fitted_chars}/900~2200자)")
    return issues


def _test_factcheck_all_errors_stop_runbook() -> list[str]:
    from pipeline import factcheck

    class FakeDb:
        def fetch_factcheck_ready(self, limit=5):
            return [{
                "id": 1,
                "body": "학술대회 등록 시스템 본문",
                "evidence": '{"facts":[{"statement":"근거"}]}',
            }]

        def claim(self, _post_id, _from_status, _to_status):
            return True

    original_db = factcheck.db
    original_check = factcheck.check
    original_client = factcheck.LLMClient
    try:
        factcheck.db = FakeDb()
        factcheck.LLMClient = lambda: object()
        factcheck.check = lambda _llm, _body, _evidence: (_ for _ in ()).throw(RuntimeError("LLM 429"))
        try:
            factcheck.run_once(batch=1)
        except RuntimeError:
            return []
        return ["factcheck: 모든 검증 오류를 성공 명령으로 처리함"]
    finally:
        factcheck.db = original_db
        factcheck.check = original_check
        factcheck.LLMClient = original_client


def _test_factcheck_all_failed_stop_runbook() -> list[str]:
    from pipeline import factcheck

    class FakeDb:
        def __init__(self):
            self.failed = 0

        def fetch_factcheck_ready(self, limit=5):
            return [{
                "id": 1,
                "body": "근거와 맞지 않는 본문",
                "evidence": '{"facts":[{"statement":"근거"}]}',
                "attempts": 0,
                "max_attempts": 5,
            }]

        def claim(self, _post_id, _from_status, _to_status):
            return True

        def save_grounding(self, _post_id, _ratio):
            return None

        def mark_review_failed(self, _post_id, _issues):
            self.failed += 1

        def save_body(self, _post_id, _body, to_status="draft"):
            return None

        def requeue_draft(self, _post_id, _attempts, _error, _max_attempts=5):
            return "draft"

    original_db = factcheck.db
    original_check = factcheck.check
    original_client = factcheck.LLMClient
    fake_db = FakeDb()
    try:
        factcheck.db = fake_db
        factcheck.LLMClient = lambda: object()
        factcheck.check = lambda _llm, _body, _evidence: {"grounding_ratio": 0.0, "unsupported": ["x"]}
        try:
            factcheck.run_once(batch=1)
        except RuntimeError:
            return [] if fake_db.failed == 1 else ["factcheck: 탈락 처리 기록 누락"]
        return ["factcheck: 모든 사실검증 탈락을 성공 명령으로 처리함"]
    finally:
        factcheck.db = original_db
        factcheck.check = original_check
        factcheck.LLMClient = original_client


def _test_review_all_errors_stop_runbook() -> list[str]:
    from pipeline import review

    class FakeDb:
        def fetch_review_ready(self, limit=5, min_grounding=0.9):
            return [{
                "id": 1,
                "channel": "selfhosted",
                "category": "",
                "title": "학술대회 등록 시스템",
                "topic": "학술대회 등록 시스템",
                "body": SAMPLE_MD,
                "updated_at": "2099-01-01 00:00:00",
            }]

        def claim(self, _post_id, _from_status, _to_status):
            return True

        def defer_review(self, _post_id, _issues):
            return None

    original_db = review.db
    original_client = review.LLMClient
    original_rule_gate = review.rule_gate
    original_llm_gate = review.llm_gate
    original_publish_blockers = review.publish_blockers
    try:
        review.db = FakeDb()
        review.LLMClient = lambda: object()
        review.rule_gate = lambda _body: []
        review.publish_blockers = lambda _post: []
        review.llm_gate = lambda _llm, _title, _body: (_ for _ in ()).throw(RuntimeError("LLM 429"))
        try:
            review.run_once(batch=1)
        except RuntimeError:
            return []
        return ["review: 모든 검수 오류를 성공 명령으로 처리함"]
    finally:
        review.db = original_db
        review.LLMClient = original_client
        review.rule_gate = original_rule_gate
        review.llm_gate = original_llm_gate
        review.publish_blockers = original_publish_blockers


def _test_review_applies_publish_gate_before_queue() -> list[str]:
    from pipeline import review

    class FakeDb:
        def __init__(self):
            self.failed: list[list[str]] = []

        def fetch_review_ready(self, limit=5, min_grounding=0.9):
            return [{
                "id": 1,
                "channel": "selfhosted",
                "category": "beok",
                "title": "긴 원고 테스트",
                "topic": "학술대회 홈페이지 시스템",
                "body": SAMPLE_MD,
                "updated_at": "2099-01-01 00:00:00",
            }]

        def claim(self, _post_id, _from_status, _to_status):
            return True

        def mark_review_failed(self, _post_id, issues):
            self.failed.append(issues)

        def mark_reviewed(self, _post_id):
            return None

    original_db = review.db
    original_client = review.LLMClient
    original_rule_gate = review.rule_gate
    original_publish_blockers = review.publish_blockers
    original_llm_gate = review.llm_gate
    fake_db = FakeDb()
    called_llm = {"value": False}
    try:
        review.db = fake_db
        review.LLMClient = lambda: object()
        review.rule_gate = lambda _body: []
        review.publish_blockers = lambda _post: ["운영 글 본문 과다(3200/2600자)"]
        review.llm_gate = lambda _llm, _title, _body: called_llm.__setitem__("value", True) or []
        issues: list[str] = []
        try:
            review.run_once(batch=1)
        except RuntimeError:
            pass
        else:
            issues.append("review-prepublish: 전부 차단된 검수를 성공 명령으로 처리함")
        if not fake_db.failed or "본문 과다" not in fake_db.failed[0][0]:
            issues.append(f"review-prepublish: 발행 게이트 이슈 미전파({fake_db.failed})")
        if called_llm["value"]:
            issues.append("review-prepublish: 명백한 발행 차단 원고에 LLM 검수를 호출함")
        return issues
    finally:
        review.db = original_db
        review.LLMClient = original_client
        review.rule_gate = original_rule_gate
        review.publish_blockers = original_publish_blockers
        review.llm_gate = original_llm_gate


def _test_publish_zero_success_fails_runbook() -> list[str]:
    from contextlib import contextmanager
    from pipeline import publish

    class FakeDb:
        def fetch_by_status(self, _status, limit=5, due=False):
            return [{"id": 1}]

        def claim(self, _post_id, _from_status, _to_status):
            return True

        def fetch_by_id(self, _post_id):
            return {
                "id": 1,
                "channel": "selfhosted",
                "title": "발행 실패 테스트",
                "topic": "학술대회 홈페이지 시스템",
                "body": SAMPLE_MD,
                "attempts": 0,
                "max_attempts": 3,
            }

        def mark_needs_human(self, _post_id, _error, attempts=1):
            return None

    class BlockingPublisher:
        def publish(self, _post):
            raise publish.NeedsHumanError("발행 전 품질 게이트 차단")

    @contextmanager
    def fake_lock():
        yield True

    original_db = publish.db
    original_publishers = publish.PUBLISHERS
    original_gate = publish._assert_publish_quality_gate
    original_lock = publish._publish_lock
    try:
        publish.db = FakeDb()
        publish.PUBLISHERS = {"selfhosted": BlockingPublisher()}
        publish._assert_publish_quality_gate = lambda _post: None
        publish._publish_lock = fake_lock
        try:
            publish.run_once(batch=1)
        except RuntimeError:
            return []
        return ["publish: 발행 대상이 전부 차단됐는데 성공 명령으로 처리함"]
    finally:
        publish.db = original_db
        publish.PUBLISHERS = original_publishers
        publish._assert_publish_quality_gate = original_gate
        publish._publish_lock = original_lock


def _test_image_diversity() -> list[str]:
    from tools.image_bank import _HONG_PORTFOLIO, featured_image, inject_images

    body = """## 학술대회 등록 시스템

등록 접수와 참가자 관리 기준을 확인합니다.

## 온라인 결제와 등록비

결제, 수수료, 등록비 정산 흐름을 확인합니다.

## 모바일 명찰과 QR 체크인

명찰, QR, 현장 체크인 기준을 확인합니다.

## 현장 명찰 출력 장비

출력기, 프린터, 재발행 창구를 확인합니다.

## 행사 통합 운영 관리

마스터 컨트롤러와 운영 시스템을 확인합니다.
"""
    rendered = inject_images(body, brand_key="hong")
    urls = re.findall(r"!\[[^\]]*]\(([^)]+)\)", rendered)
    unique = set(urls)
    issues: list[str] = []
    if len(unique) < 5:
        issues.append(f"image-bank: hong 이미지 다양성 부족(unique={len(unique)}, urls={urls})")
    if len(urls) != len(unique):
        issues.append("image-bank: 같은 글 안에서 이미지 URL 중복")

    if len(_HONG_PORTFOLIO) < 40:
        issues.append(f"image-bank: hongcomm 포트폴리오 이미지 풀 부족({len(_HONG_PORTFOLIO)}/40)")

    context = "홍커뮤니케이션 MICE 학술대회 포트폴리오 레퍼런스"
    featured = [featured_image("hong", context, salt=str(i)).get("url", "") for i in range(12)]
    if len(set(featured)) < 6:
        issues.append(f"image-bank: 글별 대표 이미지 회전 부족(unique={len(set(featured))}, urls={featured})")

    first = featured_image("hong", context, salt="same-post")
    second = featured_image("hong", context, salt="same-post", avoid={first.get("url", "")})
    if first and second and first.get("url") == second.get("url"):
        issues.append("image-bank: avoid 이미지가 대표 이미지 선택에서 제외되지 않음")

    sparse_body = """## 운영 기준

학회 접수와 홈페이지 제작 흐름을 한 화면에서 점검합니다.

## 실행 전 점검표

| 점검 | 기준 |
|---|---|
| 접수 | 관리자 확인 |
"""
    for brand_key in ["beok", "hong"]:
        rendered_sparse = inject_images(sparse_body, brand_key=brand_key, salt=f"sparse-{brand_key}")
        sparse_urls = re.findall(r"!\[[^\]]*]\(([^)]+)\)", rendered_sparse)
        trusted = [
            url for url in set(sparse_urls)
            if "hongcomm.kr/" in url or "beoksolution.com/" in url
        ]
        if len(trusted) < 2:
            issues.append(f"image-bank: {brand_key} sparse 운영 글 신뢰 이미지 부족({len(trusted)}/2, urls={sparse_urls})")
    return issues


def _test_publish_quality_gate() -> list[str]:
    from tools.content_quality import publish_blockers

    good_body = """## 학술대회 등록 기준

![학술대회 등록 시스템](https://hongcomm.kr/img/page/a1.png)

학회 사무국은 참가자 등록 기준과 결제 상태를 먼저 하나로 맞춰야 합니다. 홈페이지 신청폼, 등록 시스템, 관리자 대시보드가 같은 데이터를 보고 있어야 현장 접수에서 중복 확인이 줄어듭니다.
등록 데이터는 이름, 소속, 등록 구분, 결제 상태, QR 식별값을 같은 기준으로 관리해야 합니다. 사전 등록과 현장 등록이 섞이는 행사에서는 이 기준이 흔들리면 접수대에서 확인 전화와 재출력이 반복됩니다.

## 현장 명찰 출력 기준

![현장 명찰 출력 시스템](https://hongcomm.kr/img/page/c1.jpg)

명찰 출력은 최종 명단, QR 코드, 소속 표기, 재발행 승인 기준을 함께 확인해야 합니다. 비오케이솔루션은 홈페이지와 접수 데이터 흐름을, 홍커뮤니케이션은 MICE 현장 운영 레퍼런스를 기준으로 점검합니다.
현장 출력은 빠른 장비보다 같은 기준을 유지하는 절차가 더 중요합니다. 출력 담당자와 승인 담당자를 나누고, 수정 사유와 출력 시간을 남기면 행사 후 미수령자와 당일 변경 요청을 정리하기 쉽습니다.

## 운영 전 점검표

| 점검 항목 | 확인 기준 |
| --- | --- |
| 등록 데이터 | 홈페이지 신청 내역과 관리자 DB 일치 |
| 명찰 출력 | QR 스캔과 소속 표기 확인 |

## 시스템 연동 기준

현장 운영은 명찰 출력만으로 끝나지 않습니다. 등록, 결제, 체크인, 재발행 로그가 연결되어야 행사 후 참가자 데이터 정리와 문의 응대가 쉬워집니다.
홈페이지 제작 단계에서 신청폼과 관리자 화면을 어떻게 설계했는지가 현장 운영 품질로 이어집니다. 그래서 학술대회 운영 글은 단순한 명찰 제작 안내가 아니라 접수 시스템, 결제, 데이터 검수, 출력 현장을 함께 다뤄야 합니다.
운영 담당자는 행사 규모, 참가자 유형, 현장 등록 가능 여부, 결제 마감 시점, 명찰 양식을 한 번에 확인해야 합니다. 이 정보가 있어야 개발팀은 관리자 화면과 데이터 내보내기 형식을 맞추고, 현장팀은 접수대 배치와 출력 동선을 정할 수 있습니다.
"""
    long_body = good_body + ("\n\n반복 설명입니다." * 260)
    no_image_body = re.sub(r"!\[[^\]]*]\([^)\s]+\)\n\n", "", good_body)
    duplicate_image_body = good_body.replace("https://hongcomm.kr/img/page/c1.jpg", "https://hongcomm.kr/img/page/a1.png")
    thin_body = """## 안내

학회 명찰 출력 안내입니다.
"""
    base = {
        "id": 999001,
        "channel": "selfhosted",
        "category": "hong",
        "title": "학술대회 등록 시스템과 현장 명찰 출력 기준",
        "topic": "학술대회 등록 시스템과 현장 명찰 출력 기준",
        "updated_at": "2099-01-01 00:00:00",
    }
    cases = [
        ("good", good_body, []),
        ("too-long", long_body, ["본문 과다"]),
        ("no-image", no_image_body, ["이미지 부족", "계열 이미지 부족"]),
        ("duplicate-image", duplicate_image_body, ["이미지 URL 반복"]),
        ("thin", thin_body, ["본문 부족", "이미지 부족", "소제목 구조 부족", "점검표/비교표 없음"]),
    ]
    issues: list[str] = []
    for name, body, expected_fragments in cases:
        post = {**base, "body": body}
        blockers = publish_blockers(post)
        if not expected_fragments and blockers:
            issues.append(f"publish-gate: {name} 정상 글 차단: {blockers}")
            continue
        for fragment in expected_fragments:
            if not any(fragment in blocker for blocker in blockers):
                issues.append(f"publish-gate: {name} 기대 차단 누락({fragment}): {blockers}")
    return issues


def _test_review_llm_advisory_gate() -> list[str]:
    """LLM 검수는 주관적 개선 의견만으로 운영 재고를 0%로 만들면 안 된다."""
    import config
    from pipeline import review

    class MockReviewLLM:
        def __init__(self, response: str):
            self.response = response

        def chat(self, system: str, user: str, **kw) -> str:
            return self.response

    original_min_score = config.MIN_REVIEW_SCORE
    original_hard_fail = config.REVIEW_HARD_FAIL_SCORE
    try:
        config.MIN_REVIEW_SCORE = 80
        # 운영 PC .env가 임계값을 낮춰도(예: 40) 테스트는 코드 기본값 기준으로
        # 결정적으로 돌아야 한다. score=40 케이스가 40<40=False로 통과 실패하는
        # 환경 의존을 제거한다.
        config.REVIEW_HARD_FAIL_SCORE = 50
        cases = [
            (
                "subjective-soft-fail",
                '{"score":72,"issues":["generic","repetitive"],"verdict":"fail"}',
                [],
            ),
            (
                "operational-style-soft-fail",
                '{"score":55,"issues":["unnatural_ko","generic"],"verdict":"fail"}',
                [],
            ),
            (
                "very-low-score",
                '{"score":40,"issues":["generic"],"verdict":"fail"}',
                ["low_score"],
            ),
            (
                "critical-issue",
                '{"score":72,"issues":["off_topic"],"verdict":"fail"}',
                ["off_topic"],
            ),
            (
                "critical-with-mid-score",
                '{"score":55,"issues":["factual_doubt"],"verdict":"fail"}',
                ["factual_doubt"],
            ),
            (
                "normal-pass",
                '{"score":84,"issues":[],"verdict":"pass"}',
                [],
            ),
        ]
        issues: list[str] = []
        for name, response, expected_fragments in cases:
            blockers = review.llm_gate(MockReviewLLM(response), "학회 등록 시스템", SAMPLE_MD)
            if not expected_fragments and blockers:
                issues.append(f"review-gate: {name} 주관 이슈를 hard fail 처리함: {blockers}")
                continue
            for fragment in expected_fragments:
                if not any(fragment in blocker for blocker in blockers):
                    issues.append(f"review-gate: {name} 기대 차단 누락({fragment}): {blockers}")
        return issues
    finally:
        config.MIN_REVIEW_SCORE = original_min_score
        config.REVIEW_HARD_FAIL_SCORE = original_hard_fail


def _test_operational_agenda_defaults() -> list[str]:
    import config
    from tools.keyword_bank import KEYWORDS, _BASE_KEYWORD_COUNT

    issues: list[str] = []
    if config.GENERATE_BATCH != 1:
        issues.append(f"ops-defaults: 원격 제어 generate batch는 1이어야 함 ({config.GENERATE_BATCH})")
    if len(KEYWORDS) - _BASE_KEYWORD_COUNT < 250:
        issues.append(f"agenda: 확장 키워드 부족({len(KEYWORDS) - _BASE_KEYWORD_COUNT}/250)")

    topics = [topic for topic, _ctype, brand in KEYWORDS[:12] if brand == "beok"]
    required = ["초기 제작비", "월 5만원", "예약", "결제", "알림톡", "Search Console", "AI 상담", "학회 기관 홈페이지"]
    joined = "\n".join(topics)
    for token in required:
        if token not in joined:
            issues.append(f"agenda: beoksolution 홈페이지 구축 주제 누락: {token}")
    return issues


def _test_stock_seed_after_base_keyword_exhaustion() -> list[str]:
    """기본 키워드가 모두 사용된 DB에서도 확장 주제로 stock_seed가 재고를 보충해야 한다."""
    import config
    import tempfile
    from db import db
    from tools import auto_seed
    from tools.keyword_bank import KEYWORDS, _BASE_KEYWORD_COUNT

    original_db_path = db.DB_PATH
    originals = {
        "required_terms": list(config.AUTO_SEED_REQUIRED_TERMS),
        "brand_filter": config.AUTO_SEED_BRAND_FILTER,
        "external_auto_seed": config.ALLOW_EXTERNAL_AUTO_SEED,
    }
    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            db.DB_PATH = Path(tmpdir) / "blog.db"
            db.init_db()
            config.AUTO_SEED_REQUIRED_TERMS = []
            config.AUTO_SEED_BRAND_FILTER = ""
            config.ALLOW_EXTERNAL_AUTO_SEED = False
            for topic, content_type, brand_key in KEYWORDS[:_BASE_KEYWORD_COUNT]:
                db.insert_draft("selfhosted", topic, content_type, category=brand_key)
            created = auto_seed.run_stock("selfhosted", target=_BASE_KEYWORD_COUNT + 8)
            with db.connect() as conn:
                total = conn.execute("SELECT COUNT(*) AS n FROM posts").fetchone()["n"]
                new_rows = conn.execute(
                    "SELECT topic, category FROM posts ORDER BY id DESC LIMIT ?",
                    (created,),
                ).fetchall()
        issues: list[str] = []
        if created < 8:
            issues.append(f"stock-seed: 기본 키워드 소진 후 확장 주제 생성 부족({created}/8)")
        if total < _BASE_KEYWORD_COUNT + 8:
            issues.append(f"stock-seed: 전체 draft 수 부족({total})")
        # 특정 토큰(홈페이지/학회 등)은 테마 포화 캡에 걸려 의도적으로 회피될 수
        # 있으므로, 문자 매칭 대신 주제축(pillar) 커버리지로 다양성을 검증한다.
        from tools.keyword_bank import pillar_of
        pillars = {pillar_of(row["topic"] or "", row["category"] or "") for row in new_rows}
        if len(pillars) < 3:
            issues.append(f"stock-seed: 확장 주제 축 다양성 부족(pillar {len(pillars)}종: {sorted(pillars)})")
        return issues
    finally:
        db.DB_PATH = original_db_path
        config.AUTO_SEED_REQUIRED_TERMS = originals["required_terms"]
        config.AUTO_SEED_BRAND_FILTER = originals["brand_filter"]
        config.ALLOW_EXTERNAL_AUTO_SEED = originals["external_auto_seed"]


def _test_reset_draft_backlog_plan() -> list[str]:
    from tools import reset_draft_backlog

    original_protected = reset_draft_backlog._protected_topic_keys
    try:
        reset_draft_backlog._protected_topic_keys = lambda _channels, _archive_ids: set()
        topics = reset_draft_backlog.replacement_topics(8, "selfhosted", archive_ids=[])
        pillars = {axis for _topic, _ctype, _brand, axis in topics}
        issues: list[str] = []
        # notebook_return은 별도 브랜드(쿠팡 파트너스)이므로 selfhosted 채널
        # 재시드 계획에 절대 섞이면 안 된다(auto_seed와 동일한 채널 필터 적용 검증).
        if "notebook_return" in pillars:
            issues.append("draft-reset: selfhosted 채널에 notebook_return 주제 유입")
        if len(pillars) < 5:
            issues.append(f"draft-reset: replacement plan 주제축 다양성 부족({len(pillars)}종: {sorted(pillars)})")
        if not topics or "초기 제작비" not in topics[0][0]:
            issues.append("draft-reset: beoksolution 홈페이지 운영형 주제가 우선 배치되지 않음")
        return issues
    finally:
        reset_draft_backlog._protected_topic_keys = original_protected


def _test_reset_draft_backlog_avoids_archived_topics() -> list[str]:
    import tempfile
    from db import db
    from tools import reset_draft_backlog
    from tools.keyword_bank import KEYWORDS

    original_db_path = db.DB_PATH
    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            db.DB_PATH = Path(tmpdir) / "blog.db"
            db.init_db()
            topic, content_type, category = KEYWORDS[0]
            post_id = db.insert_draft("selfhosted", topic, content_type, category=category)
            replacements = reset_draft_backlog.replacement_topics(4, "selfhosted", archive_ids=[post_id])
        repeated = [candidate for candidate, _ctype, _brand, _axis in replacements if candidate == topic]
        if repeated:
            return [f"draft-reset: archive 대상 주제를 즉시 재시드함: {topic}"]
        return []
    finally:
        db.DB_PATH = original_db_path


def _test_reset_draft_backlog_default_scope() -> list[str]:
    from tools import reset_draft_backlog

    unsafe = {"reviewed", "queued", "published"}
    overlap = unsafe & set(reset_draft_backlog.ACTIVE_STATUSES)
    if overlap:
        return [f"draft-reset: 기본 reset 범위가 발행 후보 상태까지 포함함: {sorted(overlap)}"]
    return []


def _test_content_reboot_plan() -> list[str]:
    from collections import Counter
    from tools import content_reboot

    topics = content_reboot.balanced_topics(24)
    axis_counts = Counter(axis for _topic, _ctype, _brand, axis in topics)
    titles = [topic for topic, _ctype, _brand, _axis in topics]
    joined = "\n".join(titles)
    issues: list[str] = []

    for axis in {"homepage", "system", "mice", "conference"}:
        if axis_counts[axis] != 6:
            issues.append(f"content-reboot: {axis} 주제 수 불균형({axis_counts[axis]}/6)")
    if len(titles) != len(set(titles)):
        issues.append("content-reboot: 중복 주제 포함")
    if joined.count("명찰") > 1 or joined.count("사무국") > 1:
        issues.append("content-reboot: 명찰/사무국 편중 주제가 다시 포함됨")
    for token in ["홈페이지", "시스템", "홍커뮤니케이션", "MICE", "학술대회"]:
        if token not in joined:
            issues.append(f"content-reboot: 필수 홍보 아젠다 누락: {token}")
    return issues


def _test_windows_ops_orchestration_contract() -> list[str]:
    windows_dir = ROOT / "blog_publisher" / "ops" / "windows"
    run_task = (windows_dir / "run-task.ps1").read_text(encoding="utf-8")
    install = (windows_dir / "install-windows-tasks.ps1").read_text(encoding="utf-8")
    run_control = (windows_dir / "run-control.ps1").read_text(encoding="utf-8")
    issues: list[str] = []

    if "[switch]$RunControl" not in run_task:
        issues.append("windows-ops: run-task 기본 실행에서 control queue를 끌 수 없음")
    if "if ($RunControl -and !$SkipControl" not in run_task:
        issues.append("windows-ops: 예약 태스크가 기본으로 inline control을 실행할 위험")
    if "Register-ControlTask" not in install or "-MaxCommands 3" not in install:
        issues.append("windows-ops: 전용 BEOK Blog Control 태스크 등록 누락")
    if "Set-TaskRuntimePolicy" not in install:
        issues.append("windows-ops: ScheduledTask ExecutionTimeLimit 보정 함수 누락")
    if install.count("Set-TaskRuntimePolicy -TaskName $tn -Minutes 20") < 2:
        issues.append("windows-ops: minute/control 태스크 20분 제한 보정 누락")
    if "RestartOnFailure" not in install or "Register-StartupWorker" not in install:
        issues.append("windows-ops: Worker 실패 재시작 설정 누락")
    if "Ensure-WorkerHealthy" not in run_control or "127.0.0.1:8788/health" not in run_control:
        issues.append("windows-ops: Control 태스크의 Worker health watchdog 누락")
    return issues


def _test_selfhosted_renderer() -> list[str]:
    from render.renderer import render_body

    html = render_body({
        "title": "학회 운영 사무국 명찰 출력 품질 셀프테스트",
        "body": SAMPLE_MD,
        "meta_desc": "학회 운영 사무국 명찰 출력 품질 셀프테스트입니다.",
        "tags": ["학회 운영", "명찰 출력"],
        "category": "beok",
        "topic": "학회 운영 사무국 명찰 출력",
        "locale": "ko",
    })
    issues: list[str] = []
    issues += _assert_contains(
        "selfhosted",
        html,
        [
            "summary-card",
            "summary-decision",
            "service-proof",
            "비오케이솔루션 실무 점검 범위",
            "operation-flow",
            "사무국 운영 흐름",
            "ops-comparison",
            "현장 혼잡을 줄이는 운영 기준 비교",
            'class="toc"',
            "soft-cta",
            "table-wrap",
            "<img ",
            "content-callout",
        ],
    )
    if "<article" in html or "<h1" in html:
        issues.append("selfhosted: 저장 fragment에 article/h1 포함")
    if "[이미지:" in html:
        issues.append("selfhosted: 이미지 텍스트 마커 노출")
    return issues


def _test_renderer_brand_variants() -> list[str]:
    """브랜드/주제축별 렌더 컴포넌트 분기 — 명찰 전용 블록 하드코딩 회귀 방지.

    beok(홈페이지 개발)·hong(MICE)·notebook_return(반품 노트북) 글에도 각자의
    점검 범위/운영 흐름/비교표/CTA가 붙어야 하고, 서로의 문구가 섞이면 안 된다.
    notebook_return은 쿠팡 파트너스 고지와 스타일 내장(embed)까지 검증한다.
    """
    from render.renderer import render_body, render_body_embed

    issues: list[str] = []

    beok_html = render_body({
        "title": "학원 홈페이지 제작에서 예약 시스템 설계 기준",
        "body": SAMPLE_MD,
        "meta_desc": "홈페이지 개발 렌더 테스트",
        "category": "beok",
        "topic": "학원 홈페이지 제작 예약 결제 관리자",
    })
    issues += _assert_contains("renderer-beok", beok_html, [
        "service-proof", "비오케이솔루션 구축 범위",
        "operation-flow", "개발 진행 흐름",
        "ops-comparison", "soft-cta", "beoksolution.com",
    ])
    if "명찰 발행은" in beok_html:
        issues.append("renderer-beok: 홈페이지 글에 명찰 운영 블록 노출")

    hong_html = render_body({
        "title": "국제학술대회 AI 동시통역 준비 방법",
        "body": SAMPLE_MD,
        "meta_desc": "MICE 렌더 테스트",
        "category": "hong",
        "topic": "홍커뮤니케이션 MICE 동시통역",
    })
    issues += _assert_contains("renderer-hong", hong_html, [
        "홍커뮤니케이션 운영 범위", "행사 운영 흐름", "hongcomm.kr", "홍커뮤니케이션 문의하기",
    ])
    if ">상담 문의하기<" in hong_html:
        issues.append("renderer-hong: hong 글 CTA가 비오케이솔루션으로 잘못 연결")

    nb_html = render_body_embed({
        "title": "반품 노트북 등급 차이와 고르는 기준",
        "body": SAMPLE_MD,
        "meta_desc": "반품 노트북 렌더 테스트",
        "category": "notebook_return",
        "topic": "반품 노트북 등급 비교",
    })
    issues += _assert_contains("renderer-notebook", nb_html, [
        "partner-disclosure", "쿠팡 파트너스 활동",
        "구매 전 확인 범위", "구매 판단 흐름",
        "notebook-return.web.app", "시세·재고 확인하기",
        "<style>", "bp-article",
    ])
    if "상담 문의하기" in nb_html:
        issues.append("renderer-notebook: 소비자 콘텐츠에 상담 CTA 노출")
    return issues


def _test_renderer_security_and_normalization() -> list[str]:
    from render.renderer import render_body
    from tools.og_card import build_og_svg

    body = """## 결론 요약![홍커뮤니케이션 등록 시스템](https://hongcomm.kr/img/page/a1.png)

위험 링크는 [누르면 안 됨](javascript:alert(1))으로 들어와도 텍스트만 남아야 합니다.

![위험 이미지](javascript:alert(2))

## 안전한 참고

[공식 사이트](https://hongcomm.kr/) 링크는 유지되어야 합니다.
"""
    html = render_body({
        "title": "보안 렌더 테스트",
        "body": body,
        "meta_desc": "렌더러 보안 테스트",
        "category": "hong",
        "topic": "학술대회 등록 시스템",
        "source_url": "javascript:alert(3)",
        "hero_image": "javascript:alert(4)",
    })
    issues: list[str] = []
    if "javascript:" in html:
        issues.append("renderer-security: 위험 URL 스킴 노출")
    if "![" in html:
        issues.append("renderer-normalize: 마크다운 이미지 원문 노출")
    if any("<img" in h2 for h2 in re.findall(r"<h2\b[^>]*>.*?</h2>", html, flags=re.I | re.DOTALL)):
        issues.append("renderer-normalize: 이미지가 h2 내부에 남음")
    if "<figure>" not in html or "홍커뮤니케이션 등록 시스템" not in html:
        issues.append("renderer-normalize: 안전 이미지 figure/caption 승격 실패")
    if 'href="https://hongcomm.kr/"' not in html:
        issues.append("renderer-security: 안전 링크 제거됨")
    if "참고 출처:" in html:
        issues.append("renderer-security: 위험 source_url footer 노출")

    svg = build_og_svg({
        "title": '학회 <script>alert("x")</script> 명찰',
        "category": "hong",
        "tags": ['태그"><script>'],
    })
    if "<script>" in svg or '태그"><script>' in svg:
        issues.append("og-card: SVG 텍스트 escape 실패")
    return issues


def _test_tistory_adapter() -> list[str]:
    script = f"""
import {{ convertForTistory, validateTistoryHtml }} from './tistory-html-adapter.mjs'
const source = {SAMPLE_MD!r}
const html = await convertForTistory(source)
const quality = validateTistoryHtml(html)
const issues = []
if (!quality.ok) issues.push(...quality.reasons)
for (const token of ['<h2', '<ul', '<ol', '<table', '<blockquote', '<img ', '<strong', '운영 체크포인트', '비오케이솔루션', '데이터 검수', '현장 재발행', '사무국 운영 흐름', '현장 혼잡을 줄이는 운영 기준 비교']) {{
  if (!html.includes(token)) issues.push(`티스토리: ${{token}} 누락`)
}}
if (html.includes('[이미지:')) issues.push('티스토리: 이미지 텍스트 마커 노출')
if (!/상담|문의|운영\\s*상담/.test(html)) issues.push('티스토리: 상담 CTA 누락')
console.log(JSON.stringify({{ ok: issues.length === 0, issues, quality: quality.quality }}))
process.exit(issues.length ? 1 : 0)
"""
    proc = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd=WORKER_DIR,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        timeout=30,
        check=False,
    )
    if proc.returncode == 0:
        return []
    output = "\n".join(part for part in [proc.stdout.strip(), proc.stderr.strip()] if part)
    return [f"tistory: adapter quality selftest failed\n{output}"]


def _test_channel_rewriter_gate() -> list[str]:
    good_html = """
<p>핵심 요약: 학회 운영 사무국은 명찰 출력 전 데이터 기준, 출력 순서, 현장 재발행 기준을 함께 확인해야 합니다.</p>
<ul>
  <li><strong>명단 기준 파일</strong>을 하나로 고정합니다.</li>
  <li><strong>QR 코드</strong> 스캔 정상 여부를 샘플로 확인합니다.</li>
  <li><strong>재발행 로그</strong>를 남겨 중복 출력을 막습니다.</li>
  <li><strong>소모품 수량</strong>을 접수 시작 전 다시 확인합니다.</li>
</ul>
<h2>운영 체크포인트</h2>
<ul>
  <li><strong>명단 확정 시각</strong>을 출력 전 기준으로 고정했는지 확인합니다.</li>
  <li><strong>출력 샘플</strong>로 줄바꿈과 코드 스캔을 확인합니다.</li>
  <li><strong>재발행 승인자</strong>와 출력 담당자를 분리합니다.</li>
  <li><strong>행사 후 기록</strong>으로 변경 요청을 정리합니다.</li>
</ul>
<h2>무엇을 먼저 확인해야 하나</h2>
<p>사무국은 이름, 소속, 직함, 등록 구분, 식별 코드를 같은 기준으로 정리해야 합니다. 파일이 여러 개로 갈라지면 현장에서는 어느 항목이 최종인지 판단하기 어렵습니다.</p>
<h2>왜 출력 전 샘플이 필요한가</h2>
<table><tbody><tr><th>점검 항목</th><th>확인 기준</th></tr><tr><td>이름</td><td>오탈자와 띄어쓰기 확인</td></tr><tr><td>코드</td><td>스캔 후 참가자 정보 연결 확인</td></tr></tbody></table>
<p>샘플 출력은 전체 출력 전에 줄바꿈, 여백, 절단선, 케이스 삽입 상태를 확인하는 과정입니다.</p>
<h2>어떻게 현장 재발행을 관리하나</h2>
<blockquote>현장 재발행은 빠른 처리보다 같은 기준을 유지하는 것이 중요합니다.</blockquote>
<p>재발행 요청이 들어오면 수정 사유, 승인 담당자, 출력 시간을 남겨야 합니다. 이 기록은 행사 후 미수령자와 당일 등록자를 정리하는 근거가 됩니다.</p>
<h2>상담 전 체크리스트</h2>
<p>비오케이솔루션은 학회 운영 사무국의 명찰 출력, 참가자 데이터 정리, 현장 재발행 기준을 함께 점검합니다. 운영 상담이 필요하면 행사 규모와 출력 방식부터 문의해 주세요.</p>
<p>상담 전에는 참가자 수, 등록 구분, 현장 등록 가능 여부, 명찰 크기, 출력 장비, QR 또는 바코드 사용 여부를 정리해 두면 좋습니다. 이 정보가 있어야 출력 템플릿과 접수 동선을 함께 검토할 수 있습니다.</p>
<p>특히 학회 행사는 발표자, 좌장, 초청자, 운영진처럼 서로 다른 표기가 필요한 그룹이 많습니다. 사무국이 그룹별 표기 규칙을 먼저 정해 두면 명찰 발행 직전의 수정 요청을 줄일 수 있습니다.</p>
<p>비오케이솔루션은 명찰 출력만 따로 보지 않고 참가자 데이터, 접수 확인, 재발행 승인, 행사 후 정산 자료까지 연결된 흐름으로 점검합니다. 이 기준을 갖추면 현장 접수대의 응대 속도와 참가자 경험이 함께 안정됩니다.</p>
"""
    thin_html = "<p>핵심 요약: 명찰을 출력합니다. 상담 문의 주세요.</p><h2>안내</h2><p>짧은 글입니다.</p>"
    hanzi_html = good_html.replace("명찰 출력", "名札 출력", 1)
    hype_html = good_html.replace("운영 상담이 필요하면", "운영 꿀팁이 필요하면", 1)
    semantic_risk_html = good_html.replace(
        "사무국은 이름, 소속, 직함, 등록 구분, 식별 코드를 같은 기준으로 정리해야 합니다.",
        "핵심은 단순히 명찰 출력 기능에 있습니다.",
        1,
    )

    script = f"""
import {{ validateTistoryRewrite }} from './channel-rewriter.mjs'
const cases = [
  ['good', {good_html!r}, true],
  ['thin', {thin_html!r}, false],
  ['hanzi', {hanzi_html!r}, false],
  ['hype', {hype_html!r}, false],
  ['semantic-risk', {semantic_risk_html!r}, false],
]
const failures = []
for (const [name, html, expected] of cases) {{
  const result = validateTistoryRewrite(html, 900)
  if (result.ok !== expected) {{
    failures.push(`${{name}} expected ${{expected}} got ${{result.ok}}: ${{result.reasons.join(', ')}}`)
  }}
}}
console.log(JSON.stringify({{ ok: failures.length === 0, failures }}))
process.exit(failures.length ? 1 : 0)
"""
    proc = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd=WORKER_DIR,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        timeout=30,
        check=False,
    )
    if proc.returncode == 0:
        return []
    output = "\n".join(part for part in [proc.stdout.strip(), proc.stderr.strip()] if part)
    return [f"rewriter: tistory quality gate selftest failed\n{output}"]


def _test_tistory_rewrite_required_gate() -> list[str]:
    script = f"""
import {{ channelRewriteEnabled, rewriteForChannel }} from './channel-rewriter.mjs'
const source = {SAMPLE_MD!r}
const result = await rewriteForChannel({{
  title: '학회 운영 사무국 명찰 출력 품질 셀프테스트',
  html: source,
  channel: 'tistory',
  canonicalUrl: 'https://beoksolution.com/blog/sample',
}})
const required = process.env.TISTORY_REWRITE_REQUIRED !== 'false'
const shouldBlock = required && channelRewriteEnabled() && !result.rewritten
const issues = []
if (!shouldBlock) issues.push(`티스토리 재작성 필수 게이트 미작동: rewritten=${{result.rewritten}}, error=${{result.rewrite_error || ''}}`)
if (!result.rewrite_error) issues.push('티스토리 재작성 실패 사유 누락')
console.log(JSON.stringify({{ ok: issues.length === 0, rewritten: result.rewritten, rewrite_error: result.rewrite_error, shouldBlock, issues }}))
process.exit(issues.length ? 1 : 0)
"""
    proc = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd=WORKER_DIR,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        timeout=30,
        check=False,
        env=_subprocess_env(
            CHANNEL_REWRITE="true",
            TISTORY_REWRITE_REQUIRED="true",
            AI_API_KEY="",
        ),
    )
    if proc.returncode == 0:
        return []
    output = "\n".join(part for part in [proc.stdout.strip(), proc.stderr.strip()] if part)
    return [f"rewriter: tistory rewrite-required selftest failed\n{output}"]


def run() -> bool:
    issues = (
        _test_phase_a_generation_contract()
        + _test_generate_rejects_empty_article()
        + _test_generate_hard_compacts_long_section()
        + _test_generate_all_failures_stop_runbook()
        + _test_operational_generation_length_contract_queues()
        + _test_generate_final_image_contract()
        + _test_grounding_specific_claim_contract()
        + _test_generate_final_length_band_contract()
        + _test_factcheck_all_errors_stop_runbook()
        + _test_factcheck_all_failed_stop_runbook()
        + _test_review_all_errors_stop_runbook()
        + _test_review_applies_publish_gate_before_queue()
        + _test_publish_zero_success_fails_runbook()
        + _test_image_diversity()
        + _test_publish_quality_gate()
        + _test_review_llm_advisory_gate()
        + _test_operational_agenda_defaults()
        + _test_stock_seed_after_base_keyword_exhaustion()
        + _test_reset_draft_backlog_plan()
        + _test_reset_draft_backlog_avoids_archived_topics()
        + _test_reset_draft_backlog_default_scope()
        + _test_content_reboot_plan()
        + _test_windows_ops_orchestration_contract()
        + _test_selfhosted_renderer()
        + _test_renderer_brand_variants()
        + _test_renderer_security_and_normalization()
        + _test_tistory_adapter()
        + _test_channel_rewriter_gate()
        + _test_tistory_rewrite_required_gate()
    )
    print("=== Phase A/B 품질 셀프테스트 ===")
    if issues:
        for issue in issues:
            print(f"[FAIL] {issue}")
        print(f"\n결과: FAIL ({len(issues)}건)")
        return False
    print("[OK] phase-a generation: 200~260자 프롬프트·토큰 캡·섹션 thinking·한자 재시도/제거 유지")
    print("[OK] generate gate: 빈 본문/불완전 생성 결과 저장 차단")
    print("[OK] ops flow: 운영 글 생성 길이와 발행 게이트 길이 상한 정합, queued 전환 유지")
    print("[OK] image bank: 섹션별 이미지 다양성 유지")
    print("[OK] publish gate: 길이/이미지/구조/반복 이미지 차단 유지")
    print("[OK] review gate: 주관적 LLM 이슈는 advisory, 치명 이슈/저점수는 차단")
    print("[OK] ops defaults: 홈페이지 구축 아젠다·generate batch 유지")
    print("[OK] draft reset: 미공개 병목 리셋 시 다양한 주제축 재시드")
    print("[OK] content reboot: 기존 재고 폐기 후 홈페이지/시스템/MICE/학술대회 주제축 균등 재시드")
    print("[OK] windows ops: Control 전용 큐 처리·20분 제한·Worker watchdog 계약 유지")
    print("[OK] selfhosted renderer: summary/service-proof/toc/cta/table/image/callout 유지")
    print("[OK] renderer security: URL 스킴 세척·제목 이미지 분리·OG SVG escape 유지")
    print("[OK] tistory adapter: h2/list/table/callout/image/strong/service-proof/CTA 유지")
    print("[OK] channel rewriter: 티스토리 얇은 글/한자/금칙톤/의미위험 차단")
    print("[OK] channel rewriter: 티스토리 재작성 실패 시 원문 발행 차단")
    print("\n결과: PASS")
    return True


if __name__ == "__main__":
    import sys

    raise SystemExit(0 if run() else 1)
