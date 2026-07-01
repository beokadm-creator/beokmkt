"""
발행 직전/운영 감사용 콘텐츠 품질 규칙.

목표는 좋은 글을 점수화하는 것이 아니라, 명백히 저품질인 공개 발행을 막는 것이다.
- 같은 날 같은 본문 반복 발행 차단
- 운영 주제(beok/hong) 무이미지 발행 차단
- 이미지 자동 업로드가 검증되지 않은 네이버 글은 수동 확인으로 격리
"""
from __future__ import annotations

import difflib
import re
from urllib.parse import urlparse

from db import db

OPERATIONAL_TERMS = (
    "비오케이솔루션", "홍커뮤니케이션", "hongcomm", "학회", "학술대회",
    "명찰", "사무국", "MICE", "국제회의", "컨퍼런스", "동시통역",
    "포트폴리오", "레퍼런스", "행사", "접수", "등록",
)

TOPIC_AXES = (
    ("conference", ("학회", "학술대회", "명찰", "사무국", "참가자", "접수", "출력", "발행", "재발행", "QR", "바코드")),
    ("web", ("홈페이지", "웹사이트", "반응형", "SEO", "서치콘솔", "신청폼", "문의폼", "예약", "결제", "SSL")),
    ("systems", ("시스템", "개발", "관리자", "자동화", "알림톡", "DB", "데이터", "솔루션", "연동", "셀프호스팅")),
    ("mice", ("홍커뮤니케이션", "MICE", "국제회의", "컨퍼런스", "동시통역", "전시회", "세미나", "레퍼런스", "포트폴리오")),
)

GENERIC_TITLE_PATTERNS = (
    "완벽 가이드", "A to Z", "트렌드", "전망", "비밀", "꿀팁",
    "성공 방법", "성공 전략", "바꾸는 미래",
)

SERVICE_ANCHORS = (
    "학회", "학술대회", "MICE", "국제회의", "컨퍼런스", "행사", "사무국",
    "홍커뮤니케이션", "홈페이지", "웹사이트", "시스템", "관리자", "대시보드",
    "접수", "등록", "결제", "초록", "심사", "QR", "체크인", "명찰",
    "동시통역", "API", "연동", "데이터", "백오피스",
)

COMPOSITE_OPERATION_TERMS = (
    "학회", "학술대회", "MICE", "국제회의", "컨퍼런스", "행사", "사무국",
    "등록", "접수", "초록", "결제", "체크인", "명찰", "동시통역",
)

COMPOSITE_SYSTEM_TERMS = (
    "홈페이지", "웹사이트", "시스템", "관리자", "대시보드", "개발",
    "솔루션", "API", "연동", "데이터", "백오피스", "자동화",
)


def plain_text(value: str | None) -> str:
    text = str(value or "")
    text = re.sub(r"!\[[^\]]*]\([^)\s]+\)", " ", text)
    text = re.sub(r"<script[\s\S]*?</script>", " ", text, flags=re.I)
    text = re.sub(r"<style[\s\S]*?</style>", " ", text, flags=re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def normalized_text(value: str | None, limit: int = 2600) -> str:
    text = plain_text(value).lower()
    text = re.sub(r"[^가-힣a-z0-9]+", "", text)
    return text[:limit]


def image_count(value: str | None) -> int:
    text = str(value or "")
    return len(re.findall(r"<img\b", text, flags=re.I)) + len(
        re.findall(r"!\[[^\]]*]\([^)\s]+\)", text)
    )


def image_urls(value: str | None) -> list[str]:
    text = str(value or "")
    urls = re.findall(r"<img\b[^>]*\bsrc=[\"']([^\"']+)[\"']", text, flags=re.I)
    urls.extend(re.findall(r"!\[[^\]]*]\(([^)\s]+)\)", text))
    return [url.strip() for url in urls if url.strip()]


def unique_image_count(value: str | None) -> int:
    return len(set(image_urls(value)))


def external_image_count(value: str | None) -> int:
    count = 0
    for url in image_urls(value):
        host = urlparse(url).netloc.lower()
        if host and ("hongcomm.kr" in host or "beoksolution.com" in host):
            count += 1
    return count


def is_operational_post(post) -> bool:
    category = post["category"] or ""
    if category in {"beok", "hong"}:
        return True
    # category가 명시적으로 다른 브랜드(예: notebook_return)로 태그돼 있으면,
    # 본문에 우연히 겹치는 일반 단어("등록", "접수" 등)가 있어도 beok/hong
    # 전용 게이트(hongcomm.kr/beoksolution.com 이미지 요구 등)를 적용하지 않는다.
    # 용어 폴백은 category가 비어 있는 레거시 글에만 쓴다.
    if category:
        return False
    text = f"{post['title'] or ''} {post['topic'] or ''} {post['body'] or ''}"
    return any(term in text for term in OPERATIONAL_TERMS)


def field(post, key: str) -> str:
    try:
        value = post[key]
    except (KeyError, IndexError):
        value = None
    return str(value or "")


def topic_axis(post) -> str | None:
    text = f"{field(post, 'category')} {field(post, 'title')} {field(post, 'topic')} {field(post, 'body')}"
    best_axis = None
    best_hits = 0
    for axis, terms in TOPIC_AXES:
        hits = sum(1 for term in terms if term and term in text)
        if hits > best_hits:
            best_axis = axis
            best_hits = hits
    return best_axis if best_hits >= 1 else None


def service_anchor_count(value: str | None) -> int:
    text = str(value or "")
    return sum(1 for term in SERVICE_ANCHORS if term in text)


def has_composite_service_fit(value: str | None) -> bool:
    text = str(value or "")
    has_operation = any(term in text for term in COMPOSITE_OPERATION_TERMS)
    has_system = any(term in text for term in COMPOSITE_SYSTEM_TERMS)
    return has_operation and has_system


def generic_title_risk(value: str | None) -> bool:
    title = str(value or "")
    return any(pattern in title for pattern in GENERIC_TITLE_PATTERNS)


def title_signature(value: str | None) -> set[str]:
    text = str(value or "")
    words = re.findall(r"[가-힣A-Za-z0-9]{2,}", text)
    stopwords = {"비오케이솔루션", "가이드", "방법", "기준", "정리", "체크리스트", "필수", "완벽"}
    return {word.lower() for word in words if word not in stopwords}


def similar_today_published(post, threshold: float = 0.82) -> tuple[bool, dict | None, float]:
    """
    같은 KST 날짜에 이미 공개된 글과 본문이 지나치게 유사하면 True.
    채널이 달라도 같은 날 같은 내용이면 검색 품질 리스크이므로 막는다.
    """
    current = normalized_text(post["body"])
    if len(current) < 400:
        return False, None, 0.0

    with db.connect() as conn:
        rows = conn.execute(
            """
            SELECT id, channel, title, body, published_url, updated_at
            FROM posts
            WHERE status = 'published'
              AND id != ?
              AND date(updated_at, '+9 hours') = date(?, '+9 hours')
            ORDER BY updated_at DESC
            LIMIT 80
            """,
            (post["id"], post["updated_at"]),
        ).fetchall()

    best_row = None
    best_ratio = 0.0
    for row in rows:
        other = normalized_text(row["body"])
        if len(other) < 400:
            continue
        ratio = difflib.SequenceMatcher(None, current, other).ratio()
        if ratio > best_ratio:
            best_ratio = ratio
            best_row = dict(row)
    return best_ratio >= threshold, best_row, best_ratio


def similar_topic_today_published(post, threshold: float = 0.58) -> tuple[bool, dict | None, float]:
    axis = topic_axis(post)
    current_terms = title_signature(post["title"] or post["topic"])
    if not axis or len(current_terms) < 3:
        return False, None, 0.0

    with db.connect() as conn:
        rows = conn.execute(
            """
            SELECT id, channel, title, topic, body, published_url, updated_at
            FROM posts
            WHERE status = 'published'
              AND id != ?
              AND date(updated_at, '+9 hours') = date(?, '+9 hours')
            ORDER BY updated_at DESC
            LIMIT 80
            """,
            (post["id"], post["updated_at"]),
        ).fetchall()

    best_row = None
    best_ratio = 0.0
    for row in rows:
        if topic_axis(row) != axis:
            continue
        other_terms = title_signature(row["title"] or row["topic"])
        if len(other_terms) < 3:
            continue
        ratio = len(current_terms & other_terms) / max(1, len(current_terms | other_terms))
        if ratio > best_ratio:
            best_ratio = ratio
            best_row = dict(row)
    return best_ratio >= threshold, best_row, best_ratio


def publish_blockers(post) -> list[str]:
    issues: list[str] = []
    body = post["body"] or ""
    chars = len(plain_text(body))
    images = image_count(body)
    unique_images = unique_image_count(body)
    trusted_images = external_image_count(body)

    if is_operational_post(post):
        if chars < 900:
            issues.append(f"운영 글 본문 부족({chars}/900자)")
        if chars > 2600:
            issues.append(f"운영 글 본문 과다({chars}/2600자)")
        if images < 2:
            issues.append(f"운영 글 이미지 부족({images}/2장)")
        if unique_images < images:
            issues.append("같은 글 안에서 이미지 URL 반복")
        if trusted_images < 2:
            issues.append(f"홍커뮤니케이션/비오케이 계열 이미지 부족({trusted_images}/2장)")
        if body.count("## ") < 3:
            issues.append("소제목 구조 부족(3개 미만)")
        if "|---" not in body and "| ---" not in body:
            issues.append("점검표/비교표 없음")
        title_topic = f"{field(post, 'title')} {field(post, 'topic')}"
        full_text = f"{title_topic} {plain_text(body)[:1800]}"
        if generic_title_risk(title_topic) and service_anchor_count(full_text) < 4:
            issues.append("일반론 제목 대비 서비스/운영 앵커 부족")
        if topic_axis(post) in {"conference", "mice"} and not has_composite_service_fit(full_text):
            issues.append("학회/MICE 글이 운영 맥락과 시스템·홈페이지 해법을 함께 다루지 않음")

    if post["channel"] == "naver":
        issues.append(
            "네이버 자동 발행은 이미지 업로드 보존이 아직 검증되지 않아 수동 확인 필요"
        )

    is_dup, matched, ratio = similar_today_published(post)
    if is_dup and matched:
        issues.append(
            f"당일 공개 글과 본문 중복 위험({ratio:.2f}) "
            f"matched=#{matched['id']} {matched['channel']}"
        )
    is_topic_dup, topic_matched, topic_ratio = similar_topic_today_published(post)
    if is_topic_dup and topic_matched:
        issues.append(
            f"당일 같은 콘텐츠 축 제목 중복 위험({topic_ratio:.2f}) "
            f"matched=#{topic_matched['id']} {topic_matched['channel']}"
        )
    return issues
