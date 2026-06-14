"""
셀렉터 점검 도구 (기획 04 §3.4).

저장된 세션으로 글쓰기 화면에 진입해, 어댑터의 SELECTORS가 현재 DOM에서
유효한지 하나씩 확인한다. 네이버/티스토리 DOM이 바뀌면 어디가 깨졌는지 알려준다.

사용:
  python tools/inspect_editor.py naver
  python tools/inspect_editor.py tistory

깨진 셀렉터를 고친 뒤에는 planning/CHANGELOG.md에 기록한다.
"""
from __future__ import annotations

import sys
from pathlib import Path

import config

ROOT = Path(__file__).resolve().parent.parent


def _load(channel: str):
    if channel == "naver":
        from publishers.naver import SELECTORS, STATE_PATH
        url = SELECTORS["write_url"].format(blog_id=config.NAVER_BLOG_ID)
        check_keys = ["title", "body", "publish_open", "publish_confirm"]
        iframe = SELECTORS.get("editor_iframe")
    else:
        from publishers.tistory import SELECTORS, STATE_PATH
        url = SELECTORS["write_url"].format(blog=config.TISTORY_BLOG)
        check_keys = ["title", "publish_open", "publish_confirm"]
        iframe = None
    return SELECTORS, STATE_PATH, url, check_keys, iframe


def main() -> None:
    if len(sys.argv) < 2 or sys.argv[1] not in ("naver", "tistory"):
        print("사용: python tools/inspect_editor.py [naver|tistory]")
        sys.exit(1)

    channel = sys.argv[1]
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("playwright 미설치: pip install playwright && playwright install chromium")
        sys.exit(1)

    selectors, state_path, url, check_keys, iframe = _load(channel)
    if not Path(state_path).exists():
        print(f"세션 없음: {state_path} — 먼저 python tools/login.py {channel}")
        sys.exit(1)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False)
        ctx = browser.new_context(storage_state=str(state_path), locale="ko-KR")
        page = ctx.new_page()
        page.goto(url, timeout=30000)
        scope = page.frame_locator(iframe) if iframe else page

        print(f"\n[{channel}] 셀렉터 점검 결과:")
        for key in check_keys:
            sel = selectors[key]
            try:
                count = scope.locator(sel).count()
                mark = "OK " if count > 0 else "없음"
                print(f"  [{mark}] {key}: {sel}  (matches={count})")
            except Exception as e:  # noqa: BLE001
                print(f"  [에러] {key}: {sel}  ({e})")

        input("\n확인 후 Enter로 종료... ")
        ctx.close()
        browser.close()


if __name__ == "__main__":
    main()
