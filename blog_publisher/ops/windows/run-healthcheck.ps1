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
$StallCheckPy = Join-Path $OpsDir "stall_check.py"
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

# 1) (제거됨) node publish worker(8788) health + 재시작.
#    2026-07-23 네이버/티스토리를 콘솔 복사·붙여넣기 수동 발행으로 전환하면서
#    워커와 관련 태스크를 의도적으로 Disabled 처리했다. 그 뒤에도 이 블록이 매 주기
#    "worker DOWN" 로그를 남기고 schtasks /Run 을 시도했지만 disabled 태스크라 항상
#    실패했다. 자동 발행을 되살릴 때 워커 태스크를 Enable 하면 되므로 블록을 제거한다.

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
# 인라인 `python -c @'...'@` heredoc은 PS 5.1이 외부 exe 인자로 넘기며 SQL의
# 이중따옴표를 삼켜 SyntaxError → null .Trim() 폭발이 났다. 별도 .py로 분리 호출.
try {
  $env:REPO_ROOT = $RepoRoot
  $stallCheck = & $Python $StallCheckPy 2>&1 | Out-String
  $stallLine = ($stallCheck -split "`n" | Where-Object { $_ -match "^active=" } | Select-Object -First 1)
  $checks["stall_hours"] = if ($stallLine) { $stallLine.Trim() } else { "unknown" }
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

# 4) (제거됨) session-monitor.py 로 health.json 갱신(티스토리 세션 + 워커 health).
#    사용자가 "BEOK Session Monitor" 태스크를 의도적으로 Disabled 했는데도 이 블록이
#    같은 스크립트를 15분마다 대신 실행해 disable 의도를 무력화하고 있었다.
#    워커·세션은 은퇴했고 대시보드도 더 이상 health.json 을 표시하지 않으므로 제거한다.

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
Write-Log "healthcheck done dashboard=$dashOk actions=$actionText"
exit 0
