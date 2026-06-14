"""규칙 기반 검수용 텍스트 유틸. LLM 호출 전에 싸게 거르는 1차 게이트."""
from __future__ import annotations

import re

import config


def visible_len(text: str) -> int:
    """마크다운 기호/공백 제외 대략적 본문 길이."""
    stripped = re.sub(r"[#*_`>\-\s]", "", text)
    return len(stripped)


def dup_ratio(text: str, n: int = 3) -> float:
    """
    n-gram(어절 기준) 중복률. 1에 가까울수록 같은 말 반복.
    긴 단일 출력에서 흔한 '늘려쓰기'를 잡는다.
    """
    words = re.findall(r"\w+", text)
    if len(words) < n + 1:
        return 0.0
    grams = [tuple(words[i:i + n]) for i in range(len(words) - n + 1)]
    if not grams:
        return 0.0
    unique = len(set(grams))
    return 1.0 - (unique / len(grams))


def has_banned_words(text: str) -> bool:
    low = text.lower()
    return any(w.lower() in low for w in config.BANNED_WORDS)


def count_headings(text: str) -> int:
    return len(re.findall(r"^#{2,3}\s", text, flags=re.MULTILINE))
