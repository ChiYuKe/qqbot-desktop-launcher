$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$python = Join-Path $root '.venv\Scripts\python.exe'
$backendSource = Join-Path $root 'admin\server.py'
$backendDist = Join-Path $root 'admin\backend-dist'
$backendBuild = Join-Path $root 'admin\backend-build'
$runtimeSource = $env:QQ_BOT_PYTHON_RUNTIME
if (-not $runtimeSource) {
  $homeLine = Get-Content (Join-Path $root '.venv\pyvenv.cfg') | Where-Object { $_ -match '^home\s*=' } | Select-Object -First 1
  if ($homeLine) {
    $runtimeSource = ($homeLine -split '=', 2)[1].Trim()
  }
}
$runtimeTarget = Join-Path $root 'admin\desktop\runtime-python'

if (-not (Test-Path -LiteralPath $python)) {
  throw "Build Python not found: $python"
}
if (-not (Test-Path -LiteralPath $runtimeSource)) {
  throw "Python runtime not found: $runtimeSource"
}

New-Item -ItemType Directory -Force -Path $backendDist, $backendBuild, $runtimeTarget | Out-Null
& $python -m PyInstaller --noconfirm --clean --onefile --name qqbot-admin --paths (Join-Path $root 'admin') --distpath $backendDist --workpath $backendBuild --specpath $backendBuild $backendSource
if ($LASTEXITCODE -ne 0) {
  throw "Backend packaging failed with exit code: $LASTEXITCODE"
}

Copy-Item -Path (Join-Path $runtimeSource '*') -Destination $runtimeTarget -Recurse -Force
Write-Host "Backend and Python runtime are ready."
