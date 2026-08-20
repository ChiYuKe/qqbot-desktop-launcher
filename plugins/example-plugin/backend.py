"""示例插件后端入口：系统监控数据接口。

使用 psutil 采集本机资源信息。与全系统监控不同，进程列表只返回与
QQBot Desktop Launcher 相关的进程：桌面控制台、管理后端、DeepSeek Harness WebUI、各账号的
Bot 框架（NoneBot / AstrBot）与 NapCat 协议端。
"""

from __future__ import annotations

import os
import subprocess
import time
from datetime import datetime
from typing import Any

import psutil
from fastapi import APIRouter, HTTPException, Request


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


def _sample_cpu(process: psutil.Process) -> float:
    """Return the CPU usage percentage for *process*.

    On the first call for a given PID a baseline is established and 0.0 is
    returned; subsequent calls return the actual usage since the last call.
    The same ``psutil.Process`` instance must be reused across calls, which
    is why we cache by PID.
    """
    pid = process.pid
    cached = _cpu_samples.get(pid)
    if cached is None:
        try:
            process.cpu_percent(interval=None)  # baseline
        except psutil.Error:
            return 0.0
        _cpu_samples[pid] = process
        return 0.0
    try:
        return cached.cpu_percent(interval=None)
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
    - deepseek   DeepSeek Harness WebUI
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
        "deepseek": {"label": "DeepSeek Harness", "count": 0},
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

        cpu = _sample_cpu(process)

        try:
            memory = process.memory_percent()
        except psutil.Error:
            memory = 0.0

        try:
            create_time = process.create_time()
        except psutil.Error:
            create_time = 0.0

        try:
            name = process.name() or "?"
        except psutil.Error:
            name = "?"

        rows.append(
            {
                "pid": pid,
                "name": name,
                "kind": kind,
                "group": group_label,
                "bot_name": bot_name,
                "cpu": round(cpu, 2),
                "memory": round(memory, 2),
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

    # 4. 由 DeepSeek Harness 插件实际启动的 WebUI 进程树。
    dsh_provider = getattr(request.app.state, "deepseek_harness_processes", None)
    if callable(dsh_provider):
        try:
            for process in dsh_provider():
                add(process, "deepseek", "DeepSeek Harness")
        except Exception:  # noqa: BLE001 - optional plugin status must not break monitoring
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


def _protected_pids() -> set[int]:
    """返回不允许结束的关键进程 PID 集合：管理后端自身及其 Electron 桌面控制台。

    结束这些进程会导致正在展示本页面的控制台（或其后端）崩溃，因此必须保护。
    """
    protected = {os.getpid()}  # 管理后端（FastAPI）自身
    console_root = _find_console_root(os.getpid())
    if console_root is not None:
        protected.add(console_root.pid)
        try:
            for child in console_root.children(recursive=True):
                if _is_console_process(child):
                    protected.add(child.pid)
        except psutil.Error:
            pass
    return protected


def _terminate(process: psutil.Process, force_tree: bool) -> None:
    """按平台终止进程；force_tree 为 True 时一并结束子进程树。"""
    if os.name == "nt":
        args = ["taskkill", "/PID", str(process.pid), "/F"]
        if force_tree:
            args.append("/T")
        subprocess.run(
            args,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
            timeout=10,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        return
    # Unix：先温和终止，超时后再强制结束。
    try:
        process.terminate()
        process.wait(timeout=5)
    except (psutil.TimeoutExpired, psutil.Error):
        try:
            process.kill()
        except psutil.Error:
            pass


@router.post("/kill")
async def kill_process(payload: dict[str, Any]) -> dict[str, Any]:
    """结束指定进程（危险操作）。

    请求体：{"pid": int, "name": str, "tree": bool}
    - pid：目标进程 PID（必填）
    - name：进程名，用于校验该 PID 未被系统复用，避免误杀其他进程
    - tree：是否一并结束子进程树，默认 False
    """
    raw_pid = payload.get("pid")
    try:
        pid = int(raw_pid)
    except (TypeError, ValueError):
        raise HTTPException(422, "pid 必须是正整数")
    if pid <= 0:
        raise HTTPException(422, "pid 必须是正整数")

    if pid in _protected_pids():
        raise HTTPException(403, "该进程是管理服务或桌面控制台的关键进程，禁止结束")

    try:
        process = psutil.Process(pid)
    except psutil.NoSuchProcess:
        raise HTTPException(404, f"进程 {pid} 不存在")

    # 名称校验，防止 PID 被回收复用后误杀新进程。
    expected_name = payload.get("name")
    if expected_name:
        try:
            actual_name = process.name()
        except psutil.Error:
            actual_name = None
        if actual_name is not None and actual_name.lower() != str(expected_name).lower():
            raise HTTPException(409, f"进程已变化（期望 {expected_name}，实际 {actual_name}），请刷新后重试")

    _terminate(process, bool(payload.get("tree", False)))

    # taskkill /F 是异步强制终止：Windows 上进程句柄需要数百毫秒才完全回收，
    # PID 不会在命令返回后立刻从系统消失。轮询一小段时间等待进程真正退出，
    # 避免把已经正常关闭的进程误判为"未能完全终止"（导致前端误报失败）。
    _KILL_WAIT_SECONDS = 3.0
    wait_deadline = time.monotonic() + _KILL_WAIT_SECONDS
    while time.monotonic() < wait_deadline:
        try:
            if not (process.is_running() and process.status() != psutil.STATUS_ZOMBIE):
                break
        except psutil.NoSuchProcess:
            break  # 进程已彻底退出
        except psutil.Error:
            pass  # AccessDenied 等：无法读取状态，交由超时统一判定
        time.sleep(0.05)
    else:
        raise HTTPException(500, f"进程 {pid} 未能完全终止")

    # 清理已结束进程的 CPU 采样缓存，避免后续请求读取已不存在的 Process 对象。
    _cpu_samples.pop(pid, None)
    return {"ok": True, "pid": pid}


def register(app) -> None:
    """挂载示例插件的路由到管理服务。"""
    app.include_router(router)