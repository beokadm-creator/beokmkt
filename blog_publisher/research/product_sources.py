"""
notebook-return(쿠팡 반품 노트북 마켓) 근거 수집.

일반 웹 검색 대신, 이미 크롤된 실제 상품 데이터(Firestore products 컬렉션)를
근거로 사용한다. 가격/등급/재고가 실제 값이므로 grounding 품질이 웹 검색보다 높다.
Firestore/Node 어떤 이유로든 실패해도 다른 브랜드의 생성 흐름을 절대 깨지 않도록
모든 예외를 흡수하고 빈 리스트를 반환한다(research/collect.py의 analyze_serp와 동일한 방어).
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

from research.collect import CollectedSource

ROOT_DIR = Path(__file__).resolve().parents[2]
SCRIPT = Path(__file__).resolve().parents[1] / "tools" / "notebook_return" / "fetch_products.mjs"


def _node_exe() -> str:
    return os.environ.get("NODE_EXE") or shutil.which("node") or str(ROOT_DIR / "bin" / "node.cmd")


def collect_product_sources(topic: str, limit: int = 8) -> list[CollectedSource]:
    try:
        result = subprocess.run(
            [_node_exe(), str(SCRIPT), topic, str(limit)],
            cwd=ROOT_DIR,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=30,
        )
        if result.returncode != 0:
            print(f"[product_sources] fetch_products.mjs 실패(무시): {result.stdout or result.stderr}".strip())
            return []
        data = json.loads(result.stdout)
        if not data.get("ok"):
            return []
    except Exception as e:  # noqa: BLE001
        print(f"[product_sources] 근거 수집 실패(무시): {e}")
        return []

    sources: list[CollectedSource] = []
    for p in data.get("products", []):
        title = str(p.get("title") or "").strip()
        url = str(p.get("affiliateUrl") or "").strip()
        if not title or not url:
            continue
        parts = []
        if p.get("returnGrade"):
            parts.append(f"반품/중고 등급: {p['returnGrade']}")
        if p.get("price") is not None:
            parts.append(f"가격: {p['price']:,}원")
        if p.get("returnMinPrice") is not None:
            parts.append(f"최저 반품가: {p['returnMinPrice']:,}원")
        if p.get("returnCount") is not None:
            parts.append(f"반품 재고: {p['returnCount']}건")
        parts.append(f"로켓배송: {'예' if p.get('isRocket') else '아니오'}")
        sources.append(CollectedSource(
            title=title,
            url=url,
            text=f"{title}. " + ", ".join(parts),
            trust="high",
            thumbnail=str(p.get("thumbnail") or ""),
        ))
    return sources
