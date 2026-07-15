from __future__ import annotations

import asyncio
from contextlib import suppress
from dataclasses import dataclass
import logging
import os
import subprocess
import threading
import time
from collections.abc import Awaitable, Callable, Iterable
from pathlib import Path
from typing import Any

import psutil

from backend.domain.models import BotConfig

EventSink = Callable[[str, str, str], Awaitable[None]]
ProcessAlive = Callable[[], bool]
_listener_cache: tuple[float, list[Any]] | None = None
_listener_cache_lock = threading.Lock()
_LOGGER = logging.getLogger(__name__)


@dataclass(frozen=True)
class ProcessSnapshot:
    pid: int
    kind: str
    external: bool
    started_at: float | None = None


def process_command(process: psutil.Process) -> str:
    try:
        return " ".join(str(item) for item in (process.cmdline() or [])).lower()
    except (psutil.NoSuchProcess, psutil.AccessDenied, OSError):
        return ""


def find_listening_process(port: int) -> psutil.Process | None:
    """Return the process currently owning a configured TCP listener."""
    global _listener_cache
    now = time.monotonic()
    # /api/bots and /api/system can probe concurrently. Serializing the
    # refresh prevents several expensive Windows socket snapshots from
    # occupying the executor at the same time.
    with _listener_cache_lock:
        now = time.monotonic()
        if _listener_cache is None or now - _listener_cache[0] >= 0.75:
            try:
                connections = psutil.net_connections(kind="tcp")
            except psutil.Error:
                return None
            _listener_cache = (now, connections)
        else:
            connections = _listener_cache[1]
    for connection in connections:
        if not connection.laddr or connection.laddr.port != port:
            continue
        if connection.status != psutil.CONN_LISTEN or not connection.pid:
            continue
        try:
            process = psutil.Process(connection.pid)
            if process.is_running():
                return process
        except (psutil.NoSuchProcess, psutil.AccessDenied, OSError):
            continue
    return None


def find_processes_by_command(fragment: str) -> list[psutil.Process]:
    fragment = fragment.lower().replace("/", "\\")
    if not fragment:
        return []
    matches: list[psutil.Process] = []
    try:
        candidates = psutil.process_iter(["pid", "cmdline"])
    except psutil.Error:
        return matches
    for process in candidates:
        try:
            command = " ".join(str(item) for item in (process.info.get("cmdline") or [])).lower().replace("/", "\\")
            if fragment in command:
                matches.append(process)
        except (psutil.NoSuchProcess, psutil.AccessDenied, TypeError):
            continue
    return matches


def collapse_process_ids(pids: Iterable[int]) -> set[int]:
    """Remove child PIDs when their ancestor is already scheduled for cleanup."""
    unique = {int(pid) for pid in pids if int(pid) > 0}
    if len(unique) < 2:
        return unique
    result = set(unique)
    for pid in tuple(unique):
        try:
            current = psutil.Process(pid)
            ancestors: set[int] = set()
            while True:
                parent_id = current.ppid()
                if not parent_id or parent_id in ancestors:
                    break
                ancestors.add(parent_id)
                if parent_id in unique:
                    result.discard(pid)
                    break
                current = psutil.Process(parent_id)
        except (psutil.NoSuchProcess, psutil.AccessDenied, OSError):
            continue
    return result


async def terminate_process_tree(pid: int, timeout: float = 8.0) -> bool:
    """Terminate one process tree within a bounded deadline."""
    if not psutil.pid_exists(pid):
        return True

    try:
        root = psutil.Process(pid)
        processes = [*root.children(recursive=True), root]
    except (psutil.NoSuchProcess, psutil.AccessDenied, OSError):
        processes = []
    tracked_pids = {process.pid for process in processes} or {pid}
    deadline = time.monotonic() + max(0.5, timeout)
    if os.name == "nt":
        remaining = max(0.5, deadline - time.monotonic())
        try:
            await asyncio.to_thread(
                subprocess.run,
                ["taskkill", "/PID", str(pid), "/T", "/F"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
                timeout=remaining,
            )
        except (OSError, subprocess.TimeoutExpired):
            pass

    while any(psutil.pid_exists(item) for item in tracked_pids) and time.monotonic() < deadline:
        await asyncio.sleep(0.1)
    if not any(psutil.pid_exists(item) for item in tracked_pids):
        return True

    try:
        for process in processes:
            with suppress(psutil.NoSuchProcess, psutil.AccessDenied):
                process.terminate()
        remaining_time = max(0.1, deadline - time.monotonic())
        _, remaining = await asyncio.to_thread(psutil.wait_procs, processes, timeout=remaining_time)
        for process in remaining:
            with suppress(psutil.NoSuchProcess, psutil.AccessDenied):
                process.kill()
        if remaining:
            await asyncio.to_thread(psutil.wait_procs, remaining, timeout=max(0.1, deadline - time.monotonic()))
    except (psutil.NoSuchProcess, psutil.AccessDenied, OSError):
        for item in tracked_pids:
            with suppress(psutil.NoSuchProcess, psutil.AccessDenied, OSError):
                psutil.Process(item).kill()
    return not any(psutil.pid_exists(item) for item in tracked_pids)


async def terminate_processes(pids: Iterable[int], timeout: float = 8.0) -> set[int]:
    """Terminate all roots concurrently and return processes still alive."""
    roots = collapse_process_ids(pids)
    if not roots:
        return set()
    await asyncio.gather(*(terminate_process_tree(pid, timeout) for pid in roots))
    return {pid for pid in roots if psutil.pid_exists(pid)}


class OutputProcessAdapter:
    def __init__(self, sink: EventSink, log_directory: Path, log_suffix: str) -> None:
        self._sink = sink
        self._log_directory = log_directory
        self._log_suffix = log_suffix
        self._processes: dict[str, subprocess.Popen[str]] = {}
        self._external: dict[str, psutil.Process] = {}
        self._started_at: dict[str, float] = {}
        self._drain_tasks: dict[str, asyncio.Task[None]] = {}
        try:
            self._loop: asyncio.AbstractEventLoop | None = asyncio.get_running_loop()
        except RuntimeError:
            self._loop = None

    def process(self, bot_id: str) -> subprocess.Popen[str] | None:
        process = self._processes.get(bot_id)
        if process and process.poll() is not None:
            self._processes.pop(bot_id, None)
            return None
        return process

    def tracked_process(self, bot_id: str) -> psutil.Process | None:
        process = self.process(bot_id)
        if process is not None:
            with suppress(psutil.NoSuchProcess, psutil.AccessDenied):
                return psutil.Process(process.pid)
        external = self._external.get(bot_id)
        if external is not None:
            try:
                if external.is_running():
                    return external
            except psutil.Error:
                pass
            self._external.pop(bot_id, None)
        return None

    def is_running(self, bot_id: str) -> bool:
        return self.tracked_process(bot_id) is not None

    def log_path(self, bot: BotConfig) -> Path:
        return self._log_directory / f"{bot.id}.{self._log_suffix}.log"

    def prepare_log_path(self, bot: BotConfig) -> Path:
        path = self.log_path(bot)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.touch(exist_ok=True)
        return path

    def register(self, bot: BotConfig, process: subprocess.Popen[str], start_position: int = 0) -> None:
        self._processes[bot.id] = process
        self._external.pop(bot.id, None)
        self._started_at[bot.id] = time.time()
        self._start_tail(bot, lambda: process.poll() is None, start_position)

    def attach_external(self, bot: BotConfig, process: psutil.Process) -> None:
        if self.tracked_process(bot.id) is not None:
            return
        self._external[bot.id] = process
        try:
            started_at = process.create_time()
        except (AttributeError, psutil.NoSuchProcess, psutil.AccessDenied, OSError):
            started_at = None
        if started_at is not None:
            self._started_at[bot.id] = started_at
        path = self.prepare_log_path(bot)
        try:
            start_position = path.stat().st_size
        except OSError:
            start_position = 0
        self._start_tail(bot, process.is_running, start_position)

    def snapshot(self, bot_id: str, kind: str) -> ProcessSnapshot | None:
        process = self.tracked_process(bot_id)
        if process is None:
            return None
        try:
            started_at = self._started_at.get(bot_id) or process.create_time()
        except (AttributeError, psutil.NoSuchProcess, psutil.AccessDenied, OSError):
            started_at = self._started_at.get(bot_id)
        return ProcessSnapshot(process.pid, kind, bot_id in self._external, started_at)

    def start_time(self, bot_id: str) -> float | None:
        return self._started_at.get(bot_id)

    def _start_tail(self, bot: BotConfig, is_alive: ProcessAlive, start_position: int) -> None:
        # Process discovery is also used from API worker threads. Task
        # creation must happen on the backend event loop; otherwise an
        # external-process probe can raise "no running event loop" and leave
        # the API request half-closed.
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            loop = self._loop
            if loop is not None and loop.is_running():
                loop.call_soon_threadsafe(self._start_tail, bot, is_alive, start_position)
            else:
                _LOGGER.warning("无法启动 Bot 日志跟踪任务：管理事件循环不可用（bot=%s）", bot.id)
            return
        previous = self._drain_tasks.pop(bot.id, None)
        if previous is not None:
            previous.cancel()
        task = asyncio.create_task(self._tail_output(bot, is_alive, start_position))
        self._drain_tasks[bot.id] = task

        def forget_task(_: asyncio.Task[None]) -> None:
            if self._drain_tasks.get(bot.id) is task:
                self._drain_tasks.pop(bot.id, None)

        task.add_done_callback(forget_task)

    async def _tail_output(self, bot: BotConfig, is_alive: ProcessAlive, position: int) -> None:
        path = self.log_path(bot)
        while True:
            try:
                if path.exists():
                    size = path.stat().st_size
                    if position > size:
                        position = 0
                    with path.open("r", encoding="utf-8", errors="replace") as stream:
                        stream.seek(position)
                        while True:
                            line = stream.readline()
                            if not line:
                                break
                            position = stream.tell()
                            try:
                                await self._sink("INFO", bot.name, line.rstrip("\r\n"))
                            except asyncio.CancelledError:
                                raise
                            except Exception:  # noqa: BLE001 - one bad sink event must not kill tailing
                                _LOGGER.exception("转发 Bot 日志失败：bot=%s", bot.id)
                if not is_alive():
                    return
            except asyncio.CancelledError:
                raise
            except (OSError, UnicodeError, ValueError, psutil.Error):
                with suppress(psutil.Error):
                    if not is_alive():
                        return
            await asyncio.sleep(0.25)

    def process_ids(self, bot_id: str) -> set[int]:
        process = self.tracked_process(bot_id)
        return {process.pid} if process is not None else set()

    def forget(self, bot_id: str) -> None:
        process = self._processes.pop(bot_id, None)
        close = getattr(process, "close", None)
        if close is not None:
            close()
        self._external.pop(bot_id, None)
        self._started_at.pop(bot_id, None)
        task = self._drain_tasks.pop(bot_id, None)
        if task is not None:
            task.cancel()

    async def stop_local(self, bot_id: str) -> None:
        process = self._processes.get(bot_id)
        if process is not None:
            await terminate_processes({process.pid})
        self.forget(bot_id)

    async def shutdown(self) -> None:
        pids = [process.pid for process in self._processes.values() if process.poll() is None]
        await terminate_processes(pids)
        tasks = tuple(self._drain_tasks.values())
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        for process in self._processes.values():
            close = getattr(process, "close", None)
            if close is not None:
                close()
        self._processes.clear()
        self._external.clear()
        self._started_at.clear()
        self._drain_tasks.clear()
