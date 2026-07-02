"""
생성 워커 — 근거기반 콘텐츠 엔진 (기획 05·06).

상상 생성이 아니라 '수집된 근거의 합성'이다.
  ① 의도/키워드 도출 → ② 자료 수집 → ③ 근거팩 →
  ④ 근거기반 개요(유형 템플릿) → ⑤ 근거기반 섹션 작성 → 통합
사실검증(⑥)은 별도 워커(pipeline/factcheck.py)가 이어받는다.
"""
from __future__ import annotations

import multiprocessing as mp
import os
from contextlib import contextmanager
from pathlib import Path

import config
from db import db
from llm import prompts
from llm.client import LLMClient
from llm.parse import chat_json
from pipeline import seo
from research import collect, evidence as ev
from utils.notify import notify

if os.name == "nt":
    import msvcrt
else:
    import fcntl


# CJK 한자(漢字) 범위. 한국어 블로그 본문엔 사실상 0개여야 한다.
# glm 계열 모델이 한국어 단어를 중국어 글자로 바꿔치기하는 결함을 잡는다.
import re as _re

_HANZI_RE = _re.compile(r"[一-鿿㐀-䶿]")
_RUN_META_RE = _re.compile(
    r"\s*[\(\[][^)\]]*(?:실제\s*발행\s*검증|실발행\s*검증|검증\s*\d{4}[-_]\d{4}|\d{4}[-_]\d{4}\s*검증)[^)\]]*[\)\]]\s*"
)
_RUN_DATE_TAG_RE = _re.compile(r"(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])(?:[-_][0-9A-Za-z가-힣]+)?")
_RUN_META_INLINE_RE = _re.compile(
    r"(?:네이버|티스토리|자체|selfhosted|naver|tistory)?\s*"
    r"(?:(?:실제|신규)\s*)?(?:발행\s*)?(?:품질\s*)?검증\s*"
    r"(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])(?:[-_][0-9A-Za-z가-힣]+)?",
    _re.IGNORECASE,
)
_RUN_META_PHRASE_RE = _re.compile(
    r"(?:네이버|티스토리|자체|selfhosted|naver|tistory)?\s*"
    r"(?:(?:실제|신규)\s*)?(?:발행\s*)?(?:품질\s*)?검증",
    _re.IGNORECASE,
)


def _lock_path() -> Path:
    return db.DB_PATH.with_name("generate.lock")


def _try_lock(fh) -> bool:
    if os.name == "nt":
        try:
            msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
            return True
        except OSError:
            return False
    try:
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        return True
    except BlockingIOError:
        return False


def _unlock(fh) -> None:
    if os.name == "nt":
        fh.seek(0)
        msvcrt.locking(fh.fileno(), msvcrt.LK_UNLCK, 1)
    else:
        fcntl.flock(fh.fileno(), fcntl.LOCK_UN)


@contextmanager
def _generate_lock():
    """cron 겹침으로 동일 재고를 여러 생성 워커가 잡는 것을 막는다."""
    lock_path = _lock_path()
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("w") as fh:
        if not _try_lock(fh):
            yield False
            return
        try:
            yield True
        finally:
            _unlock(fh)


def _generate_one_child(post: dict, result_queue: mp.Queue) -> None:
    """글 1건 생성 자식 프로세스. 부모가 하드 타임아웃으로 종료할 수 있다."""
    try:
        _generate_one(LLMClient(), post)
        result_queue.put(("ok", ""))
    except Exception as e:  # noqa: BLE001
        result_queue.put(("error", str(e)))


def _generate_one_with_timeout(post: dict) -> None:
    """SDK/SSL 레벨 timeout이 멈춰도 글 1건을 무한 점유하지 않게 한다."""
    if not config.GENERATE_PROCESS_ISOLATION:
        _generate_one(LLMClient(), post)
        return

    seconds = max(1, int(config.GENERATE_POST_TIMEOUT_SEC))
    ctx = mp.get_context("spawn")
    queue: mp.Queue = ctx.Queue(maxsize=1)
    proc = ctx.Process(target=_generate_one_child, args=(post, queue))
    proc.start()
    proc.join(seconds)
    if proc.is_alive():
        proc.terminate()
        proc.join(5)
        if proc.is_alive():
            proc.kill()
            proc.join(5)
        raise TimeoutError(f"id={post['id']} 생성 하드 타임아웃({seconds}s)")
    if proc.exitcode not in (0, None):
        raise RuntimeError(f"id={post['id']} 생성 자식 프로세스 종료 코드 {proc.exitcode}")
    try:
        status, message = queue.get_nowait()
    except Exception as e:  # noqa: BLE001
        raise RuntimeError(f"id={post['id']} 생성 결과 수신 실패: {e}") from e
    if status != "ok":
        raise RuntimeError(message)


def _count_hanzi(text: str) -> int:
    return len(_HANZI_RE.findall(text or ""))


def _strip_hanzi(text: str) -> str:
    """한자와, 한자만 들어있던 괄호 잔여물을 정리."""
    if not text:
        return text
    out = _HANZI_RE.sub("", text)
    out = _re.sub(r"\(\s*\)", "", out)      # 빈 괄호 제거
    out = _re.sub(r"[ \t]{2,}", " ", out)
    return out


def _strip_run_meta_text(text: str) -> str:
    """운영 run tag/검증 메타가 공개 산출물 소재로 새는 것을 막는다."""
    source = text or ""
    protected: list[str] = []

    def protect(match: _re.Match) -> str:
        protected.append(match.group(0))
        return f"@@BEOK_IMAGE_{len(protected) - 1}@@"

    source = _re.sub(r"!\[[^\]]*]\([^)\s]+\)", protect, source)
    source = _re.sub(r"<img\b[^>]*>", protect, source, flags=_re.I)

    cleaned = _RUN_META_RE.sub(" ", source)
    cleaned = _RUN_META_INLINE_RE.sub(" ", cleaned)
    cleaned = _RUN_DATE_TAG_RE.sub(" ", cleaned)
    cleaned = _RUN_META_PHRASE_RE.sub(" ", cleaned)
    cleaned = _re.sub(r"[ \t]{2,}", " ", cleaned)
    cleaned = _re.sub(r"\n[ \t]+", "\n", cleaned)
    cleaned = _re.sub(r"[ \t]+\n", "\n", cleaned)
    cleaned = _re.sub(r"\n{3,}", "\n\n", cleaned).strip()
    cleaned = _re.sub(r"\s+([,.!?])", r"\1", cleaned)
    for idx, image_markup in enumerate(protected):
        cleaned = cleaned.replace(f"@@BEOK_IMAGE_{idx}@@", image_markup)
    cleaned = _re.sub(r"(?m)^(## [^\n!]+)!\[", r"\1\n\n![", cleaned)
    cleaned = _re.sub(r"(?m)^([^\n]*\S)(!\[[^\]]*]\([^)\s]+\))", r"\1\n\n\2", cleaned)
    cleaned = _re.sub(r"(?m)(!\[[^\]]*]\([^)\s]+\))([^\n])", r"\1\n\n\2", cleaned)
    return cleaned or (text or "").strip()


def _content_topic(topic: str) -> str:
    """운영 run tag/검증 메타가 LLM 본문 소재로 새는 것을 막는다."""
    return _strip_run_meta_text(topic)


def _channel_rules(engine: str) -> str:
    if engine == "naver":
        return (
            "- 네이버 자동 발행용이다. 이미지, 마크다운 이미지, HTML 표, 마크다운 표를 절대 쓰지 마라.\n"
            "- 비교·체크리스트는 불릿 목록이나 번호 목록으로 풀어쓴다.\n"
            "- `| 항목 | 기준 |` 같은 표 문법을 한 줄도 출력하지 마라."
        )
    return "- 리치 HTML 보존 채널이다. 필요하면 이미지, 표, 목록, 인용을 자연스럽게 활용한다."


def _section_max_tokens() -> int:
    return min(config.MAX_TOKENS_SECTION, config.SECTION_TOKEN_CAP)


def _markdown_table_to_list(block: str) -> str:
    lines = [line.strip() for line in block.splitlines() if line.strip()]
    rows = [line.strip("|").split("|") for line in lines if "|" in line]
    rows = [[cell.strip() for cell in row] for row in rows]
    rows = [row for row in rows if not all(_re.fullmatch(r":?-{3,}:?", cell or "") for cell in row)]
    if len(rows) < 2:
        return ""
    header, data_rows = rows[0], rows[1:]
    items = []
    for row in data_rows:
        pairs = []
        for idx, cell in enumerate(row):
            key = header[idx] if idx < len(header) and header[idx] else f"항목 {idx + 1}"
            pairs.append(f"{key}: {cell}")
        if pairs:
            items.append("- " + " / ".join(pairs))
    return "\n".join(items)


def _sanitize_naver_body(body: str) -> str:
    """네이버 자동 발행이 보존하지 못하는 리치 마크다운을 발행 가능한 구조로 낮춘다."""
    text = _re.sub(r"!\[[^\]]*\]\([^)\s]+\)\s*", "", body or "")
    blocks = text.split("\n\n")
    out: list[str] = []
    for block in blocks:
        lines = block.splitlines()
        table_like = lines and sum(1 for line in lines if "|" in line) >= 2
        if table_like and any(_re.search(r"\|\s*:?-{3,}:?\s*\|", line) for line in lines):
            converted = _markdown_table_to_list(block)
            if converted:
                out.append(converted)
            continue
        out.append(block)
    text = "\n\n".join(out)
    text = _re.sub(r"\n{3,}", "\n\n", text).strip()
    return text


def _compact_section_body(body: str) -> str:
    """모델이 과하게 길게 쓴 섹션을 문단 단위로 줄인다."""
    max_len = int(getattr(config, "SECTION_MAX_LEN", 0) or 0)
    text = (body or "").strip()
    if max_len <= 0 or len(text) <= max_len:
        return text

    blocks = [block.strip() for block in _re.split(r"\n{2,}", text) if block.strip()]
    kept: list[str] = []
    total = 0
    has_list = False
    has_table = False
    for block in blocks:
        block_len = len(block) + (2 if kept else 0)
        block_has_list = bool(_re.search(r"(^|\n)\s*(?:[-*]\s+|\d+\.\s+)", block))
        block_has_table = "|" in block and "\n" in block
        must_keep = not kept or (block_has_list and not has_list) or (block_has_table and not has_table)
        if not must_keep and total + block_len > max_len:
            break
        kept.append(block)
        total += block_len
        has_list = has_list or block_has_list
        has_table = has_table or block_has_table
        if total >= max_len * 0.85 and has_list:
            break
    compacted = "\n\n".join(kept).strip()
    if compacted and len(compacted) <= max_len:
        return compacted
    source = compacted or text
    sentences = _re.findall(r".+?(?:[.!?。]|다\.|요\.|니다\.|$)", source, flags=_re.S)
    out: list[str] = []
    total = 0
    for sentence in sentences:
        sentence = sentence.strip()
        if not sentence:
            continue
        extra = len(sentence) + (1 if out else 0)
        if out and total + extra > max_len:
            break
        if not out and len(sentence) > max_len:
            return sentence[:max_len].rstrip()
        out.append(sentence)
        total += extra
    return " ".join(out).strip() or source[:max_len].rstrip()


def _log_stage(topic: str, stage: str) -> None:
    print(f"[generate] topic={topic!r} 단계={stage}", flush=True)


def _facts_summary(evidence: dict, limit: int = 40) -> str:
    """개요 입력용 사실 요약(출처 표기)."""
    lines = []
    for f in evidence.get("facts", [])[:limit]:
        lines.append(f"- {f['statement']} (출처: {f['source_title']})")
    return "\n".join(lines) or "(수집된 사실 없음)"


def _evidence_for_section(evidence: dict, h2: str, point: str, limit: int = 12) -> str:
    """
    섹션에 줄 근거. 단순화를 위해 전체 facts를 제공하되,
    섹션 키워드와 겹치는 것을 앞으로 정렬(후속: 임베딩 기반 선별).
    """
    facts = evidence.get("facts", [])
    key = (h2 + " " + point)

    def score(f: dict) -> int:
        return sum(1 for w in key.split() if w and w in f.get("statement", ""))

    ranked = sorted(facts, key=score, reverse=True)[:limit]
    return "\n".join(
        f"- {f['statement']} (출처: {f['source_title']})" for f in ranked
    ) or "(이 섹션에 직접 대응하는 근거 부족)"


def _brand_hint(brand_key: str) -> str:
    """category에 브랜드 키가 있으면 개요 프롬프트에 붙일 힌트를 반환."""
    if not brand_key:
        return ""
    try:
        from tools.keyword_bank import BRANDS
        b = BRANDS.get(brand_key)
        if not b:
            return ""
        return prompts.OUTLINE_BRAND_HINT.format(
            brand_name=b["name"],
            brand_url=b["url"],
            service_summary=b.get("service_summary", ""),
            contact=b.get("contact", ""),
        )
    except Exception:  # noqa: BLE001
        return ""


def _image_brand_key(brand_key: str, topic: str, body_text: str) -> str:
    """운영 글 이미지 풀을 고른다. category가 축 이름이어도 운영 글이면 이미지를 넣는다."""
    if brand_key == "notebook_return":
        return "notebook_return"  # 정적 image_bank 대신 실제 상품 썸네일 사용(호출부에서 분기)
    if brand_key in {"hong", "beok"}:
        return brand_key
    key = (brand_key or "").lower()
    if key in {"conference", "event_ops", "mice", "event", "academic"}:
        return "hong"
    if key in {"company", "web", "website", "systems", "system", "solution"}:
        return "beok"
    text = f"{brand_key} {topic} {body_text}"
    hong_terms = ("홍커뮤니케이션", "hongcomm", "MICE", "학회", "학술대회", "국제회의", "컨퍼런스", "행사", "명찰", "사무국", "접수", "등록", "체크인", "레퍼런스", "포트폴리오")
    beok_terms = ("비오케이", "홈페이지", "제작", "개발", "예약", "결제", "관리자", "자동화")
    if any(term in text for term in hong_terms):
        return "hong"
    if any(term in text for term in beok_terms):
        return "beok"
    operational_terms = ("동시통역", "초록", "심사", "QR", "바코드", "참가자", "시스템", "솔루션", "데이터", "백오피스", "API", "연동")
    if any(term in text for term in operational_terms):
        return "beok"
    return ""


def _inject_notebook_return_images(body_text: str, topic: str) -> str:
    """정적 image_bank 대신 실제로 크롤된 상품 썸네일을 본문에 삽입한다.
    상품 조회 실패 시 이미지 없이 원문을 그대로 반환(이 브랜드는 품질 게이트가
    이미지 개수를 요구하지 않으므로 안전)."""
    try:
        from research.product_sources import collect_product_sources
        sources = [s for s in collect_product_sources(topic, limit=4) if s.thumbnail]
    except Exception as e:  # noqa: BLE001
        print(f"[notebook_return] 상품 이미지 조회 실패(이미지 없이 진행): {e}")
        return body_text
    if not sources:
        return body_text
    figures = "\n\n".join(
        f'![{s.title}]({s.thumbnail})' for s in sources[:2]
    )
    return f"{body_text}\n\n{figures}"


def _build_outline(llm: LLMClient, post: dict, evidence: dict) -> dict:
    content_type = post.get("content_type", "howto")
    system = prompts.OUTLINE_TEMPLATES.get(content_type, prompts.OUTLINE_TEMPLATES["howto"])
    _log_stage(post["topic"], "outline")
    outline = chat_json(
        llm,
        system,
        prompts.OUTLINE_USER.format(
            topic=post["topic"],
            content_type=content_type,
            intent=evidence.get("intent", ""),
            coverage="\n".join(f"- {c}" for c in evidence.get("coverage_targets", [])),
            facts=_facts_summary(evidence),
            brand_hint=_brand_hint(post.get("category") or post.get("brand_key", "")),
        ),
        model=config.MODEL_OUTLINE,
        max_tokens=config.MAX_TOKENS_OUTLINE_JSON,
        thinking=False,
    )
    return _validate_outline(outline)


def _table_cell(value: object, limit: int) -> str:
    text = _re.sub(r"\s+", " ", str(value or "").replace("|", "/")).strip()
    if len(text) <= limit:
        return text
    return text[:limit].rstrip()


def _ensure_summary_table(body_text: str, outline: dict, allow_table: bool = True) -> str:
    """리치 HTML 품질 기준: 글 전체에 비교/점검용 표가 1개 이상 있게 한다."""
    if not allow_table:
        return body_text
    if "|---" in body_text:
        return body_text
    sections = [
        s for s in outline.get("sections", [])
        if isinstance(s, dict) and s.get("h2") and s.get("point")
    ][:4]
    if not sections:
        return body_text
    rows = [
        "| 점검 | 기준 |",
        "|---|---|",
    ]
    for sec in sections:
        h2 = _table_cell(sec["h2"], 18)
        point = _table_cell(sec["point"], 34)
        rows.append(f"| {h2} | {point} |")
    return body_text + "\n\n## 실행 전 점검표\n\n" + "\n".join(rows)


def _visible_text_len(body: str) -> int:
    text = _re.sub(r"!\[[^\]]*\]\([^)]*\)", " ", body or "")
    text = _re.sub(r"\[[^\]]+\]\([^)]*\)", " ", text)
    text = _re.sub(r"[#>*_`|\\-]+", " ", text)
    text = _re.sub(r"\s+", " ", text).strip()
    return len(text)


def _validate_generated_article(result: dict) -> dict:
    title = str(result.get("title") or "").strip()
    body = str(result.get("body") or "").strip()
    if not title:
        raise ValueError("생성 결과 제목이 비어 있음")
    if not body:
        raise ValueError("생성 결과 본문이 비어 있음")
    if body.count("## ") < SECTION_MIN:
        raise ValueError(f"생성 결과 소제목 부족({body.count('## ')}/{SECTION_MIN})")
    min_visible_chars = max(250, config.SECTION_MIN_LEN * SECTION_MIN)
    visible_chars = _visible_text_len(body)
    if visible_chars < min_visible_chars:
        raise ValueError(f"생성 결과 본문 부족({visible_chars}/{min_visible_chars}자)")
    return result


def _remove_unsupported_specific_claims(body_text: str, evidence: dict) -> str:
    """근거팩 밖 가격·기간·규모 수치 문장은 최종 본문에서 제거한다."""
    try:
        from pipeline.factcheck import local_unsupported_claims
    except Exception:  # noqa: BLE001
        return body_text
    unsupported = local_unsupported_claims(body_text, evidence)
    if not unsupported:
        return body_text
    blocks = _re.split(r"(\n{2,})", body_text or "")
    out: list[str] = []
    for block in blocks:
        if block.startswith("\n"):
            out.append(block)
            continue
        if block.startswith("![") or block.lstrip().startswith("<img"):
            out.append(block)
            continue
        cleaned = block
        for claim in unsupported:
            cleaned = cleaned.replace(claim, "")
        cleaned = _re.sub(r"[ \t]{2,}", " ", cleaned).strip()
        if cleaned or block.startswith("## "):
            out.append(cleaned)
    cleaned_body = "".join(out)
    cleaned_body = _re.sub(r"\n{3,}", "\n\n", cleaned_body).strip()
    return cleaned_body or body_text


def _plain_len(body_text: str) -> int:
    text = _re.sub(r"!\[[^\]]*]\([^)\s]+\)", " ", body_text or "")
    text = _re.sub(r"<script[\s\S]*?</script>", " ", text, flags=_re.I)
    text = _re.sub(r"<style[\s\S]*?</style>", " ", text, flags=_re.I)
    text = _re.sub(r"<[^>]+>", " ", text)
    return len(_re.sub(r"\s+", " ", text).strip())


def _is_structural_block(block: str) -> bool:
    stripped = (block or "").strip()
    if not stripped:
        return True
    if stripped.startswith("## ") or stripped.startswith("![") or stripped.startswith("<img"):
        return True
    lines = [line.strip() for line in stripped.splitlines() if line.strip()]
    return bool(lines) and all("|" in line for line in lines)


def _truncate_text_block(block: str, limit: int) -> str:
    text = (block or "").strip()
    if len(text) <= limit:
        return text
    units = _re.findall(r".+?(?:[.!?。]|다\.|요\.|니다\.|$)", text, flags=_re.S)
    out: list[str] = []
    total = 0
    for unit in units:
        unit = unit.strip()
        if not unit:
            continue
        extra = len(unit) + (1 if out else 0)
        if out and total + extra > limit:
            break
        if not out and len(unit) > limit:
            return unit[:limit].rstrip()
        out.append(unit)
        total += extra
    return " ".join(out).strip() or text[:limit].rstrip()


def _trim_to_plain_limit(body_text: str, max_chars: int) -> str:
    if _plain_len(body_text) <= max_chars:
        return body_text
    blocks = _re.split(r"\n{2,}", body_text or "")
    for _ in range(80):
        current_len = _plain_len("\n\n".join(blocks))
        if current_len <= max_chars:
            break
        overflow = current_len - max_chars
        changed = False
        for idx in range(len(blocks) - 1, -1, -1):
            block = blocks[idx]
            if _is_structural_block(block):
                continue
            block_len = _plain_len(block)
            if block_len <= 0:
                blocks.pop(idx)
                changed = True
                break
            if block_len > overflow + 90:
                blocks[idx] = _truncate_text_block(block, max(90, block_len - overflow - 40))
            else:
                blocks.pop(idx)
            changed = True
            break
        if not changed:
            break
    return _re.sub(r"\n{3,}", "\n\n", "\n\n".join(block for block in blocks if block.strip())).strip()


def _evidence_service_summary(evidence: dict) -> str:
    facts = [str(f.get("statement", "")).strip() for f in (evidence or {}).get("facts", []) if f.get("statement")]
    joined = " ".join(facts)
    if "홍커뮤니케이션" in joined and "비오케이솔루션" in joined:
        return "비오케이솔루션의 홈페이지·맞춤형 시스템 개발과 홍커뮤니케이션의 MICE 운영 맥락을 함께 놓고 봐야 합니다."
    if "홍커뮤니케이션" in joined:
        return "홍커뮤니케이션의 MICE 운영 맥락을 기준으로 접수와 현장 확인 흐름을 점검해야 합니다."
    if "비오케이솔루션" in joined:
        return "비오케이솔루션의 홈페이지 제작과 맞춤형 시스템 개발 맥락에서 운영 화면을 점검해야 합니다."
    return "공개 근거로 확인되는 서비스 범위 안에서 접수, 관리자 화면, 현장 운영 기준을 점검해야 합니다."


def _fit_operational_length_band(
    body_text: str,
    evidence: dict,
    topic: str = "",
    min_chars: int = 940,
    max_chars: int = 2200,
) -> str:
    """운영 글 최종 본문을 발행 게이트 밴드(900~2600) 안에 안정적으로 맞춘다."""
    fitted = _trim_to_plain_limit(body_text, max_chars)
    if _plain_len(fitted) >= min_chars:
        return fitted

    additions = [
        (
            "## 상담 전 확인할 운영 기준\n\n"
            f"{_evidence_service_summary(evidence)} "
            "이 단계에서는 요금이나 기간을 단정하기보다 실제 운영자가 매일 확인할 화면과 데이터 흐름을 먼저 정리하는 편이 안전합니다."
        ),
        (
            "- 참가자가 입력하는 항목과 사무국이 수정하는 항목을 나눕니다.\n"
            "- 등록, 결제, 체크인, 명찰 재발행처럼 상태가 바뀌는 지점을 같은 기준으로 표시합니다.\n"
            "- 행사 후 확인할 데이터와 관리자 권한을 미리 정해 개발 범위를 좁힙니다."
        ),
        (
            "상담 전에는 현재 쓰는 신청 방식, 담당자별 확인 절차, 현장 변경 요청 처리 기준을 정리해 두면 좋습니다. "
            "이 정보가 있어야 홈페이지 제작, 관리자 시스템, MICE 현장 운영 지원을 한 흐름으로 검토할 수 있습니다."
        ),
        (
            "특히 학회나 행사는 사전 등록과 현장 대응이 분리되면 같은 문의가 반복됩니다. "
            "접수 단계에서 받은 정보가 명찰 출력, 체크인 확인, 사후 데이터 정리까지 이어지는지 먼저 확인하면 운영 리스크를 줄일 수 있습니다."
        ),
    ]
    for addition in additions:
        if _plain_len(fitted) >= min_chars:
            break
        fitted = f"{fitted}\n\n{addition}".strip()
    return _trim_to_plain_limit(fitted, max_chars)


def generate_article(
    llm: LLMClient, topic: str, content_type: str, channel: str = "selfhosted",
    brand_key: str = "",
) -> dict:
    """
    DB와 무관하게 근거기반 + 검색노출 최적화 원고를 만든다(워커/측정 도구 공유).
    반환: {title, meta_description, body, tags, target_engine, evidence, seo}
    """
    engine = config.target_engine(channel)   # 기획 07: 채널별 타깃 엔진

    # ① 의도/키워드/하위질문
    _log_stage(topic, "query_plan")
    public_topic = _content_topic(topic)
    plan = ev.derive_query_plan(llm, public_topic, content_type)
    # ②a 타깃 엔진 SERP 분석(노출용) / ②b 사실 수집(근거용, 일반 웹)
    _log_stage(topic, f"serp:{engine}")
    serp = collect.analyze_serp(engine, plan["primary_keyword"])
    _log_stage(topic, "source_collect")
    sources = collect.collect(ev.search_queries(plan), category=brand_key, topic=public_topic)
    if not sources and config.MIN_GROUNDING_RATIO > 0:
        raise RuntimeError(
            "근거 출처 0건: 검색 공급자/키워드/출처 수집을 확인해야 하므로 자동 생성 중단"
        )
    # ③ 근거팩(커버리지는 타깃 SERP 반영)
    _log_stage(topic, "evidence_pack")
    evidence = ev.build_evidence_pack(llm, public_topic, content_type, plan, sources, serp=serp)

    # ④~⑥ 개요·섹션·SEO 합성(재작성 파이프라인과 공유)
    return compose_article(llm, public_topic, content_type, engine, evidence, serp, brand_key=brand_key)


def compose_article(
    llm: LLMClient,
    topic: str,
    content_type: str,
    engine: str,
    evidence: dict,
    serp: list[dict] | None = None,
    brand_key: str = "",
) -> dict:
    """근거팩이 준비된 뒤의 합성 단계(개요→섹션→SEO). generate/rewrite 공용."""
    topic = _content_topic(topic)
    # ④ 근거기반 개요
    outline = _build_outline(
        llm, {"topic": topic, "content_type": content_type, "brand_key": brand_key}, evidence
    )
    title = outline["title"]

    # ⑤ 근거기반 섹션 작성 (빈 응답/한자 혼입 시 재시도)
    parts: list[str] = []
    total_sections = len(outline["sections"])
    for idx, sec in enumerate(outline["sections"], start=1):
        body = ""
        for _sec_try in range(3):
            _log_stage(topic, f"section {idx}/{total_sections}: {sec['h2']} try {_sec_try + 1}")
            body = llm.chat(
                prompts.SECTION_SYSTEM,
                prompts.SECTION_USER.format(
                    title=title,
                    h2=sec["h2"],
                    point=sec["point"],
                    tone=config.DEFAULT_TONE,
                    channel_rules=_channel_rules(engine),
                    evidence=_evidence_for_section(evidence, sec["h2"], sec["point"]),
                ),
                model=config.MODEL_SECTION,
                max_tokens=_section_max_tokens(),
                thinking=True,   # 깊이·구조 향상(품질 우선). 통과율/비용 보며 조정.
            )
            too_short = len(body.strip()) < config.SECTION_MIN_LEN
            # glm 계열이 한국어에 한자(信信, 几次 등)를 섞는 경우 → 재생성
            has_hanzi = _count_hanzi(body) > 0
            if not too_short and not has_hanzi:
                break
            reason = "너무 짧음" if too_short else f"한자 {_count_hanzi(body)}자 혼입"
            print(f"[generate] 섹션 '{sec['h2']}' {reason}({len(body)}자), 재시도", flush=True)
        # 최종 시도에도 한자가 남으면 제거(최후의 안전망)
        body = _compact_section_body(_strip_hanzi(body))
        parts.append(f"## {sec['h2']}\n\n{body}")
    body_text = "\n\n".join(parts)
    body_text = _ensure_summary_table(body_text, outline, allow_table=engine != "naver")

    # ⑥ SEO 최적화(엔진별). 실패해도 원고는 살린다.
    try:
        _log_stage(topic, "seo")
        seo_data = seo.optimize(llm, engine, topic, title, body_text, evidence, serp)
        final_title = seo_data.get("seo_title") or title
        meta = seo_data.get("meta_description") or outline.get("meta_description", "")
        tags = seo_data.get("tags", [])
    except Exception as e:  # noqa: BLE001
        print(f"[seo] 최적화 실패(원고 유지): {e}", flush=True)
        seo_data, final_title, meta, tags = {}, title, outline.get("meta_description", ""), []

    image_brand_key = ""
    if engine == "naver":
        body_text = _sanitize_naver_body(body_text)
    else:
        image_brand_key = _image_brand_key(brand_key, topic, body_text)
    if engine != "naver" and image_brand_key == "notebook_return":
        body_text = _inject_notebook_return_images(body_text, topic)
    elif engine != "naver" and image_brand_key:
        from tools.image_bank import inject_images, recent_published_image_urls
        body_text = inject_images(
            body_text,
            brand_key=image_brand_key,
            avoid=recent_published_image_urls(limit=18),
            salt=topic,
        )

    final_title = _strip_run_meta_text(final_title)
    meta = _strip_run_meta_text(meta)
    body_text = _strip_run_meta_text(body_text)
    body_text = _remove_unsupported_specific_claims(body_text, evidence)
    # notebook_return은 beok/hong 전용 "상담 전 확인" 문구가 어울리지 않으므로 제외.
    if engine != "naver" and image_brand_key and image_brand_key != "notebook_return":
        body_text = _fit_operational_length_band(body_text, evidence, topic=topic)

    return _validate_generated_article({
        "title": final_title,
        "meta_description": meta,
        "body": body_text,
        "tags": tags,
        "target_engine": engine,
        "evidence": evidence,
        "seo": seo_data,
    })


def _generate_one(llm: LLMClient, post: dict) -> None:
    result = generate_article(
        llm, post["topic"], post.get("content_type", "howto"),
        post.get("channel", "selfhosted"),
        brand_key=post.get("category", ""),
    )
    db.save_research(post["id"], result["evidence"])
    db.save_seo(post["id"], result["target_engine"], result["tags"])
    db.save_article(
        post["id"], result["title"], result["meta_description"], result["body"]
    )


SECTION_MIN = 2   # 하한(이하면 실패)
SECTION_MAX = 4   # 상한(초과분은 잘라서 보정). 운영 글은 이미지/표 주입 후 2600자 이하여야 한다.


def _validate_outline(outline: dict) -> dict:
    """
    기획 01 §4.1 + 06. 하드 리젝 대신 '보정'으로 throughput 손실을 막는다(감사 후속).
    - title 없으면 실패
    - h2/point 없는 섹션은 버림
    - 유효 섹션이 SECTION_MIN 미만이면 실패, SECTION_MAX 초과면 앞에서 자름
    """
    if not outline.get("title"):
        raise ValueError("개요에 title 없음")
    sections = outline.get("sections")
    if not isinstance(sections, list):
        raise ValueError("sections가 리스트가 아님")

    valid = [
        s for s in sections
        if isinstance(s, dict) and s.get("h2") and s.get("point")
    ]
    if len(valid) < SECTION_MIN:
        raise ValueError(f"유효 섹션 부족(<{SECTION_MIN}): {len(valid)}")
    if len(valid) > SECTION_MAX:
        print(f"[generate] 섹션 {len(valid)}개 → {SECTION_MAX}개로 보정")
        valid = valid[:SECTION_MAX]

    outline["sections"] = valid
    return outline


def _order_by_pillar_diversity(ready: list) -> list:
    """생성 순서를 주제축(pillar) 기준으로 재배열한다.

    시드 순서(FIFO)가 같은 축으로 몰려 있어도 — 예: 명찰 draft가 연번으로 쌓인
    백로그 — 최근 생성된 글과 다른 축의 draft를 먼저 집어 발행 흐름을 섞는다."""
    if len(ready) <= 1:
        return list(ready)
    try:
        from tools.keyword_bank import pillar_of
    except Exception:  # noqa: BLE001
        return list(ready)

    with db.connect() as conn:
        recent = conn.execute(
            "SELECT topic, category FROM posts "
            "WHERE body IS NOT NULL AND body != '' AND topic IS NOT NULL "
            "ORDER BY updated_at DESC LIMIT 12"
        ).fetchall()
    recent_counts: dict[str, int] = {}
    for r in recent:
        p = pillar_of(r["topic"] or "", r["category"] or "")
        recent_counts[p] = recent_counts.get(p, 0) + 1

    # 최근에 덜 나온 축 우선, 같은 축이면 오래된 draft 우선(원래 FIFO 유지)
    return sorted(
        ready,
        key=lambda post: (
            recent_counts.get(pillar_of(post["topic"] or "", post["category"] or ""), 0),
            post["created_at"] or "",
            post["id"],
        ),
    )


def run_once(batch: int | None = None) -> int:
    """본문이 없는 draft(next_run_at 지난 것)를 근거기반 생성. 처리 건수 반환."""
    batch = batch or config.GENERATE_BATCH
    processed = 0
    attempted = 0
    failures: list[str] = []
    with _generate_lock() as acquired:
        if not acquired:
            print("[generate] 다른 생성 프로세스가 실행 중이라 이번 주기는 건너뜀", flush=True)
            return processed
        if not config.can_generate_with_evidence():
            health = config.search_health_status()
            print(f"[generate] 공식 출처/근거 수집 미설정으로 이번 주기 건너뜀: {health['reason']}", flush=True)
            return processed

        ready = _order_by_pillar_diversity(db.fetch_generate_ready(limit=max(batch * 8, 16)))
        for post in ready:
            if attempted >= batch:
                break
            if not db.claim(post["id"], "draft", "generating"):
                continue
            attempted += 1
            try:
                print(f"[generate] id={post['id']} 시작 topic={post['topic']!r}", flush=True)
                _generate_one_with_timeout(dict(post))
                processed += 1
                print(f"[generate] id={post['id']} 완료", flush=True)
            except Exception as e:  # noqa: BLE001
                attempts = (post["attempts"] or 0) + 1
                new_status = db.requeue_draft(
                    post["id"], attempts, str(e)[:500],
                    max_attempts=config.GENERATE_MAX_ATTEMPTS,
                )
                print(f"[generate] id={post['id']} 시도{attempts}/{config.GENERATE_MAX_ATTEMPTS} "
                      f"실패→{new_status}: {e}", flush=True)
                failures.append(f"id={post['id']} {new_status}: {e}")
                if new_status == "needs_human":
                    notify(f"생성 실패 격리: id={post['id']} topic={post['topic']!r} — {e}", "error")
    if attempted and processed == 0 and len(failures) == attempted:
        detail = "; ".join(failures[:3])
        if len(failures) > 3:
            detail += f"; 외 {len(failures) - 3}건"
        raise RuntimeError(f"생성 대상 {attempted}건 모두 실패: {detail}")
    return processed


if __name__ == "__main__":
    print(f"[generate] {run_once()}건 생성")
