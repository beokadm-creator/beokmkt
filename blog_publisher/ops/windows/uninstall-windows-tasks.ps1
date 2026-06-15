param(
  [string]$TaskPrefix = "BEOK Blog"
)

$tasks = @(
  "Worker",
  "Keepalive AM",
  "Keepalive PM",
  "Stock Seed",
  "Generate",
  "Factcheck",
  "Review",
  "Schedule",
  "Publish",
  "Recover",
  "Sync Snapshot",
  "Backup",
  "Verify Public",
  "Quality Selftest",
  "Image Audit"
)

foreach ($task in $tasks) {
  schtasks /Delete /F /TN "$TaskPrefix $task" 2>$null | Out-Null
}

Write-Host "Removed Windows tasks with prefix: $TaskPrefix"
