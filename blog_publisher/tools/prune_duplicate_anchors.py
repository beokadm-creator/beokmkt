"""
근접중복(같은 틀) 공개 글 정리.

전략(기획 08/13)의 조합형 시드가 "학원 홈페이지 제작에서 OO 항목을 먼저 설계
하는 기준" 같은 같은 틀(앵커=제목 앞 2단어)에 변형만 붙여 여러 건을 만들어
왔다. 제목이 매번 달라 strategy_audit의 문자열 중복 탐지는 걸리지 않지만,
검색 관점에서는 사실상 같은 주제의 근접중복이다. 이 도구는 앵커별로 남길
개수(cap)를 넘는 글을 골라 selfhosted 공개 API에서 soft-delete한다.

실제 삭제는 --apply 때만 실행한다(기본은 dry-run). 삭제는 Firestore
deleted_at 기록 방식의 soft-delete이므로 로컬 DB 기록으로 원상복구 판단이
가능하다(server 쪽 하드 삭제 아님).
"""
from __future__ import annotations

import argparse
import json
import re
import time
import urllib.parse
import urllib.request
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path

import requests

import config

DEFAULT_PUBLIC_BASE = "https://beoksolution.com"
DEFAULT_CAP = 2


def _api_base() -> str:
    return (config.SELFHOST_API_URL or DEFAULT_PUBLIC_BASE).rstrip("/")


def _normalize(text: str) -> str:
    return re.sub(r"[^가-힣a-z0-9]", "", (text or "").lower())


def _anchor(title: str) -> str:
    """같은 틀 주제를 묶는 키. auto_seed._anchor/schedule_publish._anchor와 동일 규칙."""
    toks = [t for t in re.split(r"\s+", title or "") if t]
    return _normalize("".join(toks[:2]))


def _fetch_all_published(limit_per_page: int = 100) -> list[dict]:
    base = _api_base()
    posts: list[dict] = []
    offset = 0
    while True:
        query = urllib.parse.urlencode({"status": "published", "limit": limit_per_page, "offset": offset})
        url = f"{base}/api/blog-posts?{query}"
        with urllib.request.urlopen(url, timeout=20) as response:
            payload = json.loads(response.read().decode("utf-8"))
        data = payload.get("data") or {}
        items = data.get("items") or []
        posts.extend(items)
        total = data.get("total") or 0
        if not items or len(posts) >= total:
            break
        offset += limit_per_page
    return posts


def build_plan(posts: list[dict], cap: int) -> tuple[list[dict], list[dict]]:
    """(keep, delete) 반환. 앵커별 created_at 오름차순(가장 오래된 글)으로 cap개까지 유지."""
    groups: dict[str, list[dict]] = {}
    for post in posts:
        groups.setdefault(_anchor(post.get("title") or ""), []).append(post)

    keep: list[dict] = []
    delete: list[dict] = []
    for anchor, items in groups.items():
        if not anchor:
            keep.extend(items)
            continue
        ordered = sorted(items, key=lambda p: p.get("created_at") or "")
        keep.extend(ordered[:cap])
        delete.extend(ordered[cap:])
    return keep, delete


@dataclass
class DeleteResult:
    id: str
    title: str
    slug: str
    ok: bool
    reason: str


def _delete_post(post: dict) -> DeleteResult:
    post_id = str(post.get("id") or "")
    title = str(post.get("title") or "")
    slug = str(post.get("slug") or "")
    if not post_id or not config.SELFHOST_API_KEY:
        return DeleteResult(post_id, title, slug, False, "id 없음 또는 SELFHOST_API_KEY 미설정")
    try:
        resp = requests.delete(
            f"{_api_base()}/api/blog-posts/{urllib.parse.quote(post_id, safe='')}",
            headers={"X-API-Key": config.SELFHOST_API_KEY},
            timeout=20,
        )
        if resp.status_code in (200, 204):
            return DeleteResult(post_id, title, slug, True, "삭제 완료")
        if resp.status_code == 404:
            return DeleteResult(post_id, title, slug, True, "이미 삭제됨")
        return DeleteResult(post_id, title, slug, False, f"HTTP {resp.status_code}: {resp.text[:160]}")
    except requests.RequestException as exc:
        return DeleteResult(post_id, title, slug, False, f"네트워크 오류: {exc}")


def _write_report(report: dict) -> Path:
    report_dir = Path(__file__).resolve().parents[1] / "reports"
    report_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    path = report_dir / f"prune-duplicate-anchors-{stamp}.json"
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def run(argv: list[str] | None = None) -> bool:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cap", type=int, default=DEFAULT_CAP, help="앵커당 유지할 최대 글 수")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args(argv)

    posts = _fetch_all_published()
    keep, delete = build_plan(posts, args.cap)

    report = {
        "mode": "apply" if args.apply else "dry-run",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "cap": args.cap,
        "checked": len(posts),
        "keep_count": len(keep),
        "delete_count": len(delete),
        "delete_plan": [
            {"id": p.get("id"), "title": p.get("title"), "slug": p.get("slug"), "created_at": p.get("created_at")}
            for p in delete
        ],
        "delete_results": [],
    }

    print(f"=== 근접중복 앵커 정리 ({report['mode']}) ===")
    print(f"검사 {len(posts)}건 / 유지 {len(keep)}건 / 삭제 대상 {len(delete)}건 (cap={args.cap})")

    if args.apply:
        results: list[DeleteResult] = []
        for i, post in enumerate(delete, start=1):
            result = _delete_post(post)
            results.append(result)
            status = "OK" if result.ok else "FAIL"
            print(f"  [{i}/{len(delete)}] {status} {result.title[:50]!r} — {result.reason}")
            if i % 10 == 0:
                time.sleep(1)  # API 부담 완화
        report["delete_results"] = [asdict(r) for r in results]
        failed = [r for r in results if not r.ok]
        report["failed_count"] = len(failed)
        print(f"\n완료: 성공 {len(results) - len(failed)} / 실패 {len(failed)}")

    path = _write_report(report)
    print(f"report={path}")
    return True


if __name__ == "__main__":
    import sys

    raise SystemExit(0 if run(sys.argv[1:]) else 1)
