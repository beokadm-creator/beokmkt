param(
  [string]$RepoRoot = "C:\beokmkt",
  [string]$Node = "node",
  [switch]$NoPull
)

$ErrorActionPreference = "Stop"

$WorkerDir = Join-Path $RepoRoot "executors\naver-blog-worker"
$LogDir = Join-Path $RepoRoot "logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$logPath = Join-Path $LogDir "blog-worker.log"

if (!(Test-Path $WorkerDir)) {
  throw "Worker directory not found: $WorkerDir"
}

Set-Location $RepoRoot

if (!$NoPull) {
  "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] git fetch origin main; git merge --ff-only origin/main" | Tee-Object -FilePath $logPath -Append
  $prevEAP = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  # 동시 실행 시 FETCH_HEAD 경합을 피하려고 원격추적 ref로 merge한다.
  git fetch origin main 2>&1 | Tee-Object -FilePath $logPath -Append
  git merge --ff-only origin/main 2>&1 | Tee-Object -FilePath $logPath -Append
  $ErrorActionPreference = $prevEAP
  if ($LASTEXITCODE -ne 0) { throw "git update failed (exit=$LASTEXITCODE)" }
}

Set-Location $WorkerDir
if (!(Test-Path "node_modules")) {
  "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] npm install" | Tee-Object -FilePath $logPath -Append
  npm install 2>&1 | Tee-Object -FilePath $logPath -Append
}

"[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $Node index.mjs" | Tee-Object -FilePath $logPath -Append
& $Node "index.mjs" 2>&1 | Tee-Object -FilePath $logPath -Append
exit $LASTEXITCODE
