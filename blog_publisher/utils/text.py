"""규칙 기반 검수용 텍스트 유틸. LLM 호출 전에 싸게 거르는 1차 게이트."""
from __future__ import annotations

import re

import config

# 실측 filler 사전(발행/유사발행 본문 10건 정독 기반, 콘텐츠 품질 진단
# reports/content-quality-audit-20260705.md §3). "쓸 말이 없어서" 서사적
# 수사로 분량을 채우는 패턴 — 정보밀도가 아니라 반복 빈도로 판정한다.
FILLER_TERMS: tuple[str, ...] = (
    "완벽한", "압도적인", "획기적으로", "필수적입니다", "핵심입니다",
    "가장 중요한", "비로소", "과언이 아닙니다", "다름없습니다", "골든타임",
    "심장이다", "막막하신가요", "잊지 마세요", "드릴게요", "상상해 보세요",
    "이제야", "번거로운 일입니다", "악몽 같은",
)

_SENTENCE_RE = re.compile(r".+?(?:[.!?。]|다\.|요\.|니다\.|$)", re.S)


def _sentences(text: str) -> list[str]:
    return [s.strip() for s in _SENTENCE_RE.findall(text or "") if s.strip()]


def filler_ratio(text: str) -> float:
    """filler 사전에 매칭되는 문장 비율(0~1, 참고용). 전체 문장 수 대비 계산.

    발행 게이트에는 쓰지 않는다 — 실측 발행분(7,000~13,500자, 문장 100개
    이상)에서 filler 매칭이 문장 전체에 희석되어 8~13%를 넘기지 못했다
    (모든 exhibit이 0.049~0.073으로 통과). filler_density()를 게이트에 쓴다.
    """
    sentences = _sentences(text)
    if not sentences:
        return 0.0
    hit = sum(1 for s in sentences if any(term in s for term in FILLER_TERMS))
    return hit / len(sentences)


def filler_density(text: str) -> float:
    """filler 사전 매칭 문장 수를 본문 1,000자당 건수로 환산(문서 길이에 덜 희석됨)."""
    length = len(text or "")
    if length == 0:
        return 0.0
    sentences = _sentences(text)
    hit = sum(1 for s in sentences if any(term in s for term in FILLER_TERMS))
    return hit / (length / 1000)


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
