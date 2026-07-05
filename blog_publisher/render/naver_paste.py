"""
네이버 수기 발행 출력물 — paste.html 생성 (기획 14 §2).

사용자가 브라우저로 열어 [본문 전체 복사] 한 번으로 SmartEditor ONE에 붙여넣는다.
서식 보존율을 위해 표준 태그만 쓴다:
  허용: <p> <strong> <blockquote> <ul>/<ol>/<li> <br>
  금지: <h1~h6>(에디터 매핑 불안정 → 굵은 단독 문단) / <img>(사진 슬롯) / style·class(복사본)

복사 방식(신뢰도 순):
  1) Range 선택 + execCommand('copy') → 클립보드에 text/html flavor 동반(file://에서도 동작)
  2) navigator.clipboard.write(ClipboardItem{text/html,text/plain}) 폴백
  3) 안내: 미리보기 영역 드래그 전체선택 후 Ctrl+C
"""
from __future__ import annotations

import html
import json
import re
from datetime import datetime, timezone
from pathlib import Path

import config


# ---------------------------------------------------------------------------
# 마크다운 → SmartEditor 안전 HTML (복사 대상 본문)
# ---------------------------------------------------------------------------
def _inline(text: str) -> str:
    """인라인 서식: **굵게**만 <strong>으로. 나머지는 이스케이프."""
    out: list[str] = []
    i = 0
    for m in re.finditer(r"\*\*(.+?)\*\*", text):
        out.append(html.escape(text[i:m.start()]))
        out.append(f"<strong>{html.escape(m.group(1))}</strong>")
        i = m.end()
    out.append(html.escape(text[i:]))
    return "".join(out)


def _photo_slot_line(caption: str) -> str:
    """사진 슬롯 → 복사본엔 한 줄 텍스트, 미리보기엔 노란 박스(class는 붙여넣기 시 탈락)."""
    safe = html.escape(caption.strip())
    return f'<p class="photo-slot">(📷 사진: {safe})</p>'


# humanize 모델이 사진 마커를 문단 끝에 붙이거나(...달립니다.![사진:...])
# 이미지 문법(!)으로 쓰는 경우가 있다. 파싱 전에 독립 줄로 떼어낸다.
_PHOTO_INLINE_RE = re.compile(r"!?\[사진:\s*[^\]]*\]")


def _split_photo_markers(body_md: str) -> str:
    def repl(m: re.Match) -> str:
        inner = m.group(0).lstrip("!")
        return f"\n\n{inner}\n\n"
    return _PHOTO_INLINE_RE.sub(repl, body_md)


def markdown_to_paste_html(body_md: str) -> tuple[str, list[str]]:
    """본문 마크다운 → 붙여넣기용 HTML. (html, 소제목 목록) 반환.

    소제목 목록은 사용자가 에디터에서 '소제목' 스타일을 입힐 위치 안내용.
    """
    lines = _split_photo_markers(body_md).split("\n")
    out: list[str] = []
    subheads: list[str] = []
    list_buf: list[str] = []
    para_buf: list[str] = []

    def flush_para() -> None:
        if para_buf:
            joined = " ".join(para_buf).strip()
            if joined:
                out.append(f"<p>{_inline(joined)}</p>")
            para_buf.clear()

    def flush_list() -> None:
        if list_buf:
            items = "".join(f"<li>{_inline(x)}</li>" for x in list_buf)
            out.append(f"<ul>{items}</ul>")
            list_buf.clear()

    for raw in lines:
        s = raw.strip()
        if not s:
            flush_para(); flush_list()
            continue
        # 사진 슬롯
        slot = re.match(r"\[사진:\s*(.+?)\]$", s)
        if slot:
            flush_para(); flush_list()
            out.append(_photo_slot_line(slot.group(1)))
            continue
        # 소제목 (## / ###) → 굵은 단독 문단
        head = re.match(r"^#{2,3}\s+(.+)$", s)
        if head:
            flush_para(); flush_list()
            title = head.group(1).strip()
            subheads.append(title)
            out.append(f'<p class="subhead"><strong>{_inline(title)}</strong></p>')
            continue
        # 인용
        if s.startswith("> "):
            flush_para(); flush_list()
            out.append(f"<blockquote>{_inline(s[2:].strip())}</blockquote>")
            continue
        # 목록
        item = re.match(r"^[-*]\s+(.+)$", s)
        if item:
            flush_para()
            list_buf.append(item.group(1).strip())
            continue
        # 일반 문단
        flush_list()
        para_buf.append(s)

    flush_para(); flush_list()
    return "\n".join(out), subheads


# ---------------------------------------------------------------------------
# paste.html 셸 (외부 의존 0 — 인라인 CSS/JS)
# ---------------------------------------------------------------------------
_PAGE = """<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>네이버 발행 원고 · {title_esc}</title>
<style>
:root{{color-scheme:light}}
*{{box-sizing:border-box}}
body{{margin:0;background:#f1f3f5;color:#191919;font-family:-apple-system,'Malgun Gothic',sans-serif;line-height:1.7}}
.wrap{{max-width:760px;margin:0 auto;padding:24px 16px 80px}}
.panel{{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:20px;margin-bottom:16px}}
.panel h2{{font-size:15px;margin:0 0 12px;color:#03c75a;letter-spacing:-.01em}}
.row{{display:flex;gap:8px;align-items:flex-start;margin:8px 0;flex-wrap:wrap}}
.k{{min-width:72px;color:#868e96;font-size:13px;padding-top:6px}}
.v{{flex:1;min-width:220px}}
.copyfield{{cursor:pointer;background:#f8f9fa;border:1px solid #dee2e6;border-radius:8px;padding:8px 12px;font-size:14px;transition:background .15s;word-break:keep-all}}
.copyfield:hover{{background:#e7f9ee;border-color:#03c75a}}
.copyfield::after{{content:'클릭=복사';float:right;font-size:11px;color:#adb5bd}}
.copyfield.copied::after{{content:'✓ 복사됨';color:#03c75a}}
.bigcopy{{width:100%;padding:14px;font-size:16px;font-weight:700;color:#fff;background:#03c75a;border:none;border-radius:10px;cursor:pointer}}
.bigcopy:hover{{background:#02b350}}
.bigcopy.copied{{background:#02b350}}
.hint{{font-size:12px;color:#868e96;margin-top:8px}}
ol.steps{{margin:8px 0 0;padding-left:20px;font-size:13px;color:#495057}}
ol.steps li{{margin:4px 0}}
.tag{{display:inline-block;background:#e7f9ee;color:#0a8f43;border-radius:14px;padding:3px 10px;margin:2px 4px 2px 0;font-size:13px}}
/* 복사 대상 본문 미리보기 = 실제 복사 영역 */
#copy-body{{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:24px}}
#copy-body p{{margin:0 0 14px}}
#copy-body .subhead{{font-size:19px;margin:26px 0 10px}}
#copy-body blockquote{{margin:14px 0;padding:10px 16px;border-left:3px solid #03c75a;background:#f8f9fa;color:#495057}}
#copy-body ul{{margin:0 0 14px;padding-left:20px}}
#copy-body li{{margin:4px 0}}
#copy-body .photo-slot{{background:#fff9db;border:1px dashed #ffd43b;border-radius:8px;padding:12px 14px;color:#997404;font-size:14px}}
.subhead-list{{font-size:13px;color:#495057;margin:6px 0 0;padding-left:18px}}
</style></head>
<body><div class="wrap">

<div class="panel">
  <h2>발행 체크리스트</h2>
  <div class="row"><div class="k">제목</div><div class="v"><div class="copyfield" data-copy="{title_attr}">{title_esc}</div></div></div>
  <div class="row"><div class="k">태그</div><div class="v"><div class="copyfield" data-copy="{tags_attr}">{tags_view}</div></div></div>
  <div class="row"><div class="k">요약</div><div class="v" style="font-size:13px;color:#495057">{meta_esc}</div></div>
  <div class="row"><div class="k">테마</div><div class="v" style="font-size:13px;color:#495057">{theme_esc} · 주 키워드 「{kw_esc}」</div></div>
  <ol class="steps">
    <li>제목 클릭 → 네이버 글쓰기 제목에 붙여넣기</li>
    <li>아래 <b>[본문 전체 복사]</b> → 본문에 붙여넣기</li>
    <li>📷 사진 슬롯 {slots}곳 → 준비한 사진으로 교체(그 줄 삭제 후 사진 업로드)</li>
    <li>소제목 {subhead_n}곳을 에디터에서 '소제목' 스타일로 지정 {subhead_hint}</li>
    <li>태그 클릭 → 태그란에 붙여넣기 → 발행</li>
    <li>발행 후: <code>python run.py naver_mark {post_id} &lt;발행URL&gt;</code></li>
  </ol>
</div>

<div class="panel">
  <button class="bigcopy" id="btn-copy">본문 전체 복사</button>
  <div class="hint">버튼이 안 되면 아래 미리보기 영역을 드래그로 전체 선택한 뒤 Ctrl+C(⌘+C) 하세요. 사진·소제목 스타일은 붙여넣은 뒤 에디터에서 적용합니다.</div>
</div>

<div id="copy-body">
{body_html}
</div>

<script>
(function(){{
  var btn=document.getElementById('btn-copy');
  var body=document.getElementById('copy-body');
  function flash(el,cls){{el.classList.add(cls);setTimeout(function(){{el.classList.remove(cls);}},1400);}}
  function copyNode(node){{
    try{{
      var range=document.createRange();range.selectNodeContents(node);
      var sel=window.getSelection();sel.removeAllRanges();sel.addRange(range);
      var ok=document.execCommand('copy');sel.removeAllRanges();
      if(ok)return true;
    }}catch(e){{}}
    if(navigator.clipboard&&window.ClipboardItem){{
      try{{
        var data=new ClipboardItem({{
          'text/html':new Blob([node.innerHTML],{{type:'text/html'}}),
          'text/plain':new Blob([node.innerText],{{type:'text/plain'}})
        }});
        navigator.clipboard.write([data]);return true;
      }}catch(e){{}}
    }}
    return false;
  }}
  btn.addEventListener('click',function(){{
    if(copyNode(body)){{btn.textContent='✓ 본문이 복사됐어요';flash(btn,'copied');
      setTimeout(function(){{btn.textContent='본문 전체 복사';}},1600);}}
    else{{btn.textContent='복사 실패 — 드래그로 선택해 주세요';}}
  }});
  document.querySelectorAll('.copyfield').forEach(function(el){{
    el.addEventListener('click',function(){{
      var t=el.getAttribute('data-copy')||el.innerText;
      var done=false;
      if(navigator.clipboard&&navigator.clipboard.writeText){{navigator.clipboard.writeText(t);done=true;}}
      else{{var ta=document.createElement('textarea');ta.value=t;document.body.appendChild(ta);
        ta.select();try{{done=document.execCommand('copy');}}catch(e){{}}document.body.removeChild(ta);}}
      if(done)flash(el,'copied');
    }});
  }});
}})();
</script>
</div></body></html>
"""


def _slugify(text: str) -> str:
    s = re.sub(r"[^\w가-힣\s-]", "", text or "").strip().lower()
    s = re.sub(r"\s+", "-", s)[:40]
    return s or "post"


def export(
    *,
    post_id: int,
    theme,
    title: str,
    body_md: str,
    tags: list[str],
    meta_desc: str,
    primary_keyword: str,
) -> dict:
    """paste.html + draft.json을 out/naver/<날짜>_<슬러그>/에 쓰고 경로 반환."""
    body_html, subheads = markdown_to_paste_html(body_md)
    slot_count = len(re.findall(r"\[사진:", body_md))
    tag_list = [t.strip().lstrip("#") for t in (tags or []) if t and t.strip()]
    tags_text = " ".join(f"#{t}" for t in tag_list)

    date = datetime.now(timezone(_kst())).strftime("%Y-%m-%d")
    out_dir = Path(config.NAVER_MANUAL_OUT_DIR) / f"{date}_{_slugify(title)}"
    out_dir.mkdir(parents=True, exist_ok=True)

    subhead_hint = (
        "(" + " / ".join(f"「{h[:16]}」" for h in subheads[:4]) + ")" if subheads else ""
    )
    page = _PAGE.format(
        title_esc=html.escape(title),
        title_attr=html.escape(title, quote=True),
        tags_attr=html.escape(tags_text, quote=True),
        tags_view="".join(f'<span class="tag">#{html.escape(t)}</span>' for t in tag_list) or "—",
        meta_esc=html.escape(meta_desc or ""),
        theme_esc=html.escape(getattr(theme, "label", "")),
        kw_esc=html.escape(primary_keyword or ""),
        slots=slot_count,
        subhead_n=len(subheads),
        subhead_hint=html.escape(subhead_hint),
        post_id=post_id,
        body_html=body_html,
    )
    paste_path = out_dir / "paste.html"
    paste_path.write_text(page, encoding="utf-8")

    (out_dir / "draft.json").write_text(
        json.dumps({
            "post_id": post_id,
            "theme": getattr(theme, "key", ""),
            "title": title,
            "primary_keyword": primary_keyword,
            "tags": tag_list,
            "meta_description": meta_desc,
            "subheads": subheads,
            "photo_slots": slot_count,
            "body_markdown": body_md,
        }, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return {"paste_path": str(paste_path), "dir": str(out_dir), "subheads": subheads}


def _kst():
    from datetime import timedelta
    return timedelta(hours=config.PUBLISH_TZ_OFFSET)
