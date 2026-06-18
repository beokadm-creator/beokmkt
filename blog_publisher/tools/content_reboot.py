"""
기존 블로그 원고/공개 글을 정리하고 다양한 주제로 다시 시작한다.

목적:
- 과거 저품질 selfhosted 공개 글을 API로 soft-delete
- 로컬 SQLite의 기존 selfhosted/tistory 운영 원고를 archived로 격리
- 홈페이지 구축, 맞춤형 시스템, MICE 레퍼런스, 학술대회 운영을 균형 있게 새 draft로 시드
"""
from __future__ import annotations

import argparse
import json
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

import requests

import config
from db import db


RESET_STATUSES = (
    "draft",
    "generating",
    "factchecking",
    "reviewing",
    "reviewed",
    "queued",
    "publishing",
    "published",
    "needs_human",
    "failed",
)

REBOOT_TOPICS: list[tuple[str, str, str, str]] = [
    ("초기 제작비 없이 시작하는 운영형 홈페이지, 어떤 사업자에게 맞을까", "niche", "beok", "homepage"),
    ("월 구독형 홈페이지에서 서버, SSL, SEO를 함께 봐야 하는 이유", "howto", "beok", "homepage"),
    ("예약, 결제, 알림톡이 필요한 서비스업 홈페이지 설계 기준", "howto", "beok", "homepage"),
    ("회사 홈페이지 제작 전에 Search Console과 콘텐츠 구조를 정하는 방법", "howto", "beok", "homepage"),
    ("소개형 홈페이지와 관리자형 홈페이지의 차이, 개발 전에 정리할 것들", "review", "beok", "homepage"),
    ("AI 상담과 견적 문의 자동화를 홈페이지에 연결하는 현실적인 방법", "howto", "beok", "homepage"),
    ("엑셀로 관리하던 업무를 웹 관리자 시스템으로 옮기는 순서", "howto", "beok", "system"),
    ("예약, 결제, 고객관리 백오피스를 하나로 묶는 맞춤형 시스템 설계", "howto", "beok", "system"),
    ("카카오 알림톡, 결제, 이메일 API 연동 프로젝트에서 먼저 정해야 할 것", "howto", "beok", "system"),
    ("운영 대시보드 구축 시 대표가 매일 봐야 하는 지표와 화면 구성", "niche", "beok", "system"),
    ("회원 DB, 승인 권한, 관리자 로그를 갖춘 업무 시스템 기획 방법", "howto", "beok", "system"),
    ("기존 홈페이지 데이터를 새 시스템으로 이전할 때 생기는 실무 리스크", "niche", "beok", "system"),
    ("홍커뮤니케이션 MICE 운영 레퍼런스로 보는 국제학술대회 준비 흐름", "niche", "hong", "mice"),
    ("AI 실시간 동시통역을 국제회의 프로그램에 넣을 때 확인할 운영 조건", "howto", "hong", "mice"),
    ("참가자 경험을 기준으로 국제회의 접수, 안내, 세션 운영을 설계하는 방법", "howto", "hong", "mice"),
    ("MICE 행사 사후 보고서에 남겨야 할 등록, 참석, 만족도 데이터", "howto", "hong", "mice"),
    ("하이브리드 학술대회에서 온라인 안내와 현장 운영을 함께 설계하는 법", "howto", "hong", "mice"),
    ("행사 대행사와 개발사가 함께 요구사항을 정리해야 하는 이유", "niche", "hong", "mice"),
    ("학술대회 홈페이지에서 초록 접수, 심사, 결제를 분리하지 않는 설계법", "howto", "beok", "conference"),
    ("논문 투고 시스템을 학회 홈페이지에 붙일 때 필요한 관리자 권한", "howto", "beok", "conference"),
    ("등록비 결제, 영수증, 참가확인증을 한 흐름으로 관리하는 방법", "howto", "beok", "conference"),
    ("QR 체크인과 참석자 리포트를 학술대회 운영 데이터로 남기는 방법", "howto", "beok", "conference"),
    ("학회 회원 DB와 행사 신청 DB를 연동할 때 확인할 보안 기준", "niche", "beok", "conference"),
    ("행사 전후 이메일과 문자 안내를 자동화하는 학술대회 운영 시스템", "howto", "beok", "conference"),
]


@dataclass
class PublicDelete:
    id: str
    title: str
    slug: str
    ok: bool
    reason: str


def _utcnow() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def balanced_topics(limit: int = 24) -> list[tuple[str, str, str, str]]:
    """축별 순서를 섞어 한 주제군이 과도하게 반복되지 않게 한다."""
    axes = ("homepage", "system", "mice", "conference")
    grouped = {axis: [topic for topic in REBOOT_TOPICS if topic[3] == axis] for axis in axes}
    selected: list[tuple[str, str, str, str]] = []
    while len(selected) < limit:
        added = False
        for axis in axes:
            if grouped[axis]:
                selected.append(grouped[axis].pop(0))
                added = True
                if len(selected) >= limit:
                    break
        if not added:
            break
    return selected


def _api_base() -> str:
    return (config.SELFHOST_API_URL or "https://beokmkt.web.app").rstrip("/")


def _fetch_public_posts() -> list[dict]:
    posts: list[dict] = []
    seen: set[str] = set()
    for _ in range(5):
        resp = requests.get(
            f"{_api_base()}/api/blog-posts",
            params={"status": "published", "limit": 100},
            headers={"X-API-Key": config.SELFHOST_API_KEY} if config.SELFHOST_API_KEY else {},
            timeout=30,
        )
        resp.raise_for_status()
        items = resp.json().get("data", {}).get("items", [])
        fresh = [item for item in items if item.get("id") not in seen]
        posts.extend(fresh)
        seen.update(str(item.get("id")) for item in fresh)
        if len(items) < 100:
            break
        # 삭제 전 dry-run에서는 첫 100개면 충분하다. apply에서는 삭제 후 루프가 다시 호출된다.
        break
    return posts


def _delete_public_posts() -> list[PublicDelete]:
    results: list[PublicDelete] = []
    if not config.SELFHOST_API_KEY:
        return [PublicDelete("", "", "", False, "SELFHOST_API_KEY 미설정")]
    for _ in range(5):
        posts = _fetch_public_posts()
        if not posts:
            break
        for post in posts:
            post_id = str(post.get("id") or "")
            title = str(post.get("title") or "")
            slug = str(post.get("slug") or "")
            if not post_id:
                results.append(PublicDelete("", title, slug, False, "id 없음"))
                continue
            try:
                resp = requests.delete(
                    f"{_api_base()}/api/blog-posts/{post_id}",
                    headers={"X-API-Key": config.SELFHOST_API_KEY},
                    timeout=30,
                )
                ok = resp.status_code in {200, 204}
                results.append(PublicDelete(
                    post_id,
                    title,
                    slug,
                    ok,
                    "삭제 완료" if ok else f"HTTP {resp.status_code}: {resp.text[:160]}",
                ))
            except requests.RequestException as exc:
                results.append(PublicDelete(post_id, title, slug, False, f"네트워크 오류: {exc}"))
        if len(posts) < 100:
            break
    return results


def _local_rows(channels: Iterable[str]):
    channels = tuple(channels)
    channel_marks = ",".join("?" for _ in channels)
    status_marks = ",".join("?" for _ in RESET_STATUSES)
    with db.connect() as conn:
        return conn.execute(
            f"""
            SELECT id, channel, status, topic, title, published_url, updated_at
            FROM posts
            WHERE channel IN ({channel_marks})
              AND status IN ({status_marks})
            ORDER BY channel, updated_at, id
            """,
            (*channels, *RESET_STATUSES),
        ).fetchall()


def _archive_local(post_ids: list[int], reason: str) -> int:
    if not post_ids:
        return 0
    placeholders = ",".join("?" for _ in post_ids)
    now = _utcnow()
    message = f"ARCHIVED: {reason}"
    with db.connect() as conn:
        cur = conn.execute(
            f"""
            UPDATE posts
            SET status = 'archived',
                last_error = CASE
                  WHEN last_error IS NULL OR last_error = '' THEN ?
                  ELSE ? || ' | previous: ' || substr(last_error, 1, 800)
                END,
                updated_at = ?
            WHERE id IN ({placeholders})
            """,
            (message, message, now, *post_ids),
        )
        return cur.rowcount


def _seed_selfhosted(limit: int) -> list[dict]:
    created: list[dict] = []
    for topic, content_type, brand, axis in balanced_topics(limit):
        post_id = db.insert_draft(
            channel="selfhosted",
            topic=topic,
            content_type=content_type,
            category=brand,
        )
        created.append({
            "id": post_id,
            "channel": "selfhosted",
            "topic": topic,
            "content_type": content_type,
            "category": brand,
            "axis": axis,
        })
    return created


def _write_report(report: dict) -> Path:
    report_dir = Path(__file__).resolve().parents[1] / "reports"
    report_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    path = report_dir / f"content-reboot-{stamp}.json"
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def run(argv: list[str] | None = None) -> bool:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--selfhosted-target", type=int, default=24)
    parser.add_argument("--channels", default="selfhosted,tistory")
    args = parser.parse_args(argv)

    channels = tuple(part.strip() for part in args.channels.split(",") if part.strip())
    rows = _local_rows(channels)
    public_posts = _fetch_public_posts()
    report = {
        "ok": True,
        "mode": "apply" if args.apply else "dry-run",
        "generated_at": _utcnow(),
        "channels": list(channels),
        "local_matched": len(rows),
        "local_ids": [int(row["id"]) for row in rows],
        "public_matched": len(public_posts),
        "public_posts": [
            {"id": post.get("id"), "title": post.get("title"), "slug": post.get("slug")}
            for post in public_posts
        ],
        "public_deletes": [],
        "local_archived": 0,
        "created": [],
        "topic_plan": [
            {"topic": topic, "content_type": ctype, "category": brand, "axis": axis}
            for topic, ctype, brand, axis in balanced_topics(args.selfhosted_target)
        ],
    }

    if args.apply:
        deletes = _delete_public_posts()
        report["public_deletes"] = [asdict(item) for item in deletes]
        failed = [item for item in deletes if not item.ok]
        if failed:
            report["ok"] = False
            path = _write_report(report)
            print(json.dumps(report, ensure_ascii=False, indent=2))
            print(f"report={path}")
            return False
        report["local_archived"] = _archive_local([int(row["id"]) for row in rows], "content_reboot_all_previous")
        report["created"] = _seed_selfhosted(args.selfhosted_target)

    path = _write_report(report)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    print(f"report={path}")
    return bool(report["ok"])


if __name__ == "__main__":
    import sys

    raise SystemExit(0 if run(sys.argv[1:]) else 1)
