"""
발행 워커 — 큐에서 due 글을 집어 채널 어댑터로 발행한다.

안정성 장치
- claim(): 원자적 queued->publishing 전환으로 중복 발행 방지.
- 멱등성: idem_key UNIQUE. 재시도가 같은 글을 두 번 올리지 않게.
- 재시도: RetryableError -> 지수 백오프 후 queued 복귀. max_attempts 초과 시 needs_human.
- 격리: FatalError -> 즉시 failed. needs_human/failed는 사람이 처리(수동 폴백 큐).
"""
from __future__ import annotations

import config
from db import db
from publishers import PUBLISHERS
from publishers.base import FatalError, RetryableError
from utils.notify import notify


def run_once(batch: int = 5) -> dict:
    stats = {"published": 0, "retried": 0, "needs_human": 0, "failed": 0}

    for post in db.fetch_by_status("queued", limit=batch, due=True):
        # 소유권 획득 — 실패하면 다른 워커가 가져간 것
        if not db.claim(post["id"], "queued", "publishing"):
            continue

        publisher = PUBLISHERS.get(post["channel"])
        if publisher is None:
            db.mark_failed(post["id"], f"unknown channel: {post['channel']}")
            stats["failed"] += 1
            continue

        try:
            url = publisher.publish(dict(post))
            db.mark_published(post["id"], url)
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


if __name__ == "__main__":
    print(f"[publish] {run_once()}")
