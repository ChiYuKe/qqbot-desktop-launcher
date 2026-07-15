from __future__ import annotations

import os
from pathlib import Path
import subprocess
import time

import psutil

from backend.adapter.process import (
    EventSink,
    OutputProcessAdapter,
    find_listening_process,
    find_processes_by_command,
    process_command,
)
import backend.config as runtime_config
from backend.domain.errors import AdapterUnavailableError
from backend.domain.models import BotConfig


class OneBotAdapter(OutputProcessAdapter):
    def __init__(self, sink: EventSink) -> None:
        super().__init__(sink, runtime_config.PROCESS_LOG_DIR, "nonebot")

    def prepare(self, bot: BotConfig) -> None:
        if bot.framework == "astrbot":
            status = runtime_config.resource_status()["astrbot"]
            if not status.get("valid"):
                raise AdapterUnavailableError("AstrBot 资源不完整：需要 main.py、pyproject.toml 和依赖环境")
            runtime_config.ensure_astrbot_config(bot.id, bot.port, bot.napcat_port)
            return
        runtime_config.ensure_nonebot_environment(bot.port)

    async def start(self, bot: BotConfig) -> None:
        if self.is_running_for_bot(bot):
            return
        script = Path(bot.script)
        if not script.exists():
            raise AdapterUnavailableError("Bot 启动脚本不存在")

        environment = os.environ.copy()
        environment["QQ_NONEBOT_DIR"] = str(runtime_config.NONEBOT_DIR)
        environment["QQ_ASTRBOT_DIR"] = str(runtime_config.ASTRBOT_DIR)
        environment["QQ_ASTRBOT_INSTANCE_DIR"] = str(runtime_config.astrbot_instance_dir(bot.id))
        environment["PYTHONIOENCODING"] = "utf-8"
        environment["PYTHONUTF8"] = "1"
        environment["PYTHONUNBUFFERED"] = "1"
        environment["QQ_BOT_ID"] = bot.id
        compat_path = Path(__file__).resolve().parents[1] / "runtime_compat"
        python_path = [str(compat_path)]
        if environment.get("PYTHONPATH"):
            python_path.append(environment["PYTHONPATH"])
        environment["PYTHONPATH"] = os.pathsep.join(python_path)

        working_directory = runtime_config.ASTRBOT_DIR if bot.framework == "astrbot" else runtime_config.NONEBOT_DIR
        log_path = self.prepare_log_path(bot)
        start_position = log_path.stat().st_size
        with log_path.open("a", encoding="utf-8", buffering=1) as output:
            process = subprocess.Popen(
                ["powershell", "-ExecutionPolicy", "Bypass", "-File", str(script)],
                cwd=working_directory,
                text=True,
                encoding="utf-8",
                errors="replace",
                env=environment,
                stdout=output,
                stderr=subprocess.STDOUT,
            )
        self.register(bot, process, start_position)

    def discover(self, bot: BotConfig) -> psutil.Process | None:
        tracked = self.tracked_process(bot.id)
        if tracked is not None:
            return tracked
        listener = find_listening_process(bot.port)
        if listener is not None:
            command = process_command(listener)
            if bot.framework == "astrbot":
                matches_framework = "main.py" in command or "astrbot" in command
            else:
                matches_framework = "bot.py" in command or "nonebot" in command
            if matches_framework:
                self.attach_external(bot, listener)
                return listener
        matches = find_processes_by_command(str(Path(bot.script).resolve()))
        if matches:
            self.attach_external(bot, matches[0])
            return matches[0]
        return None

    def external_process(self, bot: BotConfig) -> psutil.Process | None:
        return self.discover(bot)

    def is_running_for_bot(self, bot: BotConfig) -> bool:
        return self.discover(bot) is not None

    def process_ids_for_bot(self, bot: BotConfig) -> set[int]:
        pids = self.process_ids(bot.id)
        process = self.discover(bot)
        if process is not None:
            pids.add(process.pid)
        pids.update(item.pid for item in find_processes_by_command(str(Path(bot.script).resolve())))
        return pids

    def uptime(self, bot_id: str) -> int:
        started_at = self.start_time(bot_id)
        if started_at is None:
            return 0
        return max(0, int(time.time() - started_at))
