"""
오프라인 셀프테스트 (기획 12 §3.3).

키 없이 mock LLM/검색/발행으로 전체 파이프라인을 '실제 코드'로 관통시킨다.
generate → factcheck → review → schedule → publish 까지 돌려
한 글이 published 에 도달하면 PASS.

목적:
- 파이프라인 배선(상태 전환·게이트·발행)이 정상인지 키 없이 검증.
- 회귀 가드(코드 변경 후 깨짐 즉시 감지).

실행: python run.py selftest   (또는 python -m tools.selftest)
"""
from __future__ import annotations

import json
import tempfile
from pathlib import Path


def _install_mocks():
    """LLM·검색·발행을 결정적 mock으로 교체."""
    import config
    from db import db

    # 임시 DB (실DB 오염 방지)
    db.DB_PATH = Path(tempfile.gettempdir()) / "blog_selftest.db"
    if db.DB_PATH.exists():
        db.DB_PATH.unlink()
    db.init_db()

    # 게이트 완화(짧은 mock 본문 통과)
    config.MIN_BODY_LEN = 50
    config.MIN_SOURCE_TEXT_LEN = 30
    config.MAX_DUP_RATIO = 0.95
    config.MIN_GROUNDING_RATIO = 0.9
    config.MIN_REVIEW_SCORE = 80
    config.GENERATE_PROCESS_ISOLATION = False
    # 즉시 발행되도록 스케줄 분산/윈도우 무력화(테스트 결정성)
    config.PUBLISH_SPACING_MIN = 0
    config.PUBLISH_WINDOW_START = 0
    config.PUBLISH_WINDOW_END = 24

    # 검색 mock (네트워크/키 불필요)
    from research import collect
    from research.collect import CollectedSource
    collect.collect = lambda q: [
        CollectedSource("출처A", "http://a.test", "제품 A는 6시간 재생, 89000원, IPX4 방수.", "high"),
        CollectedSource("출처B", "http://b.test", "제품 B는 8시간 재생, 노이즈캔슬링 지원.", "med"),
    ]
    collect.analyze_serp = lambda engine, kw: [
        {"title": "가성비 비교 top5", "snippet": "", "url": "http://serp.test/1"},
    ]

    # LLM mock: 단계별 결정적 출력 (다양성 위해 섹션 번호 포함)
    class MockLLM:
        _sec = 0

        def chat(self, system, user, **k):
            if "SEO 콘텐츠 전략가" in system or "검색 의도를 분석" in system:
                return json.dumps({"intent": "가성비 이어폰 고르기",
                                   "primary_keyword": "무선이어폰 가성비",
                                   "secondary_keywords": ["노이즈캔슬링"],
                                   "subquestions": ["재생시간", "가격", "방수"]})
            if "사실 추출기" in system:
                return json.dumps({"facts": [
                    {"id": "f1", "statement": "A는 6시간 재생, 89000원", "source_id": "s1", "confidence": "high"},
                    {"id": "f2", "statement": "B는 8시간 재생, 노이즈캔슬링", "source_id": "s2", "confidence": "med"}],
                    "entities": [{"name": "A", "type": "제품", "note": "방수", "source_id": "s1"}]})
            if "콘텐츠 기획자" in system:
                return json.dumps({"coverage_targets": ["재생시간", "가격", "방수", "장점", "단점", "결론"]})
            if "개요를 짠다" in system:
                return json.dumps({"title": "무선이어폰 가성비 비교", "meta_description": "A와 B 비교 가이드",
                    "sections": [{"h2": "추천 대상", "point": "누구에게"},
                                 {"h2": "스펙 비교", "point": "재생/가격/방수"},
                                 {"h2": "장점", "point": "강점"},
                                 {"h2": "단점", "point": "약점"},
                                 {"h2": "결론", "point": "추천"}]})
            if "블로그 작가" in system or "블로그 전문 작가" in system:
                MockLLM._sec += 1
                return (
                    f"### 비교 기준 {MockLLM._sec}\n\n"
                    f"제품을 고를 때는 **재생시간, 가격, 방수, 노이즈캔슬링**을 한 번에 봐야 한다. "
                    f"A는 6시간 재생과 89000원이라는 조건이 분명하고, B는 8시간 재생과 노이즈캔슬링 지원이 강점이다. "
                    f"따라서 단순히 저렴한 제품을 고르기보다 실제 사용 시간이 긴지, 이동 중 소음 차단이 필요한지부터 정리하는 편이 안전하다.\n\n"
                    f"- A가 맞는 경우: 가격과 기본 방수를 우선 보는 사용자\n"
                    f"- B가 맞는 경우: 긴 재생시간과 노이즈캔슬링을 중시하는 사용자\n"
                    f"- 공통 체크: 착용감, 교환 정책, 충전 케이스 사용성을 함께 확인\n\n"
                    f"| 항목 | A | B |\n|---|---|---|\n| 재생시간 | 6시간 | 8시간 |\n| 주요 강점 | 89000원, IPX4 방수 | 노이즈캔슬링 |\n\n"
                    f"결론적으로 섹션 {MockLLM._sec}에서는 가격만 보지 말고 생활 패턴에 맞춰 선택 기준을 세우는 것이 핵심이다."
                )
            if "구글 SEO" in system or "네이버 블로그 상위노출" in system:
                return json.dumps({"seo_title": "무선이어폰 가성비 추천 비교",
                                   "meta_description": "A와 B를 직접 비교한 가이드",
                                   "tags": ["무선이어폰", "가성비"],
                                   "image_markers": ["제품 외관"], "notes": []})
            if "팩트체커" in system:
                return json.dumps({"claims": [{"claim": "A 6시간", "status": "supported"}],
                                   "grounding_ratio": 0.95, "unsupported": []})
            if "품질 검수자" in system:
                return json.dumps({"score": 86, "issues": [], "verdict": "pass"})
            return "{}"

    import llm.client as lc
    lc.LLMClient = MockLLM
    # 각 워커가 import한 LLMClient 심볼도 교체
    from pipeline import generate, factcheck, review
    generate.LLMClient = MockLLM
    factcheck.LLMClient = MockLLM
    review.LLMClient = MockLLM

    # 발행 mock (네트워크 없이 성공 URL 반환)
    from pipeline import publish

    class MockPublisher:
        name = "mock"

        def publish(self, post):
            return f"https://published.test/{post['id']}"

    publish.PUBLISHERS = {"selfhosted": MockPublisher(), "naver": MockPublisher(),
                          "tistory": MockPublisher()}
    return db


def run() -> bool:
    db = _install_mocks()
    from pipeline import factcheck, generate, publish, review, schedule_publish

    pid = db.insert_draft("selfhosted", "무선이어폰 가성비 추천", "review")

    steps = [
        ("generate", lambda: generate.run_once()),
        ("factcheck", lambda: factcheck.run_once()),
        ("review", lambda: review.run_once()),
        ("schedule", lambda: schedule_publish.run_once()),
        ("publish", lambda: publish.run_once()),
    ]
    print("=== 파이프라인 셀프테스트 ===")
    for name, fn in steps:
        res = fn()
        row = db.fetch_by_id(pid)
        print(f"  {name:9} → status={row['status']:11} grounding={row['grounding_ratio']} ({res})")

    final = db.fetch_by_id(pid)
    ok = final["status"] == "published" and bool(final["published_url"])
    print(f"\n결과: {'PASS ✅' if ok else 'FAIL ❌'}  "
          f"(status={final['status']}, url={final['published_url']})")
    return ok


if __name__ == "__main__":
    import sys
    sys.exit(0 if run() else 1)
