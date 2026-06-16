param(
  [string]$RepoRoot  = "C:\beokmkt",
  [string]$Python    = "C:\Users\Aaron\AppData\Local\Programs\Python\Python312\python.exe",
  [string]$StatusDir = "C:\Users\Aaron\Claude\Projects\beokmkt\status",
  [int]$Port         = 7070
)

$ErrorActionPreference = "Stop"

$Script = Join-Path $RepoRoot "blog_publisher\ops\windows\dashboard.py"
$DbPath = Join-Path $RepoRoot "blog_publisher\db\blog.db"

if (!(Test-Path $Script)) { throw "dashboard.py not found: $Script" }
if (!(Test-Path $DbPath))  { throw "blog.db not found: $DbPath" }

$env:SESSION_STATUS_DIR = $StatusDir
$env:BLOG_DB_PATH       = $DbPath

Write-Host "대시보드 시작: http://localhost:$Port" -ForegroundColor Cyan
& $Python $Script --port $Port
