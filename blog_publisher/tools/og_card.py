"""
글마다 고유한 대표 이미지(OG/히어로) 카드를 결정론적으로 생성한다.

문제: 현재 이미지 뱅크는 고정된 hongcomm 썸네일/브랜드 SVG 소수를 모든 글에 돌려쓴다.
      → 네이버·구글 모두 '원본 이미지'를 품질·고유성 신호로 보는데 불리하고, 시각적으로도 반복적이다.

해결: 외부 의존 없이 제목·카테고리·키워드만으로 글마다 다른 SVG 카드를 만든다.
      featured_image(og:image)와 본문 상단 히어로에 사용한다. (AI 이미지가 준비되면 그쪽을 우선)

사용:
    from tools.og_card import build_og_svg, save_og_card
    svg = build_og_svg(post)                 # SVG 문자열
    path = save_og_card(post, "public/assets/blog/og", slug="my-post")  # 파일로 저장
"""
from __future__ import annotations

import hashlib
import html
import re
from pathlib import Path

# 카테고리별 브랜드 팔레트(딥 → 라이트, 강조색). 외부 폰트 없음(시스템 폰트).
_PALETTES: dict[str, dict[str, str]] = {
    "beok": {"a": "#1d4ed8", "b": "#0ea5e9", "ink": "#0b1220", "brand": "비오케이솔루션"},
    "hong": {"a": "#0f766e", "b": "#14b8a6", "ink": "#04201d", "brand": "홍커뮤니케이션"},
    "conference": {"a": "#7c3aed", "b": "#a855f7", "ink": "#1a0f2e", "brand": "BEOK"},
    "marketing": {"a": "#b45309", "b": "#f59e0b", "ink": "#241405", "brand": "BEOK"},
    "_default": {"a": "#1f2937", "b": "#3b82f6", "ink": "#0b1220", "brand": "BEOK"},
}


def _palette(category: str | None, seed: str) -> dict[str, str]:
    base = _PALETTES.get((category or "").lower(), _PALETTES["_default"]).copy()
    # 같은 카테고리라도 글마다 색조가 미세하게 달라지도록 hue 회전
    h = int(hashlib.md5(seed.encode("utf-8")).hexdigest(), 16)
    base["rot"] = str(h % 40 - 20)  # -20°~+20° 회전
    base["dots"] = str(h % 7)       # 배경 패턴 변주
    return base


def _wrap(title: str, width: int = 15, max_lines: int = 4) -> list[str]:
    """한국어 제목을 카드 폭에 맞춰 단어 경계 우선으로 줄바꿈."""
    words = title.split()
    lines: list[str] = []
    cur = ""
    for w in words:
        if len(cur) + len(w) + (1 if cur else 0) <= width:
            cur = f"{cur} {w}".strip()
        else:
            if cur:
                lines.append(cur)
            # 단어 자체가 길면 강제로 끊는다
            while len(w) > width:
                lines.append(w[:width])
                w = w[width:]
            cur = w
    if cur:
        lines.append(cur)
    if len(lines) > max_lines:
        lines = lines[:max_lines]
        lines[-1] = lines[-1][: width - 1].rstrip() + "…"
    return lines


def build_og_svg(post: dict, width: int = 1200, height: int = 630) -> str:
    """post(title, category, tags/keywords) → 고유 OG 카드 SVG 문자열."""
    title = (post.get("title") or "").strip() or "BEOK"
    category = post.get("category") or post.get("blog_profile") or ""
    pal = _palette(category, title)

    tags = post.get("tags") or post.get("keywords") or []
    if isinstance(tags, str):
        tags = re.findall(r"[\w가-힣]+", tags)
    kicker = (tags[0] if tags else (category or "BEOK")).strip()[:18]

    lines = _wrap(title, width=15, max_lines=4)
    line_h = 92
    block_h = line_h * len(lines)
    start_y = (height // 2) - (block_h // 2) + 64

    tspans = "".join(
        f'<tspan x="80" dy="{0 if i == 0 else line_h}">{html.escape(ln)}</tspan>'
        for i, ln in enumerate(lines)
    )

    # 배경 장식 도트(시드별 변주)
    dots = ""
    n = 6 + int(pal["dots"])
    for i in range(n):
        seed = int(hashlib.md5(f"{title}{i}".encode()).hexdigest(), 16)
        cx = 760 + (seed % 380)
        cy = 70 + ((seed >> 8) % 480)
        r = 6 + ((seed >> 16) % 26)
        op = 0.06 + ((seed >> 4) % 10) / 100
        dots += f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="#ffffff" opacity="{op:.2f}"/>'

    brand = html.escape(pal["brand"])
    kicker_esc = html.escape(kicker)

    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" role="img">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1" gradientTransform="rotate({pal['rot']} .5 .5)">
      <stop offset="0" stop-color="{pal['a']}"/>
      <stop offset="1" stop-color="{pal['b']}"/>
    </linearGradient>
  </defs>
  <rect width="{width}" height="{height}" fill="{pal['ink']}"/>
  <rect width="{width}" height="{height}" fill="url(#bg)"/>
  {dots}
  <rect x="0" y="0" width="14" height="{height}" fill="#ffffff" opacity="0.85"/>
  <g font-family="-apple-system, 'Apple SD Gothic Neo', 'Malgun Gothic', sans-serif">
    <rect x="80" y="86" width="{28 + len(kicker_esc) * 22}" height="46" rx="23" fill="#ffffff" opacity="0.16"/>
    <text x="100" y="117" font-size="26" font-weight="700" fill="#ffffff" opacity="0.95">{kicker_esc}</text>
    <text y="{start_y}" font-size="74" font-weight="800" fill="#ffffff" letter-spacing="-1">{tspans}</text>
    <text x="80" y="{height - 64}" font-size="30" font-weight="700" fill="#ffffff" opacity="0.92">{brand}</text>
    <text x="80" y="{height - 28}" font-size="22" font-weight="500" fill="#ffffff" opacity="0.6">beoksolution.com</text>
  </g>
</svg>"""


def save_og_card(post: dict, out_dir: str | Path, slug: str | None = None) -> Path:
    """OG 카드를 .svg 파일로 저장하고 경로를 반환."""
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    if not slug:
        slug = _slugify(post.get("title", "post"))
    path = out / f"{slug}.svg"
    path.write_text(build_og_svg(post), encoding="utf-8")
    return path


def _slugify(text: str) -> str:
    s = re.sub(r"[^\w가-힣\s-]", "", text).strip().lower()
    s = re.sub(r"\s+", "-", s)[:50]
    digest = hashlib.md5(text.encode("utf-8")).hexdigest()[:6]
    return f"{s or 'post'}-{digest}"
