param(
  [string]$RepoRoot   = "C:\beokmkt",
  [string]$Python     = "python",
  [string]$StatusDir  = "C:\Users\Aaron\Claude\Projects\beokmkt\status",
  [int]$DashboardPort = 7070,
  [switch]$NoPull
)

# Health check must never hard-fail: if one recovery step errors, keep checking the rest.
$ErrorActionPreference = "Continue"
try {
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
  $OutputEncoding = [Console]::OutputEncoding
  chcp 65001 | Out-Null
} catch { }
$env:PYTHONUTF8 = "1"
$env:PYTHONIOENCODING = "utf-8"

$OpsDir       = Join-Path $RepoRoot "blog_publisher\ops\windows"
$GitUpdate    = Join-Path $OpsDir "git-update.ps1"
$DashScript   = Join-Path $OpsDir "run-dashboard.ps1"
$MonitorPy    = Join-Path $OpsDir "session-monitor.py"
$PublisherDir = Join-Path $RepoRoot "blog_publisher"
$EnvPath      = Join-Path $PublisherDir ".env"
$LogDir       = Join-Path $RepoRoot "logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
New-Item -ItemType Directory -Force -Path $StatusDir | Out-Null
$logPath = Join-Path $LogDir "blog-healthcheck.log"

function Write-Log([string]$Message) {
  "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $Message" | Tee-Object -FilePath $logPath -Append | Out-Null
}

function Read-DotEnvValue([string]$Key) {
  if (!(Test-Path $EnvPath)) { return "" }
  $line = Get-Content $EnvPath | Where-Object { $_ -match "^\s*$([regex]::Escape($Key))\s*=" } | Select-Object -First 1
  if (!$line) { return "" }
  $value = ($line -replace "^\s*$([regex]::Escape($Key))\s*=\s*", "").Trim()
  return $value.Trim('"').Trim("'")
}

Set-Location $RepoRoot
if (!$NoPull -and (Test-Path $GitUpdate)) {
  . $GitUpdate
  Invoke-BlogGitUpdate -RepoRoot $RepoRoot -LogPath $logPath
}

$actions = @()
$checks  = @{}

# 1) node publish worker (8788): restart Worker task if its /health is down.
$workerUrl = $env:NAVER_WORKER_URL
if (!$workerUrl) { $workerUrl = Read-DotEnvValue "NAVER_WORKER_URL" }
if (!$workerUrl) { $workerUrl = "http://127.0.0.1:8788" }
$workerHealthUrl = "$($workerUrl.TrimEnd('/'))/health"
$workerOk = $false
try {
  $h = Invoke-RestMethod -Uri $workerHealthUrl -Method Get -TimeoutSec 5
  $workerOk = [bool]$h.ok
} catch { $workerOk = $false }
$checks["worker"] = $workerOk
if (!$workerOk) {
  Write-Log "worker DOWN ($workerHealthUrl) -> starting BEOK Blog Worker"
  schtasks /Run /TN "BEOK Blog Worker" 2>&1 | Tee-Object -FilePath $logPath -Append | Out-Null
  $actions += "worker_restarted"
}

# 2) local dashboard (7070): relaunch hidden if the port is not listening.
$dashOk = $false
try {
  $conn = Get-NetTCPConnection -LocalPort $DashboardPort -State Listen -ErrorAction SilentlyContinue
  $dashOk = [bool]$conn
} catch { $dashOk = $false }
$checks["dashboard"] = $dashOk
if (!$dashOk -and (Test-Path $DashScript)) {
  Write-Log "dashboard DOWN (port $DashboardPort) -> launching run-dashboard.ps1"
  Start-Process -FilePath "powershell.exe" `
    -ArgumentList @("-NoProfile","-WindowStyle","Hidden","-ExecutionPolicy","Bypass","-File",$DashScript,"-RepoRoot",$RepoRoot,"-Port","$DashboardPort") `
    -WindowStyle Hidden | Out-Null
  $actions += "dashboard_restarted"
}

# 3) recover stuck pipeline posts (generating/reviewing past the stuck threshold).
try {
  Set-Location $PublisherDir
  $recoverOut = & $Python "run.py" "recover" 2>&1 | Out-String
  Set-Location $RepoRoot
  $recoverLine = ($recoverOut -split "`n" | Where-Object { $_ -match "stuck" } | Select-Object -First 1)
  if ($recoverLine) {
    $recoverLine = $recoverLine.Trim()
    $checks["recover"] = $recoverLine
    if ($recoverLine -match "stuck\D*([1-9][0-9]*)") { $actions += "stuck_recovered" }
  }
} catch {
  Write-Log "recover failed: $($_.Exception.Message)"
  $checks["recover"] = "error"
}

# 3b) stall detection: if pipeline has been idle too long with draft posts available, kick generate.
try {
  Set-Location $PublisherDir
  $stallCheck = & $Python "-c" @'
import sys, sqlite3, datetime
sys.stdout.reconfigure(errors="replace")
conn = sqlite3.connect("db/blog.db")
c = conn.cursor()
c.execute("SELECT COUNT(*) FROM posts WHERE status='queued' OR status='reviewing' OR status='reviewed' OR status='publishing'")
active = c.fetchone()[0]
c.execute("SELECT COUNT(*) FROM posts WHERE status='draft' AND (body IS NULL OR body='')")
draft_ready = c.fetchone()[0]
c.execute("SELECT MAX(updated_at) FROM posts WHERE status='published'")
last_pub = c.fetchone()[0]
conn.close()
stall_hours = 0
if last_pub:
    dt = datetime.datetime.strptime(last_pub, "%Y-%m-%d %H:%M:%S")
    stall_hours = (datetime.datetime.utcnow() - dt).total_seconds() / 3600
print(f"active={active} draft_ready={draft_ready} stall_hours={stall_hours:.1f}")
if active == 0 and draft_ready > 0 and stall_hours > 6:
    print("STALL_DETECTED")
'@ 2>&1 | Out-String
  Set-Location $RepoRoot
  $checks["stall_hours"] = ($stallCheck -split "`n" | Where-Object { $_ -match "^active=" } | Select-Object -First 1).Trim()
  if ($stallCheck -match "STALL_DETECTED") {
    Write-Log "pipeline stall detected -> triggering generate"
    Set-Location $PublisherDir
    $env:PYTHONUTF8 = "1"
    $env:PYTHONIOENCODING = "utf-8"
    & $Python "run.py" "generate" 2>&1 | Out-String | Write-Log
    Set-Location $RepoRoot
    $actions += "stall_generate_triggered"
  }
} catch {
  Write-Log "stall check failed: $($_.Exception.Message)"
}

# 4) refresh health.json (tistory session + worker) via the existing reporter.
if (Test-Path $MonitorPy) {
  try {
    Set-Location $OpsDir
    $env:REPO_ROOT = $RepoRoot
    $env:SESSION_STATUS_DIR = $StatusDir
    & $Python $MonitorPy 2>&1 | Out-Null
    Set-Location $RepoRoot
  } catch { Write-Log "session-monitor failed: $($_.Exception.Message)" }
}

# 5) write our own healthcheck.json summary (checks + recovery actions taken).
$summary = [ordered]@{
  checked_at = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  checks     = $checks
  actions    = $actions
}
try {
  ($summary | ConvertTo-Json -Depth 5) | Out-File -FilePath (Join-Path $StatusDir "healthcheck.json") -Encoding utf8
} catch { }

$actionText = if ($actions.Count) { ($actions -join ",") } else { "none" }
Write-Log "healthcheck done worker=$workerOk dashboard=$dashOk actions=$actionText"
exit 0
