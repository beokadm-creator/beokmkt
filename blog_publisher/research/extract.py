"""
URL 본문 추출 (기획 10 §4).

원문 URL에서 사람이 읽는 본문 텍스트를 뽑는다.
- trafilatura/readability 있으면 사용(정밀), 없으면 간이 HTML 태그 제거 폴백.
- 추출 실패/저품질(너무 짧음)은 예외로 알려 재작성을 막는다.
"""
from __future__ import annotations

import re

import config


def extract(url: str) -> tuple[str, str]:
    """(title, text) 반환. 실패 시 ValueError."""
    html = _download(url)
    if not html:
        raise ValueError(f"본문 다운로드 실패: {url}")

    title = ""
    m = re.search(r"<title[^>]*>(.*?)</title>", html, flags=re.I | re.S)
    if m:
        title = re.sub(r"\s+", " ", m.group(1)).strip()

    text = _extract_main(html)
    if len(text) < config.MIN_SOURCE_TEXT_LEN:
        raise ValueError(f"추출 본문이 너무 짧음({len(text)}자): {url}")
    return title, text[: config.MAX_SOURCE_TEXT_LEN]


def _download(url: str) -> str:
    import requests

    try:
        r = requests.get(url, timeout=20, headers={"User-Agent": "Mozilla/5.0"})
        return r.text if r.status_code == 200 else ""
    except requests.RequestException:
        return ""


def _extract_main(html: str) -> str:
    # 정밀 추출기 우선
    try:
        import trafilatura

        out = trafilatura.extract(html)
        if out:
            return out.strip()
    except ImportError:
        pass
    try:
        from readability import Document

        doc = Document(html)
        return _strip_tags(doc.summary())
    except ImportError:
        pass

    # 폴백: script/style 제거 후 태그 제거
    html = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", html, flags=re.I | re.S)
    return _strip_tags(html)


def _strip_tags(html: str) -> str:
    text = re.sub(r"<[^>]+>", " ", html)
    text = re.sub(r"&[a-z]+;", " ", text)
    return re.sub(r"\s+", " ", text).strip()
