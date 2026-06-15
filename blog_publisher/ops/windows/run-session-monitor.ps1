param(
  [string]$RepoRoot = "C:\beokmkt",
  [string]$Python   = "python",
  [string]$StatusDir = "C:\Users\Aaron\Claude\Projects\beokmkt\status"
)

$ErrorActionPreference = "Stop"

$Script  = Join-Path $RepoRoot "blog_publisher\ops\windows\session-monitor.py"
$LogDir  = Join-Path $RepoRoot "logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$logPath = Join-Path $LogDir "session-monitor.log"

function Write-Log([string]$Message) {
  "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $Message" | Tee-Object -FilePath $logPath -Append
}

Write-Log "session-monitor start"

$env:REPO_ROOT          = $RepoRoot
$env:SESSION_STATUS_DIR = $StatusDir

& $Python $Script 2>&1 | Tee-Object -FilePath $logPath -Append
$exitCode = $LASTEXITCODE
Write-Log "exit=$exitCode"
exit $exitCode
