"""
LLM 클라이언트 래퍼 (GLM 계열 기준, OpenAI 호환 엔드포인트 가정).

핵심 설계
- 단계별로 모델/thinking/토큰을 다르게 쓴다.
    * 개요(outline): 짧은 출력 + 추론 ON 이 유리
    * 본문(section): thinking ON + 섹션당 1500토큰  -> 깊이·구조 품질 우선
- 모델 등급은 config에서만 바꾼다. 코드 곳곳에 모델명을 박지 않는다.
- 호출 실패는 재시도(여기서는 단순 백오프). 워커 레벨 재시도와 별개.
"""
from __future__ import annotations

import time

import config

try:
    from openai import OpenAI  # GLM도 OpenAI 호환 SDK로 호출 가능
except ImportError:  # SDK 미설치 환경에서도 import 에러로 죽지 않게
    OpenAI = None


class LLMClient:
    def __init__(self):
        if OpenAI is None:
            raise RuntimeError("openai 패키지가 필요합니다: pip install openai")
        self.client = OpenAI(api_key=config.LLM_API_KEY, base_url=config.LLM_BASE_URL)

    def chat(
        self,
        system: str,
        user: str,
        *,
        model: str,
        max_tokens: int = 2048,
        temperature: float = 0.7,
        thinking: bool = False,
        retries: int = 3,
    ) -> str:
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ]
        # GLM thinking 토글: 모델/엔드포인트에 따라 파라미터명이 다를 수 있어 extra_body로 전달.
        extra_body = {"thinking": {"type": "enabled" if thinking else "disabled"}}

        last_err: Exception | None = None
        for attempt in range(retries):
            try:
                resp = self.client.chat.completions.create(
                    model=model,
                    messages=messages,
                    max_tokens=max_tokens,
                    temperature=temperature,
                    extra_body=extra_body,
                    timeout=config.LLM_TIMEOUT_SEC,
                )
                content = (resp.choices[0].message.content or "").strip()
                if not content:
                    raise RuntimeError("빈 응답(thinking 토큰 과소비 의심 — 재시도)")
                return content
            except Exception as e:  # noqa: BLE001
                last_err = e
                if attempt < retries - 1:
                    time.sleep(min(4 ** attempt, 30))
        raise RuntimeError(f"LLM 호출 실패({retries}회): {last_err}")
