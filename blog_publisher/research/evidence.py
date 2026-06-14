"""
근거팩 빌더 (기획 05 §3 ①③, §5).

흐름:
  derive_query_plan : 주제+유형 → 검색 의도/키워드/하위질문
  (collect 로 자료 수집)
  build_evidence_pack : 수집 자료 → 사실/엔티티/커버리지타깃 (모두 출처 귀속)

원칙: LLM은 '주어진 출처 본문에서만' 사실을 추출한다(지어내기 금지).
"""
from __future__ import annotations

import config
from llm import prompts
from llm.client import LLMClient
from llm.parse import chat_json
from research.collect import CollectedSource


def derive_query_plan(llm: LLMClient, topic: str, content_type: str) -> dict:
    """① 검색 의도 + 주/보조 키워드 + 하위질문."""
    plan = chat_json(
        llm,
        prompts.INTENT_SYSTEM,
        prompts.INTENT_USER.format(topic=topic, content_type=content_type),
        model=config.MODEL_OUTLINE,
        max_tokens=config.MAX_TOKENS_OUTLINE,
        thinking=True,
    )
    plan.setdefault("primary_keyword", topic)
    plan.setdefault("secondary_keywords", [])
    plan.setdefault("subquestions", [])
    plan.setdefault("intent", "")
    return plan


def search_queries(plan: dict) -> list[str]:
    """수집에 쓸 쿼리 목록: 주 키워드 + 하위질문(상한)."""
    queries = [plan["primary_keyword"]]
    queries += plan.get("subquestions", [])[: config.MAX_SUBQUERIES]
    # 중복 제거, 빈 값 제거
    seen, out = set(), []
    for q in queries:
        q = (q or "").strip()
        if q and q not in seen:
            seen.add(q)
            out.append(q)
    return out


def build_evidence_pack(
    llm: LLMClient,
    topic: str,
    content_type: str,
    plan: dict,
    sources: list[CollectedSource],
    serp: list[dict] | None = None,
) -> dict:
    """③ 수집 자료에서 사실/엔티티/커버리지타깃 추출. 모든 사실은 출처 귀속.

    serp: 타깃 엔진(네이버/구글) 상위 노출 제목·요약(기획 07). 커버리지 산출에 사용.
    """
    if not sources:
        # 검색 공급자 미설정 시 빈 근거팩으로 계속 진행(LLM 자체 지식 기반 생성)
        return {
            "topic": topic, "content_type": content_type,
            "intent": plan.get("intent", ""), "primary_keyword": plan.get("primary_keyword", topic),
            "secondary_keywords": plan.get("secondary_keywords", []),
            "coverage_targets": plan.get("subquestions", []),
            "facts": [], "entities": [], "sources": [],
        }

    # 출처에 id 부여 + LLM 입력용 블록(본문은 추출용으로 길이 제한)
    src_index = {f"s{i+1}": s for i, s in enumerate(sources)}
    blocks = []
    for sid, s in src_index.items():
        blocks.append(f"[{sid}] {s.title}\nURL: {s.url}\n{s.text[:config.EVIDENCE_SRC_SNIPPET]}")
    sources_text = "\n\n---\n\n".join(blocks)

    # 사실/엔티티 추출 (주어진 본문에서만)
    fe = chat_json(
        llm,
        prompts.FACTS_SYSTEM,
        prompts.FACTS_USER.format(topic=topic, sources=sources_text),
        model=config.MODEL_SECTION,
        max_tokens=config.MAX_TOKENS_SECTION,
        thinking=False,
        temperature=0.0,
    )

    # 커버리지 타깃 (SERP 갭): 타깃 엔진 상위 제목 우선, 없으면 수집 출처 제목.
    if serp:
        titles = "\n".join(f"- {r.get('title', '')}" for r in serp)
    else:
        titles = "\n".join(f"- {s.title}" for s in sources)
    cov = chat_json(
        llm,
        prompts.COVERAGE_SYSTEM,
        prompts.COVERAGE_USER.format(
            topic=topic,
            intent=plan.get("intent", ""),
            subquestions="\n".join(f"- {q}" for q in plan.get("subquestions", [])),
            competitor_titles=titles,
        ),
        model=config.MODEL_SECTION,
        max_tokens=config.MAX_TOKENS_REVIEW,
        thinking=False,
    )
    coverage = cov.get("coverage_targets", []) if isinstance(cov, dict) else []

    # source_id → url/title 로 환원
    def _src(sid: str) -> tuple[str, str]:
        s = src_index.get(sid)
        return (s.url, s.title) if s else ("", "")

    facts = []
    for f in fe.get("facts", []):
        url, title = _src(f.get("source_id", ""))
        if not url:                      # 출처 없는 사실은 버린다(05 §5)
            continue
        facts.append({
            "id": f.get("id") or f"f{len(facts)+1}",
            "statement": f.get("statement", ""),
            "source_url": url,
            "source_title": title,
            "confidence": f.get("confidence", "med"),
        })

    entities = []
    for ent in fe.get("entities", []):
        url, _ = _src(ent.get("source_id", ""))
        entities.append({
            "name": ent.get("name", ""),
            "type": ent.get("type", ""),
            "note": ent.get("note", ""),
            "source_url": url,
        })

    return {
        "topic": topic,
        "content_type": content_type,
        "intent": plan.get("intent", ""),
        "primary_keyword": plan.get("primary_keyword", topic),
        "secondary_keywords": plan.get("secondary_keywords", []),
        "coverage_targets": coverage,
        "facts": facts,
        "entities": entities,
        "sources": [{"url": s.url, "title": s.title, "trust": s.trust} for s in sources],
    }
