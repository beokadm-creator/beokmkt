function Invoke-BlogGitUpdate {
  param(
    [Parameter(Mandatory = $true)]
    [string]$RepoRoot,

    [Parameter(Mandatory = $true)]
    [string]$LogPath,

    [int]$TimeoutSeconds = 120,
    [int]$StaleMinutes = 10
  )

  function Write-GitUpdateLog([string]$Message) {
    "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $Message" | Tee-Object -FilePath $LogPath -Append
  }

  $gitDir = Join-Path $RepoRoot ".git"
  if (!(Test-Path $gitDir)) {
    Write-GitUpdateLog "git update skipped: .git directory not found"
    return
  }

  $lockDir = Join-Path $gitDir "beok-update.lock"
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $acquired = $false

  while ((Get-Date) -lt $deadline) {
    try {
      New-Item -ItemType Directory -Path $lockDir -ErrorAction Stop | Out-Null
      $acquired = $true
      break
    } catch {
      $lock = Get-Item $lockDir -ErrorAction SilentlyContinue
      if ($lock -and ((Get-Date) - $lock.LastWriteTime).TotalMinutes -gt $StaleMinutes) {
        Write-GitUpdateLog "removing stale git update lock: $lockDir"
        Remove-Item -Recurse -Force $lockDir -ErrorAction SilentlyContinue
        continue
      }
      Start-Sleep -Seconds 2
    }
  }

  if (!$acquired) {
    Write-GitUpdateLog "git update lock busy; continuing with current checkout"
    return
  }

  $prevEAP = $ErrorActionPreference
  try {
    Set-Location $RepoRoot
    Write-GitUpdateLog "git fetch origin main; git merge --ff-only origin/main"
    $ErrorActionPreference = "Continue"

    git fetch origin main 2>&1 | Tee-Object -FilePath $LogPath -Append
    $fetchExit = $LASTEXITCODE
    if ($fetchExit -ne 0) {
      Write-GitUpdateLog "WARN: git fetch failed (exit=$fetchExit); continuing with current checkout"
      return
    }

    git merge --ff-only origin/main 2>&1 | Tee-Object -FilePath $LogPath -Append
    $mergeExit = $LASTEXITCODE
    if ($mergeExit -ne 0) {
      Write-GitUpdateLog "WARN: git merge failed (exit=$mergeExit); continuing with current checkout"
      return
    }
  } finally {
    $ErrorActionPreference = $prevEAP
    Remove-Item -Recurse -Force $lockDir -ErrorAction SilentlyContinue
  }
}
