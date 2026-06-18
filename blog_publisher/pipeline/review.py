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
from tools.content_quality import publish_blockers
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


def _score(data: dict) -> int:
    try:
        return int(float(data.get("score", 0)))
    except (TypeError, ValueError):
        return 0


def _issues(data: dict) -> list[str]:
    raw = data.get("issues", [])
    if isinstance(raw, str):
        return [raw]
    if not isinstance(raw, list):
        return []
    return [str(issue).strip() for issue in raw if str(issue).strip()]


def _issue_key(issue: str) -> str:
    return issue.split(":", 1)[0].strip().lower().replace("-", "_").replace(" ", "_")


def review_blockers(data: dict) -> list[str]:
    """
    LLM 평가는 hard gate가 아니라 2차 안전망이다.

    규칙 게이트/발행 게이트가 이미 길이, 구조, 이미지, 중복, 서비스 축을 차단하므로
    LLM의 generic/repetitive 같은 주관적 개선 의견만으로는 재고를 모두 폐기하지 않는다.
    다만 매우 낮은 점수와 사실성·주제이탈·위험·환각 같은 치명 이슈는 계속 차단한다.
    unnatural_ko/generic/repetitive는 규칙 게이트와 발행 게이트를 통과한 글에서는 advisory로 둔다.
    """
    if config.MIN_REVIEW_SCORE <= 0:
        return []   # 검수 점수 임계 0 = LLM 게이트 비활성
    if not isinstance(data, dict):
        return ["invalid_review_response"]

    score = _score(data)
    issues = _issues(data)
    if score < config.REVIEW_HARD_FAIL_SCORE:
        blockers = [f"low_score:{score}"]
        blockers.extend(issue for issue in issues if issue not in blockers)
        return blockers

    critical = {_issue_key(issue) for issue in getattr(config, "REVIEW_CRITICAL_ISSUES", [])}
    blockers = [issue for issue in issues if _issue_key(issue) in critical]
    if blockers:
        return blockers
    return []


def llm_gate(llm: LLMClient, title: str, body: str) -> list[str]:
    return review_blockers(evaluate(llm, title, body))


def prepublish_gate(post) -> list[str]:
    """발행 게이트와 같은 치명 이슈를 review 단계에서 먼저 차단한다."""
    return publish_blockers(post)


def run_once(batch: int = 5) -> tuple[int, int]:
    """
    검수 대상: 본문이 있고 '사실검증을 통과한'(grounding_ratio >= 임계) draft.
    사실검증 전(grounding NULL)이거나 미달인 글은 건너뛴다. (통과, 탈락) 반환.
    """
    llm = LLMClient()
    passed = failed = 0
    attempted = 0
    errors: list[str] = []
    for post in db.fetch_review_ready(limit=batch, min_grounding=config.MIN_GROUNDING_RATIO):
        if not db.claim(post["id"], "draft", "reviewing"):
            continue
        attempted += 1

        issues = rule_gate(post["body"]) + prepublish_gate(post)
        if not issues:
            try:
                issues = llm_gate(llm, post["title"], post["body"])
            except Exception as e:  # noqa: BLE001
                # 검수기 자체 오류는 본문을 폐기하지 않고 보류한다.
                # LLM/API 일시 오류가 양호한 글을 재생성 루프로 밀어 넣으면 재고가 0%로 고갈된다.
                db.defer_review(post["id"], [f"reviewer_error:{e}"])
                errors.append(f"id={post['id']}: {e}")
                continue

        if issues:
            db.mark_review_failed(post["id"], issues)
            failed += 1
        else:
            db.mark_reviewed(post["id"])
            passed += 1
    if attempted and passed == 0 and failed == 0 and len(errors) == attempted:
        detail = "; ".join(errors[:3])
        if len(errors) > 3:
            detail += f"; 외 {len(errors) - 3}건"
        raise RuntimeError(f"검수 대상 {attempted}건 모두 오류: {detail}")
    if attempted and passed == 0 and failed > 0:
        raise RuntimeError(f"검수 대상 {attempted}건 중 통과 0건 / 탈락 {failed}건")
    return passed, failed


if __name__ == "__main__":
    p, f = run_once()
    print(f"[review] 통과 {p} / 탈락 {f}")
