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
    "sync-snapshot",
    "quality-selftest",
    "image-audit",
    "status"
  )]
  [string]$Task,

  [string]$RepoRoot = "C:\beokmkt",
  [string]$Python = "python",
  [switch]$NoPull
)

$ErrorActionPreference = "Stop"

$PublisherDir = Join-Path $RepoRoot "blog_publisher"
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
  Write-Log "git pull --ff-only"
  git pull --ff-only 2>&1 | Tee-Object -FilePath $logPath -Append
}

$argsByTask = @{
  "stock-seed"       = @("run.py", "stock_seed", "selfhosted", "15")
  "generate"         = @("run.py", "generate")
  "factcheck"        = @("run.py", "factcheck")
  "review"           = @("run.py", "review")
  "schedule"         = @("run.py", "schedule")
  "publish"          = @("run.py", "publish")
  "recover"          = @("run.py", "recover")
  "backup"           = @("run.py", "backup")
  "verify-public"    = @("run.py", "verify_public", "20")
  "sync-snapshot"    = @("run.py", "sync_snapshot")
  "quality-selftest" = @("run.py", "quality_selftest")
  "image-audit"      = @("run.py", "image_audit")
  "status"           = @("run.py", "status")
}

Set-Location $PublisherDir
Write-Log "$Python $($argsByTask[$Task] -join ' ')"
& $Python @($argsByTask[$Task]) 2>&1 | Tee-Object -FilePath $logPath -Append
$exitCode = $LASTEXITCODE
Write-Log "exit=$exitCode"
exit $exitCode
