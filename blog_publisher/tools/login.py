"""
세션 저장 도구 (기획 04 §3.5).

네이버/티스토리는 공식 API가 없어 Playwright로 로그인 세션을 재사용한다.
이 스크립트는 브라우저를 띄워 사용자가 '직접' 로그인하게 하고,
로그인 완료 후 storage_state를 저장한다(이후 발행 어댑터가 이 세션을 로드).

사용:
  python tools/login.py naver
  python tools/login.py tistory

주의: headless=False로 실제 창이 떠야 한다. 2차 인증/캡차는 사람이 처리.
세션은 시간이 지나면 만료되므로, 발행이 로그인 화면으로 튕기면 재실행한다.
"""
from __future__ import annotations

import sys
from pathlib import Path

PUBLISHERS_DIR = Path(__file__).resolve().parent.parent / "publishers"

LOGIN_URLS = {
    "naver": "https://nid.naver.com/nidlogin.login",
    "tistory": "https://www.tistory.com/auth/login",
}
STATE_FILES = {
    "naver": PUBLISHERS_DIR / "naver_state.json",
    "tistory": PUBLISHERS_DIR / "tistory_state.json",
}


def main() -> None:
    if len(sys.argv) < 2 or sys.argv[1] not in LOGIN_URLS:
        print("사용: python tools/login.py [naver|tistory]")
        sys.exit(1)

    channel = sys.argv[1]
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("playwright 미설치: pip install playwright && playwright install chromium")
        sys.exit(1)

    state_path = STATE_FILES[channel]
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False)
        ctx = browser.new_context(locale="ko-KR")
        page = ctx.new_page()
        page.goto(LOGIN_URLS[channel])

        print(f"\n[{channel}] 브라우저에서 직접 로그인하세요.")
        input("로그인을 마쳤으면 이 터미널에서 Enter를 누르세요... ")

        ctx.storage_state(path=str(state_path))
        print(f"세션 저장 완료: {state_path}")
        ctx.close()
        browser.close()


if __name__ == "__main__":
    main()
