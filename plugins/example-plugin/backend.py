"""示例插件后端入口：系统监控数据接口。

使用 psutil 采集本机资源信息。与全系统监控不同，进程列表只返回与
QQBot Desktop Launcher 相关的进程：桌面控制台、管理后端、各账号的
Bot 框架（NoneBot / AstrBot）与 NapCat 协议端。
"""

from __future__ import annotations

import os
from datetime import datetime
from typing import Any

import psutil
from fastapi import APIRouter, Request


router = APIRouter(prefix="/api/plugins/example")


def _fmt_bytes(value: int) -> str:
    size = float(value or 0)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if size < 1024 or unit == "TB":
            return f"{size:.1f} {unit}" if unit != "B" else f"{int(size)} B"
        size /= 1024
    return f"{size:.1f} TB"


def _is_console_process(process: psutil.Process) -> bool:
    """判断进程是否属于桌面控制台（Electron 主/渲染/子进程）。"""
    try:
        exe = (process.exe() or "").lower()
        name = (process.name() or "").lower()
    except psutil.Error:
        return False
    if "electron" in exe or exe.endswith("electron.exe"):
        return True
    return "qqbot-desktop-launcher" in name or "qqbot-desktop-launcher" in exe


def _find_console_root(pid: int) -> psutil.Process | None:
    """沿父进程链向上找桌面控制台主进程（管理后端由它启动）。"""
    try:
        cursor = psutil.Process(pid)
    except psutil.Error:
        return None
    for _ in range(10):
        try:
            cursor = cursor.parent()
        except psutil.Error:
            return None
        if cursor is None:
            return None
        if _is_console_process(cursor):
            return cursor
    return None


def _descends_from(process: psutil.Process, ancestor_pid: int) -> bool:
    """判断进程是否从指定 pid 派生（用于排除管理后端分支）。"""
    cursor = process
    for _ in range(12):
        if cursor is None:
            return False
        if cursor.pid == ancestor_pid:
            return True
        try:
            cursor = cursor.parent()
        except psutil.Error:
            return False
    return False


# psutil 的 cpu_percent 需要复用同一个 Process 对象才有跨请求的采样基准，
# 否则每次新建对象都会返回 0。这里缓存对象以获得真实的 CPU 使用率。
_cpu_samples: dict[int, psutil.Process] = {}


def _sample_cpu(pid: int) -> float:
    process = _cpu_samples.get(pid)
    if process is None:
        try:
            process = psutil.Process(pid)
            process.cpu_percent(interval=None)  # 首次调用只建立采样基准
            _cpu_samples[pid] = process
        except psutil.Error:
            return 0.0
        return 0.0
    try:
        return process.cpu_percent(interval=None)
    except psutil.Error:
        _cpu_samples.pop(pid, None)
        return 0.0


@router.get("/overview")
async def overview() -> dict[str, Any]:
    """返回本机 CPU、内存、磁盘概览和运行时间。"""
    memory = psutil.virtual_memory()
    disk = psutil.disk_usage("/")
    boot = psutil.boot_time()
    return {
        "cpu_percent": psutil.cpu_percent(interval=None),
        "cpu_count": psutil.cpu_count(),
        "memory_percent": memory.percent,
        "memory_used": _fmt_bytes(memory.used),
        "memory_total": _fmt_bytes(memory.total),
        "disk_percent": disk.percent,
        "disk_used": _fmt_bytes(disk.used),
        "disk_total": _fmt_bytes(disk.total),
        "uptime_seconds": int(datetime.now().timestamp() - boot),
    }


@router.get("/processes")
async def processes(request: Request) -> dict[str, Any]:
    """返回与本程序相关的进程。

    分组：
    - console    桌面控制台（Electron 主进程及子进程）
    - backend    管理后端（FastAPI 服务）
    - framework  Bot 框架（NoneBot / AstrBot）
    - napcat     NapCat 协议端
    """
    manager = getattr(request.app.state, "bot_manager", None)
    repository = getattr(request.app.state, "repository", None)
    rows: list[dict[str, Any]] = []
    seen: set[int] = set()
    groups = {
        "console": {"label": "桌面控制台", "count": 0},
        "backend": {"label": "管理后端", "count": 0},
        "framework": {"label": "Bot 框架", "count": 0},
        "napcat": {"label": "NapCat 协议端", "count": 0},
    }

    def add(process: psutil.Process | None, kind: str, group_label: str, bot_name: str | None = None) -> None:
        if process is None:
            return
        pid = process.pid
        if pid in seen:
            return
        seen.add(pid)
        try:
            cpu = _sample_cpu(pid)
            memory = process.memory_percent()
            create_time = process.create_time()
            name = process.name() or "?"
        except psutil.Error:
            cpu = 0.0
            memory = 0.0
            create_time = 0.0
            name = "?"
        rows.append(
            {
                "pid": pid,
                "name": name,
                "kind": kind,
                "group": group_label,
                "bot_name": bot_name,
                "cpu": round(cpu, 1),
                "memory": round(memory, 1),
                "started_at": int(create_time),
            }
        )
        if kind in groups:
            groups[kind]["count"] += 1

    # 1. 管理后端自身。
    try:
        add(psutil.Process(os.getpid()), "backend", "管理后端")
    except psutil.Error:
        pass

    # 2. 桌面控制台：沿父链找 Electron 主进程，再收集其 Electron 子进程。
    console_root = _find_console_root(os.getpid())
    if console_root is not None:
        add(console_root, "console", "桌面控制台")
        try:
            for child in console_root.children(recursive=True):
                if _is_console_process(child) and not _descends_from(child, os.getpid()):
                    add(child, "console", "桌面控制台")
        except psutil.Error:
            pass

    # 3. 各账号的 Bot 框架与 NapCat 协议端（来自 BotManager 的进程探测）。
    if repository is not None and manager is not None:
        for bot in repository.list():
            try:
                snapshot = manager.snapshot(bot)
            except Exception:  # noqa: BLE001 - 单个账号探测失败不影响其他账号
                continue
            runtime = snapshot.get("runtime", {}) or {}
            framework = runtime.get("framework", {}) or {}
            napcat = runtime.get("napcat", {}) or {}
            framework_label = "AstrBot" if snapshot.get("framework") == "astrbot" else "NoneBot"
            framework_pid = framework.get("pid")
            if framework_pid:
                try:
                    add(psutil.Process(framework_pid), "framework", framework_label, bot.name)
                except psutil.Error:
                    pass
            napcat_pid = napcat.get("pid")
            if napcat_pid:
                try:
                    add(psutil.Process(napcat_pid), "napcat", "NapCat", bot.name)
                except psutil.Error:
                    pass

    rows.sort(key=lambda item: (item["kind"], item["bot_name"] or "", item["pid"]))
    # 清理不再被采集的进程的采样缓存，避免缓存膨胀。
    for pid in list(_cpu_samples):
        if pid not in seen:
            _cpu_samples.pop(pid, None)
    return {
        "groups": groups,
        "processes": rows,
    }


def register(app) -> None:
    """挂载示例插件的路由到管理服务。"""
    app.include_router(router)