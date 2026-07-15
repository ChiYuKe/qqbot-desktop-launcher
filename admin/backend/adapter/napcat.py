from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess

import psutil

from backend.adapter.process import EventSink, OutputProcessAdapter, find_listening_process, process_command
import backend.config as runtime_config
from backend.domain.errors import AdapterUnavailableError
from backend.domain.models import BotConfig
from backend.security.secrets import reveal_secret


class NapCatAdapter(OutputProcessAdapter):
    def __init__(self, sink: EventSink) -> None:
        super().__init__(sink, runtime_config.PROCESS_LOG_DIR, "napcat")

    @property
    def available(self) -> bool:
        return bool(runtime_config.resource_status()["napcat"]["valid"])

    def _config_directory(self) -> Path | None:
        napcat_dir = runtime_config.NAPCAT_DIR
        if not napcat_dir.exists():
            return None
        candidates = list(napcat_dir.rglob("onebot11_*.json"))
        if candidates:
            return candidates[0].parent
        webui = next(iter(napcat_dir.rglob("webui.json")), None)
        return webui.parent if webui else None

    def sync_onebot_port(self, bot: BotConfig) -> bool:
        config_directory = self._config_directory()
        if config_directory is None:
            return False
        config_file = config_directory / f"onebot11_{bot.qq}.json"
        try:
            config = json.loads(config_file.read_text(encoding="utf-8")) if config_file.exists() else {"network": {}}
            network = config.setdefault("network", {})
            clients = network.setdefault("websocketClients", [])
            if not isinstance(clients, list):
                clients = []
                network["websocketClients"] = clients
            client = next((item for item in clients if isinstance(item, dict) and item.get("name") == bot.name), None)
            if client is None and clients:
                client = next((item for item in clients if isinstance(item, dict)), None)
            if client is None:
                client = {
                    "enable": True,
                    "name": bot.name,
                    "url": "",
                    "reportSelfMessage": False,
                    "messagePostFormat": "array",
                    "token": "",
                    "debug": False,
                    "heartInterval": 3000,
                    "reconnectInterval": 3000,
                    "verifyCertificate": True,
                }
                clients.append(client)
            client["name"] = bot.name
            client["url"] = f"ws://127.0.0.1:{bot.port}/onebot/v11/ws"
            config_file.write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            return True
        except (OSError, UnicodeError, json.JSONDecodeError, TypeError):
            return False

    def _is_launcher(self, process: psutil.Process) -> bool:
        executable_name = runtime_config.NAPCAT_EXE.name.lower()
        try:
            info = process.as_dict(attrs=["name", "cmdline"])
            command_line = [str(item) for item in (info.get("cmdline") or [])]
            command = " ".join(command_line).lower()
            name = str(info.get("name") or "").lower()
            return executable_name == name or executable_name in command
        except (psutil.NoSuchProcess, psutil.AccessDenied, OSError, TypeError):
            return False

    def _find_launcher(self, bot: BotConfig, listener: psutil.Process | None = None) -> psutil.Process | None:
        """Find NapCat's launcher instead of treating a QQ worker as the root."""
        if listener is not None:
            current = listener
            seen: set[int] = set()
            while current.pid not in seen:
                seen.add(current.pid)
                if self._is_launcher(current):
                    return current
                try:
                    parent = current.parent()
                except (psutil.NoSuchProcess, psutil.AccessDenied, OSError):
                    break
                if parent is None:
                    break
                current = parent

        try:
            candidates = psutil.process_iter(["pid", "name", "cmdline"])
        except psutil.Error:
            return None
        for process in candidates:
            try:
                if not self._is_launcher(process):
                    continue
                command_line = [str(item) for item in (process.info.get("cmdline") or [])]
                if bot.qq in command_line or bot.qq in " ".join(command_line):
                    return process
            except (psutil.NoSuchProcess, psutil.AccessDenied, TypeError):
                continue
        return None

    async def start(self, bot: BotConfig, quick_login: str | None = None, use_password: bool = True) -> None:
        if self.is_running_for_bot(bot):
            return
        if not self.available:
            raise AdapterUnavailableError("NapCat 资源不完整：需要同一目录包含 QQ.exe 和 NapCatWinBootMain.exe")

        login_account = quick_login or bot.qq
        environment = os.environ.copy()
        environment["ACCOUNT"] = login_account
        environment["NAPCAT_QUICK_ACCOUNT"] = login_account
        environment["NAPCAT_WEBUI_PREFERRED_PORT"] = str(bot.napcat_port)
        password = reveal_secret(bot.password_secret) if use_password else ""
        if password:
            environment["NAPCAT_QUICK_PASSWORD"] = password
            environment.pop("NAPCAT_QUICK_PASSWORD_MD5", None)
        else:
            environment.pop("NAPCAT_QUICK_PASSWORD", None)
            environment.pop("NAPCAT_QUICK_PASSWORD_MD5", None)

        log_path = self.prepare_log_path(bot)
        start_position = log_path.stat().st_size
        with log_path.open("a", encoding="utf-8", buffering=1) as output:
            process = subprocess.Popen(
                [str(runtime_config.NAPCAT_EXE), login_account],
                cwd=runtime_config.NAPCAT_DIR,
                text=True,
                encoding="utf-8",
                errors="replace",
                env=environment,
                stdout=output,
                stderr=subprocess.STDOUT,
            )
        self.register(bot, process, start_position)
        await self._sink("INFO", bot.name, "NapCat 已启动，等待 QQ 协议端连接")

    def discover(self, bot: BotConfig) -> psutil.Process | None:
        tracked = self.tracked_process(bot.id)
        if tracked is not None:
            return tracked
        listener = find_listening_process(bot.napcat_port)
        launcher = self._find_launcher(bot, listener)
        if launcher is not None:
            self.attach_external(bot, launcher)
            return launcher
        if listener is not None:
            self.attach_external(bot, listener)
            return listener
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
        listener = find_listening_process(bot.napcat_port)
        if listener is not None:
            pids.add(listener.pid)
        launcher = self._find_launcher(bot, listener)
        if launcher is not None:
            pids.add(launcher.pid)
        return pids
