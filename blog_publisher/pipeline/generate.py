"""
생성 워커 — 근거기반 콘텐츠 엔진 (기획 05·06).

상상 생성이 아니라 '수집된 근거의 합성'이다.
  ① 의도/키워드 도출 → ② 자료 수집 → ③ 근거팩 →
  ④ 근거기반 개요(유형 템플릿) → ⑤ 근거기반 섹션 작성 → 통합
사실검증(⑥)은 별도 워커(pipeline/factcheck.py)가 이어받는다.
"""
from __future__ import annotations

import config
from db import db
from llm import prompts
from llm.client import LLMClient
from llm.parse import chat_json
from pipeline import seo
from research import collect, evidence as ev
from utils.notify import notify


# CJK 한자(漢字) 범위. 한국어 블로그 본문엔 사실상 0개여야 한다.
# glm 계열 모델이 한국어 단어를 중국어 글자로 바꿔치기하는 결함을 잡는다.
import re as _re

_HANZI_RE = _re.compile(r"[一-鿿㐀-䶿]")


def _count_hanzi(text: str) -> int:
    return len(_HANZI_RE.findall(text or ""))


def _strip_hanzi(text: str) -> str:
    """한자와, 한자만 들어있던 괄호 잔여물을 정리."""
    if not text:
        return text
    out = _HANZI_RE.sub("", text)
    out = _re.sub(r"\(\s*\)", "", out)      # 빈 괄호 제거
    out = _re.sub(r"[ \t]{2,}", " ", out)
    return out


def _facts_summary(evidence: dict, limit: int = 40) -> str:
    """개요 입력용 사실 요약(출처 표기)."""
    lines = []
    for f in evidence.get("facts", [])[:limit]:
        lines.append(f"- {f['statement']} (출처: {f['source_title']})")
    return "\n".join(lines) or "(수집된 사실 없음)"


def _evidence_for_section(evidence: dict, h2: str, point: str, limit: int = 12) -> str:
    """
    섹션에 줄 근거. 단순화를 위해 전체 facts를 제공하되,
    섹션 키워드와 겹치는 것을 앞으로 정렬(후속: 임베딩 기반 선별).
    """
    facts = evidence.get("facts", [])
    key = (h2 + " " + point)

    def score(f: dict) -> int:
        return sum(1 for w in key.split() if w and w in f.get("statement", ""))

    ranked = sorted(facts, key=score, reverse=True)[:limit]
    return "\n".join(
        f"- {f['statement']} (출처: {f['source_title']})" for f in ranked
    ) or "(이 섹션에 직접 대응하는 근거 부족)"


def _brand_hint(brand_key: str) -> str:
    """category에 브랜드 키가 있으면 개요 프롬프트에 붙일 힌트를 반환."""
    if not brand_key:
        return ""
    try:
        from tools.keyword_bank import BRANDS
        b = BRANDS.get(brand_key)
        if not b:
            return ""
        return prompts.OUTLINE_BRAND_HINT.format(
            brand_name=b["name"], brand_url=b["url"]
        )
    except Exception:  # noqa: BLE001
        return ""


def _build_outline(llm: LLMClient, post: dict, evidence: dict) -> dict:
    content_type = post.get("content_type", "howto")
    system = prompts.OUTLINE_TEMPLATES.get(content_type, prompts.OUTLINE_TEMPLATES["howto"])
    outline = chat_json(
        llm,
        system,
        prompts.OUTLINE_USER.format(
            topic=post["topic"],
            content_type=content_type,
            intent=evidence.get("intent", ""),
            coverage="\n".join(f"- {c}" for c in evidence.get("coverage_targets", [])),
            facts=_facts_summary(evidence),
            brand_hint=_brand_hint(post.get("category") or post.get("brand_key", "")),
        ),
        model=config.MODEL_OUTLINE,
        max_tokens=config.MAX_TOKENS_OUTLINE,
        thinking=True,
    )
    return _validate_outline(outline)


def generate_article(
    llm: LLMClient, topic: str, content_type: str, channel: str = "selfhosted",
    brand_key: str = "",
) -> dict:
    """
    DB와 무관하게 근거기반 + 검색노출 최적화 원고를 만든다(워커/측정 도구 공유).
    반환: {title, meta_description, body, tags, target_engine, evidence, seo}
    """
    engine = config.target_engine(channel)   # 기획 07: 채널별 타깃 엔진

    # ① 의도/키워드/하위질문
    plan = ev.derive_query_plan(llm, topic, content_type)
    # ②a 타깃 엔진 SERP 분석(노출용) / ②b 사실 수집(근거용, 일반 웹)
    serp = collect.analyze_serp(engine, plan["primary_keyword"])
    sources = collect.collect(ev.search_queries(plan))
    # ③ 근거팩(커버리지는 타깃 SERP 반영)
    evidence = ev.build_evidence_pack(llm, topic, content_type, plan, sources, serp=serp)

    # ④~⑥ 개요·섹션·SEO 합성(재작성 파이프라인과 공유)
    return compose_article(llm, topic, content_type, engine, evidence, serp, brand_key=brand_key)


def compose_article(
    llm: LLMClient,
    topic: str,
    content_type: str,
    engine: str,
    evidence: dict,
    serp: list[dict] | None = None,
    brand_key: str = "",
) -> dict:
    """근거팩이 준비된 뒤의 합성 단계(개요→섹션→SEO). generate/rewrite 공용."""
    # ④ 근거기반 개요
    outline = _build_outline(
        llm, {"topic": topic, "content_type": content_type, "brand_key": brand_key}, evidence
    )
    title = outline["title"]

    # ⑤ 근거기반 섹션 작성 (빈 응답/한자 혼입 시 재시도)
    parts: list[str] = []
    for sec in outline["sections"]:
        body = ""
        for _sec_try in range(3):
            body = llm.chat(
                prompts.SECTION_SYSTEM,
                prompts.SECTION_USER.format(
                    title=title,
                    h2=sec["h2"],
                    point=sec["point"],
                    tone=config.DEFAULT_TONE,
                    evidence=_evidence_for_section(evidence, sec["h2"], sec["point"]),
                ),
                model=config.MODEL_SECTION,
                max_tokens=config.MAX_TOKENS_SECTION,
                thinking=True,   # 깊이·구조 향상(품질 우선). 통과율/비용 보며 조정.
            )
            too_short = len(body.strip()) < config.SECTION_MIN_LEN
            # glm 계열이 한국어에 한자(信信, 几次 등)를 섞는 경우 → 재생성
            has_hanzi = _count_hanzi(body) > 0
            if not too_short and not has_hanzi:
                break
            reason = "너무 짧음" if too_short else f"한자 {_count_hanzi(body)}자 혼입"
            print(f"[generate] 섹션 '{sec['h2']}' {reason}({len(body)}자), 재시도")
        # 최종 시도에도 한자가 남으면 제거(최후의 안전망)
        body = _strip_hanzi(body)
        parts.append(f"## {sec['h2']}\n\n{body}")
    body_text = "\n\n".join(parts)

    # ⑥ SEO 최적화(엔진별). 실패해도 원고는 살린다.
    try:
        seo_data = seo.optimize(llm, engine, topic, title, body_text, evidence, serp)
        final_title = seo_data.get("seo_title") or title
        meta = seo_data.get("meta_description") or outline.get("meta_description", "")
        tags = seo_data.get("tags", [])
        if brand_key in {"hong", "beok"}:
            from tools.image_bank import inject_images
            body_text = inject_images(body_text, brand_key=brand_key)
        elif engine == "naver":
            body_text = seo.apply_image_markers(body_text, seo_data.get("image_markers", []))
    except Exception as e:  # noqa: BLE001
        print(f"[seo] 최적화 실패(원고 유지): {e}")
        seo_data, final_title, meta, tags = {}, title, outline.get("meta_description", ""), []

    return {
        "title": final_title,
        "meta_description": meta,
        "body": body_text,
        "tags": tags,
        "target_engine": engine,
        "evidence": evidence,
        "seo": seo_data,
    }


def _generate_one(llm: LLMClient, post: dict) -> None:
    result = generate_article(
        llm, post["topic"], post.get("content_type", "howto"),
        post.get("channel", "selfhosted"),
        brand_key=post.get("category", ""),
    )
    db.save_research(post["id"], result["evidence"])
    db.save_seo(post["id"], result["target_engine"], result["tags"])
    db.save_article(
        post["id"], result["title"], result["meta_description"], result["body"]
    )


SECTION_MIN = 2   # 하한(이하면 실패)
SECTION_MAX = 8   # 상한(초과분은 잘라서 보정)


def _validate_outline(outline: dict) -> dict:
    """
    기획 01 §4.1 + 06. 하드 리젝 대신 '보정'으로 throughput 손실을 막는다(감사 후속).
    - title 없으면 실패
    - h2/point 없는 섹션은 버림
    - 유효 섹션이 SECTION_MIN 미만이면 실패, SECTION_MAX 초과면 앞에서 자름
    """
    if not outline.get("title"):
        raise ValueError("개요에 title 없음")
    sections = outline.get("sections")
    if not isinstance(sections, list):
        raise ValueError("sections가 리스트가 아님")

    valid = [
        s for s in sections
        if isinstance(s, dict) and s.get("h2") and s.get("point")
    ]
    if len(valid) < SECTION_MIN:
        raise ValueError(f"유효 섹션 부족(<{SECTION_MIN}): {len(valid)}")
    if len(valid) > SECTION_MAX:
        print(f"[generate] 섹션 {len(valid)}개 → {SECTION_MAX}개로 보정")
        valid = valid[:SECTION_MAX]

    outline["sections"] = valid
    return outline


def run_once(batch: int = 5) -> int:
    """본문이 없는 draft(next_run_at 지난 것)를 근거기반 생성. 처리 건수 반환."""
    llm = LLMClient()
    processed = 0
    for post in db.fetch_generate_ready(limit=batch):
        if not db.claim(post["id"], "draft", "generating"):
            continue
        try:
            _generate_one(llm, dict(post))
            processed += 1
        except Exception as e:  # noqa: BLE001
            attempts = (post["attempts"] or 0) + 1
            new_status = db.requeue_draft(
                post["id"], attempts, str(e)[:500],
                max_attempts=config.GENERATE_MAX_ATTEMPTS,
            )
            print(f"[generate] id={post['id']} 시도{attempts}/{config.GENERATE_MAX_ATTEMPTS} "
                  f"실패→{new_status}: {e}")
            if new_status == "needs_human":
                notify(f"생성 실패 격리: id={post['id']} topic={post['topic']!r} — {e}", "error")
    return processed


if __name__ == "__main__":
    print(f"[generate] {run_once()}건 생성")
