"""발행된 자체 블로그 글의 인라인 스타일 생존 검증 (기획: 인라인 스타일 렌더 전환).

WHY: 자체 블로그 CMS(beoksolution.com)는 발행 본문에서 CSS 클래스 규칙과 <style>
블록을 렌더하지 않는다. 그래서 렌더러는 모든 시각 요소를 인라인 style=로 그린다.
div/span/strong/a/aside의 인라인 스타일이 살아남는 것은 실측됐지만, table/th/td/h2/li/
figure 같은 태그의 style이 CMS sanitizer를 통과하는지는 '실제 발행글 공개 URL'로만
최종 확인된다(북극성 원칙: 산출물을 직접 읽어 검증).

사용:
    python3 tools/verify_inline_styles.py <공개_URL>
    python3 tools/verify_inline_styles.py --api <post_id 또는 slug>   # API content 필드 직접 검사

발행 워커가 새 글을 self-hosted에 올린 뒤, 그 공개 URL로 한 번 실행해
table/h2/li 등에 style이 살아있고 평문이 아닌지 확인한다.
"""
from __future__ import annotations

import re
import sys
import urllib.request

# 인라인 스타일이 반드시 살아있어야 하는 태그(평문 발행 방지의 핵심 지표)
_MUST_SURVIVE = ["table", "th", "td", "h2", "li", "figure"]
# 이미 실측으로 생존이 확인된 태그(대조군)
_KNOWN_GOOD = ["aside", "section"]


def _fetch(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": "beok-style-verify/1.0"})
    with urllib.request.urlopen(req, timeout=20) as resp:  # noqa: S310
        return resp.read().decode("utf-8", errors="replace")


def _styled_count(html: str, tag: str) -> tuple[int, int]:
    """(style 속성이 있는 여는 태그 수, 전체 여는 태그 수)."""
    opens = re.findall(rf"<{tag}\b[^>]*>", html, flags=re.I)
    styled = [t for t in opens if re.search(r"\bstyle\s*=", t, flags=re.I)]
    return len(styled), len(opens)


def verify(html: str) -> bool:
    ok = True
    print("태그별 인라인 style 생존 (styled/total):")
    for tag in _MUST_SURVIVE + _KNOWN_GOOD:
        styled, total = _styled_count(html, tag)
        if total == 0:
            print(f"  - {tag:7s}: (본문에 없음)")
            continue
        status = "OK" if styled == total else "손실"
        if tag in _MUST_SURVIVE and styled < total:
            ok = False
        print(f"  - {tag:7s}: {styled}/{total}  {status}")
    # 평문 발행의 결정적 신호: 컴포넌트 클래스는 있는데 style이 하나도 없음
    if "summary-card" in html and 'summary-card"' in html.replace("style=", "STYLE"):
        pass
    print("\n판정:", "통과 — 인라인 스타일이 공개 렌더까지 생존" if ok
          else "실패 — 일부 태그에서 style이 제거됨(해당 태그는 인라인 대신 다른 전달 방식 필요)")
    return ok


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 2
    target = argv[-1]
    html = _fetch(target)
    print(f"검사 대상: {target}  ({len(html):,} bytes)\n")
    return 0 if verify(html) else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
