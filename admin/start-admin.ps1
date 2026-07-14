$root = Split-Path -Parent $PSScriptRoot
$python = Join-Path $root '.venv\Scripts\python.exe'
if (-not (Test-Path $python)) { $python = 'python' }
Start-Process powershell -ArgumentList '-NoExit', '-Command', "Set-Location '$PSScriptRoot'; & '$python' -m uvicorn server:app --host 127.0.0.1 --port 6700" -WindowStyle Hidden
Set-Location (Join-Path $PSScriptRoot 'frontend')
npm run dev -- --host 127.0.0.1
