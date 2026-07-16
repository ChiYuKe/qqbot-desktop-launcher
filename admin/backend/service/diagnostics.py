from __future__ import annotations

import os
import platform
import sqlite3
from datetime import datetime
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Any

import backend.config as runtime_config
from backend.database.migrations import applied_versions


def _package_version(name: str) -> str:
    try:
        return version(name)
    except PackageNotFoundError:
        return "unknown"


def _check(identifier: str, label: str, status: str, message: str, **details: Any) -> dict[str, Any]:
    return {
        "id": identifier,
        "label": label,
        "status": status,
        "message": message,
        "details": details,
    }


def _database_snapshot(database_file: Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    checks: list[dict[str, Any]] = []
    snapshot: dict[str, Any] = {
        "exists": database_file.exists(),
        "size_bytes": database_file.stat().st_size if database_file.exists() else 0,
        "integrity": "missing",
        "migrations": [],
    }
    if not database_file.exists():
        checks.append(_check("database", "账号数据库", "warn", "数据库尚未创建，将在首次启动时初始化"))
        return snapshot, checks
    try:
        connection = sqlite3.connect(f"file:{database_file.as_posix()}?mode=ro", uri=True, timeout=3)
        try:
            snapshot["integrity"] = str(connection.execute("PRAGMA integrity_check").fetchone()[0])
            snapshot["migrations"] = applied_versions(connection)
        finally:
            connection.close()
    except (OSError, sqlite3.Error) as error:
        snapshot["integrity"] = "error"
        checks.append(_check("database", "账号数据库", "fail", "数据库无法读取", error=str(error)))
        return snapshot, checks
    status = "pass" if snapshot["integrity"] == "ok" else "fail"
    checks.append(_check("database", "账号数据库", status, "数据库完整性正常" if status == "pass" else "数据库完整性检查失败"))
    return snapshot, checks


def collect_diagnostics(repository: Any, manager: Any) -> dict[str, Any]:
    resources = runtime_config.resource_status()
    database, checks = _database_snapshot(runtime_config.DATABASE_FILE)
    data_dir = runtime_config.DATA_DIR
    data_writable = data_dir.exists() and os.access(data_dir, os.W_OK)
    checks.append(
        _check(
            "data-directory",
            "数据目录",
            "pass" if data_writable else "fail",
            "数据目录可写" if data_writable else "数据目录不存在或不可写",
            path=str(data_dir),
        )
    )
    framework_ready = bool(resources.get("nonebot", {}).get("valid") or resources.get("astrbot", {}).get("valid"))
    napcat_ready = bool(resources.get("napcat", {}).get("valid"))
    checks.append(
        _check(
            "framework-resource",
            "机器人框架",
            "pass" if framework_ready else "warn",
            "至少一个机器人框架已就绪" if framework_ready else "尚未配置 NoneBot 或 AstrBot",
        )
    )
    checks.append(
        _check(
            "napcat-resource",
            "NapCat",
            "pass" if napcat_ready else "warn",
            "NapCat 与 QQ 资源已就绪" if napcat_ready else "NapCat 或 QQ 资源尚未配置完整",
        )
    )
    bots = repository.list()
    runtime_rows = manager.list()
    errors = [row for row in runtime_rows if row.get("status") == "error"]
    checks.append(
        _check(
            "bot-runtime",
            "Bot 运行状态",
            "warn" if errors else "pass",
            f"{len(errors)} 个 Bot 处于异常状态" if errors else f"已检查 {len(bots)} 个 Bot",
            error_bot_ids=[str(row.get("id")) for row in errors],
        )
    )
    severity = {"pass": 0, "warn": 1, "fail": 2}
    highest = max((severity.get(str(item["status"]), 0) for item in checks), default=0)
    status = "unhealthy" if highest == 2 else "degraded" if highest == 1 else "healthy"
    return {
        "status": status,
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "versions": {
            "python": platform.python_version(),
            "fastapi": _package_version("fastapi"),
            "uvicorn": _package_version("uvicorn"),
            "psutil": _package_version("psutil"),
        },
        "paths": {
            "project": str(runtime_config.ROOT),
            "data": str(data_dir),
            "program": str(runtime_config.PROGRAM_DIR),
        },
        "database": database,
        "checks": checks,
    }

