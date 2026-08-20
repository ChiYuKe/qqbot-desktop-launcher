"""启动本机 DeepSeek Harness WebUI 的控制台插件后端。"""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

import psutil
from fastapi import APIRouter, HTTPException


router = APIRouter(prefix="/api/plugins/deepseek-harness-webui")
DEFAULT_DSH_ROOT = Path(r"C:\Users\Administrator\Desktop\Project\deepseek-harness-desktop\deepseek-harness")
DEFAULT_DSH_PORT = 3080
_DSH_LOG_SOURCE = "DeepSeek Harness"
_READY_MARKER = b"__DSH_BOOT__"
_START_LOCK = threading.Lock()
_LOGGER = logging.getLogger(__name__)
_dsh_process: subprocess.Popen[str] | None = None
_dsh_event_bus: Any | None = None
_dsh_loop: asyncio.AbstractEventLoop | None = None
_dsh_settings_provider: Any | None = None
_DSH_SETTINGS_ID = "deepseek-harness-webui"
_DSH_ROOT_KEY = "dsh_root"
_DSH_PORT_KEY = "dsh_web_port"
_DSH_SHOW_WINDOW_KEY = "dsh_show_window"


def _settings() -> tuple[Path, int, str, bool]:
    configured: dict[str, Any] = {}
    provider = _dsh_settings_provider
    if callable(provider):
        try:
            candidate = provider(_DSH_SETTINGS_ID)
            if isinstance(candidate, dict):
                configured = candidate
        except Exception:  # noqa: BLE001 - fall back to environment/defaults if storage is unavailable
            _LOGGER.exception("读取 DeepSeek Harness 配置失败")

    root_value = configured.get(_DSH_ROOT_KEY) or os.getenv("DSH_ROOT") or str(DEFAULT_DSH_ROOT)
    root = Path(str(root_value)).expanduser().resolve()
    port_value = configured.get(_DSH_PORT_KEY) or os.getenv("DSH_WEB_PORT") or str(DEFAULT_DSH_PORT)
    try:
        port = int(port_value)
    except (TypeError, ValueError) as error:
        raise RuntimeError("DSH WebUI 端口必须是有效端口") from error
    if not 1024 <= port <= 65535:
        raise RuntimeError("DSH WebUI 端口必须在 1024-65535 之间")

    # 启动时是否显示命令窗口：默认隐藏（False），可通过配置或 DSH_SHOW_WINDOW 环境变量覆盖。
    show_window = configured.get(_DSH_SHOW_WINDOW_KEY)
    if show_window is None:
        env_value = os.getenv("DSH_SHOW_WINDOW")
        if env_value is not None:
            show_window = env_value.strip().lower() in ("1", "true", "yes", "on")
        else:
            show_window = False
    else:
        show_window = bool(show_window)
    return root, port, f"http://127.0.0.1:{port}", show_window


def _is_ready(url: str) -> bool:
    request = urllib.request.Request(url, headers={"Cache-Control": "no-cache"})
    try:
        with urllib.request.urlopen(request, timeout=0.6) as response:
            return _READY_MARKER in response.read(16 * 1024)
    except urllib.error.HTTPError:
        return False
    except (OSError, urllib.error.URLError):
        return False


def _command(root: Path, port: int) -> list[str]:
    pnpm = shutil.which("pnpm.cmd") or shutil.which("pnpm")
    if pnpm:
        return [pnpm, "dsh", "web", "--port", str(port)]

    # The fallback keeps source checkouts usable when pnpm is installed only
    # through a shell shim that is not visible to the desktop process.
    node = shutil.which("node.exe") or shutil.which("node")
    entry = root / "apps" / "cli" / "src" / "bin.ts"
    if node and entry.is_file():
        return [node, "--import", "tsx/esm", str(entry), "web", "--port", str(port)]
    raise RuntimeError("没有找到 pnpm 或 Node.js，请先安装依赖并确认它们在管理服务 PATH 中")


def _log_level(message: str) -> str:
    lowered = message.lower()
    if any(marker in lowered for marker in ("error", "fatal", "exception", "failed", "失败")):
        return "ERROR"
    if any(marker in lowered for marker in ("warn", "warning", "警告")):
        return "WARN"
    return "INFO"


def _publish_log(level: str, message: str) -> None:
    event_bus = _dsh_event_bus
    loop = _dsh_loop
    if event_bus is None or loop is None or loop.is_closed() or not message:
        return

    def emit() -> None:
        task = asyncio.create_task(event_bus.publish(level, _DSH_LOG_SOURCE, message))

        def report_failure(done: asyncio.Task[Any]) -> None:
            try:
                done.result()
            except asyncio.CancelledError:
                pass
            except Exception:  # noqa: BLE001 - logging must not affect the DSH process
                _LOGGER.exception("转发 DeepSeek Harness 日志失败")

        task.add_done_callback(report_failure)

    try:
        loop.call_soon_threadsafe(emit)
    except RuntimeError:
        # The management service may be shutting down while the pipe reader
        # receives its final line.
        return


def _drain_output(process: subprocess.Popen[str]) -> None:
    stream = process.stdout
    if stream is None:
        return
    try:
        for raw_line in stream:
            message = raw_line.rstrip()
            if message:
                _publish_log(_log_level(message), message)
    except (OSError, UnicodeError) as error:
        _publish_log("ERROR", f"读取 DeepSeek Harness 输出失败：{error}")
    finally:
        stream.close()
        try:
            returncode = process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            returncode = process.poll()
        if returncode is not None:
            level = "INFO" if returncode == 0 else "ERROR"
            _publish_log(level, f"dsh web 进程已退出，退出码：{returncode}")


def _spawn(root: Path, port: int, show_window: bool) -> subprocess.Popen[str]:
    command = _command(root, port)
    creationflags = 0
    startupinfo = None
    if os.name == "nt":
        # 默认后台无窗口启动；仅当配置开启“显示命令窗口”时保留可见控制台窗口，
        # 方便排查 dsh web 的输出。
        if not show_window:
            # CREATE_NO_WINDOW also applies to the cmd.exe wrapper used for
            # pnpm.cmd. STARTUPINFO covers shells that still honor window state.
            creationflags = (
                getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
                | getattr(subprocess, "CREATE_NO_WINDOW", 0)
            )
            startupinfo = subprocess.STARTUPINFO()
            startupinfo.dwFlags |= getattr(subprocess, "STARTF_USESHOWWINDOW", 0)
            startupinfo.wShowWindow = getattr(subprocess, "SW_HIDE", 0)
        else:
            creationflags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    process = subprocess.Popen(
        command,
        cwd=str(root),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        creationflags=creationflags,
        startupinfo=startupinfo,
        start_new_session=os.name != "nt",
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
    )
    threading.Thread(
        target=_drain_output,
        args=(process,),
        name="deepseek-harness-log",
        daemon=True,
    ).start()
    return process


def _find_by_port(port: int) -> psutil.Process | None:
    """Return the process that is listening on *port*, or ``None``."""
    try:
        for conn in psutil.net_connections(kind="inet"):
            if conn.laddr.port == port and conn.status == "LISTEN":
                return psutil.Process(conn.pid)
    except (psutil.AccessDenied, OSError):
        pass
    return None


def _processes() -> list[psutil.Process]:
    """Return the DSH process tree found by the configured listening port.

    Using port-based discovery is more robust than tracking the
    ``subprocess.Popen`` handle because on Windows ``pnpm.cmd`` is
    executed through a transient ``cmd.exe`` wrapper whose PID may
    differ from the long-running ``node`` server.
    """
    _root, port, _url, _show = _settings()
    listener = _find_by_port(port)
    if listener is None:
        return []
    try:
        return [listener, *listener.children(recursive=True)]
    except (psutil.NoSuchProcess, psutil.AccessDenied, OSError):
        return []


def _stop_dsh() -> None:
    global _dsh_process
    with _START_LOCK:
        tracked = _dsh_process
        _dsh_process = None

        _root, port, _url, _show = _settings()
        listener = _find_by_port(port)

        if listener is None and tracked is None:
            return
        if listener is None and tracked is not None and tracked.poll() is not None:
            return

        _publish_log("INFO", "正在停止 DeepSeek Harness WebUI 及其后台进程")

        if listener is not None:
            if os.name == "nt":
                try:
                    subprocess.run(
                        ["taskkill", "/PID", str(listener.pid), "/T", "/F"],
                        stdin=subprocess.DEVNULL,
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                        check=False,
                        timeout=10,
                        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                    )
                except (OSError, subprocess.TimeoutExpired):
                    pass
            else:
                try:
                    listener.terminate()
                except psutil.Error:
                    pass

        # Fallback: kill the tracked wrapper process if it is still alive.
        if tracked is not None and tracked.poll() is None:
            if os.name == "nt":
                try:
                    subprocess.run(
                        ["taskkill", "/PID", str(tracked.pid), "/T", "/F"],
                        stdin=subprocess.DEVNULL,
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                        check=False,
                        timeout=10,
                        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                    )
                except (OSError, subprocess.TimeoutExpired):
                    try:
                        tracked.kill()
                    except OSError:
                        pass
            else:
                tracked.terminate()
            try:
                tracked.wait(timeout=5)
            except subprocess.TimeoutExpired:
                try:
                    tracked.kill()
                    tracked.wait(timeout=5)
                except (OSError, subprocess.TimeoutExpired):
                    pass

        if listener is not None:
            try:
                if listener.is_running():
                    _publish_log("ERROR", "DeepSeek Harness WebUI 进程未能完全停止")
                    return
            except psutil.Error:
                pass
        _publish_log("INFO", "DeepSeek Harness WebUI 已停止")


def on_settings_changed(_: dict[str, Any]) -> None:
    """配置变化后停止旧实例，下一次打开时使用新的目录和端口。"""
    _publish_log("INFO", "DeepSeek Harness 配置已更新，正在停止旧 WebUI 进程")
    _stop_dsh()


def shutdown() -> None:
    """Called by the console plugin registry when this plugin is disabled."""
    _stop_dsh()


def _start_dsh() -> dict[str, Any]:
    global _dsh_process
    root, port, url, show_window = _settings()
    if not root.is_dir() or not (root / "package.json").is_file():
        raise RuntimeError(f"DeepSeek Harness checkout 不存在或无效：{root}")

    with _START_LOCK:
        if _is_ready(url):
            _publish_log("INFO", f"DeepSeek Harness WebUI 已在后台运行：{url}")
            return {"ok": True, "started": False, "url": url}
        if _dsh_process is None or _dsh_process.poll() is not None:
            mode = "显示命令窗口" if show_window else "后台无窗口"
            _publish_log("INFO", f"正在{mode}启动 DeepSeek Harness WebUI：{url}")
            _dsh_process = _spawn(root, port, show_window)

        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            if _is_ready(url):
                _publish_log("INFO", f"DeepSeek Harness WebUI 已就绪：{url}")
                return {"ok": True, "started": True, "url": url}
            if _dsh_process.poll() is not None:
                _dsh_process = None
                raise RuntimeError("dsh web 启动失败，请查看最近活动中的 DeepSeek Harness 日志")
            time.sleep(0.3)

    raise RuntimeError("dsh web 启动超时，请查看最近活动中的 DeepSeek Harness 日志")


@router.post("/start")
async def start() -> dict[str, Any]:
    try:
        return await asyncio.to_thread(_start_dsh)
    except RuntimeError as error:
        _publish_log("ERROR", str(error))
        raise HTTPException(status_code=503, detail=str(error)) from error


def register(app) -> None:
    global _dsh_event_bus, _dsh_loop, _dsh_settings_provider
    _dsh_event_bus = getattr(app.state, "event_bus", None)
    registry = getattr(app.state, "console_plugin_registry", None)
    _dsh_settings_provider = getattr(registry, "get_settings", None)
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = getattr(app.state, "_deepseek_harness_event_loop", None)
    if loop is not None and loop.is_running() and not loop.is_closed():
        _dsh_loop = loop
        app.state._deepseek_harness_event_loop = loop
    app.state.deepseek_harness_processes = _processes
    app.include_router(router)
