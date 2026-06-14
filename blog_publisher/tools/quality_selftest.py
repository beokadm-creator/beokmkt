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


def _test_channel_rewriter_gate() -> list[str]:
    good_html = """
<p>핵심 요약: 학회 운영 사무국은 명찰 출력 전 데이터 기준, 출력 순서, 현장 재발행 기준을 함께 확인해야 합니다.</p>
<ul>
  <li><strong>명단 기준 파일</strong>을 하나로 고정합니다.</li>
  <li><strong>QR 코드</strong> 스캔 정상 여부를 샘플로 확인합니다.</li>
  <li><strong>재발행 로그</strong>를 남겨 중복 출력을 막습니다.</li>
  <li><strong>소모품 수량</strong>을 접수 시작 전 다시 확인합니다.</li>
</ul>
<h2>무엇을 먼저 확인해야 하나</h2>
<p>사무국은 이름, 소속, 직함, 등록 구분, 식별 코드를 같은 기준으로 정리해야 합니다. 파일이 여러 개로 갈라지면 현장에서는 어느 항목이 최종인지 판단하기 어렵습니다.</p>
<h2>왜 출력 전 샘플이 필요한가</h2>
<table><tbody><tr><th>점검 항목</th><th>확인 기준</th></tr><tr><td>이름</td><td>오탈자와 띄어쓰기 확인</td></tr><tr><td>코드</td><td>스캔 후 참가자 정보 연결 확인</td></tr></tbody></table>
<p>샘플 출력은 전체 출력 전에 줄바꿈, 여백, 절단선, 케이스 삽입 상태를 확인하는 과정입니다.</p>
<h2>어떻게 현장 재발행을 관리하나</h2>
<blockquote>현장 재발행은 빠른 처리보다 같은 기준을 유지하는 것이 중요합니다.</blockquote>
<p>재발행 요청이 들어오면 수정 사유, 승인 담당자, 출력 시간을 남겨야 합니다. 이 기록은 행사 후 미수령자와 당일 등록자를 정리하는 근거가 됩니다.</p>
<h2>상담 전 체크리스트</h2>
<p>비오케이솔루션은 학회 운영 사무국의 명찰 출력, 참가자 데이터 정리, 현장 재발행 기준을 함께 점검합니다. 운영 상담이 필요하면 행사 규모와 출력 방식부터 문의해 주세요.</p>
<p>상담 전에는 참가자 수, 등록 구분, 현장 등록 가능 여부, 명찰 크기, 출력 장비, QR 또는 바코드 사용 여부를 정리해 두면 좋습니다. 이 정보가 있어야 출력 템플릿과 접수 동선을 함께 검토할 수 있습니다.</p>
<p>특히 학회 행사는 발표자, 좌장, 초청자, 운영진처럼 서로 다른 표기가 필요한 그룹이 많습니다. 사무국이 그룹별 표기 규칙을 먼저 정해 두면 명찰 발행 직전의 수정 요청을 줄일 수 있습니다.</p>
<p>비오케이솔루션은 명찰 출력만 따로 보지 않고 참가자 데이터, 접수 확인, 재발행 승인, 행사 후 정산 자료까지 연결된 흐름으로 점검합니다. 이 기준을 갖추면 현장 접수대의 응대 속도와 참가자 경험이 함께 안정됩니다.</p>
"""
    thin_html = "<p>핵심 요약: 명찰을 출력합니다. 상담 문의 주세요.</p><h2>안내</h2><p>짧은 글입니다.</p>"
    hanzi_html = good_html.replace("명찰 출력", "名札 출력", 1)
    hype_html = good_html.replace("운영 상담이 필요하면", "운영 꿀팁이 필요하면", 1)
    semantic_risk_html = good_html.replace(
        "사무국은 이름, 소속, 직함, 등록 구분, 식별 코드를 같은 기준으로 정리해야 합니다.",
        "핵심은 단순히 명찰 출력 기능에 있습니다.",
        1,
    )

    script = f"""
import {{ validateTistoryRewrite }} from './channel-rewriter.mjs'
const cases = [
  ['good', {good_html!r}, true],
  ['thin', {thin_html!r}, false],
  ['hanzi', {hanzi_html!r}, false],
  ['hype', {hype_html!r}, false],
  ['semantic-risk', {semantic_risk_html!r}, false],
]
const failures = []
for (const [name, html, expected] of cases) {{
  const result = validateTistoryRewrite(html, 900)
  if (result.ok !== expected) {{
    failures.push(`${{name}} expected ${{expected}} got ${{result.ok}}: ${{result.reasons.join(', ')}}`)
  }}
}}
console.log(JSON.stringify({{ ok: failures.length === 0, failures }}))
process.exit(failures.length ? 1 : 0)
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
    return [f"rewriter: tistory quality gate selftest failed\n{output}"]


def run() -> bool:
    issues = _test_selfhosted_renderer() + _test_tistory_adapter() + _test_channel_rewriter_gate()
    print("=== Phase B 품질 셀프테스트 ===")
    if issues:
        for issue in issues:
            print(f"[FAIL] {issue}")
        print(f"\n결과: FAIL ({len(issues)}건)")
        return False
    print("[OK] selfhosted renderer: summary/toc/cta/table/image/callout 유지")
    print("[OK] tistory adapter: h2/list/table/callout/image/strong/CTA 유지")
    print("[OK] channel rewriter: 티스토리 얇은 글/한자/금칙톤/의미위험 차단")
    print("\n결과: PASS")
    return True


if __name__ == "__main__":
    import sys

    raise SystemExit(0 if run() else 1)
