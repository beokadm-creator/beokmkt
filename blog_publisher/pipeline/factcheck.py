"""
사실검증 게이트 (기획 05 §6).

근거기반 생성 직후, 품질검수(02) '이전'에 사실성만 본다.
초안의 구체 주장을 근거팩과 대조해 grounding_ratio를 구하고,
임계 미만이면 draft로 되돌려 재생성 대상이 되게 한다.

상태 흐름: draft(본문 있음) -> [factcheck] -> draft(통과, grounding 저장) | draft(탈락)
검수 워커(review)는 grounding 통과분만 다루도록 grounding_ratio를 본다.
"""
from __future__ import annotations

import json

import config
from db import db
from llm import prompts
from llm.client import LLMClient
from llm.parse import chat_json


def _facts_text(evidence: dict, limit: int = 60) -> str:
    facts = (evidence or {}).get("facts", [])
    return "\n".join(f"- {f['statement']}" for f in facts[:limit]) or "(근거 없음)"


def check(llm: LLMClient, body: str, evidence: dict) -> dict:
    return chat_json(
        llm,
        prompts.FACTCHECK_SYSTEM,
        prompts.FACTCHECK_USER.format(facts=_facts_text(evidence), body=body),
        model=config.MODEL_REVIEW,
        max_tokens=config.MAX_TOKENS_REVIEW,
        thinking=False,
        temperature=0.0,
    )


def run_once(batch: int = 5) -> tuple[int, int]:
    """
    grounding 미평가 draft(본문 있음, grounding_ratio NULL)를 검증.
    (통과, 탈락) 반환.
    """
    llm = LLMClient()
    passed = failed = 0
    attempted = 0
    errors: list[str] = []
    for post in db.fetch_factcheck_ready(limit=batch):
        if not db.claim(post["id"], "draft", "factchecking"):
            continue
        attempted += 1

        try:
            evidence = json.loads(post["evidence"]) if post["evidence"] else {}
            if not evidence.get("facts"):
                db.save_grounding(post["id"], 0.0)
                db.claim(post["id"], "factchecking", "draft")
                db.mark_review_failed(post["id"], ["no_evidence_facts"])
                db.save_body(post["id"], "", to_status="draft")
                db.save_grounding(post["id"], 0.0)
                failed += 1
                continue
            result = check(llm, post["body"], evidence)
        except Exception as e:  # noqa: BLE001
            db.claim(post["id"], "factchecking", "draft")
            print(f"[factcheck] id={post['id']} 오류: {e}")
            errors.append(f"id={post['id']}: {e}")
            continue

        ratio = float(result.get("grounding_ratio", 0.0))
        db.save_grounding(post["id"], ratio)
        db.claim(post["id"], "factchecking", "draft")  # 평가 끝, draft 유지

        if ratio < config.MIN_GROUNDING_RATIO:
            # 근거 부족 -> 재생성 대상. 본문/grounding 초기화.
            db.mark_review_failed(post["id"], [
                f"low_grounding:{ratio:.2f}",
                *[f"unsupported:{u}" for u in result.get("unsupported", [])[:5]],
            ])
            db.save_body(post["id"], "", to_status="draft")  # 본문 비워 재생성 유도
            db.save_grounding(post["id"], ratio)
            failed += 1
        else:
            passed += 1
    if attempted and passed == 0 and failed == 0 and len(errors) == attempted:
        detail = "; ".join(errors[:3])
        if len(errors) > 3:
            detail += f"; 외 {len(errors) - 3}건"
        raise RuntimeError(f"사실검증 대상 {attempted}건 모두 오류: {detail}")
    return passed, failed


if __name__ == "__main__":
    p, f = run_once()
    print(f"[factcheck] 통과 {p} / 탈락 {f}")
