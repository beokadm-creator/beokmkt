"""
네이버 수기 발행 원고 엔진 (기획 14).

봇 발행이 아니라 사람이 복사-붙여넣기로 올리는 고품질 원고를 온디맨드로 만든다.

흐름 (2-pass + 재검증):
  pass 1  기존 근거기반 엔진(경험담 개요로 교체) → 사실 골격
  pass 2  NAVER_HUMANIZE → 1인칭 현장 경험담으로 재작성(사실 불변)
  pass 3  factcheck 재검증 → humanize가 사실을 왜곡했는지 확인
  gate    네이버 전용 품질 게이트
  export  paste.html 생성 + status='awaiting_manual'(사람 발행 대기)

스케줄러/발행 워커는 channel='naver_manual'을 절대 건드리지 않는다.
"""
from __future__ import annotations

from datetime import datetime, timezone

import config
from db import db
from llm import prompts
from llm.client import LLMClient
from pipeline import factcheck, generate
from tools import naver_keyword_bank as themes
from tools import naver_quality
from render import naver_paste


def _normalize(text: str) -> str:
    return "".join(ch for ch in (text or "").lower() if ch.isalnum() or "가" <= ch <= "힣")


def _existing_topics() -> set[str]:
    with db.connect() as conn:
        rows = conn.execute("SELECT topic FROM posts WHERE topic IS NOT NULL").fetchall()
    return {_normalize(r["topic"]) for r in rows}


def _today_count() -> int:
    """오늘(발행 로컬 타임존) 생성된 naver_manual 원고 수(소프트 상한 경고용)."""
    from datetime import timedelta
    tz = timezone(timedelta(hours=config.PUBLISH_TZ_OFFSET))
    start = datetime.now(tz).replace(hour=0, minute=0, second=0, microsecond=0)
    start_utc = start.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    with db.connect() as conn:
        row = conn.execute(
            "SELECT COUNT(*) AS n FROM posts "
            "WHERE channel = ? AND created_at >= ?",
            (config.NAVER_MANUAL_CHANNEL, start_utc),
        ).fetchone()
    return int(row["n"])


def _norm(s: str) -> str:
    return (s or "").replace(" ", "")


def _make_title(outline_title: str, primary_keyword: str) -> str:
    """제목을 네이버 최적 구간(12~34자)으로 맞추되 주 키워드 포함을 보장한다.

    개요 제목이 '학회 명찰 출력, 명단이 세 번 바뀌어도…'처럼 쉼표 절을 붙여
    40자를 넘기거나, 키워드 변형(재발급 vs 재발행)으로 정확 키워드를 빠뜨리는
    경우가 있다. 자연 경계에서 줄이고, 키워드가 없으면 '키워드, 훅' 형태로 만든다."""
    t = (outline_title or "").strip().strip("#").strip()
    kw = (primary_keyword or "").strip()

    # 1) 자연 경계로 34자 이하 축약
    def shrink(text: str) -> str:
        if len(text) <= 34:
            return text
        for sep in ("—", " - ", ", ", ": ", " · "):
            head = text.split(sep)[0].strip()
            if 12 <= len(head) <= 34:
                return head
        words = text.split()
        out = ""
        for w in words:
            if len(out) + len(w) + 1 > 34:
                break
            out = f"{out} {w}".strip()
        return out or text[:34]

    tight = shrink(t)
    if not kw or _norm(kw) in _norm(tight):
        return tight

    # 2) 키워드가 없으면 '키워드, 훅' 조합. 훅은 개요 제목 뒷절/핵심 어구에서.
    hook = t
    for sep in (", ", "—", " - ", ": "):
        if sep in t:
            parts = [p.strip() for p in t.split(sep) if p.strip()]
            hook = parts[-1] if len(parts) > 1 else parts[0]
            break
    hook = hook.strip()
    candidate = f"{kw}, {hook}" if hook and _norm(hook) not in _norm(kw) else kw
    return shrink(candidate)


def _humanize(llm: LLMClient, title: str, primary_keyword: str, body_md: str) -> str:
    """pass 2: 근거 골격을 1인칭 경험담으로 재작성한다. 사실은 그대로."""
    system = prompts.NAVER_HUMANIZE_SYSTEM.format(
        primary_keyword=primary_keyword,
        photo_slots=config.NAVER_MANUAL_PHOTO_SLOTS,
        min_len=config.NAVER_MANUAL_MIN_LEN,
        max_len=config.NAVER_MANUAL_MAX_LEN,
    )
    out = llm.chat(
        system,
        prompts.NAVER_HUMANIZE_USER.format(
            title=title, primary_keyword=primary_keyword, body=body_md
        ),
        model=config.MODEL_HUMANIZE,
        max_tokens=config.MAX_TOKENS_HUMANIZE,
        temperature=0.75,   # 사람 문체 다양성. 사실은 프롬프트가 잠근다.
        thinking=True,
    )
    return (out or "").strip()


def generate_one(theme_key: str, verbose: bool = True) -> dict:
    """테마 하나로 원고 1건 생성 → paste.html export → awaiting_manual.

    반환: {ok, post_id, theme, title, paste_path, issues}
    ok=False면 issues에 사유. 미달 원고는 발행 대기함에 넣지 않는다.
    """
    theme = themes.get_theme(theme_key)
    if not theme:
        return {"ok": False, "issues": [f"unknown theme: {theme_key}",
                                        f"themes: {', '.join(themes.theme_keys())}"]}

    picked = themes.pick_keyword(theme_key, _existing_topics())
    if not picked:
        return {"ok": False, "theme": theme_key,
                "issues": [f"테마 '{theme.label}'의 키워드를 모두 소진했습니다. "
                           "naver_keyword_bank에 주제를 추가하거나 다른 테마를 고르세요."]}
    topic, content_type, primary = picked

    if config.NAVER_MANUAL_SOFT_DAILY_CAP and _today_count() >= config.NAVER_MANUAL_SOFT_DAILY_CAP:
        print(f"[naver_manual] 참고: 오늘 이미 {_today_count()}건 생성(소프트 상한 "
              f"{config.NAVER_MANUAL_SOFT_DAILY_CAP}). 계속 진행합니다.")

    post_id = db.insert_draft(
        channel=config.NAVER_MANUAL_CHANNEL,
        topic=topic,
        content_type=content_type,
        category="beok",   # 이미지 뱅크·브랜드 힌트용(네이버 본문엔 이미지 주입 안 함)
    )
    if verbose:
        print(f"[naver_manual] draft id={post_id} theme={theme_key} topic={topic!r}")

    llm = LLMClient()

    # pass 1: 근거기반 골격은 한 번만 만든다(비싸다 — 리서치+섹션 생성).
    # 게이트 미달 시 humanize(pass 2)만 재시도한다 — 변동성은 humanize에 있다.
    try:
        skeleton = generate.generate_article(
            llm, topic, content_type,
            channel=config.NAVER_MANUAL_CHANNEL,
            brand_key="beok",
            outline_system=prompts.NAVER_MANUAL_OUTLINE,
        )
    except Exception as e:  # noqa: BLE001
        db.archive_posts([post_id], reason="naver_manual 골격 생성 실패")
        return {"ok": False, "post_id": post_id, "theme": theme_key,
                "issues": [f"pass1 {type(e).__name__}: {e}"]}

    # 검색 키워드는 뱅크에서 고른 이 글의 키워드(primary)를 권위로 삼는다 —
    # evidence 자동 추출 키워드는 제목·본문과 어긋나 게이트를 헛되이 떨어뜨린다.
    title = _make_title(skeleton["title"], primary)
    evidence = skeleton["evidence"]

    last_issues: list[str] = []
    for attempt in range(1, config.NAVER_MANUAL_MAX_RETRIES + 2):
        try:
            if verbose:
                print(f"[naver_manual] humanize (attempt {attempt})")
            body_md = _humanize(llm, title, primary, skeleton["body"])
            body_md = generate._strip_run_meta_text(generate._strip_hanzi(body_md))

            # pass 3: factcheck 재검증(humanize가 사실을 바꾸지 않았는지)
            local_unsupported = factcheck.local_unsupported_claims(body_md, evidence)
            fc = factcheck.check(llm, body_md, evidence)
            grounding = float(fc.get("grounding_ratio", 0.0) or 0.0)
            if verbose:
                print(f"[naver_manual] grounding={grounding:.2f} "
                      f"local_unsupported={len(local_unsupported)}")

            gate = naver_quality.evaluate(
                title=title, body_md=body_md, primary_keyword=primary,
                grounding=grounding, local_unsupported=local_unsupported,
            )
            if not gate["ok"]:
                last_issues = gate["issues"]
                if verbose:
                    print(f"[naver_manual] 게이트 미달(attempt {attempt}): {gate['issues']}")
                continue   # humanize부터 재시도(골격은 유지)

            # 통과 → 저장 + export
            db.save_research(post_id, evidence)
            db.save_seo(post_id, skeleton["target_engine"], skeleton["tags"])
            db.save_article(post_id, title, skeleton["meta_description"], body_md)
            db.save_grounding(post_id, grounding)

            export = naver_paste.export(
                post_id=post_id, theme=theme, title=title, body_md=body_md,
                tags=skeleton["tags"], meta_desc=skeleton["meta_description"],
                primary_keyword=primary,
            )
            db.set_awaiting_manual(post_id, export["paste_path"])
            if verbose:
                print(f"[naver_manual] ✅ awaiting_manual id={post_id}  "
                      f"metrics={gate['metrics']}\n  paste.html: {export['paste_path']}")
            return {
                "ok": True, "post_id": post_id, "theme": theme_key,
                "title": title, "paste_path": export["paste_path"],
                "grounding": grounding, "issues": [],
            }
        except Exception as e:  # noqa: BLE001
            last_issues = [f"{type(e).__name__}: {e}"]
            if verbose:
                print(f"[naver_manual] humanize 오류(attempt {attempt}): {e}")

    # 재시도 소진 — 미달 원고를 억지로 내보내지 않는다(archive).
    db.archive_posts([post_id], reason="naver_manual 품질 미달")
    return {"ok": False, "post_id": post_id, "theme": theme_key, "issues": last_issues}


def queue() -> list[dict]:
    """발행 대기함: awaiting_manual 건과 paste.html 경로."""
    with db.connect() as conn:
        rows = conn.execute(
            "SELECT id, topic, title, manual_artifact, updated_at "
            "FROM posts WHERE channel = ? AND status = ? "
            "ORDER BY updated_at DESC",
            (config.NAVER_MANUAL_CHANNEL, config.NAVER_MANUAL_STATE),
        ).fetchall()
    return [
        {
            "id": r["id"], "title": r["title"] or r["topic"],
            "paste_path": r["manual_artifact"] or "", "updated_at": r["updated_at"],
        }
        for r in rows
    ]


def mark(post_id: int, url: str) -> bool:
    """수기 발행 완료 기록. awaiting_manual → published."""
    post = db.fetch_by_id(post_id)
    if not post:
        print(f"[naver_manual] id={post_id} 없음")
        return False
    if post["channel"] != config.NAVER_MANUAL_CHANNEL:
        print(f"[naver_manual] id={post_id}는 naver_manual 채널이 아님({post['channel']})")
        return False
    db.mark_published(post_id, url)
    print(f"[naver_manual] ✅ published id={post_id} → {url}")
    return True
