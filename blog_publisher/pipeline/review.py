"""
검수 워커 — 발행 전 품질 게이트.

2단계 검수
  1) 규칙 기반(싸다): 길이/중복률/금칙어/구조  -> 미달이면 LLM 호출 없이 탈락
  2) LLM 평가(비쌈): 1차 통과분만. 사실성/자연스러움/주제적합 점수화

통과분만 reviewed -> (스케줄러가) queued 로 넘긴다.
탈락분은 draft로 되돌려 재생성 대상이 된다.

운영 팁: 모델 등급을 낮출지 말지는 '이 게이트 통과율'로 판단한다.
싼 모델로 통과율이 유지되면 그게 정답이다. 감으로 정하지 않는다.
"""
from __future__ import annotations

import config
from db import db
from llm import prompts
from llm.parse import chat_json
from llm.client import LLMClient
from utils import text as T


def rule_gate(body: str) -> list[str]:
    issues: list[str] = []
    if T.visible_len(body) < config.MIN_BODY_LEN:
        issues.append("too_short")
    if T.dup_ratio(body) > config.MAX_DUP_RATIO:
        issues.append("repetitive")
    if T.has_banned_words(body):
        issues.append("banned_words")
    if T.count_headings(body) < config.MIN_HEADINGS:
        issues.append("thin_structure")
    return issues


def evaluate(llm: LLMClient, title: str, body: str) -> dict:
    """LLM 검수 원본 결과(dict: score/issues/verdict)를 반환. 측정 도구가 점수에 접근."""
    return chat_json(
        llm,
        prompts.REVIEW_SYSTEM,
        prompts.REVIEW_USER.format(title=title, body=body),
        model=config.MODEL_REVIEW,
        max_tokens=config.MAX_TOKENS_REVIEW,
        thinking=False,
        temperature=0.0,
    )


def llm_gate(llm: LLMClient, title: str, body: str) -> list[str]:
    if config.MIN_REVIEW_SCORE <= 0:
        return []   # 검수 점수 임계 0 = LLM 게이트 비활성
    data = evaluate(llm, title, body)
    if data.get("score", 0) < config.MIN_REVIEW_SCORE:
        return data.get("issues", ["low_score"])
    return []


def run_once(batch: int = 5) -> tuple[int, int]:
    """
    검수 대상: 본문이 있고 '사실검증을 통과한'(grounding_ratio >= 임계) draft.
    사실검증 전(grounding NULL)이거나 미달인 글은 건너뛴다. (통과, 탈락) 반환.
    """
    llm = LLMClient()
    passed = failed = 0
    for post in db.fetch_review_ready(limit=batch, min_grounding=config.MIN_GROUNDING_RATIO):
        if not db.claim(post["id"], "draft", "reviewing"):
            continue

        issues = rule_gate(post["body"])
        if not issues:
            try:
                issues = llm_gate(llm, post["title"], post["body"])
            except Exception as e:  # noqa: BLE001
                # 검수기 자체 오류는 보류(draft 복귀) — 발행으로 새지 않게
                db.mark_review_failed(post["id"], [f"reviewer_error:{e}"])
                continue

        if issues:
            db.mark_review_failed(post["id"], issues)
            failed += 1
        else:
            db.mark_reviewed(post["id"])
            passed += 1
    return passed, failed


if __name__ == "__main__":
    p, f = run_once()
    print(f"[review] 통과 {p} / 탈락 {f}")
