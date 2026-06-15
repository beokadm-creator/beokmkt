#!/usr/bin/env bash
# macOS 운영 자동화 중지. Windows 운영 PC로 이관할 때 중복 실행을 막는다.
set -euo pipefail

backup="/tmp/beokmkt.crontab.disabled.$(date +%Y%m%d%H%M%S)"
crontab -l > "$backup" 2>/dev/null || true
crontab -r 2>/dev/null || true
echo "crontab removed. backup: $backup"

for label in \
  com.beok.blog-worker \
  com.beok.blog-stock-seed \
  com.beok.blog-generate \
  com.beok.blog-factcheck \
  com.beok.blog-review \
  com.beok.blog-schedule \
  com.beok.blog-publish \
  com.beok.blog-recover \
  com.beok.blog-backup \
  com.beok.blog-sync-snapshot \
  com.beok.blog-verify-public \
  com.beok.blog-quality-selftest \
  com.beok.blog-image-audit \
  com.beokmkt.blog-keepalive
do
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null \
    || launchctl unload -w "$HOME/Library/LaunchAgents/$label.plist" 2>/dev/null \
    || true
done

echo "remaining LaunchAgents:"
launchctl list | grep -E 'com\.beok\.blog|beokmkt\.blog' || true
