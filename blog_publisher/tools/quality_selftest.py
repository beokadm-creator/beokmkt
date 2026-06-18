"""
Phase A/B 품질 셀프테스트.

외부 발행이나 LLM 호출 없이, 실제 렌더러/티스토리 어댑터를 실행해
생성 품질 계약과 리치 HTML 구성요소가 사라지지 않는지 확인한다.
"""
from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
WORKER_DIR = ROOT / "executors" / "naver-blog-worker"


def _subprocess_env(**overrides: str) -> dict[str, str]:
    env = os.environ.copy()
    env.update({key: value for key, value in overrides.items() if value is not None})
    return env


SAMPLE_MD = """학회 운영 사무국의 명찰 출력은 참가자 응대 품질과 바로 연결됩니다.

![학회 명찰 출력 체크리스트](https://beokmkt.web.app/assets/blog/beok/checklist-card.svg)

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
    if config.SECTION_MAX_LEN > 1000:
        issues.append(f"phase-a: SECTION_MAX_LEN > 1000 ({config.SECTION_MAX_LEN})")
    for token in ["350~650자", "### 소소제목", "`**굵게**`", "마크다운 표", "한자"]:
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
    for token in ["###", "- ", "**", "| 항목 | 확인 기준 |"]:
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


def _test_review_all_errors_stop_runbook() -> list[str]:
    from pipeline import review

    class FakeDb:
        def fetch_review_ready(self, limit=5, min_grounding=0.9):
            return [{
                "id": 1,
                "title": "학술대회 등록 시스템",
                "body": SAMPLE_MD,
            }]

        def claim(self, _post_id, _from_status, _to_status):
            return True

        def defer_review(self, _post_id, _issues):
            return None

    original_db = review.db
    original_client = review.LLMClient
    original_rule_gate = review.rule_gate
    original_llm_gate = review.llm_gate
    try:
        review.db = FakeDb()
        review.LLMClient = lambda: object()
        review.rule_gate = lambda _body: []
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


def _test_image_diversity() -> list[str]:
    from tools.image_bank import inject_images

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
    try:
        config.MIN_REVIEW_SCORE = 80
        cases = [
            (
                "subjective-soft-fail",
                '{"score":72,"issues":["generic","repetitive"],"verdict":"fail"}',
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


def _test_operational_agenda_defaults() -> list[str]:
    import config
    from tools.keyword_bank import KEYWORDS

    issues: list[str] = []
    if config.GENERATE_BATCH != 1:
        issues.append(f"ops-defaults: 원격 제어 generate batch는 1이어야 함 ({config.GENERATE_BATCH})")

    topics = [topic for topic, _ctype, brand in KEYWORDS[:12] if brand == "beok"]
    required = ["초기 제작비", "월 5만원", "예약", "결제", "알림톡", "Search Console", "AI 상담", "학회 기관 홈페이지"]
    joined = "\n".join(topics)
    for token in required:
        if token not in joined:
            issues.append(f"agenda: beoksolution 홈페이지 구축 주제 누락: {token}")
    return issues


def _test_reset_draft_backlog_plan() -> list[str]:
    from tools import reset_draft_backlog

    original_protected = reset_draft_backlog._protected_topic_keys
    try:
        reset_draft_backlog._protected_topic_keys = lambda _channels, _archive_ids: set()
        topics = reset_draft_backlog.replacement_topics(8, "selfhosted", archive_ids=[])
        axes = {axis for _topic, _ctype, _brand, axis in topics}
        issues: list[str] = []
        for axis in {"homepage", "conference_system", "mice_reference", "badge_ops"}:
            if axis not in axes:
                issues.append(f"draft-reset: replacement plan axis 누락: {axis}")
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
  canonicalUrl: 'https://beokmkt.web.app/blog/sample',
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
        + _test_generate_all_failures_stop_runbook()
        + _test_factcheck_all_errors_stop_runbook()
        + _test_review_all_errors_stop_runbook()
        + _test_image_diversity()
        + _test_publish_quality_gate()
        + _test_review_llm_advisory_gate()
        + _test_operational_agenda_defaults()
        + _test_reset_draft_backlog_plan()
        + _test_reset_draft_backlog_avoids_archived_topics()
        + _test_reset_draft_backlog_default_scope()
        + _test_selfhosted_renderer()
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
    print("[OK] phase-a generation: 350~650자 프롬프트·토큰 캡·섹션 thinking·한자 재시도/제거 유지")
    print("[OK] generate gate: 빈 본문/불완전 생성 결과 저장 차단")
    print("[OK] image bank: 섹션별 이미지 다양성 유지")
    print("[OK] publish gate: 길이/이미지/구조/반복 이미지 차단 유지")
    print("[OK] review gate: 주관적 LLM 이슈는 advisory, 치명 이슈/저점수는 차단")
    print("[OK] ops defaults: 홈페이지 구축 아젠다·generate batch 유지")
    print("[OK] draft reset: 미공개 병목 리셋 시 다양한 주제축 재시드")
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
