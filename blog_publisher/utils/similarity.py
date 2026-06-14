"""텍스트 유사도 (기획 10). n-gram 자카드로 원문 대비 변형 정도를 측정."""
from __future__ import annotations

import re


def _ngrams(text: str, n: int = 3) -> set[tuple[str, ...]]:
    words = re.findall(r"\w+", text.lower())
    if len(words) < n:
        return set()
    return {tuple(words[i:i + n]) for i in range(len(words) - n + 1)}


def jaccard(a: str, b: str, n: int = 3) -> float:
    """0(완전 다름)~1(동일). 원문(a)과 초안(b)의 n-gram 자카드 유사도."""
    ga, gb = _ngrams(a, n), _ngrams(b, n)
    if not ga or not gb:
        return 0.0
    inter = len(ga & gb)
    union = len(ga | gb)
    return inter / union if union else 0.0
