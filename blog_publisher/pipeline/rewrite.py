"""
URL 기반 재작성 발행 (기획 10).

원문 URL을 '하나의 참고자료'로 삼아 대폭 재구성한 새 글을 만든다.
가드레일: 유사도 검증(원문과 충분히 달라야 통과) + 출처 표기 + (옵션)추가 리서치.
"저작권/중복 콘텐츠" 위험을 줄이기 위한 설계 — 기획 10 §1 참고.
"""
from __future__ import annotations

import config
from db import db
from llm.client import LLMClient
from pipeline import generate
from research import collect, evidence as ev
from research.collect import CollectedSource
from research.extract import extract
from utils.similarity import jaccard


def rewrite_from_url(
    llm: LLMClient,
    url: str,
    content_type: str = "howto",
    channel: str = "selfhosted",
) -> dict:
    """
    반환: generate.compose_article 결과 + {source_url, similarity}.
    유사도 게이트 통과 실패 시 ValueError.
    """
    engine = config.target_engine(channel)

    # ① 원문 추출
    src_title, src_text = extract(url)
    topic = src_title or src_text[:40]

    # ② 의도/키워드 + ③ 추가 리서치(원문을 한 출처로 포함)
    plan = ev.derive_query_plan(llm, topic, content_type)
    serp = collect.analyze_serp(engine, plan["primary_keyword"])
    sources: list[CollectedSource] = [
        CollectedSource(title=src_title or "원문", url=url, text=src_text, trust="med")
    ]
    if config.REWRITE_EXTRA_RESEARCH:
        try:
            sources += collect.collect(ev.search_queries(plan))
        except Exception as e:  # noqa: BLE001
            print(f"[rewrite] 추가 리서치 생략: {e}")

    evidence = ev.build_evidence_pack(llm, topic, content_type, plan, sources, serp=serp)

    # ④ 합성 + ⑤ 유사도 검증(원문 대비). 임계 이상이면 재작성.
    last = None
    for attempt in range(config.REWRITE_MAX_RETRIES + 1):
        article = generate.compose_article(llm, topic, content_type, engine, evidence, serp)
        sim = jaccard(src_text, article["body"])
        last = (article, sim)
        if sim < config.MAX_SIMILARITY:
            article["source_url"] = url
            article["similarity"] = round(sim, 3)
            return article
        print(f"[rewrite] 유사도 높음({sim:.2f}) 재작성 {attempt+1}")

    article, sim = last
    raise ValueError(
        f"원문과 너무 유사함(유사도 {sim:.2f} ≥ {config.MAX_SIMILARITY}). 발행 보류."
    )


def run_url(url: str, content_type: str = "howto", channel: str = "selfhosted") -> int:
    """단건 재작성 → draft로 저장. post id 반환(실패 시 -1)."""
    llm = LLMClient()
    try:
        article = rewrite_from_url(llm, url, content_type, channel)
    except Exception as e:  # noqa: BLE001
        print(f"[rewrite] 실패: {e}")
        return -1

    pid = db.insert_draft(channel, article["title"], content_type)
    db.save_research(pid, article["evidence"])
    db.save_seo(pid, article["target_engine"], article["tags"])
    db.save_source_url(pid, url)
    db.save_article(pid, article["title"], article["meta_description"], article["body"])
    print(f"[rewrite] 저장 id={pid} 유사도={article['similarity']} 출처={url}")
    return pid


if __name__ == "__main__":
    import sys

    if len(sys.argv) < 2:
        print("사용: python -m pipeline.rewrite <url> [channel] [type]")
    else:
        run_url(sys.argv[1],
                sys.argv[3] if len(sys.argv) > 3 else "howto",
                sys.argv[2] if len(sys.argv) > 2 else "selfhosted")
