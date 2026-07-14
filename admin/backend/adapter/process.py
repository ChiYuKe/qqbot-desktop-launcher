from __future__ import annotations

import asyncio
from contextlib import suppress
import os
import subprocess
from collections.abc import Awaitable, Callable

import psutil

from backend.domain.models import BotConfig

EventSink = Callable[[str, str, str], Awaitable[None]]


async def terminate_process_tree(pid: int) -> None:
    if not psutil.pid_exists(pid):
        return
    if os.name == "nt":
        try:
            await asyncio.to_thread(
                subprocess.run,
                ["taskkill", "/PID", str(pid), "/T", "/F"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
                timeout=8,
            )
            for _ in range(20):
                if not psutil.pid_exists(pid):
                    return
                await asyncio.sleep(0.1)
        except (OSError, subprocess.TimeoutExpired):
            pass
    try:
        parent = psutil.Process(pid)
        children = parent.children(recursive=True)
        processes = [*children, parent]
        for process in processes:
            with suppress(psutil.NoSuchProcess, psutil.AccessDenied):
                process.terminate()
        _, remaining = await asyncio.to_thread(psutil.wait_procs, processes, timeout=5)
        for process in remaining:
            with suppress(psutil.NoSuchProcess, psutil.AccessDenied):
                process.kill()
        if remaining:
            await asyncio.to_thread(psutil.wait_procs, remaining, timeout=3)
    except (psutil.NoSuchProcess, psutil.AccessDenied, subprocess.TimeoutExpired):
        try:
            psutil.Process(pid).kill()
        except (psutil.NoSuchProcess, psutil.AccessDenied, OSError):
            pass


async def terminate_process(process: subprocess.Popen[str] | None) -> None:
    if not process or process.poll() is not None:
        return
    await terminate_process_tree(process.pid)
    try:
        await asyncio.to_thread(process.wait, 5)
    except (subprocess.TimeoutExpired, OSError):
        pass


class OutputProcessAdapter:
    def __init__(self, sink: EventSink) -> None:
        self._sink = sink
        self._processes: dict[str, subprocess.Popen[str]] = {}
        self._drain_tasks: dict[str, asyncio.Task[None]] = {}

    def process(self, bot_id: str) -> subprocess.Popen[str] | None:
        process = self._processes.get(bot_id)
        if process and process.poll() is not None:
            self._processes.pop(bot_id, None)
            return None
        return process

    def is_running(self, bot_id: str) -> bool:
        return self.process(bot_id) is not None

    def register(self, bot: BotConfig, process: subprocess.Popen[str]) -> None:
        self._processes[bot.id] = process
        task = asyncio.create_task(self._drain_output(bot, process))
        self._drain_tasks[bot.id] = task

        def forget_task(_: asyncio.Task[None]) -> None:
            if self._drain_tasks.get(bot.id) is task:
                self._drain_tasks.pop(bot.id, None)

        task.add_done_callback(forget_task)

    async def _drain_output(self, bot: BotConfig, process: subprocess.Popen[str]) -> None:
        if process.stdout is None:
            return
        while process.poll() is None:
            line = await asyncio.to_thread(process.stdout.readline)
            if line:
                await self._sink("INFO", bot.name, line.strip())
            else:
                await asyncio.sleep(0.1)

    async def stop(self, bot_id: str) -> None:
        process = self._processes.pop(bot_id, None)
        drain_task = self._drain_tasks.pop(bot_id, None)
        await terminate_process(process)
        if drain_task is not None:
            drain_task.cancel()
            with suppress(asyncio.CancelledError):
                await drain_task
        if process and process.stdout is not None:
            with suppress(OSError, ValueError):
                process.stdout.close()

    async def shutdown(self) -> None:
        for bot_id in list(self._processes):
            await self.stop(bot_id)
        for task in tuple(self._drain_tasks.values()):
            task.cancel()
        for task in tuple(self._drain_tasks.values()):
            with suppress(asyncio.CancelledError):
                await task
        self._drain_tasks.clear()
