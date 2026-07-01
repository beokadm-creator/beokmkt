"""
BEOK 블로그 자동화 모니터링 대시보드
Usage: python dashboard.py [--port 5050]
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import webbrowser
from datetime import datetime, timezone, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Timer

KST = timezone(timedelta(hours=9))

_THIS_DIR = Path(__file__).resolve().parent
DB_PATH = Path(os.environ.get(
    "BLOG_DB_PATH",
    str(_THIS_DIR.parent.parent / "db" / "blog.db"),
))
STATUS_DIR = Path(os.environ.get(
    "SESSION_STATUS_DIR",
    r"C:\Users\Aaron\Claude\Projects\beokmkt\status",
))
HEALTH_FILE = STATUS_DIR / "health.json"
COUPANG_HEARTBEAT = Path(os.environ.get(
    "COUPANG_HEARTBEAT_FILE",
    r"C:\Users\Aaron\Claude\Projects\coupang\.runtime\heartbeat.json",
))

STATUSES = [
    "draft", "generating", "factchecking", "reviewing", "reviewed",
    "queued", "publishing", "published", "needs_human", "failed",
]


def _pipeline_data() -> dict:
    try:
        conn = sqlite3.connect(str(DB_PATH), timeout=5)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL;")
        counts = {s: conn.execute(
            "SELECT COUNT(*) AS n FROM posts WHERE status=?", (s,)
        ).fetchone()["n"] for s in STATUSES}
        now_utc = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
        queued_due = conn.execute(
            "SELECT COUNT(*) AS n FROM posts WHERE status='queued' AND next_run_at <= ?",
            (now_utc,),
        ).fetchone()["n"]
        next_queued = conn.execute(
            "SELECT MIN(next_run_at) AS v FROM posts WHERE status='queued'"
        ).fetchone()["v"]
        rows = conn.execute("""
            SELECT channel, status, COUNT(*) AS n FROM posts
            WHERE status IN (
                'draft','generating','factchecking','reviewing','reviewed',
                'queued','publishing','published','needs_human','failed'
            )
            GROUP BY channel, status
        """).fetchall()
        recent = conn.execute("""
            SELECT id, title, channel, published_url, updated_at
            FROM posts
            WHERE status='published'
              AND published_url IS NOT NULL AND published_url != ''
            ORDER BY updated_at DESC
            LIMIT 15
        """).fetchall()
        conn.close()
        by_channel: dict = {}
        for r in rows:
            by_channel.setdefault(r["channel"], {})[r["status"]] = int(r["n"])
        recent_posts = [
            {"id": r["id"], "title": r["title"], "channel": r["channel"],
             "url": r["published_url"], "updated_at": r["updated_at"]}
            for r in recent
        ]
        return {
            "ok": True, "counts": counts,
            "queued_due": queued_due, "next_queued": next_queued,
            "by_channel": by_channel,
            "recent_posts": recent_posts,
        }
    except Exception as e:
        return {"ok": False, "error": str(e), "counts": {s: 0 for s in STATUSES}}


def _health_data() -> dict:
    try:
        return {"ok": True, **json.loads(HEALTH_FILE.read_text(encoding="utf-8"))}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def _coupang_data() -> dict:
    """쿠팡 스크래퍼 로컬 하트비트 파일(.runtime/heartbeat.json)을 읽는다."""
    try:
        raw = json.loads(COUPANG_HEARTBEAT.read_text(encoding="utf-8"))
        return {"ok": True, **raw}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def _status() -> dict:
    return {
        "timestamp": datetime.now(tz=KST).isoformat(),
        "pipeline": _pipeline_data(),
        "health": _health_data(),
        "coupang": _coupang_data(),
    }


_HTML = r"""<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>BEOK 대시보드</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0d0d14;color:#e2e8f0;font-family:-apple-system,'Segoe UI',sans-serif;min-height:100vh;padding:28px 24px}
h1{font-size:1.1rem;font-weight:600;letter-spacing:.06em;color:#64748b;margin-bottom:4px}
.ts{font-size:.75rem;color:#334155;margin-bottom:24px}
.cd{background:#1e293b;padding:2px 8px;border-radius:4px;font-size:.7rem;color:#475569;margin-left:8px}
.grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:14px}
.grid2{display:grid;grid-template-columns:repeat(2,1fr);gap:14px;margin-top:14px}
.card{background:#13131f;border:1px solid #1e293b;border-radius:12px;padding:18px 20px}
.card-title{font-size:.65rem;font-weight:700;letter-spacing:.1em;color:#475569;text-transform:uppercase;margin-bottom:12px}
.badge{display:inline-flex;align-items:center;gap:7px;font-size:1rem;font-weight:700}
.dot{width:9px;height:9px;border-radius:50%;flex-shrink:0}
.ok .dot{background:#4ade80;box-shadow:0 0 8px #4ade8077}
.warn .dot{background:#facc15;box-shadow:0 0 8px #facc1577}
.err .dot{background:#f87171;box-shadow:0 0 8px #f8717177}
.ok{color:#4ade80}.warn{color:#facc15}.err{color:#f87171}
.sub{font-size:.78rem;color:#475569;margin-top:6px}
.pipe-flow{display:flex;align-items:flex-end;gap:0;overflow-x:auto;padding-bottom:4px}
.stage{display:flex;flex-direction:column;align-items:center;min-width:80px}
.sn{font-size:1.9rem;font-weight:800;font-variant-numeric:tabular-nums;line-height:1;margin-bottom:5px}
.sl{font-size:.6rem;color:#475569;text-transform:uppercase;letter-spacing:.06em;text-align:center}
.arr{color:#1e293b;font-size:1.1rem;padding-bottom:22px;margin:0 2px;flex-shrink:0}
.c-act{color:#60a5fa}.c-zero{color:#1e293b}.c-pub{color:#4ade80}.c-warn{color:#facc15}.c-err{color:#f87171}
.cs{display:flex;justify-content:space-between;font-size:.78rem;color:#475569;margin-top:5px}
.cs span:last-child{color:#e2e8f0;font-weight:600;font-variant-numeric:tabular-nums}
.extras{margin-top:12px;font-size:.75rem;display:flex;gap:12px}
.recent-table{width:100%;border-collapse:collapse;margin-top:4px}
.recent-table th{font-size:.6rem;font-weight:700;letter-spacing:.08em;color:#334155;text-transform:uppercase;padding:0 8px 8px 0;text-align:left;white-space:nowrap}
.recent-table td{font-size:.78rem;padding:6px 8px 6px 0;border-top:1px solid #1e293b;vertical-align:middle}
.recent-table tr:first-child td{border-top:none}
.ch-tag{display:inline-block;font-size:.6rem;font-weight:700;padding:2px 6px;border-radius:4px;text-transform:uppercase;letter-spacing:.05em;white-space:nowrap}
.ch-selfhosted{background:#1e3a5f;color:#60a5fa}
.ch-tistory{background:#3b1f2b;color:#f472b6}
.ch-naver{background:#1a3326;color:#4ade80}
.post-link{color:#e2e8f0;text-decoration:none;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:480px}
.post-link:hover{color:#60a5fa;text-decoration:underline}
.post-date{color:#334155;font-size:.72rem;white-space:nowrap}
</style>
</head>
<body>
<h1>BEOK 블로그 자동화</h1>
<div class="ts">마지막 갱신: <span id="ts">—</span><span class="cd" id="cd">30s</span></div>

<div class="grid3">
  <div class="card">
    <div class="card-title">워커</div>
    <div class="badge" id="w-b"><span class="dot"></span><span>—</span></div>
    <div class="sub" id="w-s">—</div>
  </div>
  <div class="card">
    <div class="card-title">티스토리 세션</div>
    <div class="badge" id="s-b"><span class="dot"></span><span>—</span></div>
    <div class="sub" id="s-s">—</div>
  </div>
  <div class="card">
    <div class="card-title">Keepalive</div>
    <div class="badge" id="k-b"><span class="dot"></span><span>—</span></div>
    <div class="sub" id="k-s">—</div>
  </div>
</div>

<div class="card" style="margin-bottom:14px">
  <div class="card-title">쿠팡 스크래퍼</div>
  <div class="badge" id="cp-b"><span class="dot"></span><span>—</span></div>
  <div class="sub" id="cp-s">—</div>
  <div class="extras" id="cp-x"></div>
</div>

<div class="card" style="margin-bottom:14px">
  <div class="card-title">파이프라인</div>
  <div class="pipe-flow" id="pipe">—</div>
  <div class="extras" id="extras"></div>
</div>

<div class="grid2">
  <div class="card"><div class="card-title">selfhosted</div><div id="ch-selfhosted">—</div></div>
  <div class="card"><div class="card-title">tistory</div><div id="ch-tistory">—</div></div>
</div>

<div class="card" style="margin-top:14px">
  <div class="card-title">최근 발행</div>
  <div id="recent-posts">—</div>
</div>

<script>
const STAGES=[
  {k:'draft',l:'draft'},{k:'generating',l:'generate'},{k:'factchecking',l:'factcheck'},
  {k:'reviewing',l:'review'},{k:'reviewed',l:'reviewed'},{k:'queued',l:'queued'},
  {k:'publishing',l:'publishing'},{k:'published',l:'published'},
];
const INV=['draft','generating','factchecking','reviewing','reviewed'];

function kst(iso){
  if(!iso)return'—';
  try{return new Date(iso).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',hour12:false})}
  catch{return iso}
}
function badge(id,cls,txt){
  const el=document.getElementById(id);
  el.className='badge '+cls;
  el.querySelector('span:last-child').textContent=txt;
}

function render(data){
  document.getElementById('ts').textContent=kst(data.timestamp);
  const h=data.health||{};
  const p=data.pipeline||{};
  const counts=p.counts||{};

  // Worker
  const w=h.worker_health||{};
  if(w.ok){badge('w-b','ok','정상');document.getElementById('w-s').textContent='http://127.0.0.1:8788';}
  else{badge('w-b','err','오프라인');document.getElementById('w-s').textContent=w.error||'응답 없음';}

  // Session
  const sess=h.tistory_session||null;
  if(sess&&sess.valid){
    const d=sess.days_to_expiry;
    const cls=d>7?'ok':d>3?'warn':'err';
    badge('s-b',cls,`D-${Math.floor(d)} 유효`);
    const exp=sess.min_cookie_expiry?kst(sess.min_cookie_expiry).split(' ')[0]:'—';
    document.getElementById('s-s').textContent=`만료 ${exp}`;
  } else if(sess){
    badge('s-b','err','만료/없음');
    document.getElementById('s-s').textContent=sess.error||'세션 없음';
  } else {
    badge('s-b','warn','—');
    document.getElementById('s-s').textContent='health.json 없음';
  }

  // Keepalive
  const kOk=h.keepalive_ok;const kAt=h.keepalive_last_run;
  if(kOk===true)badge('k-b','ok','정상');
  else if(kOk===false)badge('k-b','err','실패');
  else badge('k-b','warn','미실행');
  document.getElementById('k-s').textContent=kAt?kst(kAt):'—';

  // Coupang scraper (로컬 heartbeat.json 기반)
  const cp=data.coupang||{};
  if(cp.ok){
    const st=cp.status||'unknown';
    const upd=cp.updatedAt?new Date(cp.updatedAt):null;
    const ageMin=upd?((Date.now()-upd.getTime())/60000):null;
    // max-interval 7200s(2h) 기준: 150분 넘게 갱신 없으면 정지로 간주
    let cls='ok',label=st;
    if(st==='stopped'){cls='warn';label='중지됨';}
    else if(st==='scanning'){cls='ok';label='스캔 중';}
    else if(st==='idle'){cls='ok';label='대기';}
    else if(st==='starting'){cls='ok';label='시작 중';}
    if(ageMin!==null&&ageMin>150){cls='err';label='정지(갱신 끊김)';}
    badge('cp-b',cls,label);
    document.getElementById('cp-s').textContent='갱신 '+(upd?kst(cp.updatedAt):'—');
    let ex='';
    if(cp.scanCount!=null)ex+=`<span>스캔 ${cp.scanCount}회</span>`;
    if(cp.errorCount)ex+=`<span class="c-err">에러 ${cp.errorCount}</span>`;
    if(cp.nextScanAt)ex+=`<span style="color:#334155">다음 ${kst(cp.nextScanAt)}</span>`;
    document.getElementById('cp-x').innerHTML=ex;
  } else {
    badge('cp-b','err','미실행/없음');
    document.getElementById('cp-s').textContent='heartbeat.json 없음 (스크래퍼 미동작)';
    document.getElementById('cp-x').innerHTML='';
  }

  // Pipeline
  const pipe=document.getElementById('pipe');
  pipe.innerHTML=STAGES.map((s,i)=>{
    const n=counts[s.k]||0;
    let c='c-zero';
    if(s.k==='published')c=n>0?'c-pub':'c-zero';
    else if(n>0)c='c-act';
    const arr=i<STAGES.length-1?'<span class="arr">›</span>':'';
    return`<div class="stage"><div class="sn ${c}">${n}</div><div class="sl">${s.l}</div></div>${arr}`;
  }).join('');

  const extras=document.getElementById('extras');
  const nh=counts.needs_human||0,fa=counts.failed||0;
  const nq=p.next_queued;
  let ex='';
  if(nh)ex+=`<span class="c-err">⚠ needs_human: ${nh}</span>`;
  if(fa)ex+=`<span class="c-err">✗ failed: ${fa}</span>`;
  if(nq&&!nh&&!fa)ex+=`<span style="color:#334155">다음 예약 KST ${kst(nq)}</span>`;
  extras.innerHTML=ex;

  // Channels
  ['selfhosted','tistory'].forEach(ch=>{
    const el=document.getElementById('ch-'+ch);
    const row=(p.by_channel||{})[ch]||{};
    const inv=INV.reduce((s,k)=>s+(row[k]||0),0);
    let html=`
      <div class="cs"><span>인벤토리</span><span>${inv}</span></div>
      <div class="cs"><span>큐</span><span>${(row.queued||0)+(row.publishing||0)}</span></div>
      <div class="cs"><span>발행</span><span>${row.published||0}</span></div>`;
    if(row.needs_human)html+=`<div class="cs"><span class="c-err">수동처리</span><span class="c-err">${row.needs_human}</span></div>`;
    if(row.failed)html+=`<div class="cs"><span class="c-err">실패</span><span class="c-err">${row.failed}</span></div>`;
    el.innerHTML=html;
  });

  // Recent posts
  const posts=p.recent_posts||[];
  const rEl=document.getElementById('recent-posts');
  if(!posts.length){rEl.textContent='발행 이력 없음';return;}
  const chTag=ch=>{
    const cls={'selfhosted':'ch-selfhosted','tistory':'ch-tistory','naver':'ch-naver'}[ch]||'';
    return`<span class="ch-tag ${cls}">${ch}</span>`;
  };
  const fmtDate=s=>{
    if(!s)return'—';
    try{
      const d=new Date(s.replace(' ','T')+'Z');
      return d.toLocaleString('ko-KR',{timeZone:'Asia/Seoul',hour12:false,month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
    }catch{return s.slice(0,16);}
  };
  rEl.innerHTML=`<table class="recent-table">
    <thead><tr><th>채널</th><th style="width:100%">제목</th><th>발행일시</th></tr></thead>
    <tbody>${posts.map(p=>`<tr>
      <td>${chTag(p.channel)}</td>
      <td><a class="post-link" href="${p.url}" target="_blank" title="${p.title||''}">${p.title||'(제목 없음)'}</a></td>
      <td class="post-date">${fmtDate(p.updated_at)}</td>
    </tr>`).join('')}</tbody>
  </table>`;
}

let cd=30,cdTimer;
function tick(){
  document.getElementById('cd').textContent=cd+'s';
  if(--cd<0){clearInterval(cdTimer);refresh();}
}
function refresh(){
  fetch('/api/status').then(r=>r.json()).then(d=>{render(d);cd=30;clearInterval(cdTimer);cdTimer=setInterval(tick,1000);}).catch(()=>{cd=30;clearInterval(cdTimer);cdTimer=setInterval(tick,1000);});
}
refresh();
</script>
</body>
</html>"""


class _Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/api/status":
            body = json.dumps(_status(), ensure_ascii=False).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif self.path in ("/", "/index.html"):
            body = _HTML.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, *_):
        pass


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=5050)
    ap.add_argument(
        "--no-browser",
        action="store_true",
        default=bool(os.environ.get("DASHBOARD_NO_BROWSER")),
        help="Do not auto-open a browser (use when running as a service).",
    )
    args = ap.parse_args()
    url = f"http://localhost:{args.port}"
    print(f"대시보드: {url}")
    print(f"DB: {DB_PATH}")
    print(f"health.json: {HEALTH_FILE}")
    print("종료: Ctrl+C")
    if not args.no_browser:
        Timer(1.0, lambda: webbrowser.open(url)).start()
    # ThreadingHTTPServer: 한 요청이 느리거나 막혀도(예: DB 잠금) 전체 페이지가
    # 멈추지 않도록 요청마다 별도 스레드로 처리한다.
    ThreadingHTTPServer(("127.0.0.1", args.port), _Handler).serve_forever()
