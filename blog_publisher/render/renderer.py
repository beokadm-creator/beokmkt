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


_SERVICE_PROOF = {
    "badge": ("비오케이솔루션 실무 점검 범위", [
        ("데이터 검수", "이름·소속·역할·등록 구분을 기준 파일 하나로 고정합니다."),
        ("출력 기준", "줄바꿈, QR·바코드, 여분 수량을 샘플 출력으로 확인합니다."),
        ("현장 재발행", "승인 기준과 출력 기록을 남겨 중복 처리를 줄입니다."),
        ("사후 정리", "미수령·변경 요청을 다음 행사 기준으로 남깁니다."),
    ]),
    "conference": ("비오케이솔루션 학회 시스템 구축 범위", [
        ("등록·결제", "참가자 등록, 등록비 결제, 영수증 처리를 한 흐름으로 연결합니다."),
        ("초록·심사", "초록 접수와 심사 배정을 관리자 화면에서 처리합니다."),
        ("현장 체크인", "QR 체크인과 명찰 출력을 등록 데이터와 연동합니다."),
        ("사후 데이터", "참석·결제 기록을 보고서용 데이터로 정리합니다."),
    ]),
    "beok": ("비오케이솔루션 구축 범위", [
        ("요구사항 정리", "업무 흐름을 화면과 데이터 구조로 먼저 정리합니다."),
        ("홈페이지·시스템", "홈페이지, 관리자 대시보드, 맞춤 업무 화면을 구축합니다."),
        ("연동 개발", "예약·결제·알림톡·이메일 API를 업무 흐름에 연결합니다."),
        ("운영·유지보수", "서버, SSL, 검색 노출 기본 세팅까지 운영을 지원합니다."),
    ]),
    "hong": ("홍커뮤니케이션 운영 범위", [
        ("행사 기획", "국제학술대회·기업행사·전시회를 기획부터 정산까지 대행합니다."),
        ("등록 시스템", "e-Regi 등록, 결제, 논문 투고를 학회 홈페이지와 연결합니다."),
        ("AI 동시통역", "38개국 실시간 통역을 행사 규모에 맞춰 구성합니다."),
        ("현장 운영", "체크인, 세션 운영, 사후 보고까지 현장 인력이 지원합니다."),
    ]),
    "notebook_return": ("구매 전 확인 범위", [
        ("등급 확인", "최상·상·중·리퍼 등급별 상태 기준을 먼저 확인합니다."),
        ("가격 비교", "정가 대비 할인율과 브랜드별 시세를 비교합니다."),
        ("보증·구성품", "A/S 기간, 충전기 등 구성품 포함 여부를 확인합니다."),
        ("재고 확인", "반품 매물은 재고 변동이 빠르므로 실시간 재고를 확인합니다."),
    ]),
}


def _service_proof_html(post: dict) -> str:
    ctx = _post_context(post)
    proof = _SERVICE_PROOF.get(ctx)
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
    "badge": ("사무국 운영 흐름", "명찰 발행은 데이터 확정부터 현장 기록까지 이어집니다", [
        ("명단 확정", "최종 파일과 QR·바코드 열을 잠급니다."),
        ("샘플 출력", "긴 소속명, 줄바꿈, 코드 스캔을 확인합니다."),
        ("현장 배치", "접수대와 재발행 창구 역할을 나눕니다."),
        ("기록 정리", "수정·미수령·현장 등록 기록을 남깁니다."),
    ]),
    "conference": ("학회 시스템 구축 흐름", "등록부터 사후 데이터까지 하나의 운영 데이터로 연결합니다", [
        ("요구 정리", "등록 항목, 결제 방식, 심사 절차를 확정합니다."),
        ("시스템 구축", "등록 페이지와 관리자 화면을 함께 만듭니다."),
        ("현장 운영", "QR 체크인과 명찰 출력을 실데이터로 검증합니다."),
        ("사후 정리", "참석·결제 데이터를 보고서로 넘깁니다."),
    ]),
    "beok": ("개발 진행 흐름", "상담부터 오픈까지 단계마다 확인하며 진행합니다", [
        ("상담·견적", "업무 흐름을 듣고 화면 단위로 범위를 정합니다."),
        ("설계 확정", "화면 시안과 데이터 구조를 먼저 확인받습니다."),
        ("구축·연동", "홈페이지·관리자·API 연동을 구축합니다."),
        ("오픈·운영", "검색 노출 세팅과 유지보수 기준을 정리합니다."),
    ]),
    "hong": ("행사 운영 흐름", "기획부터 사후 보고까지 한 팀이 책임집니다", [
        ("기획·예산", "행사 목적에 맞춰 프로그램과 예산을 설계합니다."),
        ("등록 오픈", "등록·결제·초록 접수 시스템을 오픈합니다."),
        ("현장 운영", "체크인, 통역, 세션 운영을 현장에서 지원합니다."),
        ("사후 보고", "등록·참석·정산 데이터를 보고서로 정리합니다."),
    ]),
    "notebook_return": ("구매 판단 흐름", "반품 노트북은 등급 확인부터 재고 확인까지 순서대로 보면 실패가 줄어듭니다", [
        ("용도 정리", "사무용·인강용·게이밍 등 용도와 예산을 정합니다."),
        ("등급 확인", "최상·상·중·리퍼 등급 기준과 상태 설명을 봅니다."),
        ("가격 비교", "정가 대비 할인율과 동급 매물 시세를 비교합니다."),
        ("재고 확인", "실시간 재고와 배송·보증 조건을 확인하고 결정합니다."),
    ]),
}


def _operation_flow_html(post: dict) -> str:
    ctx = _post_context(post)
    flow = _OPERATION_FLOW.get(ctx)
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
    "badge": ("현장 혼잡을 줄이는 운영 기준 비교", ("항목", "흔한 문제", "권장 기준"), [
        ("명단 파일", "파일 분산", "기준 파일 1개"),
        ("출력 검수", "현장 오류 발견", "샘플 출력 선확인"),
        ("재발행", "즉시 재출력", "승인·사유 기록"),
        ("행사 후", "기록 소실", "정산 자료화"),
    ]),
    "conference": ("학회 운영 방식 비교", ("항목", "흔한 문제", "권장 기준"), [
        ("등록 관리", "엑셀 수기 취합", "등록 시스템 자동 집계"),
        ("결제 확인", "입금 대조 수작업", "결제·영수증 자동 연동"),
        ("현장 확인", "명단 출력물 대조", "QR 체크인"),
        ("사후 보고", "기억에 의존", "데이터 기반 보고서"),
    ]),
    "beok": ("홈페이지·시스템 운영 방식 비교", ("항목", "흔한 문제", "권장 기준"), [
        ("문의 접수", "전화·수기 메모", "문의폼·관리자 알림"),
        ("예약·결제", "수동 확인", "자동 연동·알림톡"),
        ("데이터 관리", "엑셀 분산", "관리자 대시보드"),
        ("검색 노출", "방치", "기본 SEO 세팅"),
    ]),
    "hong": ("행사 준비 방식 비교", ("항목", "흔한 문제", "권장 기준"), [
        ("등록 접수", "이메일 취합", "e-Regi 등록 시스템"),
        ("통역", "부스·장비 임대", "AI 실시간 동시통역"),
        ("현장 운영", "사무국 단독 대응", "전문 운영 인력 배치"),
        ("사후 보고", "자료 소실", "등록·참석 데이터 보고"),
    ]),
    "notebook_return": ("신품 vs 반품 노트북 비교", ("항목", "신품 구매", "반품 매물"), [
        ("가격", "정가 그대로", "정가 대비 할인"),
        ("상태", "새 제품", "등급별 상태 표기"),
        ("보증", "제조사 보증", "판매 조건별 상이 — 확인 필수"),
        ("재고", "상시 판매", "실시간 변동 — 시세 확인"),
    ]),
}


def _ops_comparison_html(post: dict) -> str:
    ctx = _post_context(post)
    comp = _OPS_COMPARISON.get(ctx)
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
