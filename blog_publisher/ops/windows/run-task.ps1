param(
  [Parameter(Mandatory = $true)]
  [ValidateSet(
    "stock-seed",
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
    "sync-snapshot",
    "quality-selftest",
    "image-audit",
    "status"
  )]
  [string]$Task,

  [string]$RepoRoot = "C:\beokmkt",
  [string]$Python = "python",
  [switch]$NoPull,
  [switch]$SkipControl
)

$ErrorActionPreference = "Stop"

$PublisherDir = Join-Path $RepoRoot "blog_publisher"
$GitUpdate = Join-Path $RepoRoot "blog_publisher\ops\windows\git-update.ps1"
$RunControl = Join-Path $RepoRoot "blog_publisher\ops\windows\run-control.ps1"
$LogDir = Join-Path $RepoRoot "logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
$logPath = Join-Path $LogDir "blog-$Task.log"

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

if (!$SkipControl -and (Test-Path $RunControl)) {
  Write-Log "pipeline control poll"
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File $RunControl `
    -RepoRoot $RepoRoot `
    -Python $Python `
    -MaxCommands 2 2>&1 | Tee-Object -FilePath $logPath -Append
}

$argsByTask = @{
  "stock-seed"       = @("run.py", "stock_seed", "selfhosted", "40")
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
