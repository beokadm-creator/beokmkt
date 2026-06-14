#!/usr/bin/env bash
# 운영 자동화 설치 (감사 후속). macOS 기준.
# 사용: bash blog_publisher/ops/install-ops.sh
set -euo pipefail

REPO="/Users/aaron/Developer/personal/beokmkt"
WORKERDIR="$REPO/executors/naver-blog-worker"
OPSDIR="$REPO/blog_publisher/ops"
PLIST="com.beok.blog-worker.plist"

echo "▶ 1) 워커 LaunchAgent 설치"
mkdir -p "$HOME/Library/LaunchAgents"
cp "$WORKERDIR/$PLIST" "$HOME/Library/LaunchAgents/$PLIST"
# 기존 임시 실행(launchctl submit)과 이전 LaunchAgent를 정리 후 로드
launchctl remove beokmkt.blog-worker 2>/dev/null || true
launchctl unload -w "$HOME/Library/LaunchAgents/$PLIST" 2>/dev/null || true
launchctl load -w "$HOME/Library/LaunchAgents/$PLIST"
echo "  설치됨. 상태: $(launchctl list | grep com.beok.blog-worker || echo '미확인')"

echo "▶ 1-1) 품질 점검 LaunchAgent 설치"
for quality_plist in \
  com.beok.blog-verify-public.plist \
  com.beok.blog-quality-selftest.plist \
  com.beok.blog-image-audit.plist
do
  cp "$OPSDIR/$quality_plist" "$HOME/Library/LaunchAgents/$quality_plist"
  launchctl unload -w "$HOME/Library/LaunchAgents/$quality_plist" 2>/dev/null || true
  launchctl load -w "$HOME/Library/LaunchAgents/$quality_plist"
  echo "  설치됨: $quality_plist"
done

echo "▶ 2) 로그 로테이션(newsyslog) 설치 — sudo 필요"
if sudo -n true 2>/dev/null; then
  sudo cp "$OPSDIR/newsyslog-blog.conf" /etc/newsyslog.d/blog.conf
  echo "  /etc/newsyslog.d/blog.conf 설치됨 (드라이런: sudo newsyslog -nv)"
else
  echo "  ⚠ sudo 권한 필요. 수동 설치: sudo cp $OPSDIR/newsyslog-blog.conf /etc/newsyslog.d/blog.conf"
fi

echo "▶ 3) crontab 설치"
echo "  현재 crontab 백업 → /tmp/crontab.backup.$(date +%s)"
crontab -l > "/tmp/crontab.backup.$(date +%s)" 2>/dev/null || true
echo "  ⚠ 기존 항목과 병합이 필요할 수 있습니다. 검토 후 적용:"
echo "      crontab $OPSDIR/crontab.example"
echo "  참고: 공개 URL 검증/품질 셀프테스트/이미지 감사는 LaunchAgent로도 설치됩니다."

echo "▶ 4) 헬스 체크"
sleep 2
curl -fsS http://localhost:8788/health && echo "  worker /health OK" || echo "  ⚠ worker 미응답(잠시 후 재확인)"

echo "완료. 워커 로그: tail -f /tmp/blog-worker.log"
