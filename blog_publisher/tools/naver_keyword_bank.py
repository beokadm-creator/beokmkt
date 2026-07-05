"""
네이버 수기 발행 전용 키워드 뱅크 — 테마 클러스터 (기획 14 §3.3).

관리자/사용자가 테마를 골라 원고를 생성한다. selfhosted 키워드 뱅크와 분리한다:
- 네이버는 블로그 단위 주제 일관성(C-Rank)이 중요 → 명찰/학회/행사 축으로 좁게.
- "학회 명찰 출력" 네이버 검색을 플랩패스가 독점 중 → 코어로 직접 경쟁하고,
  경쟁 공백인 롱테일부터 지분을 확보한다.

각 테마는 사람이 읽고 고를 수 있는 라벨 + 그 축의 키워드 목록.
키워드 1개 = (주제 문장, content_type). 생성 시 테마 안에서 아직 안 쓴 것을 고른다.
"""
from __future__ import annotations

import random
from dataclasses import dataclass


@dataclass(frozen=True)
class Theme:
    key: str          # CLI/관리자에서 고르는 식별자
    label: str        # 사람이 보는 이름
    primary: str      # 테마 대표 검색어(폴백용)
    # 키워드 1개 = (주제 문장, content_type, 이 글이 노릴 검색 키워드).
    # 검색 키워드는 제목 포함·밀도 게이트의 기준이 되므로 글 주제와 정확히 맞춰야 한다.
    keywords: tuple[tuple[str, str, str], ...]


# ---------------------------------------------------------------------------
# 테마 클러스터. 플랩패스 대응 우선순위: badge_core > registration_desk > onsite_ops.
# ---------------------------------------------------------------------------
THEMES: tuple[Theme, ...] = (
    Theme(
        key="badge_core",
        label="학회 명찰 출력(코어 — 플랩패스 직접 경쟁)",
        primary="학회 명찰 출력",
        keywords=(
            ("학회 명찰 출력 현장에서 겪은 준비 과정과 체크 포인트", "howto", "학회 명찰 출력"),
            ("학회 명찰 제작, 명단이 계속 바뀌어도 안 꼬이게 하는 방법", "howto", "학회 명찰 제작"),
            ("행사 명찰 현장 출력, 접수대에서 실제로 하는 일", "howto", "행사 명찰 출력"),
            ("QR 명찰 출력 준비하면서 미리 챙겨야 했던 것들", "howto", "QR 명찰 출력"),
            ("학회 명찰 재발행 요청이 몰릴 때 현장 대응", "howto", "학회 명찰 재발행"),
        ),
    ),
    Theme(
        key="registration_desk",
        label="학회 접수·등록 데스크(롱테일 — 경쟁 공백)",
        primary="학회 접수대 준비",
        keywords=(
            ("학회 접수대 준비물, 현장에서 빠지면 곤란했던 것", "howto", "학회 접수대 준비물"),
            ("학술대회 등록 데스크 운영, 줄 안 서게 만든 동선", "howto", "학술대회 등록 데스크"),
            ("참가자 명단 정리, 현장 등록까지 생각한 데이터 준비", "howto", "참가자 명단 정리"),
            ("현장등록 명찰 발급, 사전등록과 섞이지 않게 나눈 방법", "howto", "현장등록 명찰"),
            ("학회 사무국 체크리스트, 행사 전날 밤에 확인한 것들", "howto", "학회 사무국 체크리스트"),
        ),
    ),
    Theme(
        key="onsite_ops",
        label="현장 운영·체크인(연관 확장)",
        primary="학회 QR 체크인",
        keywords=(
            ("학회 QR 체크인 현장 도입, 종이 명단과 뭐가 달랐나", "howto", "학회 QR 체크인"),
            ("학술대회 등록 시스템, 사무국 업무가 실제로 줄어든 부분", "niche", "학술대회 등록 시스템"),
            ("행사 참가자 데이터, 사후 보고서까지 남긴 정리 방법", "howto", "행사 참가자 데이터"),
            ("학회 현장 스태프 배치, 접수·명찰·안내를 나눈 기준", "howto", "학회 현장 스태프"),
        ),
    ),
)

_THEME_BY_KEY = {t.key: t for t in THEMES}


def theme_keys() -> list[str]:
    return [t.key for t in THEMES]


def get_theme(key: str) -> Theme | None:
    return _THEME_BY_KEY.get(key)


def list_themes() -> list[Theme]:
    return list(THEMES)


def pick_keyword(theme_key: str, used_topics: set[str]) -> tuple[str, str, str] | None:
    """테마 안에서 아직 안 쓴 (주제, content_type, 검색 키워드)를 무작위로 하나 고른다.

    used_topics: 이미 DB에 있는 topic의 정규화 집합. 모두 소진되면 None.
    """
    theme = get_theme(theme_key)
    if not theme:
        return None
    fresh = [kw for kw in theme.keywords if _normalize(kw[0]) not in used_topics]
    if not fresh:
        return None
    return random.choice(fresh)


def _normalize(text: str) -> str:
    return "".join(ch for ch in (text or "").lower() if ch.isalnum() or "가" <= ch <= "힣")
