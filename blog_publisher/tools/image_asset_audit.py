"""
이미지 자산 도달성 감사.

이미지 뱅크에 들어간 공개 URL을 실제로 요청해 깨진 외부 이미지를
발행 전에 발견한다. 다운로드 저장은 하지 않고 상태만 확인한다.
"""
from __future__ import annotations

from dataclasses import dataclass
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from tools import image_bank


@dataclass
class ImageCheck:
    group: str
    url: str
    alt: str
    ok: bool
    status: int | None
    content_type: str
    bytes_read: int
    error: str


def _catalog() -> list[tuple[str, list[dict]]]:
    return [
        ("hong_solution", image_bank._HONG_SOLUTION),
        ("hong_conference", image_bank._HONG_CONFERENCE),
        ("hong_portfolio", image_bank._HONG_PORTFOLIO),
        ("beok_brand", image_bank._BEOK_BRAND),
        ("beok_conference", image_bank._BEOK_CONFERENCE),
    ]


def _check(group: str, item: dict, timeout: int = 15) -> ImageCheck:
    url = str(item.get("url", ""))
    req = Request(url, headers={"User-Agent": "Mozilla/5.0 image-asset-audit/1.0"})
    try:
        with urlopen(req, timeout=timeout) as res:
            raw = res.read(2048)
            ctype = res.headers.get("content-type", "")
            ok = int(res.status) == 200 and (
                ctype.startswith("image/")
                or url.lower().endswith(".svg")
                or "svg" in ctype
            )
            return ImageCheck(
                group=group,
                url=url,
                alt=str(item.get("alt", "")),
                ok=ok,
                status=int(res.status),
                content_type=ctype,
                bytes_read=len(raw),
                error="" if ok else f"unexpected content-type: {ctype}",
            )
    except HTTPError as e:
        return ImageCheck(group, url, str(item.get("alt", "")), False, int(e.code), "", 0, str(e))
    except (URLError, TimeoutError, OSError) as e:
        return ImageCheck(group, url, str(item.get("alt", "")), False, None, "", 0, str(e))


def run() -> bool:
    checks: list[ImageCheck] = []
    cache: dict[str, ImageCheck] = {}
    for group, items in _catalog():
        for item in items:
            url = str(item.get("url", ""))
            if not url:
                continue
            if url not in cache:
                cache[url] = _check(group, item)
            cached = cache[url]
            checks.append(
                ImageCheck(
                    group=group,
                    url=url,
                    alt=str(item.get("alt", cached.alt)),
                    ok=cached.ok,
                    status=cached.status,
                    content_type=cached.content_type,
                    bytes_read=cached.bytes_read,
                    error=cached.error,
                )
            )

    print("=== 이미지 자산 감사 ===")
    ok_count = 0
    for check in checks:
        mark = "OK" if check.ok else "FAIL"
        if check.ok:
            ok_count += 1
        print(f"[{mark}] {check.group} status={check.status} type={check.content_type or '-'}")
        print(f"      {check.alt}")
        print(f"      {check.url}")
        if check.error:
            print(f"      - {check.error}")

    beoksolution_urls = sorted({c.url for c in checks if "beoksolution.com" in c.url and c.ok})
    beok_conference = [c for c in checks if c.group == "beok_conference"]
    beok_conference_actual = [
        c for c in beok_conference
        if "beoksolution.com" in c.url and c.ok and "logo" not in c.url.lower()
    ]
    print(f"\n결과: {ok_count}/{len(checks)} 통과")
    print(f"beoksolution.com 공개 이미지: {len(beoksolution_urls)}개")
    for url in beoksolution_urls:
        print(f"  - {url}")
    if not beok_conference_actual:
        print(
            "\n[WARN] Phase C 제한: beok_conference 그룹에 beoksolution.com 실제 학회/명찰 현장 이미지가 없습니다. "
            "현재는 beoksolution.com 로고와 hongcomm.kr 공개 시스템 이미지를 대체 사용 중입니다."
        )
    return ok_count == len(checks)


if __name__ == "__main__":
    import sys

    raise SystemExit(0 if run() else 1)
