"""
영문 번역 발행 (기획 11).

원문(ko) 글을 현지화된 영문 글로 만들고, en 로케일 draft로 저장한다.
번역 후 영문 SEO(구글 최적화) 단계로 en 제목/메타/태그를 재산출한다.
사실검증은 원문에서 통과했으므로 생략(품질 검수만 다시 받음).
"""
from __future__ import annotations

import json

import config
from db import db
from llm import prompts
from llm.client import LLMClient
from pipeline import seo


def translate_body(llm: LLMClient, title: str, body: str) -> str:
    return llm.chat(
        prompts.TRANSLATE_EN_SYSTEM,
        prompts.TRANSLATE_EN_USER.format(title=title, body=body),
        model=config.MODEL_TRANSLATE,
        max_tokens=config.MAX_TOKENS_TRANSLATE,
        thinking=False,
        temperature=0.3,
    ).strip()


def translate_post(llm: LLMClient, post: dict, target_channel: str | None = None) -> dict:
    """
    원문 post(dict)를 영문으로. 반환: {title, meta_description, body, tags, channel}.
    """
    channel = target_channel or config.EN_CHANNEL
    en_body = translate_body(llm, post["title"], post["body"])

    # 영문 SEO(구글 최적화) — en 제목/메타/태그 재산출
    evidence = {}
    try:
        evidence = json.loads(post["evidence"]) if post.get("evidence") else {}
    except (ValueError, TypeError):
        evidence = {}
    try:
        seo_data = seo.optimize(
            llm, "google", post["title"], post["title"], en_body, evidence, serp=None
        )
        en_title = seo_data.get("seo_title") or post["title"]
        meta = seo_data.get("meta_description", "")
        tags = seo_data.get("tags", [])
    except Exception as e:  # noqa: BLE001
        print(f"[translate] 영문 SEO 생략: {e}")
        en_title, meta, tags = post["title"], "", []

    return {
        "title": en_title,
        "meta_description": meta,
        "body": en_body,
        "tags": tags,
        "channel": channel,
    }


def run_post(post_id: int, target_channel: str | None = None) -> int:
    """원문 id를 영문 draft로 복제. 새 post id 반환(실패 시 -1)."""
    rows = db.fetch_by_id(post_id)
    if not rows:
        print(f"[translate] post {post_id} 없음")
        return -1
    src = dict(rows)
    if not src.get("body"):
        print(f"[translate] post {post_id} 본문 없음")
        return -1

    llm = LLMClient()
    en = translate_post(llm, src, target_channel)

    new_id = db.insert_draft(en["channel"], en["title"], src.get("content_type", "howto"))
    db.set_translation_meta(new_id, locale="en", translated_from=post_id)
    db.save_seo(new_id, "google", en["tags"])
    db.save_article(new_id, en["title"], en["meta_description"], en["body"])
    # 번역본은 사실검증 통과로 간주(원문에서 검증됨) → 검수만 받게 grounding 설정.
    db.save_grounding(new_id, 1.0)
    print(f"[translate] en draft id={new_id} (from {post_id})")
    return new_id


if __name__ == "__main__":
    import sys

    if len(sys.argv) < 2:
        print("사용: python -m pipeline.translate <post_id> [channel]")
    else:
        run_post(int(sys.argv[1]), sys.argv[2] if len(sys.argv) > 2 else None)
