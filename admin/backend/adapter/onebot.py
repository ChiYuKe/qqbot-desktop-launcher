from __future__ import annotations

import asyncio
import os
import subprocess
import time
from pathlib import Path

import psutil

from backend.adapter.process import EventSink, OutputProcessAdapter, terminate_process_tree
import backend.config as runtime_config
from backend.domain.errors import AdapterUnavailableError
from backend.domain.models import BotConfig


class OneBotAdapter(OutputProcessAdapter):
    def __init__(self, sink: EventSink) -> None:
        super().__init__(sink)
        self._started_at: dict[str, float] = {}

    async def start(self, bot: BotConfig) -> None:
        if self.is_running(bot.id):
            return
        script = Path(bot.script)
        if not script.exists():
            raise AdapterUnavailableError("Bot 启动脚本不存在")
        environment = os.environ.copy()
        environment["QQ_NONEBOT_DIR"] = str(runtime_config.NONEBOT_DIR)
        # Python on Windows may choose the system code page when stdout is
        # redirected to a pipe.  Force UTF-8 so Chinese OneBot/NoneBot logs
        # arrive at the panel without replacement characters.
        environment["PYTHONIOENCODING"] = "utf-8"
        environment["PYTHONUTF8"] = "1"
        environment["QQ_BOT_ID"] = bot.id
        # Message statistics are recorded from the management event bus. Do
        # not also enable NoneBot's direct API hook here, otherwise one sent
        # message can be counted twice.
        process = subprocess.Popen(
            ["powershell", "-ExecutionPolicy", "Bypass", "-File", str(script)],
            cwd=runtime_config.NONEBOT_DIR,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=environment,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
        self.register(bot, process)
        self._started_at[bot.id] = time.time()

    async def stop(self, bot_id: str) -> None:
        await super().stop(bot_id)
        self._started_at.pop(bot_id, None)

    def external_process(self, bot: BotConfig) -> psutil.Process | None:
        """Find a bot started before the current management service instance."""
        try:
            connections = psutil.net_connections(kind="tcp")
        except psutil.Error:
            return None
        for connection in connections:
            if not connection.laddr or connection.laddr.port != bot.port:
                continue
            if connection.status != psutil.CONN_LISTEN or not connection.pid:
                continue
            try:
                process = psutil.Process(connection.pid)
                command = " ".join(process.cmdline()).lower()
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue
            if "bot.py" in command or "nonebot" in command:
                return process
        return None

    def is_running_for_bot(self, bot: BotConfig) -> bool:
        return self.is_running(bot.id) or self.external_process(bot) is not None

    async def stop_external(self, bot: BotConfig) -> None:
        target_script = str(Path(bot.script).resolve()).lower().replace("/", "\\")
        pids: set[int] = set()
        process = self.external_process(bot)
        if process is not None:
            pids.add(process.pid)

        try:
            candidates = list(psutil.process_iter(["pid", "cmdline", "ppid"]))
        except psutil.Error:
            candidates = []

        processes = {item.pid: item for item in candidates}
        for item in candidates:
            if self._has_script_ancestor(item, processes, target_script):
                pids.add(item.pid)

        for pid in pids:
            await terminate_process_tree(pid)

    @staticmethod
    def _has_script_ancestor(process: psutil.Process, processes: dict[int, psutil.Process], target_script: str) -> bool:
        current: psutil.Process | None = process
        visited: set[int] = set()
        while current is not None and current.pid not in visited:
            visited.add(current.pid)
            try:
                command = " ".join(current.cmdline()).lower().replace("/", "\\")
                if target_script in command:
                    return True
                parent_id = current.ppid()
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                return False
            current = processes.get(parent_id)
        return False

    def uptime(self, bot_id: str) -> int:
        if not self.is_running(bot_id) or bot_id not in self._started_at:
            return 0
        return max(0, int(time.time() - self._started_at[bot_id]))
