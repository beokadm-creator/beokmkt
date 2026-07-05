"""
블로그 렌더러 (기획 09): post → 가독성+SEO HTML.

경량 마크다운 변환(H2/H3/문단/목록/링크/이미지/강조) + 자동 목차(TOC) +
JSON-LD(Article) + OG/Twitter 메타. 외부 의존 없이 동작.
markdown 패키지가 있으면 그걸 우선 사용한다.
"""
from __future__ import annotations

import html
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

_DIR = Path(__file__).parent
_TEMPLATE = (_DIR / "template.html").read_text(encoding="utf-8")
_CSS = (_DIR / "style.css").read_text(encoding="utf-8")


def _clean_heading_text(text: str) -> str:
    """제목/목차 표시·슬러그용: 마크다운 이미지·링크·강조 문법을 평문으로 정리."""
    text = re.sub(r"!\[[^\]]*\]\([^)]+\)", "", text)        # 이미지 제거
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)     # 링크는 텍스트만 남김
    text = re.sub(r"\*\*([^*]+)\*\*", r"\1", text)            # 굵게 해제
    text = re.sub(r"`([^`]+)`", r"\1", text)                 # 인라인 코드 해제
    return re.sub(r"\s+", " ", text).strip()


def _slug(text: str) -> str:
    s = re.sub(r"[^\w가-힣\s-]", "", _clean_heading_text(text)).strip().lower()
    return re.sub(r"\s+", "-", s)[:60] or "section"


def _is_safe_url(url: str, *, image: bool = False) -> bool:
    """렌더링 URL allowlist. LLM/근거 데이터가 만든 javascript: 링크 주입을 차단한다."""
    value = (url or "").strip()
    if not value:
        return False
    parsed = urlparse(value)
    if value.startswith("#"):
        return not image
    if value.startswith("/"):
        return not value.startswith("//")
    if image:
        return parsed.scheme in {"http", "https"} and bool(parsed.netloc)
    return parsed.scheme in {"http", "https", "mailto"} or not parsed.scheme


def _safe_attr_url(url: str, *, image: bool = False) -> str:
    value = (url or "").strip()
    return value if _is_safe_url(value, image=image) else ""


def _normalize_block_images(md: str) -> str:
    """제목 줄에 붙어버린 이미지(`## 제목![alt](url)`)를 별도 블록으로 분리한다.

    마크다운 변환기가 이미지를 <h2> 안에 넣거나 목차에 원문이 노출되는 결함을 차단한다.
    """
    def _split(m: "re.Match[str]") -> str:
        hashes, text = m.group(1), m.group(2)
        imgs = re.findall(r"!\[[^\]]*\]\([^)]+\)", text)
        clean = re.sub(r"!\[[^\]]*\]\([^)]+\)", "", text).rstrip()
        tail = ("\n\n" + "\n\n".join(imgs)) if imgs else ""
        return f"{hashes} {clean}{tail}"

    return re.sub(r"(?m)^(#{1,6})[ \t]+(.+?)[ \t]*$", _split, md)


def _inline(text: str) -> str:
    """인라인 마크다운: 링크/이미지/굵게/코드. 입력은 평문(이스케이프 후 패턴 복원)."""
    text = html.escape(text)

    def _image(m: "re.Match[str]") -> str:
        alt, url = m.group(1), _safe_attr_url(html.unescape(m.group(2)), image=True)
        if not url:
            return ""
        return f'<img src="{html.escape(url)}" alt="{alt}" loading="lazy">'

    def _link(m: "re.Match[str]") -> str:
        label, url = m.group(1), _safe_attr_url(html.unescape(m.group(2)))
        if not url:
            return label
        return f'<a href="{html.escape(url)}" rel="noopener">{label}</a>'

    text = re.sub(r"!\[([^\]]*)\]\(([^)]+)\)", _image, text)
    text = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", _link, text)
    text = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", text)
    text = re.sub(r"`([^`]+)`", r"<code>\1</code>", text)
    return text


def _sanitize_rendered_urls(body: str) -> str:
    """markdown 패키지가 만든 HTML도 URL 스킴을 한 번 더 세척한다."""
    def _img(m: "re.Match[str]") -> str:
        attrs = m.group(1)
        src_m = re.search(r'\bsrc=["\']([^"\']+)["\']', attrs, flags=re.I)
        if not src_m or not _is_safe_url(html.unescape(src_m.group(1)), image=True):
            return ""
        return m.group(0)

    def _anchor(m: "re.Match[str]") -> str:
        attrs, inner = m.group(1), m.group(2)
        href_m = re.search(r'\bhref=["\']([^"\']+)["\']', attrs, flags=re.I)
        if not href_m or not _is_safe_url(html.unescape(href_m.group(1))):
            return inner
        safe_href = html.escape(_safe_attr_url(html.unescape(href_m.group(1))))
        return f'<a href="{safe_href}" rel="noopener">{inner}</a>'

    body = re.sub(r"<img\b([^>]*)>", _img, body, flags=re.I)
    body = re.sub(r"<a\b([^>]*)>(.*?)</a>", _anchor, body, flags=re.I | re.DOTALL)
    return body


def _postprocess_content_html(body: str) -> str:
    """마크다운 변환 결과를 자체 블로그 디자인 컴포넌트에 맞게 보강한다."""
    out = _sanitize_rendered_urls(body)
    out = re.sub(r"<table>", '<div class="table-wrap"><table>', out)
    out = re.sub(r"</table>", "</table></div>", out)
    out = re.sub(
        r"<blockquote>\s*<p>(.*?)</p>\s*</blockquote>",
        r'<aside class="content-callout">\1</aside>',
        out,
        flags=re.DOTALL,
    )
    out = re.sub(r"<blockquote>(.*?)</blockquote>", r'<aside class="content-callout">\1</aside>', out, flags=re.DOTALL)
    out = re.sub(
        r"<li>\s*\[([ xX])\]\s*(.*?)</li>",
        lambda m: (
            f'<li class="check-item {"is-done" if m.group(1).lower() == "x" else ""}">'
            f'<span class="check-box">{"✓" if m.group(1).lower() == "x" else ""}</span>{m.group(2)}</li>'
        ),
        out,
        flags=re.DOTALL,
    )
    out = re.sub(r"<ul>\s*(<li class=\"check-item[\s\S]*?</li>)\s*</ul>", r'<ul class="check-list">\1</ul>', out)

    # 단독 이미지(<p><img></p>)를 캡션 있는 <figure>로 승격 — 가독성/시각 위계 강화
    def _to_figure(m: "re.Match[str]") -> str:
        attrs = m.group(1)
        alt_m = re.search(r'alt="([^"]*)"', attrs)
        cap = (
            f"<figcaption>{alt_m.group(1)}</figcaption>"
            if alt_m and alt_m.group(1).strip()
            else ""
        )
        return f"<figure><img{attrs}>{cap}</figure>"

    out = re.sub(r"<p>\s*<img([^>]*?)\s*/?>\s*</p>", _to_figure, out)

    # 콜아웃 변형: 머리말 키워드로 info/tip/warn 구분 — 평평한 회색 박스 탈피
    def _callout_variant(m: "re.Match[str]") -> str:
        inner = m.group(1)
        plain = re.sub(r"<[^>]+>", "", inner).lstrip()
        cls = "content-callout"
        if re.match(r"(주의|경고|위험|유의|반드시|금지|⚠)", plain):
            cls += " is-warn"
        elif re.match(r"(팁|참고|확인|체크|권장|추천|\U0001f4a1|✅)", plain):
            cls += " is-tip"
        return f'<aside class="{cls}">{inner}</aside>'

    out = re.sub(
        r'<aside class="content-callout">(.*?)</aside>',
        _callout_variant,
        out,
        flags=re.DOTALL,
    )
    return out


def _markdown_to_html(md: str) -> tuple[str, list[tuple[str, str]]]:
    """경량 변환. (html, toc[(id,title)]) 반환. H2만 목차에 넣는다."""
    md = _normalize_block_images(md)
    try:
        import markdown as _md  # 있으면 고품질 변환

        headings: list[tuple[str, str]] = []
        for m in re.finditer(r"^##\s+(.+)$", md, flags=re.MULTILINE):
            clean = _clean_heading_text(m.group(1))
            headings.append((_slug(clean), clean))
        body = _md.markdown(md, extensions=["tables", "fenced_code"])
        # H2에 등장 순서대로 id 부여(내부 태그·강조가 있어도 안전)
        _ids = iter(hid for hid, _ in headings)

        def _assign_id(m: "re.Match[str]") -> str:
            hid = next(_ids, None)
            return f'<h2 id="{hid}">{m.group(1)}</h2>' if hid else m.group(0)

        body = re.sub(r"<h2>(.*?)</h2>", _assign_id, body, flags=re.DOTALL)
        return _postprocess_content_html(body), headings
    except ImportError:
        pass

    # 경량 폴백 변환
    lines = md.split("\n")
    out: list[str] = []
    toc: list[tuple[str, str]] = []
    para: list[str] = []
    in_list = False
    table_rows: list[str] = []

    def flush_para():
        nonlocal para
        if para:
            out.append("<p>" + _inline(" ".join(para)) + "</p>")
            para = []

    def close_list():
        nonlocal in_list
        if in_list:
            out.append("</ul>")
            in_list = False

    def flush_table():
        nonlocal table_rows
        if not table_rows:
            return
        rows = [
            row for row in table_rows
            if not re.match(r"^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$", row)
        ]
        if rows:
            out.append('<div class="table-wrap"><table>')
            for i, row in enumerate(rows):
                cells = [c.strip() for c in row.strip().strip("|").split("|")]
                tag = "th" if i == 0 else "td"
                out.append("<tr>" + "".join(f"<{tag}>{_inline(c)}</{tag}>" for c in cells) + "</tr>")
            out.append("</table></div>")
        table_rows = []

    for ln in lines:
        s = ln.rstrip()
        if not s.strip():
            flush_para(); close_list(); flush_table(); continue
        if re.match(r"^\s*\|.+\|\s*$", s):
            flush_para(); close_list()
            table_rows.append(s)
            continue
        flush_table()
        if s.startswith("## "):
            flush_para(); close_list()
            t = _clean_heading_text(s[3:].strip()); hid = _slug(t); toc.append((hid, t))
            out.append(f'<h2 id="{hid}">{_inline(t)}</h2>')
        elif s.startswith("### "):
            flush_para(); close_list()
            out.append(f"<h3>{_inline(s[4:].strip())}</h3>")
        elif re.match(r"^[-*]\s+", s):
            flush_para()
            if not in_list:
                out.append("<ul>"); in_list = True
            item = re.sub(r"^[-*]\s+", "", s)
            checked = re.match(r"^\[([ xX])\]\s+(.+)$", item)
            if checked:
                mark = "✓" if checked.group(1).lower() == "x" else ""
                done = ' is-done' if mark else ''
                out.append(f'<li class="check-item{done}"><span class="check-box">{mark}</span>{_inline(checked.group(2))}</li>')
            else:
                out.append("<li>" + _inline(item) + "</li>")
        elif s.startswith("> "):
            flush_para(); close_list()
            out.append(f'<aside class="content-callout">{_inline(s[2:].strip())}</aside>')
        else:
            close_list(); para.append(s.strip())
    flush_para(); close_list(); flush_table()
    return _postprocess_content_html("\n".join(out)), toc


def _toc_html(toc: list[tuple[str, str]]) -> str:
    if len(toc) < 2:
        return ""
    items = "".join(f'<li><a href="#{hid}">{html.escape(t)}</a></li>' for hid, t in toc)
    return f'<nav class="toc"><strong>목차</strong><ol>{items}</ol></nav>'


def _post_context(post: dict) -> str:
    """브랜드/주제 문맥 키. 렌더 컴포넌트(요약·점검 범위·흐름·비교·CTA)의 분기 기준.

    과거에는 명찰/학회 문맥만 있어 그 외 주제(홈페이지 개발, MICE 대행,
    반품 노트북)는 리치 컴포넌트 없이 평문으로 발행됐다 — 채널 전체가
    '명찰 블로그'처럼 보이던 퍼블리싱 단조로움의 원인.
    """
    category = (post.get("category") or "").strip()
    topic = f"{post.get('topic', '')} {post.get('title', '')}"
    if category == "notebook_return" or any(t in topic for t in ("반품 노트북", "리퍼 노트북", "반품마켓")):
        return "notebook_return"
    # 서비스 쇼케이스 축은 category 명시가 기준(topic의 시스템/데이터 용어가
    # beok 문맥으로 새지 않게 일반 분기보다 먼저 검사).
    if category == "racekra" or "마분" in topic:
        return "racekra"
    if category == "ncs" or "NCS Passport" in topic:
        return "ncs"
    if any(t in topic for t in ("명찰", "재발행")):
        return "badge"
    if category == "hong" or any(t in topic for t in ("홍커뮤니케이션", "MICE", "동시통역", "포상여행", "컨벤션")):
        return "hong"
    if any(t in topic for t in ("학회", "학술대회", "국제회의", "사무국", "참가자", "초록", "체크인")):
        return "conference"
    if any(t in topic for t in ("홈페이지", "웹사이트", "랜딩페이지", "시스템", "관리자", "대시보드", "자동화", "연동", "예약", "결제")):
        return "beok"
    if category == "beok":
        return "beok"
    return ""


def _pick_variant(variants: list, post: dict):
    """브랜드 버킷 내 렌더 컴포넌트 variant 순환 선택.

    이전에는 브랜드(post_context)당 컴포넌트 1개뿐이라, 같은 축의 글 몇십~몇백
    건이 서비스 소개/운영 흐름/비교표를 글자 하나 다르지 않게 공유했다
    (reports/content-quality-audit-20260705.md §2-증상3 — 렌더 레벨 중복은
    posts.body에 저장되지 않아 발행 게이트가 검사조차 못 하는 사각지대였다).
    post_id 기반 결정적 순환이라 같은 글은 재렌더해도 항상 같은 variant를 쓴다
    (발행 후 재조회 시 내용이 바뀌어 보이는 혼란을 피한다)."""
    if not variants:
        return None
    if len(variants) == 1:
        return variants[0]
    try:
        seed = int(post.get("id") or 0)
    except (TypeError, ValueError):
        seed = sum(ord(c) for c in str(post.get("id") or ""))
    return variants[seed % len(variants)]


_SERVICE_PROOF = {
    "badge": [
        ("비오케이솔루션 실무 점검 범위", [
            ("데이터 검수", "이름·소속·역할·등록 구분을 기준 파일 하나로 고정합니다."),
            ("출력 기준", "줄바꿈, QR·바코드, 여분 수량을 샘플 출력으로 확인합니다."),
            ("현장 재발행", "승인 기준과 출력 기록을 남겨 중복 처리를 줄입니다."),
            ("사후 정리", "미수령·변경 요청을 다음 행사 기준으로 남깁니다."),
        ]),
        ("명찰 운영 실무 지원 범위", [
            ("명단 관리", "등록 데이터와 명찰 표기 항목을 하나의 기준으로 맞춥니다."),
            ("현장 스캔", "QR·바코드 스캔 오류를 사전 샘플 출력으로 줄입니다."),
            ("재발행 창구", "접수대와 분리된 재발행 동선으로 대기열을 나눕니다."),
            ("행사 후 기록", "재발행·미수령 이력을 다음 행사 개선 자료로 남깁니다."),
        ]),
        ("학회 명찰 발행 지원 체계", [
            ("사전 데이터 정리", "등록 정보와 표기 항목을 발행 전 기준으로 맞춥니다."),
            ("현장 출력 검증", "실제 출력 샘플로 코드 인식과 줄바꿈을 확인합니다."),
            ("재발행 프로세스", "승인 절차를 거쳐 중복·오류 재출력을 통제합니다."),
            ("행사 후 데이터", "재발행 이력을 다음 행사 개선 근거로 남깁니다."),
        ]),
        ("명찰 출력 운영 체계", [
            ("표기 기준 확정", "소속·직책 표기 규칙을 발행 전에 확정합니다."),
            ("스캔 테스트", "QR·바코드 인식률을 현장 전 미리 점검합니다."),
            ("접수 동선 분리", "일반 접수와 재발행 요청 동선을 나눕니다."),
            ("정산 자료 연계", "출력·재발행 기록을 행사 정산과 연결합니다."),
        ]),
    ],
    "conference": [
        ("비오케이솔루션 학회 시스템 구축 범위", [
            ("등록·결제", "참가자 등록, 등록비 결제, 영수증 처리를 한 흐름으로 연결합니다."),
            ("초록·심사", "초록 접수와 심사 배정을 관리자 화면에서 처리합니다."),
            ("현장 체크인", "QR 체크인과 명찰 출력을 등록 데이터와 연동합니다."),
            ("사후 데이터", "참석·결제 기록을 보고서용 데이터로 정리합니다."),
        ]),
        ("학회 운영 데이터 연결 범위", [
            ("참가자 데이터", "등록 항목과 결제 상태를 같은 화면에서 관리합니다."),
            ("심사 프로세스", "초록 접수부터 심사위원 배정까지 이력을 남깁니다."),
            ("현장 운영", "체크인·명찰 출력을 등록 데이터 오차 없이 연동합니다."),
            ("정산·보고", "행사 후 참석·결제 데이터를 자동으로 집계합니다."),
        ]),
        ("학회 등록 시스템 구축 범위", [
            ("등록 흐름 설계", "사전등록·현장등록 항목과 결제 방식을 정합니다."),
            ("초록 관리", "접수부터 심사 배정까지 관리자 화면에서 처리합니다."),
            ("체크인 연동", "QR 체크인과 명찰 출력을 등록 데이터에 연결합니다."),
            ("사후 자료화", "참석·결제 데이터를 보고서 형태로 정리합니다."),
        ]),
        ("국제학술대회 시스템 지원 범위", [
            ("접수 체계", "등록·결제·초록 접수를 하나의 흐름으로 설계합니다."),
            ("심사 관리", "심사위원 배정과 진행 상태를 관리자가 확인합니다."),
            ("현장 체크인", "등록 데이터 기반으로 체크인·명찰을 연동합니다."),
            ("사후 정산", "등록·참석 데이터를 정산 자료로 넘깁니다."),
        ]),
    ],
    "beok": [
        ("비오케이솔루션 구축 범위", [
            ("요구사항 정리", "업무 흐름을 화면과 데이터 구조로 먼저 정리합니다."),
            ("홈페이지·시스템", "홈페이지, 관리자 대시보드, 맞춤 업무 화면을 구축합니다."),
            ("연동 개발", "예약·결제·알림톡·이메일 API를 업무 흐름에 연결합니다."),
            ("운영·유지보수", "서버, SSL, 검색 노출 기본 세팅까지 운영을 지원합니다."),
        ]),
        ("비오케이솔루션 개발 진행 범위", [
            ("화면 설계", "실제 업무 데이터 흐름 기준으로 화면 구조를 잡습니다."),
            ("맞춤 시스템", "관리자 페이지·업무 화면을 홈페이지와 함께 구축합니다."),
            ("API·자동화", "결제, 알림톡, 이메일 연동으로 수작업을 줄입니다."),
            ("검색·유지보수", "SEO 기본 세팅과 운영 유지보수를 함께 지원합니다."),
        ]),
        ("맞춤형 시스템 개발 범위", [
            ("업무 분석", "기존 업무 흐름을 화면·데이터 단위로 분석합니다."),
            ("관리자 구축", "예약·결제·회원 관리를 관리자 화면으로 통합합니다."),
            ("외부 연동", "알림톡·이메일·결제 API를 시스템에 연결합니다."),
            ("운영 지원", "배포 후 서버·보안·SEO 운영까지 지원합니다."),
        ]),
        ("웹 시스템 구축 지원 범위", [
            ("현황 파악", "현재 엑셀·수기 업무 흐름을 데이터 구조로 옮깁니다."),
            ("화면·DB 설계", "관리자 화면과 데이터베이스 구조를 함께 설계합니다."),
            ("연동 개발", "결제·알림톡·이메일 등 외부 API를 붙입니다."),
            ("안정화", "오픈 후 트래픽·보안·검색 노출을 점검합니다."),
        ]),
    ],
    "hong": [
        ("홍커뮤니케이션 운영 범위", [
            ("행사 기획", "국제학술대회·기업행사·전시회를 기획부터 정산까지 대행합니다."),
            ("등록 시스템", "e-Regi 등록, 결제, 논문 투고를 학회 홈페이지와 연결합니다."),
            ("AI 동시통역", "38개국 실시간 통역을 행사 규모에 맞춰 구성합니다."),
            ("현장 운영", "체크인, 세션 운영, 사후 보고까지 현장 인력이 지원합니다."),
        ]),
        ("홍커뮤니케이션 MICE 지원 범위", [
            ("기획·정산", "행사 목적에 맞춰 예산·프로그램·정산까지 대행합니다."),
            ("등록·투고", "e-Regi 기반 등록, 결제, 논문 투고를 통합 지원합니다."),
            ("통역 솔루션", "38개국 AI 실시간 동시통역을 행사 규모에 맞춥니다."),
            ("현장 인력", "체크인·세션 운영·사후 보고를 현장에서 직접 지원합니다."),
        ]),
        ("MICE 행사 대행 범위", [
            ("기획·예산 설계", "행사 목적에 맞춰 프로그램과 예산안을 짭니다."),
            ("등록·투고 시스템", "e-Regi 등록과 논문 투고를 함께 운영합니다."),
            ("동시통역 지원", "다국어 동시통역을 행사 규모에 맞춰 배치합니다."),
            ("현장·사후 운영", "체크인부터 사후 보고까지 인력을 지원합니다."),
        ]),
        ("국제행사 운영 대행 범위", [
            ("사전 기획", "목적·예산·프로그램 구성을 함께 설계합니다."),
            ("등록 시스템 운영", "등록·결제·초록 접수를 통합 시스템으로 운영합니다."),
            ("통역 서비스", "실시간 다국어 통역을 행사에 맞게 구성합니다."),
            ("현장 지원 인력", "체크인·세션 운영·사후 보고를 대행합니다."),
        ]),
    ],
    "notebook_return": [
        ("구매 전 확인 범위", [
            ("등급 확인", "최상·상·중·리퍼 등급별 상태 기준을 먼저 확인합니다."),
            ("가격 비교", "정가 대비 할인율과 브랜드별 시세를 비교합니다."),
            ("보증·구성품", "A/S 기간, 충전기 등 구성품 포함 여부를 확인합니다."),
            ("재고 확인", "반품 매물은 재고 변동이 빠르므로 실시간 재고를 확인합니다."),
        ]),
    ],
    "racekra": [
        ("마분 서비스 구성 — 비오케이솔루션 개발 사례", [
            ("공공데이터 연동", "KRA 오픈 API로 출전표·배당·경주 기록을 수집합니다."),
            ("주목지수", "근거가 함께 보이는 설명 가능한 지표로 정리합니다."),
            ("결과 맞히기", "현금 베팅 없는 응원권 미니게임으로 운영합니다."),
            ("모바일 PWA", "설치 없이 모바일 브라우저에서 바로 사용합니다."),
        ]),
    ],
    "ncs": [
        ("NCS Passport 구성 — 비오케이솔루션 개발 사례", [
            ("직무 진단", "NCS 기준으로 보유 역량과 목표 직무의 격차를 진단합니다."),
            ("훈련과정 추천", "Work24 국민내일배움카드 훈련과정을 연결합니다."),
            ("채용·자격 정보", "채용행사, 공채속보, 자격증 정보를 함께 보여줍니다."),
            ("리포트 저장", "진단 결과를 저장해 반복 개선 흐름을 지원합니다."),
        ]),
    ],
}


def _service_proof_html(post: dict) -> str:
    ctx = _post_context(post)
    proof = _pick_variant(_SERVICE_PROOF.get(ctx, []), post)
    if not proof:
        return ""
    kicker, items = proof
    item_html = "".join(
        '<li>'
        f'<strong>{html.escape(title)}</strong>'
        f'<span>{html.escape(desc)}</span>'
        '</li>'
        for title, desc in items
    )
    return (
        f'<section class="service-proof" aria-label="{html.escape(kicker)}">'
        f'<div class="proof-kicker">{html.escape(kicker)}</div>'
        f'<ul>{item_html}</ul>'
        '</section>'
    )


_OPERATION_FLOW = {
    "badge": [
        ("사무국 운영 흐름", "명찰 발행은 데이터 확정부터 현장 기록까지 이어집니다", [
            ("명단 확정", "최종 파일과 QR·바코드 열을 잠급니다."),
            ("샘플 출력", "긴 소속명, 줄바꿈, 코드 스캔을 확인합니다."),
            ("현장 배치", "접수대와 재발행 창구 역할을 나눕니다."),
            ("기록 정리", "수정·미수령·현장 등록 기록을 남깁니다."),
        ]),
        ("명찰 발행 점검 순서", "출력 전 확정부터 사후 기록까지 순서대로 짚습니다", [
            ("데이터 확정", "표기 항목과 QR·바코드 값을 최종본으로 고정합니다."),
            ("사전 샘플링", "긴 이름·소속 줄바꿈과 스캔 여부를 미리 확인합니다."),
            ("현장 동선", "접수와 재발행 창구를 분리해 대기를 줄입니다."),
            ("사후 기록", "재발행·미수령 처리 이력을 다음 행사용으로 남깁니다."),
        ]),
        ("명찰 발행 준비 단계", "확정부터 현장 대응까지 순서로 짚습니다", [
            ("데이터 확정", "표기 항목과 코드 값을 최종본으로 고정합니다."),
            ("출력 점검", "실제 샘플로 인식률과 정렬을 확인합니다."),
            ("현장 대응", "접수·재발행 창구를 구분해 운영합니다."),
            ("기록 남기기", "재발행·오류 처리 이력을 남깁니다."),
        ]),
        ("명찰 준비·발행 순서", "사전 확정에서 사후 정리까지 이어집니다", [
            ("표기 확정", "소속·직책 등 표기 규칙을 확정합니다."),
            ("샘플 확인", "출력 전 인쇄물로 오류를 점검합니다."),
            ("현장 운영", "접수대와 재발행 동선을 분리합니다."),
            ("사후 정리", "출력·재발행 이력을 정리해 보관합니다."),
        ]),
    ],
    "conference": [
        ("학회 시스템 구축 흐름", "등록부터 사후 데이터까지 하나의 운영 데이터로 연결합니다", [
            ("요구 정리", "등록 항목, 결제 방식, 심사 절차를 확정합니다."),
            ("시스템 구축", "등록 페이지와 관리자 화면을 함께 만듭니다."),
            ("현장 운영", "QR 체크인과 명찰 출력을 실데이터로 검증합니다."),
            ("사후 정리", "참석·결제 데이터를 보고서로 넘깁니다."),
        ]),
        ("학회 운영 데이터 설계 순서", "등록 요건 확정부터 사후 보고까지 이어지는 흐름입니다", [
            ("요건 확정", "등록 항목, 결제 수단, 심사 기준을 먼저 정합니다."),
            ("화면 구축", "등록 페이지와 관리자 화면을 같은 데이터로 연결합니다."),
            ("실데이터 검증", "체크인·명찰 출력을 행사 전 실데이터로 테스트합니다."),
            ("사후 집계", "참석·결제 기록을 정산·보고 자료로 정리합니다."),
        ]),
        ("학회 시스템 도입 순서", "요건 정리부터 사후 데이터까지 진행합니다", [
            ("요건 정리", "등록·결제·심사 방식을 확정합니다."),
            ("시스템 구축", "등록 페이지와 관리자 화면을 만듭니다."),
            ("현장 검증", "체크인·명찰 출력을 실데이터로 확인합니다."),
            ("데이터 정리", "참석·결제 기록을 사후 자료로 남깁니다."),
        ]),
        ("국제학술대회 준비 흐름", "등록 설계부터 현장 운영까지 이어집니다", [
            ("등록 설계", "등록 항목과 결제 흐름을 확정합니다."),
            ("초록·심사", "접수와 심사 배정을 시스템화합니다."),
            ("체크인 연동", "현장 체크인을 등록 데이터와 연결합니다."),
            ("사후 보고", "행사 데이터를 보고서로 정리합니다."),
        ]),
    ],
    "beok": [
        ("개발 진행 흐름", "상담부터 오픈까지 단계마다 확인하며 진행합니다", [
            ("상담·견적", "업무 흐름을 듣고 화면 단위로 범위를 정합니다."),
            ("설계 확정", "화면 시안과 데이터 구조를 먼저 확인받습니다."),
            ("구축·연동", "홈페이지·관리자·API 연동을 구축합니다."),
            ("오픈·운영", "검색 노출 세팅과 유지보수 기준을 정리합니다."),
        ]),
        ("시스템 구축 진행 순서", "요구사항 정리부터 운영 이관까지 단계별로 확인합니다", [
            ("요구사항 청취", "업무 흐름과 화면 단위 범위를 먼저 정리합니다."),
            ("시안 확정", "데이터 구조와 화면 시안을 확인받고 확정합니다."),
            ("개발·연동", "홈페이지, 관리자, 결제·알림톡 API를 연결합니다."),
            ("오픈 후 운영", "SEO 기본 세팅과 유지보수 기준을 함께 정리합니다."),
        ]),
        ("맞춤 시스템 구축 순서", "분석부터 운영 지원까지 단계별로 진행합니다", [
            ("업무 분석", "기존 업무 흐름을 데이터 구조로 정리합니다."),
            ("화면 설계", "관리자 화면과 DB 구조를 확정합니다."),
            ("연동 개발", "결제·알림톡 등 외부 API를 연결합니다."),
            ("운영 지원", "오픈 후 보안·SEO 운영을 지원합니다."),
        ]),
        ("웹 시스템 개발 순서", "현황 파악부터 안정화까지 이어집니다", [
            ("현황 파악", "현재 업무 방식과 데이터를 파악합니다."),
            ("설계 확정", "화면·데이터 구조를 확정받습니다."),
            ("개발·연동", "시스템 개발과 외부 API 연동을 진행합니다."),
            ("안정화", "오픈 후 트래픽·보안을 점검합니다."),
        ]),
    ],
    "hong": [
        ("행사 운영 흐름", "기획부터 사후 보고까지 한 팀이 책임집니다", [
            ("기획·예산", "행사 목적에 맞춰 프로그램과 예산을 설계합니다."),
            ("등록 오픈", "등록·결제·초록 접수 시스템을 오픈합니다."),
            ("현장 운영", "체크인, 통역, 세션 운영을 현장에서 지원합니다."),
            ("사후 보고", "등록·참석·정산 데이터를 보고서로 정리합니다."),
        ]),
        ("MICE 운영 진행 순서", "기획 단계부터 정산 보고까지 이어지는 대행 흐름입니다", [
            ("기획 단계", "목적과 예산에 맞춰 프로그램 구성을 확정합니다."),
            ("등록 시스템", "등록·결제·초록 접수를 하나의 시스템으로 엽니다."),
            ("현장 지원", "체크인·통역·세션 운영을 현장 인력이 맡습니다."),
            ("사후 정산", "등록·참석·정산 데이터를 보고서로 마무리합니다."),
        ]),
        ("행사 대행 진행 순서", "기획부터 사후 보고까지 대행 흐름입니다", [
            ("기획", "목적에 맞춰 프로그램·예산을 설계합니다."),
            ("등록 오픈", "등록·결제·투고 시스템을 오픈합니다."),
            ("현장 운영", "통역·체크인·세션을 현장에서 지원합니다."),
            ("사후 보고", "데이터를 정리해 보고서로 제출합니다."),
        ]),
        ("국제행사 대행 순서", "설계부터 정산까지 한 팀이 진행합니다", [
            ("행사 설계", "목적·예산에 맞춰 구성을 확정합니다."),
            ("시스템 오픈", "등록·결제 시스템을 오픈합니다."),
            ("현장 지원", "통역·현장 운영 인력을 배치합니다."),
            ("정산 보고", "참석·정산 데이터를 보고서화합니다."),
        ]),
    ],
    "notebook_return": [
        ("구매 판단 흐름", "반품 노트북은 등급 확인부터 재고 확인까지 순서대로 보면 실패가 줄어듭니다", [
            ("용도 정리", "사무용·인강용·게이밍 등 용도와 예산을 정합니다."),
            ("등급 확인", "최상·상·중·리퍼 등급 기준과 상태 설명을 봅니다."),
            ("가격 비교", "정가 대비 할인율과 동급 매물 시세를 비교합니다."),
            ("재고 확인", "실시간 재고와 배송·보증 조건을 확인하고 결정합니다."),
        ]),
    ],
    "racekra": [
        ("공공데이터 서비스 개발 흐름", "API 신청부터 운영 자동화까지 실제 개발 순서로 진행합니다", [
            ("API 신청", "공공데이터포털에서 활용 신청과 승인 절차를 진행합니다."),
            ("데이터 검증", "실호출로 스키마와 갱신 주기를 확인합니다."),
            ("화면 설계", "출전표·기록 데이터를 사용자 화면으로 정리합니다."),
            ("운영 자동화", "키 갱신, 장애 감지, 데이터 파이프라인을 자동화합니다."),
        ]),
    ],
    "ncs": [
        ("공공 API 서비스 개발 흐름", "여러 공공 API를 하나의 진단 흐름으로 묶어 구축합니다", [
            ("API 선정", "Work24 API 목록에서 필요한 데이터를 고릅니다."),
            ("프록시 구성", "Functions로 인증과 결과코드 처리를 한곳에 모읍니다."),
            ("진단 설계", "NCS 기준 진단 로직과 추천 화면을 만듭니다."),
            ("반복 개선", "저장된 리포트로 추천 품질을 개선합니다."),
        ]),
    ],
}


def _operation_flow_html(post: dict) -> str:
    ctx = _post_context(post)
    flow = _pick_variant(_OPERATION_FLOW.get(ctx, []), post)
    if not flow:
        return ""
    kicker, heading, steps = flow
    items = "".join(
        '<li>'
        f'<span class="flow-num">{i}</span>'
        '<div>'
        f'<strong>{html.escape(title)}</strong>'
        f'<p>{html.escape(desc)}</p>'
        '</div>'
        '</li>'
        for i, (title, desc) in enumerate(steps, start=1)
    )
    return (
        f'<section class="operation-flow" aria-label="{html.escape(kicker)}">'
        f'<div class="flow-kicker">{html.escape(kicker)}</div>'
        f'<h2>{html.escape(heading)}</h2>'
        f'<ol>{items}</ol>'
        '</section>'
    )


_OPS_COMPARISON = {
    "badge": [
        ("현장 혼잡을 줄이는 운영 기준 비교", ("항목", "흔한 문제", "권장 기준"), [
            ("명단 파일", "파일 분산", "기준 파일 1개"),
            ("출력 검수", "현장 오류 발견", "샘플 출력 선확인"),
            ("재발행", "즉시 재출력", "승인·사유 기록"),
            ("행사 후", "기록 소실", "정산 자료화"),
        ]),
        ("명찰 운영 전후 비교", ("항목", "기존 방식", "개선 기준"), [
            ("명단 관리", "여러 파일로 분산", "단일 기준 파일"),
            ("출력 확인", "현장에서 오류 발견", "사전 샘플 출력"),
            ("재발행 처리", "승인 없이 즉시 재출력", "승인·사유 기록 필수"),
            ("행사 후 관리", "기록이 남지 않음", "정산 자료로 보관"),
        ]),
        ("명찰 발행 리스크 비교", ("항목", "방치 시 리스크", "권장 기준"), [
            ("명단 관리", "오탈자·중복 발생", "단일 기준 파일 관리"),
            ("출력 검수", "현장에서 오류 발견", "사전 샘플 출력"),
            ("재발행", "기준 없이 즉시 처리", "승인·사유 기록"),
            ("사후 관리", "자료 소실", "정산 자료로 보관"),
        ]),
        ("학회 명찰 운영 기준 비교", ("항목", "일반적 방식", "권장 기준"), [
            ("데이터 확정", "여러 담당자가 개별 수정", "기준 파일 일원화"),
            ("출력 확인", "전량 출력 후 확인", "샘플 출력 선확인"),
            ("재발행 처리", "즉시 재출력", "승인 절차 후 처리"),
            ("행사 후", "기록 없이 종료", "이력 데이터화"),
        ]),
    ],
    "conference": [
        ("학회 운영 방식 비교", ("항목", "흔한 문제", "권장 기준"), [
            ("등록 관리", "엑셀 수기 취합", "등록 시스템 자동 집계"),
            ("결제 확인", "입금 대조 수작업", "결제·영수증 자동 연동"),
            ("현장 확인", "명단 출력물 대조", "QR 체크인"),
            ("사후 보고", "기억에 의존", "데이터 기반 보고서"),
        ]),
        ("학회 등록·현장 운영 비교", ("항목", "기존 방식", "개선 기준"), [
            ("등록 처리", "엑셀로 수기 취합", "시스템 자동 집계"),
            ("결제 대사", "입금 내역 수작업 대조", "결제·영수증 자동 연동"),
            ("현장 확인", "출력물과 대조", "QR 체크인으로 즉시 확인"),
            ("사후 정리", "담당자 기억에 의존", "데이터 기반 보고서"),
        ]),
        ("학회 등록 운영 리스크 비교", ("항목", "방치 시 리스크", "권장 기준"), [
            ("등록 관리", "수기 취합 오류", "시스템 자동 집계"),
            ("결제 확인", "입금 누락 발견 지연", "자동 연동·알림"),
            ("현장 확인", "명단 대조 지연", "QR 체크인"),
            ("사후 보고", "자료 미보관", "데이터 기반 보고서"),
        ]),
        ("국제학술대회 운영 기준 비교", ("항목", "일반적 방식", "권장 기준"), [
            ("등록 처리", "엑셀 수기 관리", "등록 시스템 자동화"),
            ("결제 대사", "수작업 대조", "자동 연동"),
            ("현장 체크인", "출력물 대조", "QR 체크인"),
            ("정산 보고", "기억에 의존", "데이터 기반 정리"),
        ]),
    ],
    "beok": [
        ("홈페이지·시스템 운영 방식 비교", ("항목", "흔한 문제", "권장 기준"), [
            ("문의 접수", "전화·수기 메모", "문의폼·관리자 알림"),
            ("예약·결제", "수동 확인", "자동 연동·알림톡"),
            ("데이터 관리", "엑셀 분산", "관리자 대시보드"),
            ("검색 노출", "방치", "기본 SEO 세팅"),
        ]),
        ("업무 시스템 전후 비교", ("항목", "기존 방식", "개선 기준"), [
            ("문의 처리", "전화로 받아 수기 기록", "문의폼과 관리자 알림 연동"),
            ("예약·결제 확인", "담당자가 수동 확인", "자동 연동과 알림톡 안내"),
            ("데이터 관리", "엑셀 파일로 분산 보관", "관리자 대시보드 일원화"),
            ("검색 노출", "별도 설정 없이 방치", "기본 SEO 세팅 적용"),
        ]),
        ("업무 시스템 리스크 비교", ("항목", "방치 시 리스크", "권장 기준"), [
            ("문의 관리", "응대 누락", "문의폼·알림 연동"),
            ("예약·결제", "확인 지연", "자동 연동"),
            ("데이터 관리", "파일 분산·유실", "관리자 대시보드"),
            ("검색 노출", "유입 저조", "기본 SEO 세팅"),
        ]),
        ("맞춤 시스템 운영 기준 비교", ("항목", "일반적 방식", "권장 기준"), [
            ("고객 문의", "전화·메일 개별 대응", "문의폼 통합 관리"),
            ("예약·결제", "수동 확인", "자동 알림 연동"),
            ("데이터", "엑셀 개별 관리", "관리자 화면 통합"),
            ("검색 노출", "미설정", "기본 SEO 적용"),
        ]),
    ],
    "hong": [
        ("행사 준비 방식 비교", ("항목", "흔한 문제", "권장 기준"), [
            ("등록 접수", "이메일 취합", "e-Regi 등록 시스템"),
            ("통역", "부스·장비 임대", "AI 실시간 동시통역"),
            ("현장 운영", "사무국 단독 대응", "전문 운영 인력 배치"),
            ("사후 보고", "자료 소실", "등록·참석 데이터 보고"),
        ]),
        ("MICE 행사 준비 전후 비교", ("항목", "기존 방식", "개선 기준"), [
            ("등록 접수", "이메일로 개별 취합", "e-Regi 시스템 일괄 관리"),
            ("통역 지원", "통역 부스·장비 별도 임대", "AI 실시간 동시통역 연동"),
            ("현장 대응", "사무국 인력만으로 대응", "전문 운영 인력 배치"),
            ("사후 정리", "참석 자료가 흩어짐", "등록·참석 데이터 보고서화"),
        ]),
        ("행사 준비 리스크 비교", ("항목", "방치 시 리스크", "권장 기준"), [
            ("등록 접수", "이메일 누락", "e-Regi 시스템"),
            ("통역", "장비 대응 지연", "AI 동시통역"),
            ("현장 운영", "인력 부족 대응", "전문 인력 배치"),
            ("사후 보고", "자료 소실", "데이터 기반 보고"),
        ]),
        ("국제행사 운영 기준 비교", ("항목", "일반적 방식", "권장 기준"), [
            ("등록", "개별 이메일 취합", "시스템 일괄 관리"),
            ("통역 지원", "별도 장비 임대", "AI 동시통역 연동"),
            ("현장 대응", "사무국 단독 대응", "전문 인력 배치"),
            ("사후 정리", "기록 부재", "보고서 데이터화"),
        ]),
    ],
    "notebook_return": [
        ("신품 vs 반품 노트북 비교", ("항목", "신품 구매", "반품 매물"), [
            ("가격", "정가 그대로", "정가 대비 할인"),
            ("상태", "새 제품", "등급별 상태 표기"),
            ("보증", "제조사 보증", "판매 조건별 상이 — 확인 필수"),
            ("재고", "상시 판매", "실시간 변동 — 시세 확인"),
        ]),
    ],
    "racekra": [
        ("공공데이터 서비스 구축 방식 비교", ("항목", "흔한 문제", "권장 기준"), [
            ("데이터 확보", "수작업 크롤링", "공공데이터 API 정식 활용 신청"),
            ("데이터 갱신", "수동 갱신", "갱신 주기 기반 자동 파이프라인"),
            ("지표 제공", "근거 없는 수치", "근거가 보이는 설명 가능한 지표"),
            ("키 관리", "만료 후 장애", "갱신·장애 감지 자동화"),
        ]),
    ],
    "ncs": [
        ("공공 고용 API 활용 방식 비교", ("항목", "흔한 문제", "권장 기준"), [
            ("API 연동", "화면별 개별 호출", "프록시 한곳에서 인증·결과코드 처리"),
            ("장애 대응", "빈 화면 노출", "공식 링크 폴백 설계"),
            ("추천 근거", "단순 목록 나열", "진단 결과 연동 추천"),
            ("이력 관리", "기록 소실", "리포트 저장·반복 진단"),
        ]),
    ],
}


def _ops_comparison_html(post: dict) -> str:
    ctx = _post_context(post)
    comp = _pick_variant(_OPS_COMPARISON.get(ctx, []), post)
    if not comp:
        return ""
    heading, headers, rows = comp
    head = "".join(f"<th>{html.escape(h)}</th>" for h in headers)
    body = "".join(
        '<tr>'
        f'<td>{html.escape(label)}</td>'
        f'<td>{html.escape(risk)}</td>'
        f'<td>{html.escape(standard)}</td>'
        '</tr>'
        for label, risk, standard in rows
    )
    return (
        f'<section class="ops-comparison" aria-label="{html.escape(heading)}">'
        f'<h2>{html.escape(heading)}</h2>'
        '<div class="table-wrap"><table>'
        f'<thead><tr>{head}</tr></thead>'
        f'<tbody>{body}</tbody>'
        '</table></div>'
        '</section>'
    )


def _plain_text(value: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", value or "")).strip()


def _reading_minutes(text: str) -> int:
    # 한국어 기준 대략 1분 650자. 너무 작게 보이지 않게 최소 1분.
    return max(1, round(len(_plain_text(text)) / 650))


def _tags(post: dict) -> list[str]:
    tags = post.get("tags", []) or []
    if isinstance(tags, str):
        try:
            parsed = json.loads(tags)
            tags = parsed if isinstance(parsed, list) else []
        except (TypeError, ValueError, json.JSONDecodeError):
            tags = [t.strip() for t in tags.split(",") if t.strip()]
    return [str(t).strip() for t in tags if str(t).strip()]


def _summary_card(post: dict, toc: list[tuple[str, str]], source_md: str) -> str:
    desc = (post.get("meta_desc") or "").strip()
    bullets = [title for _hid, title in toc[:2]]
    if not desc and not bullets:
        return ""
    bullet_html = "".join(f"<li>{html.escape(item)}</li>" for item in bullets)
    desc_html = f"<p>{html.escape(desc)}</p>" if desc else ""
    minutes = _reading_minutes(source_md)
    list_html = f"<ul>{bullet_html}</ul>" if bullet_html else ""
    decision = {
        "badge": "명단 기준과 현장 재발행 기준을 먼저 확인하세요.",
        "conference": "등록·결제·체크인 데이터가 한 흐름으로 이어지는지 먼저 확인하세요.",
        "beok": "운영 목적과 신청/문의 흐름을 먼저 대조하세요.",
        "hong": "행사 규모와 등록·통역·현장 운영 범위를 먼저 정리하세요.",
        "notebook_return": "등급·가격·보증을 확인한 뒤 실시간 재고를 확인하세요.",
        "racekra": "공공데이터 활용 신청 조건과 데이터 갱신 주기를 먼저 확인하세요.",
        "ncs": "목표 직무의 NCS 기준과 활용할 공공 API 범위를 먼저 정리하세요.",
    }.get(_post_context(post), "본문의 기준과 체크리스트를 실제 운영 상황에 맞춰 확인하세요.")
    return (
        '<section class="summary-card" aria-label="글 요약">'
        '<div class="summary-head">'
        '<div class="summary-kicker">핵심 요약</div>'
        f'<div class="summary-time">읽기 {minutes}분</div>'
        '</div>'
        f"{desc_html}"
        f"{list_html}"
        f'<div class="summary-decision"><strong>판단 포인트</strong><span>{html.escape(decision)}</span></div>'
        '</section>'
    )


_CTA = {
    "badge": (
        "학회 명찰 출력과 현장 재발행 기준이 필요하다면",
        "명단 정리, QR·바코드 확인, 출력·재발행 동선을 행사 흐름에 맞춰 점검합니다.",
        "https://beoksolution.com", "상담 문의하기",
    ),
    "conference": (
        "학회 등록·초록·체크인 시스템 구축이 필요하다면",
        "참가자 등록, 결제, 초록 접수, QR 체크인을 하나의 운영 데이터로 연결합니다.",
        "https://beoksolution.com", "상담 문의하기",
    ),
    "beok": (
        "운영 업무를 실제 시스템과 연결해야 한다면",
        "홈페이지 제작, 예약·결제, 알림톡, 관리자 대시보드, AI 자동화를 업무 흐름에 맞춰 설계합니다.",
        "https://beoksolution.com", "상담 문의하기",
    ),
    "hong": (
        "국제학술대회·MICE 행사 운영 파트너가 필요하다면",
        "행사 기획, e-Regi 등록 시스템, 38개국 AI 동시통역, 현장 운영까지 홍커뮤니케이션이 함께합니다. (02-6959-3871~3 / info@hongcomm.kr)",
        "https://hongcomm.kr", "홍커뮤니케이션 문의하기",
    ),
    "notebook_return": (
        "지금 판매 중인 반품 노트북이 궁금하다면",
        "삼성·LG·HP·레노버 반품·리퍼 매물을 등급과 실시간 가격/재고로 비교해 보여드립니다.",
        "https://notebook-return.web.app", "시세·재고 확인하기",
    ),
    "racekra": (
        "공공데이터로 만든 실제 서비스가 궁금하다면",
        "이 글의 개발 방식으로 비오케이솔루션이 직접 만든 경마·경륜·경정 정보 서비스 '마분'을 확인해 보세요. "
        "출전표·경주 기록과 설명 가능한 주목지수를 제공합니다. 비슷한 데이터 서비스 개발 의뢰도 상담해 드립니다.",
        "https://racekra-87ecc.web.app", "마분 서비스 보기",
    ),
    "ncs": (
        "내 직무 역량 진단과 훈련과정 추천이 필요하다면",
        "비오케이솔루션이 개발한 NCS Passport에서 NCS 기반 직무 진단과 국민내일배움카드 훈련과정·채용 정보 추천을 무료로 사용해 보세요. "
        "공공 API 연동 서비스 개발 의뢰도 상담해 드립니다.",
        "https://ncspj-ba46a.web.app", "NCS Passport 사용해 보기",
    ),
}


def _cta_html(post: dict) -> str:
    ctx = _post_context(post)
    if not ctx:
        category = post.get("category") or ""
        topic = f"{post.get('topic', '')} {post.get('title', '')}"
        if category in {"beok", ""} or "AI" in category or "자동화" in topic:
            ctx = "beok"
        else:
            return ""
    heading, desc, url, label = _CTA[ctx]
    return (
        '<aside class="soft-cta">'
        f'<strong>{html.escape(heading)}</strong>'
        f'<p>{html.escape(desc)}</p>'
        f'<a href="{html.escape(url)}" target="_blank" rel="noopener">{html.escape(label)}</a>'
        '</aside>'
    )


def _disclosure_html(post: dict) -> str:
    """쿠팡 파트너스 표시광고 고지 — notebook_return 글에는 반드시 노출한다."""
    if _post_context(post) != "notebook_return":
        return ""
    from tools.keyword_bank import NOTEBOOK_RETURN_DISCLOSURE
    return (
        '<aside class="content-callout is-warn partner-disclosure">'
        f'{html.escape(NOTEBOOK_RETURN_DISCLOSURE)}'
        '</aside>'
    )


def _source_footer_html(post: dict) -> str:
    source_url = _safe_attr_url(str(post.get("source_url") or ""))
    if not source_url:
        return ""
    u = html.escape(source_url)
    return (
        f'<footer class="src">참고 출처: '
        f'<a href="{u}" rel="nofollow noopener" target="_blank">{u}</a></footer>'
    )


def _hero_html(post: dict) -> str:
    """글마다 고유한 대표 이미지(og_image/hero_image)를 본문 상단 히어로로 노출."""
    src = _safe_attr_url(str(post.get("hero_image") or post.get("og_image") or ""), image=True)
    if not src:
        return ""
    alt = html.escape(post.get("title", ""))
    return (
        f'<div class="post-hero">'
        f'<img src="{html.escape(src)}" alt="{alt}" loading="eager"></div>'
    )


def _body_fragment_html(post: dict, content_html: str, toc: list[tuple[str, str]], source_md: str) -> str:
    tags = _tags(post)
    tags_html = "".join(
        f'<a href="/tag/{html.escape(t)}">#{html.escape(t)}</a>' for t in tags
    )
    return (
        f'{_hero_html(post)}\n'
        f'{_disclosure_html(post)}\n'
        f'{_summary_card(post, toc, source_md)}\n'
        f'{_service_proof_html(post)}\n'
        f'{_operation_flow_html(post)}\n'
        f'{_ops_comparison_html(post)}\n'
        f'{_toc_html(toc)}\n'
        f'<div class="content">\n{content_html}\n</div>\n'
        f'{_cta_html(post)}\n'
        f'<div class="tags">{tags_html}</div>\n'
        f'{_source_footer_html(post)}'
    )


def _build_article_html(post: dict) -> tuple[str, str, str]:
    """(article_html, tags_html, json_ld_json) 반환."""
    title = post.get("title", "")
    body_md = post.get("body", "")
    content_html, toc = _markdown_to_html(body_md)
    published = post.get("published_at") or datetime.now(timezone.utc)
    tags = _tags(post)

    tags_html = "".join(
        f'<a href="/tag/{html.escape(t)}">#{html.escape(t)}</a>' for t in tags
    )
    article_html = (
        f'<article>\n'
        f'  <header>\n'
        f'    <h1>{html.escape(title)}</h1>\n'
        f'    <div class="meta">\n'
        f'      <time datetime="{published.isoformat()}">{published.strftime("%Y-%m-%d")}</time>'
        f' · {html.escape(post.get("author", "BEOK"))}\n'
        f'    </div>\n'
        f'  </header>\n'
        f'  {_body_fragment_html(post, content_html, toc, body_md)}\n'
        f'</article>'
    )

    json_ld = json.dumps({
        "@context": "https://schema.org",
        "@type": "Article",
        "headline": title,
        "description": post.get("meta_desc", ""),
        "datePublished": published.isoformat(),
        "author": {"@type": "Person", "name": post.get("author", "BEOK")},
        "mainEntityOfPage": post.get("canonical_url", ""),
        "keywords": ", ".join(tags),
    }, ensure_ascii=False)

    return article_html, tags_html, json_ld


def render_body(post: dict) -> str:
    """Firebase처럼 외부 페이지가 제목/메타를 렌더링하는 시스템용 본문 fragment 반환."""
    body_md = post.get("body", "")
    content_html, toc = _markdown_to_html(body_md)
    return _body_fragment_html(post, content_html, toc, body_md)


def render_body_embed(post: dict, extra_footer_html: str = "") -> str:
    """스타일을 함께 내장한 self-contained fragment 반환.

    호스트 페이지가 우리 컴포넌트 CSS를 갖고 있지 않은 외부 시스템
    (예: notebook-return.web.app이 bodyHtml을 그대로 innerHTML로 삽입)용.
    스타일이 없으면 요약카드/목차/CTA가 전부 평문으로 보이는 문제를 막는다.
    extra_footer_html은 호출부가 이미 escape/세척한 신뢰 HTML이어야 한다.
    """
    embed_css = (_DIR / "embed_style.css").read_text(encoding="utf-8")
    footer = f"\n{extra_footer_html}" if extra_footer_html else ""
    return (
        f'<style>\n{embed_css}\n</style>\n'
        f'<div class="bp-article">\n{render_body(post)}{footer}\n</div>'
    )


def render(post: dict) -> str:
    """완전한 HTML 페이지 반환 (독립 배포용)."""
    article_html, _, json_ld = _build_article_html(post)
    t = html.escape(post.get("title", ""))
    desc = html.escape(post.get("meta_desc", ""))
    canonical = html.escape(post.get("canonical_url", ""))
    og_image = html.escape(post.get("og_image", ""))
    lang = post.get("lang", "ko")

    return (
        f'<!DOCTYPE html>\n<html lang="{lang}">\n<head>\n'
        f'<meta charset="utf-8">\n'
        f'<meta name="viewport" content="width=device-width, initial-scale=1">\n'
        f'<title>{t}</title>\n'
        f'<meta name="description" content="{desc}">\n'
        f'<link rel="canonical" href="{canonical}">\n'
        f'<meta name="robots" content="index,follow">\n'
        f'<meta property="og:type" content="article">\n'
        f'<meta property="og:title" content="{t}">\n'
        f'<meta property="og:description" content="{desc}">\n'
        f'<meta property="og:url" content="{canonical}">\n'
        f'<meta property="og:image" content="{og_image}">\n'
        f'<meta name="twitter:card" content="summary_large_image">\n'
        f'<meta name="twitter:title" content="{t}">\n'
        f'<meta name="twitter:description" content="{desc}">\n'
        f'<script type="application/ld+json">\n{json_ld}\n</script>\n'
        f'<style>\n{_CSS}\n</style>\n'
        f'</head>\n<body>\n<div class="wrap">\n'
        f'{article_html}\n'
        f'</div>\n</body>\n</html>'
    )
