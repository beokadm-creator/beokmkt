param(
  [string]$RepoRoot = "C:\beokmkt",
  [string]$Node = "node",
  [switch]$NoPull
)

$ErrorActionPreference = "Stop"

$WorkerDir = Join-Path $RepoRoot "executors\naver-blog-worker"
$GitUpdate = Join-Path $RepoRoot "blog_publisher\ops\windows\git-update.ps1"
$LogDir = Join-Path $RepoRoot "logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$logPath = Join-Path $LogDir "blog-worker.log"

if (!(Test-Path $WorkerDir)) {
  throw "Worker directory not found: $WorkerDir"
}

Set-Location $RepoRoot

if (!$NoPull) {
  . $GitUpdate
  Invoke-BlogGitUpdate -RepoRoot $RepoRoot -LogPath $logPath
}

Set-Location $WorkerDir
if (!(Test-Path "node_modules")) {
  "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] npm install" | Tee-Object -FilePath $logPath -Append
  npm install 2>&1 | Tee-Object -FilePath $logPath -Append
}

"[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $Node index.mjs" | Tee-Object -FilePath $logPath -Append
& $Node "index.mjs" 2>&1 | Tee-Object -FilePath $logPath -Append
exit $LASTEXITCODE
