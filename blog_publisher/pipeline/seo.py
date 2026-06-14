"""
SEO 최적화 단계 (기획 07 §5).

초안을 '타깃 엔진'(네이버/구글)에 맞춰 다듬는다.
내용(사실)은 바꾸지 않고 노출 요소(제목/메타/태그/포맷)를 최적화한다.

반환: {seo_title, meta_description, tags, image_markers, notes}
네이버는 image_markers(사진 위치 제안)를 추가로 준다.
"""
from __future__ import annotations

import config
from llm import prompts
from llm.client import LLMClient
from llm.parse import chat_json


def optimize(
    llm: LLMClient,
    engine: str,
    topic: str,
    title: str,
    body: str,
    evidence: dict,
    serp: list[dict] | None = None,
) -> dict:
    system = prompts.SEO_NAVER_SYSTEM if engine == "naver" else prompts.SEO_GOOGLE_SYSTEM
    serp_titles = "\n".join(f"- {r.get('title', '')}" for r in (serp or [])) or "(없음)"

    # 본문은 앞 1500자만 — SEO 판단에 충분하고 프롬프트 과비대 방지
    body_snippet = body[:1500]

    data = chat_json(
        llm,
        system,
        prompts.SEO_USER.format(
            topic=topic,
            primary_keyword=evidence.get("primary_keyword", topic),
            intent=evidence.get("intent", ""),
            serp_titles=serp_titles,
            title=title,
            body=body_snippet,
        ),
        model=config.MODEL_OUTLINE,
        max_tokens=config.MAX_TOKENS_SEO,
        thinking=False,
        temperature=0.3,
    )
    data.setdefault("seo_title", title)
    data.setdefault("meta_description", "")
    data.setdefault("tags", [])
    data.setdefault("image_markers", [])
    data.setdefault("notes", [])
    return data


def apply_image_markers(body: str, markers: list[str]) -> str:
    """
    네이버용 이미지 위치 제안.

    주의(감사 G4): `[이미지: ...]` 같은 리터럴 텍스트를 본문에 넣으면 실제 이미지로
    치환되지 못하고 발행 글에 그대로 노출된다. 실제 이미지 파이프라인(생성/업로드)이
    준비되기 전까지는 본문을 변경하지 않는다(노출 사고 방지).
    image_markers는 seo 산출물(notes)로만 보관해 운영자가 참고한다.
    """
    return body
