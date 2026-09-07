function Invoke-BlogGitUpdate {
  param(
    [Parameter(Mandatory = $true)]
    [string]$RepoRoot,

    [Parameter(Mandatory = $true)]
    [string]$LogPath,

    [int]$TimeoutSeconds = 120,
    [int]$StaleMinutes = 10,

    # 저사양 PC 최적화: 예약 작업이 실행마다 git fetch 하면 시간당 150회 이상
    # 네트워크·디스크를 친다(2코어 i3에서 체감 부하). 최근 이 시간(분) 안에
    # fetch 했으면 건너뛴다. BEOK_GIT_UPDATE_MIN_INTERVAL 로 조정 가능.
    [int]$MinIntervalMinutes = $(if ($env:BEOK_GIT_UPDATE_MIN_INTERVAL) { [int]$env:BEOK_GIT_UPDATE_MIN_INTERVAL } else { 30 })
  )

  function Write-GitUpdateLog([string]$Message) {
    "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $Message" | Tee-Object -FilePath $LogPath -Append
  }

  $gitDir = Join-Path $RepoRoot ".git"
  if (!(Test-Path $gitDir)) {
    Write-GitUpdateLog "git update skipped: .git directory not found"
    return
  }

  # 스로틀: 마지막 성공 fetch 시각 스탬프가 충분히 최신이면 통째로 건너뛴다.
  $stampFile = Join-Path $gitDir "beok-last-fetch"
  if ($MinIntervalMinutes -gt 0 -and (Test-Path $stampFile)) {
    $age = (Get-Date) - (Get-Item $stampFile).LastWriteTime
    if ($age.TotalMinutes -lt $MinIntervalMinutes) {
      return
    }
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

    # 성공한 경우에만 스탬프를 갱신해, 실패 시에는 다음 실행에서 곧바로 재시도한다.
    Set-Content -LiteralPath $stampFile -Value (Get-Date -Format 'o') -Encoding utf8 -ErrorAction SilentlyContinue
  } finally {
    $ErrorActionPreference = $prevEAP
    Remove-Item -Recurse -Force $lockDir -ErrorAction SilentlyContinue
  }
}
