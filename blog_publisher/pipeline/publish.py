"""
발행 워커 — 큐에서 due 글을 집어 채널 어댑터로 발행한다.

안정성 장치
- claim(): 원자적 queued->publishing 전환으로 중복 발행 방지.
- 멱등성: idem_key UNIQUE. 재시도가 같은 글을 두 번 올리지 않게.
- 재시도: RetryableError -> 지수 백오프 후 queued 복귀. max_attempts 초과 시 needs_human.
- 격리: FatalError -> 즉시 failed. needs_human/failed는 사람이 처리(수동 폴백 큐).
"""
from __future__ import annotations

import os
from contextlib import contextmanager
from pathlib import Path

import config
from db import db
from publishers import PUBLISHERS
from publishers.base import FatalError, NeedsHumanError, RetryableError
from tools.content_quality import publish_blockers
from utils.notify import notify

if os.name == "nt":
    import msvcrt
else:
    import fcntl

LOCK_PATH = Path(__file__).resolve().parents[1] / "db" / "publish.lock"


def _try_lock(fh) -> bool:
    if os.name == "nt":
        try:
            msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
            return True
        except OSError:
            return False
    try:
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        return True
    except BlockingIOError:
        return False


def _unlock(fh) -> None:
    if os.name == "nt":
        fh.seek(0)
        msvcrt.locking(fh.fileno(), msvcrt.LK_UNLCK, 1)
    else:
        fcntl.flock(fh.fileno(), fcntl.LOCK_UN)


@contextmanager
def _publish_lock():
    """동일 머신에서 cron/수동 실행이 겹쳐 외부 채널을 동시에 누르는 것을 막는다."""
    LOCK_PATH.parent.mkdir(parents=True, exist_ok=True)
    with LOCK_PATH.open("w") as fh:
        if not _try_lock(fh):
            yield False
            return
        try:
            yield True
        finally:
            _unlock(fh)


def _empty_stats() -> dict:
    return {"published": 0, "retried": 0, "needs_human": 0, "failed": 0, "skipped": 0}


def _assert_publish_quality_gate(post) -> None:
    """
    운영 안전장치: 품질 임계값을 0으로 둔 테스트 설정에서는 실제 발행을 막는다.
    자체/외부 채널 모두 같은 기준이다. mock selftest는 grounding/review 값을 정상으로 둔다.
    """
    if config.MIN_GROUNDING_RATIO <= 0 or config.MIN_REVIEW_SCORE <= 0:
        raise NeedsHumanError(
            "품질 게이트 비활성 상태(MIN_GROUNDING_RATIO/MIN_REVIEW_SCORE <= 0)에서는 자동 발행 금지. "
            "운영 발행 전 MIN_GROUNDING_RATIO=0.9, MIN_REVIEW_SCORE=80 이상으로 복구하세요."
        )
    ratio = post["grounding_ratio"]
    if ratio is None or float(ratio) < config.MIN_GROUNDING_RATIO:
        raise NeedsHumanError(
            f"사실검증 미통과 grounding_ratio={ratio}; 기준={config.MIN_GROUNDING_RATIO}. 자동 발행 금지."
        )
    blockers = publish_blockers(post)
    if blockers:
        raise NeedsHumanError("발행 전 품질 게이트 차단: " + " / ".join(blockers))


def _publish_claimed_post(post) -> dict:
    """이미 publishing으로 claim된 post 1건을 채널 어댑터로 발행한다."""
    stats = _empty_stats()
    publisher = PUBLISHERS.get(post["channel"])
    if publisher is None:
        db.mark_failed(post["id"], f"unknown channel: {post['channel']}")
        stats["failed"] += 1
        return stats

    try:
        _assert_publish_quality_gate(post)
        result = publisher.publish(dict(post))
        if isinstance(result, dict):
            url = result.get("url") or ""
            published_title = result.get("title") or None
        else:
            url = result
            published_title = None
        db.mark_published(post["id"], url, title=published_title)
        stats["published"] += 1

    except RetryableError as e:
        result = db.requeue(
            post["id"],
            attempts=post["attempts"] + 1,
            max_attempts=post["max_attempts"],
            error=str(e),
        )
        if result == "needs_human":
            stats["needs_human"] += 1
            notify(f"수동 발행 필요: id={post['id']} ({post['channel']}) — {e}", "error")
        else:
            stats["retried"] += 1

    except NeedsHumanError as e:
        db.mark_needs_human(post["id"], str(e), attempts=post["attempts"] + 1)
        stats["needs_human"] += 1
        notify(f"수동 발행 필요: id={post['id']} ({post['channel']}) — {e}", "error")

    except FatalError as e:
        db.mark_failed(post["id"], str(e))
        stats["failed"] += 1
        notify(f"발행 치명 실패: id={post['id']} ({post['channel']}) — {e}", "error")

    except Exception as e:  # noqa: BLE001  예상 못한 오류도 재시도 대상으로
        result = db.requeue(
            post["id"],
            attempts=post["attempts"] + 1,
            max_attempts=post["max_attempts"],
            error=f"unexpected: {e}",
        )
        if result == "needs_human":
            stats["needs_human"] += 1
            notify(f"수동 발행 필요(예상 밖 오류): id={post['id']} ({post['channel']}) — {e}", "error")
        else:
            stats["retried"] += 1

    return stats


def publish_one(post_id: int) -> dict:
    """운영 검증용: 큐 전체가 아니라 지정한 queued 글 1건만 발행한다."""
    stats = _empty_stats()
    with _publish_lock() as acquired:
        if not acquired:
            print("[publish_one] 다른 발행 프로세스가 실행 중이라 건너뜀")
            stats["skipped"] += 1
            return stats

        post = db.fetch_by_id(post_id)
        if post is None:
            print(f"[publish_one] id={post_id} 글을 찾을 수 없음")
            stats["skipped"] += 1
            return stats
        if post["status"] != "queued":
            print(f"[publish_one] id={post_id} 상태가 queued가 아님: {post['status']}")
            stats["skipped"] += 1
            return stats
        if not db.claim(post_id, "queued", "publishing"):
            stats["skipped"] += 1
            return stats

        post = db.fetch_by_id(post_id)
        return _publish_claimed_post(post)


def run_once(batch: int = 5) -> dict:
    stats = _empty_stats()
    with _publish_lock() as acquired:
        if not acquired:
            print("[publish] 다른 발행 프로세스가 실행 중이라 이번 주기는 건너뜀")
            stats["skipped"] += 1
            return stats

        for post in db.fetch_by_status("queued", limit=batch, due=True):
            # 소유권 획득 — 실패하면 다른 워커가 가져간 것
            if not db.claim(post["id"], "queued", "publishing"):
                stats["skipped"] += 1
                continue

            post = db.fetch_by_id(post["id"])
            result = _publish_claimed_post(post)
            for key, value in result.items():
                stats[key] += value

    return stats


if __name__ == "__main__":
    print(f"[publish] {run_once()}")
