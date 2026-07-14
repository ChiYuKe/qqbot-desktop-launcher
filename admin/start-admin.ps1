$root = Split-Path -Parent $PSScriptRoot
$python = Join-Path $root '.venv\Scripts\python.exe'
if (-not (Test-Path $python)) { $python = 'python' }
$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$token = -join ($bytes | ForEach-Object { $_.ToString('x2') })
$env:QQ_CONSOLE_TOKEN = $token
$env:VITE_QQ_CONSOLE_TOKEN = $token
Start-Process powershell -ArgumentList '-NoExit', '-Command', "Set-Location '$PSScriptRoot'; & '$python' server.py" -WindowStyle Hidden
Set-Location (Join-Path $PSScriptRoot 'frontend')
npm run dev -- --host 127.0.0.1
