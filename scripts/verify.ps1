$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$python = Join-Path $root ".venv\Scripts\python.exe"
$frontend = Join-Path $root "admin\frontend"
$desktop = Join-Path $root "admin\desktop"
$tests = Join-Path $root "tests"

if (-not (Test-Path -LiteralPath $python)) {
    throw "找不到 Python 虚拟环境：$python"
}

Push-Location $root
try {
    if (Test-Path -LiteralPath $tests) {
        & $python -m pytest
        if ($LASTEXITCODE -ne 0) { throw "pytest 未通过" }
        & $python -m ruff check admin tests
    } else {
        & $python -m ruff check admin
    }
    if ($LASTEXITCODE -ne 0) { throw "Ruff 未通过" }

    & $python -m mypy
    if ($LASTEXITCODE -ne 0) { throw "mypy 未通过" }

    npm --prefix $frontend run lint
    if ($LASTEXITCODE -ne 0) { throw "前端 lint 未通过" }

    npm --prefix $frontend run typecheck
    if ($LASTEXITCODE -ne 0) { throw "前端类型检查未通过" }

    npm --prefix $frontend run test
    if ($LASTEXITCODE -ne 0) { throw "前端测试未通过" }

    npm --prefix $frontend run build
    if ($LASTEXITCODE -ne 0) { throw "前端构建未通过" }

    npm --prefix $desktop run check
    if ($LASTEXITCODE -ne 0) { throw "Electron 检查未通过" }

    npm --prefix $desktop run test
    if ($LASTEXITCODE -ne 0) { throw "Electron 测试未通过" }
}
finally {
    Pop-Location
}

