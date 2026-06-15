param(
  [string]$RepoRoot = "C:\beokmkt",
  [string]$Python = "python",
  [string]$Node = "node",
  [string]$TaskPrefix = "BEOK Blog",
  [switch]$NoPull
)

$ErrorActionPreference = "Stop"

$OpsDir = Join-Path $RepoRoot "blog_publisher\ops\windows"
$RunTask = Join-Path $OpsDir "run-task.ps1"
$RunWorker = Join-Path $OpsDir "run-worker.ps1"
$RunKeepalive = Join-Path $OpsDir "run-keepalive.ps1"
$RunMonitor   = Join-Path $OpsDir "run-session-monitor.ps1"

if (!(Test-Path $RunTask) -or !(Test-Path $RunWorker) -or !(Test-Path $RunKeepalive)) {
  throw "Windows ops scripts not found. Clone/pull repo first: $RepoRoot"
}

function Quote([string]$Value) {
  return '"' + $Value.Replace('"', '\"') + '"'
}

function Register-MinuteTask([string]$Name, [string]$Task, [int]$Minutes) {
  $pullArg = if ($NoPull) { " -NoPull" } else { "" }
  $tn = "$TaskPrefix $Name"
  $tr = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File $(Quote $RunTask) -RepoRoot $(Quote $RepoRoot) -Python $(Quote $Python) -Task $Task$pullArg"
  schtasks /Create /F /TN $tn /SC MINUTE /MO $Minutes /TR $tr | Out-Host
}

function Register-DailyTask([string]$Name, [string]$Task, [string]$Time) {
  $pullArg = if ($NoPull) { " -NoPull" } else { "" }
  $tn = "$TaskPrefix $Name"
  $tr = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File $(Quote $RunTask) -RepoRoot $(Quote $RepoRoot) -Python $(Quote $Python) -Task $Task$pullArg"
  schtasks /Create /F /TN $tn /SC DAILY /ST $Time /TR $tr | Out-Host
}

function Register-DailyKeepalive([string]$Name, [string]$Time) {
  $pullArg = if ($NoPull) { " -NoPull" } else { "" }
  $tn = "$TaskPrefix $Name"
  $tr = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File $(Quote $RunKeepalive) -RepoRoot $(Quote $RepoRoot) -Node $(Quote $Node)$pullArg"
  schtasks /Create /F /TN $tn /SC DAILY /ST $Time /TR $tr | Out-Host
}

function Register-SessionMonitor() {
  $tn = "BEOK Session Monitor"
  $tr = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File $(Quote $RunMonitor) -RepoRoot $(Quote $RepoRoot) -Python $(Quote $Python)"
  schtasks /Create /F /TN $tn /SC HOURLY /MO 2 /TR $tr | Out-Host
}

function Register-StartupWorker() {
  $pullArg = if ($NoPull) { " -NoPull" } else { "" }
  $tn = "$TaskPrefix Worker"
  $tr = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File $(Quote $RunWorker) -RepoRoot $(Quote $RepoRoot) -Node $(Quote $Node)$pullArg"
  schtasks /Create /F /TN $tn /SC ONSTART /RL HIGHEST /TR $tr | Out-Host
}

Register-StartupWorker
Register-SessionMonitor
Register-DailyKeepalive "Keepalive AM" "10:00"
Register-DailyKeepalive "Keepalive PM" "22:00"
Register-MinuteTask "Stock Seed" "stock-seed" 60
Register-MinuteTask "Generate" "generate" 30
Register-MinuteTask "Factcheck" "factcheck" 15
Register-MinuteTask "Review" "review" 30
Register-MinuteTask "Schedule" "schedule" 15
Register-MinuteTask "Publish" "publish" 5
Register-MinuteTask "Recover" "recover" 30
Register-MinuteTask "Sync Snapshot" "sync-snapshot" 30
Register-DailyTask "Backup" "backup" "04:00"
Register-DailyTask "Verify Public" "verify-public" "05:17"
Register-DailyTask "Quality Selftest" "quality-selftest" "06:23"
Register-DailyTask "Image Audit" "image-audit" "05:41"

Write-Host ""
Write-Host "Registered Windows tasks with prefix: $TaskPrefix"
Write-Host "Start worker now:"
Write-Host "  schtasks /Run /TN `"$TaskPrefix Worker`""
Write-Host "Run keepalive now:"
Write-Host "  schtasks /Run /TN `"$TaskPrefix Keepalive AM`""
Write-Host "Run status check:"
Write-Host "  powershell -ExecutionPolicy Bypass -File `"$RunTask`" -RepoRoot `"$RepoRoot`" -Task status"
