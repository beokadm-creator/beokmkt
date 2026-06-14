"""
채널 어댑터 공통 인터페이스.

설계 의도
- 발행 워커는 채널을 모른다. PUBLISHERS[channel].publish(post) 만 호출한다.
- 새 채널은 Publisher를 구현해 레지스트리에 등록하면 끝.
- 예외를 두 종류로 구분해 워커가 '재시도할지 / 격리할지'를 판단한다.
"""
from __future__ import annotations

from typing import Protocol, runtime_checkable


class RetryableError(Exception):
    """일시적 실패(네트워크, 일시적 차단, 셀렉터 타임아웃 등). 재시도 대상."""


class FatalError(Exception):
    """복구 불가(인증 영구 실패, 정책 위반 등). 즉시 격리."""


@runtime_checkable
class Publisher(Protocol):
    name: str

    def publish(self, post) -> str:
        """발행하고 게시물 URL을 반환한다. 실패 시 RetryableError/FatalError를 던진다."""
        ...
