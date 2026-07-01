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
$RunControl   = Join-Path $OpsDir "run-control.ps1"
$RunHealth    = Join-Path $OpsDir "run-healthcheck.ps1"
$RunDashboard = Join-Path $OpsDir "run-dashboard.ps1"

if (!(Test-Path $RunTask) -or !(Test-Path $RunWorker) -or !(Test-Path $RunKeepalive)) {
  throw "Windows ops scripts not found. Clone/pull repo first: $RepoRoot"
}

function Quote([string]$Value) {
  return '"' + $Value.Replace('"', '\"') + '"'
}

function Set-TaskRuntimePolicy(
  [string]$TaskName,
  [int]$Minutes = 20,
  [switch]$NoTimeLimit,
  [switch]$RestartOnFailure
) {
  $limit = if ($NoTimeLimit) { [TimeSpan]::Zero } else { New-TimeSpan -Minutes $Minutes }
  if ($RestartOnFailure) {
    $settings = New-ScheduledTaskSettingsSet `
      -ExecutionTimeLimit $limit `
      -MultipleInstances IgnoreNew `
      -Hidden `
      -RestartCount 999 `
      -RestartInterval (New-TimeSpan -Minutes 1)
  } else {
    $settings = New-ScheduledTaskSettingsSet `
      -ExecutionTimeLimit $limit `
      -MultipleInstances IgnoreNew `
      -Hidden
  }
  Set-ScheduledTask -TaskName $TaskName -Settings $settings | Out-Host
}

function Register-MinuteTask([string]$Name, [string]$Task, [int]$Minutes) {
  $pullArg = if ($NoPull) { " -NoPull" } else { "" }
  $tn = "$TaskPrefix $Name"
  $tr = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File $(Quote $RunTask) -RepoRoot $(Quote $RepoRoot) -Python $(Quote $Python) -Task $Task$pullArg"
  schtasks /Create /F /TN $tn /SC MINUTE /MO $Minutes /TR $tr | Out-Host
  Set-TaskRuntimePolicy -TaskName $tn -Minutes 20
}

function Register-DailyTask([string]$Name, [string]$Task, [string]$Time) {
  $pullArg = if ($NoPull) { " -NoPull" } else { "" }
  $tn = "$TaskPrefix $Name"
  $tr = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File $(Quote $RunTask) -RepoRoot $(Quote $RepoRoot) -Python $(Quote $Python) -Task $Task$pullArg"
  schtasks /Create /F /TN $tn /SC DAILY /ST $Time /TR $tr | Out-Host
}

function Register-DailyKeepalive([string]$Name, [string]$Time) {
  $pullArg = if ($NoPull) { " -NoPull" } else { "" }
  $tn = "$TaskPrefix $Name"
  $tr = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File $(Quote $RunKeepalive) -RepoRoot $(Quote $RepoRoot) -Node $(Quote $Node)$pullArg"
  schtasks /Create /F /TN $tn /SC DAILY /ST $Time /TR $tr | Out-Host
}

function Register-SessionMonitor() {
  $tn = "BEOK Session Monitor"
  $tr = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File $(Quote $RunMonitor) -RepoRoot $(Quote $RepoRoot) -Python $(Quote $Python)"
  schtasks /Create /F /TN $tn /SC HOURLY /MO 2 /TR $tr | Out-Host
}

function Register-ControlTask() {
  $pullArg = if ($NoPull) { " -NoPull" } else { "" }
  $tn = "$TaskPrefix Control"
  $tr = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File $(Quote $RunControl) -RepoRoot $(Quote $RepoRoot) -Python $(Quote $Python) -MaxCommands 3$pullArg"
  schtasks /Create /F /TN $tn /SC MINUTE /MO 1 /TR $tr | Out-Host
  Set-TaskRuntimePolicy -TaskName $tn -Minutes 20
}

function Register-HealthcheckTask() {
  $pullArg = if ($NoPull) { " -NoPull" } else { "" }
  $tn = "$TaskPrefix Healthcheck"
  $tr = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File $(Quote $RunHealth) -RepoRoot $(Quote $RepoRoot) -Python $(Quote $Python)$pullArg"
  schtasks /Create /F /TN $tn /SC MINUTE /MO 5 /TR $tr | Out-Host
  Set-TaskRuntimePolicy -TaskName $tn -Minutes 10
}

function Register-StartupWorker() {
  $pullArg = if ($NoPull) { " -NoPull" } else { "" }
  $tn = "$TaskPrefix Worker"
  $tr = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File $(Quote $RunWorker) -RepoRoot $(Quote $RepoRoot) -Node $(Quote $Node)$pullArg"
  schtasks /Create /F /TN $tn /SC ONSTART /RL HIGHEST /TR $tr | Out-Host
  Set-TaskRuntimePolicy -TaskName $tn -NoTimeLimit -RestartOnFailure
}

function Register-Dashboard([int]$Port = 7070) {
  # Watchdog model: fire every minute, but IgnoreNew + no time limit means the
  # long-running server stays a single Running instance and later triggers are
  # ignored. run-dashboard.ps1 also no-ops if the port is already up. If the
  # dashboard dies, the next minute trigger revives it within ~1 min, including
  # after a reboot. This is more reliable than Task Scheduler RestartOnFailure,
  # which does not fire when the child process is killed.
  $tn = "$TaskPrefix Dashboard"
  $tr = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File $(Quote $RunDashboard) -RepoRoot $(Quote $RepoRoot) -Python $(Quote $Python) -Port $Port -NoBrowser"
  schtasks /Create /F /TN $tn /SC MINUTE /MO 1 /TR $tr | Out-Host
  Set-TaskRuntimePolicy -TaskName $tn -NoTimeLimit
}

Register-StartupWorker
Register-Dashboard
Register-SessionMonitor
Register-ControlTask
Register-HealthcheckTask
Register-DailyKeepalive "Keepalive AM" "10:00"
Register-DailyKeepalive "Keepalive PM" "22:00"
Register-MinuteTask "Stock Seed" "stock-seed" 60
Register-MinuteTask "Stock Seed NotebookReturn" "stock-seed-notebook-return" 240
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
Write-Host "Run control check:"
Write-Host "  powershell -ExecutionPolicy Bypass -File `"$RunControl`" -RepoRoot `"$RepoRoot`" -MaxCommands 1"
