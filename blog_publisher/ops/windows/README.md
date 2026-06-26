# Windows 운영 PC 이관

맥은 개발 전용으로 두고, Windows PC가 GitHub에서 pull 받은 뒤 자동 생성/검수/발행을 수행하는 운영 구성이다.

## 1. Windows PC 준비

필수 설치:

- Git
- Python 3.11 이상
- Node.js 20 이상
- PowerShell 5 이상

저장소 복제:

```powershell
cd C:\
git clone https://github.com/beokadm-creator/beokmkt.git C:\beokmkt
cd C:\beokmkt
```

Python/Node 의존성:

```powershell
pip install -r C:\beokmkt\blog_publisher\requirements.txt
cd C:\beokmkt\executors\naver-blog-worker
npm install
```

## 2. 운영 파일 이관

Git에 넣지 않는 운영 파일은 최초 1회 복사한다.

필수:

- `blog_publisher\.env`
- `executors\naver-blog-worker\.env`
- `blog_publisher\db\blog.db`

권장:

- `blog_publisher\db\backups\`
- `executors\naver-blog-worker\.session\tistory-session.json`

티스토리 세션은 PC/IP/브라우저가 바뀌면 만료될 수 있다. Windows에서 다음 명령으로 재로그인하는 편이 안전하다.

```powershell
cd C:\beokmkt\executors\naver-blog-worker
npm run tistory-auth
```

## 3. 작업 스케줄러 등록

관리자 PowerShell에서 실행:

```powershell
powershell -ExecutionPolicy Bypass -File C:\beokmkt\blog_publisher\ops\windows\install-windows-tasks.ps1 -RepoRoot C:\beokmkt
```

등록되는 작업:

- 부팅 시 `BEOK Blog Worker`: Node 워커 실행
- 매일 10:00, 22:00 `BEOK Blog Keepalive AM/PM`: 티스토리/네이버 세션 갱신 확인
- 1분마다 `BEOK Blog Control`: Firebase 명령 큐 폴링, worker health watchdog
- 5분마다 `publish`
- 15분마다 `factcheck`
- 30분마다 `generate/review/recover/sync_snapshot`
- 15분마다 `schedule`
- 60분마다 `stock_seed selfhosted 40`
- 매일 `backup/verify_public/quality_selftest/image_audit`

각 작업은 실행 전에 `git fetch origin main` + `git merge --ff-only origin/main`을 시도한다. 여러 예약 작업이 동시에 떠도 `.git/beok-update.lock`으로 Git 업데이트를 직렬화하며, GitHub 일시 장애나 잠금 경합이 있어도 현재 checkout으로 본 작업은 계속 실행한다. 운영 PC에 로컬 코드 수정이 있으면 merge가 실패하므로, 운영 PC에서는 코드를 수정하지 않는다. 분 단위 작업은 20분 실행 제한과 `IgnoreNew`로 등록되어, 멈춘 작업이 기본 72시간 동안 다음 실행을 막지 않게 한다.

## 4. 즉시 점검

```powershell
schtasks /Run /TN "BEOK Blog Worker"
schtasks /Run /TN "BEOK Blog Keepalive AM"

powershell -ExecutionPolicy Bypass -File C:\beokmkt\blog_publisher\ops\windows\run-task.ps1 -RepoRoot C:\beokmkt -Task status
powershell -ExecutionPolicy Bypass -File C:\beokmkt\blog_publisher\ops\windows\run-task.ps1 -RepoRoot C:\beokmkt -Task quality-selftest
powershell -ExecutionPolicy Bypass -File C:\beokmkt\blog_publisher\ops\windows\run-task.ps1 -RepoRoot C:\beokmkt -Task verify-public
```

Firebase Functions에서 Windows 운영 PC에 작업을 지시할 수 있다. Function은 Firestore에 명령을 넣고, Windows의 `run-control.ps1`이 outbound로 가져가 허용된 작업만 실행한다.

```bash
curl -X POST https://beoksolution.com/api/pipeline/commands \
  -H "X-API-Key: $BLOG_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"runbook":"reset-draft-backlog-and-drain","reason":"품질 낮은 미공개 draft 리셋 후 새 원고 생성"}'
```

지원 runbook:

- `status-refresh`: `status` → `sync-snapshot`
- `drain-once`: `generate` → `factcheck` → `review` → `schedule` → `publish` → `sync-snapshot`
- `reset-draft-backlog-and-drain`: `reset-draft-backlog` → `generate` → `factcheck` → `review` → `schedule` → `sync-snapshot`

명령 폴링은 `BEOK Blog Control` 태스크가 1분마다 전담한다. `generate/factcheck/review/schedule/publish` 예약 작업은 자기 단계만 실행하므로, 5분 주기 `Publish`가 긴 `generate` 큐 명령에 점유되지 않는다. Control 태스크는 Node worker health도 확인하고 죽어 있으면 `BEOK Blog Worker` 태스크를 다시 실행한다.

미공개 draft가 품질 조정 이전 원고로 막혀 있으면, 먼저 dry-run으로 대상과 새 주제를 확인한 뒤 적용한다.

```powershell
cd C:\beokmkt\blog_publisher
python run.py reset_draft_backlog

# 확인 후 적용
powershell -ExecutionPolicy Bypass -File C:\beokmkt\blog_publisher\ops\windows\run-task.ps1 -RepoRoot C:\beokmkt -Task reset-draft-backlog -NoPull
```

워커 헬스체크:

```powershell
curl http://127.0.0.1:8788/health
```

로그 위치:

```text
C:\beokmkt\logs\
```

## 5. 맥 운영 중지 확인

맥에서는 자동 실행이 없어야 한다.

```bash
crontab -l
launchctl list | rg 'com\.beok\.blog|beokmkt\.blog'
```

둘 다 비어 있어야 Windows PC가 단일 운영 주체가 된다.

## 6. 주의

- `blog_publisher\db\blog.db`는 단일 운영 PC에서만 써야 한다.
- 맥과 Windows가 동시에 `generate/publish`를 돌리면 중복 발행 또는 상태 꼬임이 생길 수 있다.
- 네이버 자동 발행은 현재 운영 범위에서 제외한다.
- 티스토리는 품질 확인 후 수동 seed를 권장한다. 자동 seed는 `ALLOW_EXTERNAL_AUTO_SEED=true` 정책을 다시 검토한 뒤 켠다.
