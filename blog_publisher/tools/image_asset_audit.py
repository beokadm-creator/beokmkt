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
    seen: set[str] = set()
    for group, items in _catalog():
        for item in items:
            url = str(item.get("url", ""))
            if not url or url in seen:
                continue
            seen.add(url)
            checks.append(_check(group, item))

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

    beoksolution_urls = [c.url for c in checks if "beoksolution.com" in c.url and c.ok]
    print(f"\n결과: {ok_count}/{len(checks)} 통과")
    print(f"beoksolution.com 공개 이미지: {len(beoksolution_urls)}개")
    for url in beoksolution_urls:
        print(f"  - {url}")
    return ok_count == len(checks)


if __name__ == "__main__":
    import sys

    raise SystemExit(0 if run() else 1)
