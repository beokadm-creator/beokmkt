"""
워커 실행 진입점. 각 단계를 독립적으로 돌린다.
cron/스케줄러에서 단계별로 호출하는 것을 권장한다(서로 격리).

예)
  python run.py init                       # DB 초기화
  python run.py seed "주제" naver review    # 시드(채널/유형: review|howto|niche)
  python run.py generate                   # 근거기반 생성(리서치→근거팩→작성)
  python run.py factcheck                  # 사실검증 게이트
  python run.py review                     # 품질 검수
  python run.py schedule
  python run.py publish
  python run.py status         # 파이프라인 상태별 건수 리포트
  python run.py verify_public  # published 공개 URL 실제 HTML 품질 검증
  python run.py quality_selftest # 렌더러/티스토리 리치 HTML 품질 회귀 검증
  python run.py image_audit    # 이미지 뱅크 공개 URL 도달성 검증
  python run.py loop           # 데모용: 한 번에 전체 흐름

  # 도구(직접 실행)
  python tools/login.py naver           # 세션 저장
  python tools/inspect_editor.py naver  # 셀렉터 점검
  python tools/measure_passrate.py      # 통과율/시간 측정

cron 예시(독립 실행)
  */30 * * * * cd /path && python run.py generate
  */30 * * * * cd /path && python run.py review
  0    * * * * cd /path && python run.py schedule
  */5  * * * * cd /path && python run.py publish
"""
from __future__ import annotations

import sys

from db import db


def main() -> None:
    if len(sys.argv) < 2:                 # 무인자 → 사용법 출력 후 오류코드(감사 B2)
        print(__doc__)
        raise SystemExit(2)
    cmd = sys.argv[1]

    if cmd == "init":
        db.init_db()
        print("DB 초기화 완료")

    elif cmd == "seed":
        # python run.py seed "주제" [channel] [content_type]
        topic = sys.argv[2]
        channel = sys.argv[3] if len(sys.argv) > 3 else "selfhosted"
        content_type = sys.argv[4] if len(sys.argv) > 4 else "howto"
        pid = db.insert_draft(channel, topic, content_type)
        print(f"draft 생성 id={pid} ({channel}/{content_type}) topic={topic!r}")

    elif cmd == "generate":
        from pipeline import generate
        print(f"생성 {generate.run_once()}건")

    elif cmd == "factcheck":
        from pipeline import factcheck
        p, f = factcheck.run_once()
        print(f"사실검증 통과 {p} / 탈락 {f}")

    elif cmd == "review":
        from pipeline import review
        p, f = review.run_once()
        print(f"검수 통과 {p} / 탈락 {f}")

    elif cmd == "schedule":
        from pipeline import schedule_publish
        print(f"큐 등록 {schedule_publish.run_once()}건")

    elif cmd == "publish":
        from pipeline import publish
        print(f"발행 {publish.run_once()}")

    elif cmd == "loop":
        from pipeline import factcheck, generate, publish, review, schedule_publish
        print("생성:", generate.run_once())
        print("사실검증:", factcheck.run_once())
        print("검수:", review.run_once())
        print("스케줄:", schedule_publish.run_once())
        print("발행:", publish.run_once())

    elif cmd == "rewrite":
        # python run.py rewrite <url> [channel] [type]
        from pipeline import rewrite
        url = sys.argv[2]
        channel = sys.argv[3] if len(sys.argv) > 3 else "selfhosted"
        ctype = sys.argv[4] if len(sys.argv) > 4 else "howto"
        rewrite.run_url(url, ctype, channel)

    elif cmd == "translate":
        # python run.py translate <post_id> [channel]
        from pipeline import translate
        translate.run_post(int(sys.argv[2]), sys.argv[3] if len(sys.argv) > 3 else None)

    elif cmd == "auto_seed":
        # python run.py auto_seed [channel] [max_seeds]
        channel = sys.argv[2] if len(sys.argv) > 2 else "selfhosted"
        max_seeds = int(sys.argv[3]) if len(sys.argv) > 3 else 3
        from tools import auto_seed
        n = auto_seed.run(channel=channel, max_seeds=max_seeds)
        print(f"auto_seed 완료: {n}건 생성")

    elif cmd == "selftest":
        from tools import selftest
        raise SystemExit(0 if selftest.run() else 1)

    elif cmd == "quality_selftest":
        from tools import quality_selftest
        raise SystemExit(0 if quality_selftest.run() else 1)

    elif cmd == "image_audit":
        from tools import image_asset_audit
        raise SystemExit(0 if image_asset_audit.run() else 1)

    elif cmd == "recover":
        import config as _cfg
        n = db.reset_stuck(threshold_minutes=_cfg.STUCK_THRESHOLD_MIN)
        print(f"stuck 복구 {n}건")

    elif cmd == "status":
        from tools import status_report
        status_report.report()

    elif cmd == "verify_public":
        from tools import verify_public_posts
        limit = int(sys.argv[2]) if len(sys.argv) > 2 else 20
        raise SystemExit(0 if verify_public_posts.run(limit) else 1)

    elif cmd == "needs_human":          # 수동 처리 대기 목록(감사 J4)
        rows = db.fetch_by_status("needs_human", limit=100)
        rows += db.fetch_by_status("failed", limit=100)
        if not rows:
            print("needs_human/failed 없음 ✓")
        for r in rows:
            print(f"  [{r['status']}] id={r['id']} ({r['channel']}/{r['content_type']}) "
                  f"{(r['title'] or r['topic'])!r}\n      err: {(r['last_error'] or '')[:120]}")

    elif cmd == "backup":               # SQLite 백업(감사 J3)
        from tools import backup_db
        print(f"백업 완료: {backup_db.run()}")

    else:
        print(__doc__)
        raise SystemExit(2)             # 알 수 없는 명령 → 오류코드(감사 B2)


if __name__ == "__main__":
    main()
