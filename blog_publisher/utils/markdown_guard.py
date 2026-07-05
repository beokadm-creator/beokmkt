"""마크다운 전용 출력 가드.

이전에는 `span|div|font|p|section|article` 6개 태그명 블랙리스트가
generate.py / content_quality.py / cleanup_bodies.py 세 곳에 개별 복제되어
있었다. 모델이 7번째 태그(<b>, <u>, <br> 등)를 섞으면 세 곳 모두 놓친다.

섹션 본문은 순수 마크다운만 허용한다는 게 원래 계약(llm/prompts.py SECTION_SYSTEM)
이므로, 알려진 위반 사례를 지우는 대신 마크다운 문법에 없는 `<...>` 토큰 자체를
위반으로 간주한다. db/blog.db 전수 조사 결과 raw `<img>` HTML도 실제로는 한 번도
쓰인 적이 없다(이미지는 전부 `![alt](url)` 마크다운 문법) — 그래서 예외 없이
전체 태그를 금지해도 안전하다.
"""
from __future__ import annotations

import re

_TAG_RE = re.compile(r"</?[a-zA-Z][a-zA-Z0-9]*(?:\s[^<>]*)?/?>")


def find_html_tags(text: str) -> list[str]:
    """본문에서 마크다운 문법이 아닌 HTML 태그를 모두 찾는다."""
    return _TAG_RE.findall(text or "")


def has_html_tags(text: str) -> bool:
    return bool(_TAG_RE.search(text or ""))


def strip_html_tags(text: str) -> str:
    """일회성 정리 스크립트(tools/cleanup_bodies.py) 전용 최후 수단.

    실시간 생성 경로(pipeline/generate.py)는 이 함수로 조용히 지우지 말고
    has_html_tags()로 감지해 재생성/하드 실패시켜야 한다 — 그래야 태그가
    섞이는 근본 원인(모델 출력)이 통계에 남는다.
    """
    return _TAG_RE.sub("", text or "")
