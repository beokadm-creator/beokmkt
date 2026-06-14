"""
Phase B 품질 셀프테스트.

외부 발행이나 LLM 호출 없이, 실제 렌더러/티스토리 어댑터를 실행해
리치 HTML 구성요소가 사라지지 않는지 확인한다.
"""
from __future__ import annotations

import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
WORKER_DIR = ROOT / "executors" / "naver-blog-worker"


SAMPLE_MD = """학회 운영 사무국의 명찰 출력은 참가자 응대 품질과 바로 연결됩니다.

![학회 명찰 출력 체크리스트](https://beokmkt.web.app/assets/blog/beok/checklist-card.svg)

## 핵심 요약

- **명단 확정**은 출력 전 마지막 기준 파일 하나로 관리합니다.
- **출력 검수**는 건수, 표기, 코드, 샘플 순서로 반복합니다.
- **현장 재발행**은 승인 기준과 출력 로그를 함께 둡니다.

## 명단 확정 기준

사무국은 이름, 소속, 직함, 등록 구분, 식별 코드, 수령 여부를 같은 형식으로 정리해야 합니다.
이 단계에서 중요한 것은 담당자마다 다른 파일을 보지 않도록 기준 파일을 하나로 고정하는 일입니다.
행사 전날에는 추가 등록자와 취소자가 함께 들어오므로, 원본 명단과 출력 명단을 따로 관리하면 현장에서 재발행 요청이 늘어납니다.
따라서 최종 출력 전에는 파일명, 수정 시각, 담당자, 반영 범위를 기록하고 같은 기준으로 샘플을 확인해야 합니다.

| 점검 항목 | 확인 기준 | 담당 |
| --- | --- | --- |
| 전체 건수 | 등록 완료자 수와 출력 수 일치 | 사무국 |
| 코드 검수 | QR 또는 바코드 스캔 정상 | 운영 담당 |

## 출력 전 확인 순서

1. 최종 명단 파일을 고정합니다.
2. 필수 컬럼 누락을 확인합니다.
3. 긴 소속명의 줄바꿈을 샘플 출력으로 확인합니다.
4. 여분 용지와 케이스 수량을 점검합니다.

출력 검수는 빠르게 훑는 방식보다 같은 순서를 반복하는 방식이 안정적입니다.
전체 건수가 맞더라도 이름 표기, 소속 약칭, 직함 줄바꿈, 코드 스캔 값이 어긋나면 현장 접수대에서 바로 문의로 이어집니다.
운영 담당자는 실제 프린터로 몇 장을 먼저 뽑아 색상, 여백, 절단선, 케이스 삽입 상태를 확인하고 나서 전체 출력에 들어가는 편이 좋습니다.

> 현장 재발행은 빠른 처리보다 같은 기준을 유지하는 것이 중요합니다.

## 현장 운영과 상담

비오케이솔루션은 학회 운영 사무국의 명찰 출력, 현장 재발행, 참가자 데이터 정리 흐름을 함께 점검합니다. 명찰 운영 상담이 필요하면 행사 전 데이터 구조부터 확인해 주세요.
현장 재발행 창구에는 노트북, 프린터, 여분 용지, 케이스, 목걸이 줄을 함께 배치하고 승인 담당자와 출력 담당자를 구분하는 것이 좋습니다.
재발행 사유와 출력 시간을 남기면 행사 후 미수령 명단, 당일 등록자, 변경 요청을 정리할 때도 기준이 분명해집니다.
이 기록은 다음 학회 운영에서 접수 인력 배치와 명찰 제작 수량을 조정하는 근거가 됩니다.
"""


def _assert_contains(name: str, html: str, required: list[str]) -> list[str]:
    return [f"{name}: {token} 누락" for token in required if token not in html]


def _test_selfhosted_renderer() -> list[str]:
    from render.renderer import render_body

    html = render_body({
        "title": "학회 운영 사무국 명찰 출력 품질 셀프테스트",
        "body": SAMPLE_MD,
        "meta_desc": "학회 운영 사무국 명찰 출력 품질 셀프테스트입니다.",
        "tags": ["학회 운영", "명찰 출력"],
        "category": "beok",
        "topic": "학회 운영 사무국 명찰 출력",
        "locale": "ko",
    })
    issues: list[str] = []
    issues += _assert_contains(
        "selfhosted",
        html,
        ["summary-card", 'class="toc"', "soft-cta", "table-wrap", "<img ", "content-callout"],
    )
    if "<article" in html or "<h1" in html:
        issues.append("selfhosted: 저장 fragment에 article/h1 포함")
    if "[이미지:" in html:
        issues.append("selfhosted: 이미지 텍스트 마커 노출")
    return issues


def _test_tistory_adapter() -> list[str]:
    script = f"""
import {{ convertForTistory, validateTistoryHtml }} from './tistory-html-adapter.mjs'
const source = {SAMPLE_MD!r}
const html = await convertForTistory(source)
const quality = validateTistoryHtml(html)
const issues = []
if (!quality.ok) issues.push(...quality.reasons)
for (const token of ['<h2', '<ul', '<ol', '<table', '<blockquote', '<img ', '<strong']) {{
  if (!html.includes(token)) issues.push(`티스토리: ${{token}} 누락`)
}}
if (html.includes('[이미지:')) issues.push('티스토리: 이미지 텍스트 마커 노출')
if (!/상담|문의|운영\\s*상담/.test(html)) issues.push('티스토리: 상담 CTA 누락')
console.log(JSON.stringify({{ ok: issues.length === 0, issues, quality: quality.quality }}))
process.exit(issues.length ? 1 : 0)
"""
    proc = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd=WORKER_DIR,
        text=True,
        capture_output=True,
        timeout=30,
        check=False,
    )
    if proc.returncode == 0:
        return []
    output = "\n".join(part for part in [proc.stdout.strip(), proc.stderr.strip()] if part)
    return [f"tistory: adapter quality selftest failed\n{output}"]


def run() -> bool:
    issues = _test_selfhosted_renderer() + _test_tistory_adapter()
    print("=== Phase B 품질 셀프테스트 ===")
    if issues:
        for issue in issues:
            print(f"[FAIL] {issue}")
        print(f"\n결과: FAIL ({len(issues)}건)")
        return False
    print("[OK] selfhosted renderer: summary/toc/cta/table/image/callout 유지")
    print("[OK] tistory adapter: h2/list/table/callout/image/strong/CTA 유지")
    print("\n결과: PASS")
    return True


if __name__ == "__main__":
    import sys

    raise SystemExit(0 if run() else 1)
