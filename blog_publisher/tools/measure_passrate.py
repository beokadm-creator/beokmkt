"""
통과율/시간 측정 도구 (기획 02 §3.4).

주제 목록으로 N개 원고를 생성하고 검수 게이트를 돌려
'규칙 탈락 / LLM 탈락 / 최종 통과율 / 평균 점수 / 건당 소요시간'을 리포트한다.
모델 등급을 낮출지 결정할 때 '감 대신 데이터'로 쓰는 도구.

사용:
  python tools/measure_passrate.py topics.txt        # 파일(한 줄=한 주제)
  python tools/measure_passrate.py                   # 내장 샘플 주제

DB를 건드리지 않는다(측정 전용). 모델 조합은 config(=환경변수)로 바꿔 비교한다.
비용은 공급자 대시보드에서 동일 구간을 비교(토큰 계측은 후속).
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

import config
from llm.client import LLMClient
from pipeline import factcheck, generate, review

# (주제, 유형)
SAMPLE_TOPICS = [
    ("무선 이어폰 가성비 추천", "review"),
    ("초보자를 위한 홈트레이닝 루틴", "howto"),
    ("신용점수 올리는 현실적인 방법", "howto"),
    ("전기차 배터리 수명 관리", "niche"),
    ("캠핑 입문자가 처음 살 장비", "review"),
]


def _load_topics(argv: list[str]) -> list[str]:
    if len(argv) > 1 and Path(argv[1]).exists():
        # 파일 형식: "주제\t유형" 또는 "주제"(기본 howto)
        out = []
        for ln in Path(argv[1]).read_text(encoding="utf-8").splitlines():
            ln = ln.strip()
            if not ln:
                continue
            parts = ln.split("\t")
            out.append((parts[0], parts[1] if len(parts) > 1 else "howto"))
        return out
    return SAMPLE_TOPICS


def main() -> None:
    topics = _load_topics(sys.argv)
    llm = LLMClient()

    n = len(topics)
    rule_fail = ground_fail = llm_fail = passed = gen_error = 0
    scores: list[int] = []
    ratios: list[float] = []
    t0 = time.time()

    for i, (topic, ctype) in enumerate(topics, 1):
        try:
            art = generate.generate_article(llm, topic, ctype)
        except Exception as e:  # noqa: BLE001
            gen_error += 1
            print(f"[{i}/{n}] 생성실패: {topic} ({e})")
            continue
        title, body, evidence = art["title"], art["body"], art["evidence"]

        issues = review.rule_gate(body)
        if issues:
            rule_fail += 1
            print(f"[{i}/{n}] 규칙탈락 {issues}: {title}")
            continue

        # 사실검증(grounding)
        fc = factcheck.check(llm, body, evidence)
        ratio = float(fc.get("grounding_ratio", 0.0))
        ratios.append(ratio)
        if ratio < config.MIN_GROUNDING_RATIO:
            ground_fail += 1
            print(f"[{i}/{n}] 근거부족 ratio={ratio:.2f}: {title}")
            continue

        data = review.evaluate(llm, title, body)
        score = int(data.get("score", 0))
        scores.append(score)
        if data.get("verdict") == "fail" or score < config.MIN_REVIEW_SCORE:
            llm_fail += 1
            print(f"[{i}/{n}] 품질탈락 score={score} {data.get('issues')}: {title}")
        else:
            passed += 1
            print(f"[{i}/{n}] 통과 score={score} ground={ratio:.2f}: {title}")

    elapsed = time.time() - t0
    print("\n=== 측정 결과 ===")
    print(f"  모델: outline={config.MODEL_OUTLINE} section={config.MODEL_SECTION} "
          f"review={config.MODEL_REVIEW}")
    print(f"  검색: provider={config.SEARCH_PROVIDER or '(미설정)'}")
    print(f"  대상: {n}건 (생성실패 {gen_error})")
    print(f"  규칙탈락 {rule_fail} / 근거부족 {ground_fail} / 품질탈락 {llm_fail} / 통과 {passed}")
    if n:
        print(f"  최종 통과율: {passed / n * 100:.1f}%")
    if ratios:
        print(f"  평균 grounding: {sum(ratios) / len(ratios):.2f}")
    if scores:
        print(f"  평균 점수(품질 평가분): {sum(scores) / len(scores):.1f}")
    print(f"  건당 소요시간: {elapsed / n:.1f}초" if n else "  -")


if __name__ == "__main__":
    main()
