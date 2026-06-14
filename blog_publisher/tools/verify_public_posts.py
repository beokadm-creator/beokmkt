"""
공개 발행물 품질 검증.

로컬 SQLite의 published 글을 공개 URL 기준으로 다시 읽어,
"URL만 있음"과 "실제 산출물 품질 통과"를 분리한다.

사용:
  python run.py verify_public [limit]
"""
from __future__ import annotations

import re
import sqlite3
import sys
from dataclasses import dataclass
from html import unescape
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit, urlunsplit
from urllib.request import Request, urlopen

import config
from db import db
from utils.notify import notify


FORBIDDEN_TONE = (
    "꿀팁", "환장", "대박", "지옥", "끝판왕", "충격", "실화",
    "ㅋㅋ", "ㅎㅎ", "[이미지:",
)


TOPIC_AXES = (
    ("학회운영", ("학회", "학술대회", "명찰", "사무국", "참가자", "접수", "출력", "발행", "재발행", "QR", "바코드")),
    ("홈페이지", ("홈페이지", "웹사이트", "반응형", "SEO", "서치콘솔", "신청폼", "문의폼", "예약", "결제", "SSL")),
    ("시스템개발", ("시스템", "개발", "관리자", "자동화", "알림톡", "DB", "데이터", "솔루션", "연동", "셀프호스팅")),
    ("MICE", ("홍커뮤니케이션", "MICE", "국제회의", "컨퍼런스", "동시통역", "전시회", "세미나", "레퍼런스", "포트폴리오")),
)


def _topic_axis(title: str, topic: str = "") -> str | None:
    text = f"{title or ''} {topic or ''}"
    best_axis = None
    best_hits = 0
    for axis, terms in TOPIC_AXES:
        hits = sum(1 for term in terms if term and term in text)
        if hits > best_hits:
            best_axis = axis
            best_hits = hits
    return best_axis if best_hits >= 1 else None


@dataclass
class CheckResult:
    post_id: int
    channel: str
    title: str
    url: str
    ok: bool
    status: int | None
    chars: int
    images: int
    h1: int
    h2: int
    issues: list[str]
    cache_bust_ok: bool = False
    cache_bust_url: str | None = None


def _db_path() -> Path:
    return Path(db.DB_PATH)


def _encode_url(url: str) -> str:
    parts = urlsplit(url)
    path = quote(parts.path, safe="/%")
    query = quote(parts.query, safe="=&?/%:+,._-")
    return urlunsplit((parts.scheme, parts.netloc, path, query, parts.fragment))


def _fetch(url: str, timeout: int = 20) -> tuple[int | None, str]:
    req = Request(
        _encode_url(url),
        headers={
            "User-Agent": "Mozilla/5.0 public-post-verifier/1.0",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
    )
    try:
        with urlopen(req, timeout=timeout) as res:
            raw = res.read(2_000_000)
            charset = res.headers.get_content_charset() or "utf-8"
            return int(res.status), raw.decode(charset, errors="replace")
    except HTTPError as e:
        raw = e.read(200_000)
        charset = e.headers.get_content_charset() or "utf-8"
        return int(e.code), raw.decode(charset, errors="replace")
    except (URLError, TimeoutError, OSError) as e:
        return None, f"FETCH_ERROR: {e}"


def _plain_text(html: str) -> str:
    text = _strip_non_content(html)
    text = re.sub(r"<[^>]+>", " ", text)
    return re.sub(r"\s+", " ", unescape(text)).strip()


def _strip_non_content(html: str) -> str:
    value = re.sub(r"<script[\s\S]*?</script>", " ", html, flags=re.I)
    value = re.sub(r"<style[\s\S]*?</style>", " ", value, flags=re.I)
    return value


def _has_visible_strike(html: str) -> bool:
    if re.search(r"text-decoration\s*:\s*line-through", html, flags=re.I):
        return True
    for m in re.finditer(r"<(?:s|strike|del)\b[^>]*>([\s\S]*?)</(?:s|strike|del)>", html, flags=re.I):
        text = _plain_text(m.group(1)).replace("\u200b", "").replace("\ufeff", "").strip()
        if text:
            return True
    return False


def _inspect(post: sqlite3.Row) -> CheckResult:
    url = str(post["published_url"] or "")
    channel = str(post["channel"] or "")
    title = str(post["title"] or post["topic"] or "")
    topic = str(post["topic"] or "")
    issues: list[str] = []
    status, html = _fetch(url) if url else (None, "")
    content_html = _strip_non_content(html)
    text = _plain_text(html)

    if not url:
        issues.append("공개 URL 없음")
    if status != 200:
        issues.append(f"HTTP 상태 비정상({status})")
    if html.startswith("FETCH_ERROR:"):
        issues.append(html[:160])

    chars = len(text)
    images = len(re.findall(r"<img\b", html, flags=re.I))
    h1 = len(re.findall(r"<h1\b", html, flags=re.I))
    h2 = len(re.findall(r"<h2\b", html, flags=re.I))

    matched_words = [word for word in FORBIDDEN_TONE if word in content_html or word in text]
    if matched_words:
        issues.append(f"금칙/마커 문구 노출({', '.join(matched_words[:5])})")
    if _has_visible_strike(content_html):
        issues.append("취소선 서식 노출")
    axis = _topic_axis(title, topic)
    if not axis:
        issues.append(f"허용 콘텐츠 축 이탈({config.BLOG_FOCUS_NAME})")

    if channel == "selfhosted":
        if chars < 1000:
            issues.append(f"본문 짧음({chars}자)")
        if h1 != 1:
            issues.append(f"h1 개수 비정상({h1})")
        if re.search(r"<article\b[^>]*>\s*<header\b", html, flags=re.I):
            issues.append("저장 본문 article/header 중복 노출")
        if "학회" in title or "명찰" in title:
            if axis == "학회운영" and "학회운영" not in html:
                issues.append("학회운영 카테고리 표시 누락")
            if images < 1:
                issues.append("학회/명찰 글 이미지 없음")
    elif channel == "tistory":
        if not re.match(r"^https://[^/]+\.tistory\.com/\d+(?:[/?#].*)?$", url):
            issues.append("티스토리 공개 URL 형식 아님")
        if chars < 800:
            issues.append(f"본문 짧음({chars}자)")
        if h2 < 2:
            issues.append(f"소제목 부족({h2})")
    elif channel == "naver":
        if "PostView.naver" not in url and not re.search(r"blog\.naver\.com/[^/?#]+/\d+", url):
            issues.append("네이버 공개 URL 형식 아님")
        if status == 200 and chars < 500:
            issues.append(f"본문 짧음({chars}자)")

    cache_bust_url = None
    cache_bust_ok = False
    cache_check_needed = any("허용 콘텐츠 축 이탈" not in issue for issue in issues)
    if channel == "selfhosted" and issues and cache_check_needed and url and "?" not in url:
        cache_bust_url = f"{url}?v=public-quality-{post['id']}"
        bust_status, bust_html = _fetch(cache_bust_url)
        bust_content = _strip_non_content(bust_html)
        bust_text = _plain_text(bust_html)
        bust_forbidden = [word for word in FORBIDDEN_TONE if word in bust_content or word in bust_text]
        cache_bust_ok = bust_status == 200 and not bust_forbidden
        if cache_bust_ok:
            issues.append("캐시 우회 URL은 정상(Hosting/CDN 캐시 잔존 의심)")

    return CheckResult(
        post_id=int(post["id"]),
        channel=channel,
        title=title,
        url=url,
        ok=not issues,
        status=status,
        chars=chars,
        images=images,
        h1=h1,
        h2=h2,
        issues=issues,
        cache_bust_ok=cache_bust_ok,
        cache_bust_url=cache_bust_url,
    )


def run(limit: int = 20) -> bool:
    db_path = _db_path()
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        """
        SELECT id, channel, topic, title, published_url
        FROM posts
        WHERE status = 'published'
        ORDER BY updated_at DESC, id DESC
        LIMIT ?
        """,
        (max(1, int(limit)),),
    ).fetchall()

    print("=== 공개 발행물 검증 ===")
    if not rows:
        print("published 글 없음")
        return True

    ok_count = 0
    results = [_inspect(row) for row in rows]
    for result in results:
        mark = "OK" if result.ok else "FAIL"
        if result.ok:
            ok_count += 1
        print(
            f"[{mark}] #{result.post_id} {result.channel} "
            f"status={result.status} chars={result.chars} img={result.images} "
            f"h1={result.h1} h2={result.h2}"
        )
        print(f"      {result.title[:80]}")
        print(f"      {result.url}")
        for issue in result.issues:
            print(f"      - {issue}")
        if result.cache_bust_ok and result.cache_bust_url:
            print(f"      캐시 우회 확인: {result.cache_bust_url}")

    print(f"\n결과: {ok_count}/{len(results)} 통과")
    if ok_count != len(results):
        failed = len(results) - ok_count
        notify(f"공개 발행물 품질 검증 실패: {failed}/{len(results)}건 확인 필요", level="warn")
    return ok_count == len(results)


if __name__ == "__main__":
    arg_limit = int(sys.argv[1]) if len(sys.argv) > 1 else 20
    raise SystemExit(0 if run(arg_limit) else 1)
