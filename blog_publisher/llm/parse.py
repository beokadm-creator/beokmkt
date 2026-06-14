"""
견고한 JSON 파싱 계층 (기획 12).

자동 파이프라인이 가장 자주 깨지는 지점이 LLM의 구조화 출력 파싱이다.
코드펜스/설명문/트레일링 콤마/스마트따옴표 등 흔한 오염을 흡수하고,
실패 시 1회 자동 복구 재시도를 한다.
"""
from __future__ import annotations

import json
import re


def extract_json(raw: str) -> dict | list:
    """오염된 LLM 응답에서 JSON 객체/배열을 안전하게 추출."""
    if not raw or not raw.strip():
        raise ValueError("빈 응답")

    s = raw.strip()
    # 1) 코드펜스 제거
    s = re.sub(r"^```[a-zA-Z]*\s*", "", s)
    s = re.sub(r"\s*```$", "", s).strip()

    # 2) 첫 '{' 또는 '[' 부터 괄호 균형 스캔
    starts = [i for i in (s.find("{"), s.find("[")) if i != -1]
    if not starts:
        raise ValueError(f"JSON 시작 기호 없음: {s[:120]}")
    start = min(starts)
    opening = s[start]
    closing = "}" if opening == "{" else "]"

    depth = 0
    end = -1
    in_str = False
    esc = False
    for i in range(start, len(s)):
        c = s[i]
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
        else:
            if c == '"':
                in_str = True
            elif c == opening:
                depth += 1
            elif c == closing:
                depth -= 1
                if depth == 0:
                    end = i
                    break
    if end == -1:
        raise ValueError(f"JSON 괄호가 닫히지 않음: {s[:120]}")

    frag = s[start:end + 1]
    try:
        return json.loads(frag)
    except json.JSONDecodeError:
        # 3) 흔한 오염 정규화 후 재시도
        cleaned = re.sub(r",(\s*[}\]])", r"\1", frag)          # 트레일링 콤마
        cleaned = (cleaned.replace("“", '"').replace("”", '"')
                          .replace("‘", "'").replace("’", "'"))
        return json.loads(cleaned)


def chat_json(llm, system: str, user: str, *, retries: int = 1, **kw) -> dict | list:
    """LLM 호출 + 견고 파싱. 실패 시 'JSON만 출력' 지시를 덧붙여 재시도."""
    last: Exception | None = None
    cur_user = user
    for _ in range(retries + 1):
        raw = llm.chat(system, cur_user, **kw)
        try:
            return extract_json(raw)
        except (ValueError, json.JSONDecodeError) as e:
            last = e
            cur_user = user + "\n\n[중요] 반드시 유효한 JSON 하나만 출력하라. 코드펜스/설명/앞뒤 텍스트 금지."
    raise ValueError(f"JSON 파싱 실패(재시도 후): {last}")
