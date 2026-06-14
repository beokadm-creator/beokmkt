"""
DB 접근 계층.

설계 핵심
- 워커 간 직접 호출이 없다. 모든 협업은 posts.status를 통해서만 이뤄진다.
- claim()은 '원자적 상태 전환'으로 동일 글이 두 워커에 동시에 잡히는 것을 막는다.
- requeue()는 지수 백오프 재시도, max_attempts 초과 시 failed/needs_human으로 격리한다.

SQLite 기본 구현. PostgreSQL로 옮길 때는 connection/placeholder만 교체하면 된다.
"""
from __future__ import annotations

import json
import random
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

DB_PATH = Path(__file__).with_name("blog.db")
SCHEMA_PATH = Path(__file__).with_name("schema.sql")


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%d %H:%M:%S")


@contextmanager
def connect():
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")   # 동시 읽기/쓰기 안정화
    conn.execute("PRAGMA busy_timeout=5000;")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db() -> None:
    with connect() as conn:
        conn.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))


# ---------------------------------------------------------------------------
# 생성/조회
# ---------------------------------------------------------------------------
def insert_draft(
    channel: str,
    topic: str,
    content_type: str = "howto",
    category: str = "",
    blog_profile: str = "",
) -> int:
    with connect() as conn:
        cur = conn.execute(
            "INSERT INTO posts(channel, topic, content_type, category, blog_profile, status) "
            "VALUES (?, ?, ?, ?, ?, 'draft')",
            (channel, topic, content_type, category or None, blog_profile or None),
        )
        return cur.lastrowid


def fetch_by_status(status: str, limit: int = 10, due: bool = False) -> list[sqlite3.Row]:
    """status인 글을 가져온다. due=True면 next_run_at이 지난 것만."""
    where = "status = ?"
    params: list = [status]
    if due:
        where += " AND next_run_at <= ?"
        params.append(_iso(_utcnow()))
    params.append(limit)
    with connect() as conn:
        return conn.execute(
            f"SELECT * FROM posts WHERE {where} ORDER BY next_run_at LIMIT ?",
            params,
        ).fetchall()


def fetch_generate_ready(limit: int = 10) -> list[sqlite3.Row]:
    """생성 워커 전용: body가 없는 draft 중 next_run_at이 지났거나 NULL인 것."""
    now = _iso(_utcnow())
    with connect() as conn:
        return conn.execute(
            "SELECT * FROM posts WHERE status = 'draft' "
            "AND (body IS NULL OR body = '') "
            "AND (next_run_at IS NULL OR next_run_at <= ?) "
            "ORDER BY created_at LIMIT ?",
            (now, limit),
        ).fetchall()


def fetch_by_id(post_id: int):
    with connect() as conn:
        return conn.execute("SELECT * FROM posts WHERE id = ?", (post_id,)).fetchone()


def set_translation_meta(post_id: int, locale: str, translated_from: int) -> None:
    """번역본 메타(로케일/원문 연결) 저장(기획 11)."""
    with connect() as conn:
        conn.execute(
            "UPDATE posts SET locale = ?, translated_from = ?, updated_at = ? WHERE id = ?",
            (locale, translated_from, _iso(_utcnow()), post_id),
        )


def count_by_status(status: str) -> int:
    with connect() as conn:
        row = conn.execute(
            "SELECT COUNT(*) AS n FROM posts WHERE status = ?", (status,)
        ).fetchone()
        return row["n"]


# ---------------------------------------------------------------------------
# 상태 전환 (원자적)
# ---------------------------------------------------------------------------
def claim(post_id: int, from_status: str, to_status: str) -> bool:
    """
    from_status인 경우에만 to_status로 바꾼다.
    반환 True면 이 워커가 소유권을 획득한 것. False면 다른 워커가 이미 가져감.
    """
    with connect() as conn:
        cur = conn.execute(
            "UPDATE posts SET status = ?, updated_at = ? "
            "WHERE id = ? AND status = ?",
            (to_status, _iso(_utcnow()), post_id, from_status),
        )
        return cur.rowcount == 1


def save_outline(post_id: int, title: str, outline: dict) -> None:
    with connect() as conn:
        conn.execute(
            "UPDATE posts SET title = ?, outline = ?, updated_at = ? WHERE id = ?",
            (title, json.dumps(outline, ensure_ascii=False), _iso(_utcnow()), post_id),
        )


def save_research(post_id: int, evidence: dict) -> None:
    """근거팩/의도/키워드/출처를 저장(기획 05)."""
    with connect() as conn:
        conn.execute(
            "UPDATE posts SET intent = ?, keywords = ?, evidence = ?, sources = ?, "
            "updated_at = ? WHERE id = ?",
            (
                evidence.get("intent", ""),
                json.dumps(
                    {
                        "primary": evidence.get("primary_keyword", ""),
                        "secondary": evidence.get("secondary_keywords", []),
                    },
                    ensure_ascii=False,
                ),
                json.dumps(evidence, ensure_ascii=False),
                json.dumps(evidence.get("sources", []), ensure_ascii=False),
                _iso(_utcnow()),
                post_id,
            ),
        )


def save_source_url(post_id: int, url: str) -> None:
    """재작성 원본 URL 저장(기획 10)."""
    with connect() as conn:
        conn.execute(
            "UPDATE posts SET source_url = ?, updated_at = ? WHERE id = ?",
            (url, _iso(_utcnow()), post_id),
        )


def save_seo(post_id: int, target_engine: str, tags: list) -> None:
    """검색 노출 메타(타깃 엔진/태그) 저장(기획 07)."""
    with connect() as conn:
        conn.execute(
            "UPDATE posts SET target_engine = ?, tags = ?, updated_at = ? WHERE id = ?",
            (target_engine, json.dumps(tags, ensure_ascii=False), _iso(_utcnow()), post_id),
        )


def save_article(post_id: int, title: str, meta_desc: str, body: str) -> None:
    """근거기반 생성 결과 저장. draft 유지 -> 사실검증/검수 워커가 이어받음.

    next_run_at은 NOT NULL이므로 NULL 대신 현재시각으로 둔다(즉시 다음 단계 대상).
    """
    now = _iso(_utcnow())
    with connect() as conn:
        conn.execute(
            "UPDATE posts SET title = ?, meta_desc = ?, body = ?, status = 'draft', "
            "attempts = 0, next_run_at = ?, last_error = NULL, updated_at = ? WHERE id = ?",
            (title, meta_desc, body, now, now, post_id),
        )


def save_grounding(post_id: int, ratio: float) -> None:
    with connect() as conn:
        conn.execute(
            "UPDATE posts SET grounding_ratio = ?, updated_at = ? WHERE id = ?",
            (ratio, _iso(_utcnow()), post_id),
        )


def save_body(post_id: int, body: str, to_status: str = "draft") -> None:
    with connect() as conn:
        conn.execute(
            "UPDATE posts SET body = ?, status = ?, updated_at = ? WHERE id = ?",
            (body, to_status, _iso(_utcnow()), post_id),
        )


def mark_reviewed(post_id: int) -> None:
    with connect() as conn:
        conn.execute(
            "UPDATE posts SET status = 'reviewed', review_issues = NULL, "
            "updated_at = ? WHERE id = ?",
            (_iso(_utcnow()), post_id),
        )


def mark_review_failed(post_id: int, issues: list[str]) -> None:
    """검수 탈락 -> draft로 되돌려 재생성 대상이 되게 한다."""
    with connect() as conn:
        conn.execute(
            "UPDATE posts SET status = 'draft', review_issues = ?, updated_at = ? "
            "WHERE id = ?",
            (json.dumps(issues, ensure_ascii=False), _iso(_utcnow()), post_id),
        )


def enqueue(post_id: int, idem_key: str, run_at: datetime | None = None) -> None:
    """검수 통과분을 발행 큐에 넣는다. run_at으로 예약/분산 발행."""
    run_at = run_at or _utcnow()
    with connect() as conn:
        conn.execute(
            "UPDATE posts SET status = 'queued', idem_key = ?, next_run_at = ?, "
            "updated_at = ? WHERE id = ?",
            (idem_key, _iso(run_at), _iso(_utcnow()), post_id),
        )


def mark_published(post_id: int, url: str) -> None:
    with connect() as conn:
        conn.execute(
            "UPDATE posts SET status = 'published', published_url = ?, "
            "last_error = NULL, updated_at = ? WHERE id = ?",
            (url, _iso(_utcnow()), post_id),
        )


def requeue(post_id: int, attempts: int, max_attempts: int, error: str,
            base_seconds: int = 60) -> str:
    """
    재시도 가능한 실패 처리. 지수 백오프 + 지터.
    max_attempts 초과 시 needs_human(수동 폴백 큐)으로 격리.
    반환: 전환된 최종 상태.
    """
    if attempts >= max_attempts:
        with connect() as conn:
            conn.execute(
                "UPDATE posts SET status = 'needs_human', attempts = ?, "
                "last_error = ?, updated_at = ? WHERE id = ?",
                (attempts, error, _iso(_utcnow()), post_id),
            )
        return "needs_human"

    backoff = min(base_seconds * (2 ** attempts), 3600)
    jitter = random.randint(0, backoff // 4)
    next_run = _utcnow() + timedelta(seconds=backoff + jitter)
    with connect() as conn:
        conn.execute(
            "UPDATE posts SET status = 'queued', attempts = ?, next_run_at = ?, "
            "last_error = ?, updated_at = ? WHERE id = ?",
            (attempts, _iso(next_run), error, _iso(_utcnow()), post_id),
        )
    return "queued"


def requeue_draft(
    post_id: int, attempts: int, error: str, max_attempts: int = 5
) -> str:
    """
    생성 실패 시 지수 백오프로 draft 재시도 예약.
    기본 10분에서 시작해 최대 2시간까지 늘어난다.
    max_attempts 초과 시 needs_human으로 격리.
    """
    if attempts >= max_attempts:
        with connect() as conn:
            conn.execute(
                "UPDATE posts SET status = 'needs_human', attempts = ?, "
                "last_error = ?, updated_at = ? WHERE id = ?",
                (attempts, error[:1000], _iso(_utcnow()), post_id),
            )
        return "needs_human"
    backoff = min(600 * (2 ** attempts), 7200)
    jitter = random.randint(0, backoff // 4)
    next_run = _utcnow() + timedelta(seconds=backoff + jitter)
    with connect() as conn:
        conn.execute(
            "UPDATE posts SET status = 'draft', attempts = ?, next_run_at = ?, "
            "last_error = ?, updated_at = ? WHERE id = ?",
            (attempts, _iso(next_run), error[:1000], _iso(_utcnow()), post_id),
        )
    return "draft"


def reset_stuck(threshold_minutes: int = 35) -> int:
    """
    중간 상태(generating/factchecking/reviewing/publishing)에서 멈춘 글을
    복구 가능한 상태로 되돌린다. 프로세스 크래시 후 다음 주기에 자동 복구.
    generating/factchecking/reviewing → draft, publishing → queued.
    """
    cutoff = _iso(_utcnow() - timedelta(minutes=threshold_minutes))
    now = _iso(_utcnow())
    recovered = 0
    with connect() as conn:
        cur = conn.execute(
            "UPDATE posts SET status = 'draft', next_run_at = ?, updated_at = ? "
            "WHERE status IN ('generating', 'factchecking', 'reviewing') "
            "AND updated_at < ?",
            (now, now, cutoff),
        )
        recovered += cur.rowcount
        cur = conn.execute(
            "UPDATE posts SET status = 'queued', next_run_at = ?, updated_at = ? "
            "WHERE status = 'publishing' AND updated_at < ?",
            (now, now, cutoff),
        )
        recovered += cur.rowcount
    return recovered


def mark_failed(post_id: int, error: str) -> None:
    """복구 불가(치명적) 실패."""
    with connect() as conn:
        conn.execute(
            "UPDATE posts SET status = 'failed', last_error = ?, updated_at = ? "
            "WHERE id = ?",
            (error, _iso(_utcnow()), post_id),
        )
