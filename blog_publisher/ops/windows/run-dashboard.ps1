param(
  [string]$RepoRoot  = "C:\beokmkt",
  [string]$Python    = "C:\Users\Aaron\AppData\Local\Programs\Python\Python312\python.exe",
  [string]$StatusDir = "C:\Users\Aaron\Claude\Projects\beokmkt\status",
  [int]$Port         = 7070,
  [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"

$Script = Join-Path $RepoRoot "blog_publisher\ops\windows\dashboard.py"
$DbPath = Join-Path $RepoRoot "blog_publisher\db\blog.db"
$LogDir = Join-Path $RepoRoot "logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$logPath = Join-Path $LogDir "dashboard.log"

function Write-Log([string]$Message) {
  "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $Message" | Tee-Object -FilePath $logPath -Append
}

if (!(Test-Path $Script)) { throw "dashboard.py not found: $Script" }
if (!(Test-Path $DbPath))  { throw "blog.db not found: $DbPath" }

$env:SESSION_STATUS_DIR = $StatusDir
$env:BLOG_DB_PATH       = $DbPath

# If the dashboard is already serving on this port, do nothing and exit 0. This
# is the common case for the every-minute watchdog trigger, so stay silent in
# the persistent log to avoid unbounded growth.
$existing = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host "dashboard already listening on port $Port (pid $($existing.OwningProcess -join ',')) - nothing to do"
  exit 0
}

$pyArgs = @($Script, "--port", $Port)
if ($NoBrowser) {
  $pyArgs += "--no-browser"
} else {
  Write-Host "대시보드 시작: http://localhost:$Port" -ForegroundColor Cyan
}

Write-Log "dashboard start on port $Port"
& $Python @pyArgs 2>&1 | Tee-Object -FilePath $logPath -Append
$exitCode = $LASTEXITCODE
Write-Log "dashboard exit=$exitCode"
exit $exitCode
