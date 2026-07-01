param(
  [Parameter(Mandatory = $true)]
  [ValidateSet(
    "stock-seed",
    "stock-seed-notebook-return",
    "generate",
    "factcheck",
    "review",
    "schedule",
    "publish",
    "recover",
    "backup",
    "verify-public",
    "reset-pre-quality",
    "reset-draft-backlog",
    "content-reboot",
    "cleanup-selfhosted-blocked",
    "sync-snapshot",
    "quality-selftest",
    "image-audit",
    "status"
  )]
  [string]$Task,

  [string]$RepoRoot = "C:\beokmkt",
  [string]$Python = "python",
  [switch]$NoPull,
  [switch]$RunControl,
  [switch]$SkipControl
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

$PublisherDir = Join-Path $RepoRoot "blog_publisher"
$GitUpdate = Join-Path $RepoRoot "blog_publisher\ops\windows\git-update.ps1"
$RunControlScript = Join-Path $RepoRoot "blog_publisher\ops\windows\run-control.ps1"
$LogDir = Join-Path $RepoRoot "logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
$runStamp = Get-Date -Format "yyyyMMdd-HHmmss"
$safeTask = $Task -replace '[^A-Za-z0-9_-]', '-'
$logPath = Join-Path $LogDir "blog-$safeTask-$runStamp-$PID.log"

function Write-Log([string]$Message) {
  "[$stamp] $Message" | Tee-Object -FilePath $logPath -Append
}

if (!(Test-Path $PublisherDir)) {
  throw "RepoRoot is invalid or not cloned: $RepoRoot"
}

Set-Location $RepoRoot

if (!$NoPull) {
  . $GitUpdate
  Invoke-BlogGitUpdate -RepoRoot $RepoRoot -LogPath $logPath
}

if ($RunControl -and !$SkipControl -and (Test-Path $RunControlScript)) {
  Write-Log "pipeline control poll"
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File $RunControlScript `
    -RepoRoot $RepoRoot `
    -Python $Python `
    -MaxCommands 2 `
    -NoPull 2>&1 | Tee-Object -FilePath $logPath -Append
}

$argsByTask = @{
  "stock-seed"       = @("run.py", "stock_seed", "selfhosted", "40")
  "stock-seed-notebook-return" = @("run.py", "stock_seed", "notebook_return", "10")
  "generate"         = @("run.py", "generate")
  "factcheck"        = @("run.py", "factcheck")
  "review"           = @("run.py", "review")
  "schedule"         = @("run.py", "schedule")
  "publish"          = @("run.py", "publish")
  "recover"          = @("run.py", "recover")
  "backup"           = @("run.py", "backup")
  "verify-public"    = @("run.py", "verify_public", "20")
  "reset-pre-quality" = @("run.py", "reset_pre_quality", "--apply")
  "reset-draft-backlog" = @("run.py", "reset_draft_backlog", "--apply")
  "content-reboot"   = @("run.py", "content_reboot", "--apply")
  "cleanup-selfhosted-blocked" = @("run.py", "cleanup_selfhosted_blocked")
  "sync-snapshot"    = @("run.py", "sync_snapshot")
  "quality-selftest" = @("run.py", "quality_selftest")
  "image-audit"      = @("run.py", "image_audit")
  "status"           = @("run.py", "status")
}

# Firebase 서비스계정 키가 있으면 ADC 경로로 연결(sync-snapshot의 Firestore 쓰기용).
# 키는 .secrets/firebase-admin.json (gitignore됨)에 두면 자동 인식된다.
if (-not $env:GOOGLE_APPLICATION_CREDENTIALS) {
  $saKey = Join-Path $PublisherDir ".secrets\firebase-admin.json"
  if (Test-Path $saKey) {
    $env:GOOGLE_APPLICATION_CREDENTIALS = $saKey
    Write-Log "GOOGLE_APPLICATION_CREDENTIALS=$saKey"
  }
}

Set-Location $PublisherDir
Write-Log "$Python $($argsByTask[$Task] -join ' ')"
& $Python @($argsByTask[$Task]) 2>&1 | Tee-Object -FilePath $logPath -Append
$exitCode = $LASTEXITCODE
Write-Log "exit=$exitCode"
exit $exitCode
