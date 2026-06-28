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
import re

import config
from db import db
from llm import prompts
from llm.client import LLMClient
from llm.parse import chat_json


_RISKY_SPECIFIC_RE = re.compile(
    r"("
    r"(?:월|연|년)\s*\d+(?:\.\d+)?\s*(?:만\s*)?원"
    r"|\d+(?:\.\d+)?\s*(?:만\s*)?원\s*(?:부터|대|이상|이하|수준)?"
    r"|(?:최단|최소|최대|평균)\s*\d+\s*(?:일|주|개월|시간|분)"
    r"|\d+\s*(?:일|주|개월|시간|분)\s*(?:안에|이내|만에|소요|완성|구축|제작)"
    r"|\d+\s*(?:개국|개\s*국|개\s*언어|개언어|명|건|회|%)"
    r"|프리미엄\s*운영형"
    r"|관리자형"
    r"|요금제"
    r")",
    re.I,
)


def _normalize(value: str | None) -> str:
    text = str(value or "").lower()
    text = re.sub(r"\s+", "", text)
    text = text.replace(",", "")
    return text


def _facts_text_raw(evidence: dict) -> str:
    return " ".join(str(f.get("statement", "")) for f in (evidence or {}).get("facts", []))


def local_unsupported_claims(body: str, evidence: dict) -> list[str]:
    """
    가격·기간·규모처럼 운영상 민감한 구체 수치는 근거팩에 같은 표현이 있을 때만 허용한다.
    LLM factcheck가 놓쳐도 로컬에서 한 번 더 막아 발행량보다 정확성을 우선한다.
    """
    facts_norm = _normalize(_facts_text_raw(evidence))
    if not facts_norm:
        return []
    unsupported: list[str] = []
    seen: set[str] = set()
    text = re.sub(r"!\[[^\]]*]\([^)\s]+\)", " ", body or "")
    chunks = re.split(r"\n+|[.!?。]\s+|다\.\s*|요\.\s*|니다\.\s*", text)
    for chunk in chunks:
        claim = re.sub(r"\s+", " ", chunk).strip(" -*#|")
        if not claim:
            continue
        matches = [m.group(0) for m in _RISKY_SPECIFIC_RE.finditer(claim)]
        if not matches:
            continue
        unsupported_matches = [
            match for match in matches
            if _normalize(match) not in facts_norm
        ]
        if not unsupported_matches:
            continue
        marker = " / ".join(unsupported_matches)
        if marker in seen:
            continue
        seen.add(marker)
        unsupported.append(claim[:180])
    return unsupported


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
                db.requeue_draft(post["id"], post["attempts"] + 1,
                                 "no_evidence_facts", post["max_attempts"])
                print(f"[factcheck] id={post['id']} no_evidence_facts attempts={post['attempts']+1}/{post['max_attempts']}")
                failed += 1
                continue
            result = check(llm, post["body"], evidence)
        except Exception as e:  # noqa: BLE001
            db.claim(post["id"], "factchecking", "draft")
            print(f"[factcheck] id={post['id']} 오류: {e}")
            errors.append(f"id={post['id']}: {e}")
            continue

        local_unsupported = local_unsupported_claims(post["body"], evidence)
        if local_unsupported:
            result.setdefault("unsupported", [])
            result["unsupported"] = [*result.get("unsupported", []), *local_unsupported]
            result["grounding_ratio"] = min(float(result.get("grounding_ratio", 0.0)), 0.5)

        ratio = float(result.get("grounding_ratio", 0.0))
        db.save_grounding(post["id"], ratio)
        db.claim(post["id"], "factchecking", "draft")  # 평가 끝, draft 유지

        if ratio < config.MIN_GROUNDING_RATIO:
            # 근거 부족 -> 재생성 대상. 본문/grounding 초기화 + backoff.
            err = f"low_grounding:{ratio:.2f}"
            db.mark_review_failed(post["id"], [
                err,
                *[f"unsupported:{u}" for u in result.get("unsupported", [])[:5]],
            ])
            db.save_body(post["id"], "", to_status="draft")  # 본문 비워 재생성 유도
            db.requeue_draft(post["id"], post["attempts"] + 1,
                             err, post["max_attempts"])
            print(f"[factcheck] id={post['id']} low_grounding={ratio:.2f} attempts={post['attempts']+1}/{post['max_attempts']}")
            failed += 1
        else:
            passed += 1
    if attempted and passed == 0 and failed == 0 and len(errors) == attempted:
        detail = "; ".join(errors[:3])
        if len(errors) > 3:
            detail += f"; 외 {len(errors) - 3}건"
        raise RuntimeError(f"사실검증 대상 {attempted}건 모두 오류: {detail}")
    if attempted and passed == 0 and failed > 0:
        raise RuntimeError(f"사실검증 대상 {attempted}건 중 통과 0건 / 탈락 {failed}건")
    return passed, failed


if __name__ == "__main__":
    p, f = run_once()
    print(f"[factcheck] 통과 {p} / 탈락 {f}")
