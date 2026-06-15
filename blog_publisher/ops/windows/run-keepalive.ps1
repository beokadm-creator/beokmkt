param(
  [string]$RepoRoot = "C:\beokmkt",
  [string]$Node = "node",
  [int]$MaxJitterSeconds = 1800,
  [switch]$NoPull
)

$ErrorActionPreference = "Stop"

$WorkerDir = Join-Path $RepoRoot "executors\naver-blog-worker"
$LogDir = Join-Path $RepoRoot "logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$logPath = Join-Path $LogDir "blog-keepalive.log"

function Write-Log([string]$Message) {
  "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $Message" | Tee-Object -FilePath $logPath -Append
}

if (!(Test-Path $WorkerDir)) {
  throw "Worker directory not found: $WorkerDir"
}

if ($MaxJitterSeconds -gt 0) {
  $delay = Get-Random -Minimum 0 -Maximum $MaxJitterSeconds
  Write-Log "jitter sleep ${delay}s"
  Start-Sleep -Seconds $delay
}

Set-Location $RepoRoot

if (!$NoPull) {
  Write-Log "git pull --ff-only"
  git pull --ff-only 2>&1 | Tee-Object -FilePath $logPath -Append
}

Set-Location $WorkerDir
if (!(Test-Path "node_modules")) {
  Write-Log "npm install"
  npm install 2>&1 | Tee-Object -FilePath $logPath -Append
}

Write-Log "$Node keepalive.mjs"
& $Node "keepalive.mjs" 2>&1 | Tee-Object -FilePath $logPath -Append
$exitCode = $LASTEXITCODE
Write-Log "exit=$exitCode"
exit $exitCode
