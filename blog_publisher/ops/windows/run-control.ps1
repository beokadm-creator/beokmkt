param(
  [string]$RepoRoot = "C:\beokmkt",
  [string]$Python = "python",
  [string]$TaskPrefix = "BEOK Blog",
  [int]$MaxCommands = 2,
  [switch]$NoPull
)

$ErrorActionPreference = "Stop"
try {
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
  $OutputEncoding = [Console]::OutputEncoding
  chcp 65001 | Out-Null
} catch {
  # Best effort: old PowerShell hosts may not allow changing code pages.
}
$env:PYTHONUTF8 = "1"
$env:PYTHONIOENCODING = "utf-8"

$OpsDir = Join-Path $RepoRoot "blog_publisher\ops\windows"
$RunTask = Join-Path $OpsDir "run-task.ps1"
$GitUpdate = Join-Path $OpsDir "git-update.ps1"
$PublisherDir = Join-Path $RepoRoot "blog_publisher"
$EnvPath = Join-Path $PublisherDir ".env"
$LogDir = Join-Path $RepoRoot "logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$runStamp = Get-Date -Format "yyyyMMdd-HHmmss"
$logPath = Join-Path $LogDir "blog-control-$runStamp-$PID.log"

function Write-Log([string]$Message) {
  "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $Message" | Tee-Object -FilePath $logPath -Append
}

function Read-DotEnvValue([string]$Key) {
  if (!(Test-Path $EnvPath)) { return "" }
  $line = Get-Content $EnvPath | Where-Object { $_ -match "^\s*$([regex]::Escape($Key))\s*=" } | Select-Object -First 1
  if (!$line) { return "" }
  $value = ($line -replace "^\s*$([regex]::Escape($Key))\s*=\s*", "").Trim()
  return $value.Trim('"').Trim("'")
}

function Invoke-JsonApi([string]$Path, [hashtable]$Body) {
  $json = $Body | ConvertTo-Json -Depth 8 -Compress
  return Invoke-RestMethod `
    -Uri "$BaseUrl$Path" `
    -Method Post `
    -ContentType "application/json; charset=utf-8" `
    -Headers @{ "X-API-Key" = $ApiKey } `
    -Body $json `
    -TimeoutSec 120
}

function Resolve-WorkerHealthUrl() {
  $url = $env:NAVER_WORKER_URL
  if (!$url) { $url = Read-DotEnvValue "NAVER_WORKER_URL" }
  if (!$url) { return "http://127.0.0.1:8788/health" }
  return "$($url.TrimEnd('/'))/health"
}

function Ensure-WorkerHealthy() {
  $healthUrl = Resolve-WorkerHealthUrl
  try {
    $health = Invoke-RestMethod -Uri $healthUrl -Method Get -TimeoutSec 5
    if ($health.ok) { return }
    Write-Log "worker health unhealthy response from ${healthUrl}: $($health | ConvertTo-Json -Compress)"
  } catch {
    Write-Log "worker health check failed ${healthUrl}: $($_.Exception.Message)"
  }

  $workerTask = "$TaskPrefix Worker"
  Write-Log "starting worker task: $workerTask"
  schtasks /Run /TN $workerTask 2>&1 | Tee-Object -FilePath $logPath -Append | Out-Null
}

function Get-LatestTaskLogTail([string]$Task, [int]$Tail = 120) {
  $safeTask = $Task -replace '[^A-Za-z0-9_-]', '-'
  $latest = Get-ChildItem -Path $LogDir -Filter "blog-$safeTask-*.log" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if (!$latest) { return "" }
  $body = Get-Content -Path $latest.FullName -Tail $Tail -ErrorAction SilentlyContinue | Out-String
  if (!$body) { return "" }
  return "`n--- latest task log: $($latest.FullName) ---`n$body"
}

if (!(Test-Path $RunTask)) {
  throw "run-task.ps1 not found: $RunTask"
}

Set-Location $RepoRoot
if (!$NoPull -and (Test-Path $GitUpdate)) {
  . $GitUpdate
  Invoke-BlogGitUpdate -RepoRoot $RepoRoot -LogPath $logPath
}

$BaseUrl = $env:PIPELINE_CONTROL_API_URL
if (!$BaseUrl) { $BaseUrl = Read-DotEnvValue "PIPELINE_CONTROL_API_URL" }
if (!$BaseUrl) { $BaseUrl = Read-DotEnvValue "SELFHOST_API_URL" }
if (!$BaseUrl) { $BaseUrl = "https://beokmkt.web.app" }
$BaseUrl = $BaseUrl.TrimEnd("/")

$ApiKey = $env:PIPELINE_CONTROL_API_KEY
if (!$ApiKey) { $ApiKey = Read-DotEnvValue "PIPELINE_CONTROL_API_KEY" }
if (!$ApiKey) { $ApiKey = Read-DotEnvValue "BLOG_API_KEY" }
if (!$ApiKey) { $ApiKey = Read-DotEnvValue "SELFHOST_API_KEY" }

if (!$ApiKey) {
  Write-Log "control skipped: PIPELINE_CONTROL_API_KEY/BLOG_API_KEY/SELFHOST_API_KEY not configured"
  exit 0
}

$WorkerId = $env:COMPUTERNAME
if (!$WorkerId) { $WorkerId = "windows-worker" }

$allowed = @(
  "status",
  "quality-selftest",
  "reset-draft-backlog",
  "content-reboot",
  "cleanup-selfhosted-blocked",
  "stock-seed",
  "generate",
  "factcheck",
  "review",
  "schedule",
  "publish",
  "sync-snapshot",
  "recover",
  "verify-public",
  "image-audit",
  "backup"
)

Ensure-WorkerHealthy

for ($i = 0; $i -lt $MaxCommands; $i++) {
  try {
    $claim = Invoke-JsonApi "/api/pipeline/commands/claim" @{
      worker_id = $WorkerId
      lease_ms = 1800000
    }
  } catch {
    Write-Log "claim failed: $($_.Exception.Message)"
    exit 0
  }

  $command = $claim.data.command
  if (!$command) {
    if ($i -eq 0) { Write-Log "no pending command" }
    exit 0
  }

  $commandId = [string]$command.id
  $task = [string]$command.task
  if ($allowed -notcontains $task) {
    Write-Log "unsupported command task=$task id=$commandId"
    Invoke-JsonApi "/api/pipeline/commands/$commandId/complete" @{
      ok = $false
      exit_code = 2
      worker_id = $WorkerId
      error = "unsupported task: $task"
      output = ""
    } | Out-Null
    continue
  }

  Write-Log "run command id=$commandId task=$task"
  $output = ""
  $exitCode = 1
  try {
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
      $lines = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $RunTask `
        -RepoRoot $RepoRoot `
        -Python $Python `
        -Task $task `
        -NoPull `
        -SkipControl 2>&1
      $exitCode = $LASTEXITCODE
      $output = ($lines | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine
    } finally {
      $ErrorActionPreference = $previousErrorActionPreference
    }
  } catch {
    $exitCode = 1
    $output = $_ | Out-String
  }
  $logTail = Get-LatestTaskLogTail -Task $task
  if ($logTail) { $output = "$output$logTail" }

  $ok = $exitCode -eq 0
  try {
    Invoke-JsonApi "/api/pipeline/commands/$commandId/complete" @{
      ok = $ok
      exit_code = $exitCode
      worker_id = $WorkerId
      output = $output
      error = if ($ok) { "" } else { $output }
    } | Out-Null
  } catch {
    Write-Log "complete failed id=${commandId}: $($_.Exception.Message)"
    exit 1
  }
  Write-Log "command done id=$commandId task=$task exit=$exitCode"
}
