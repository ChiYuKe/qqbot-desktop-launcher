from __future__ import annotations

import os
import json
import subprocess
from pathlib import Path

import psutil

from backend.adapter.process import EventSink, OutputProcessAdapter, terminate_process_tree
import backend.config as runtime_config
from backend.domain.errors import AdapterUnavailableError
from backend.domain.models import BotConfig
from backend.security.secrets import reveal_secret


class NapCatAdapter(OutputProcessAdapter):
    def __init__(self, sink: EventSink) -> None:
        super().__init__(sink)

    @property
    def available(self) -> bool:
        return runtime_config.NAPCAT_EXE.exists()

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
        """Keep NapCat's websocket client pointed at this Bot's NoneBot port."""
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

    def external_process(self, bot: BotConfig) -> psutil.Process | None:
        """Find a NapCat launcher left behind by a previous API instance."""
        executable_name = runtime_config.NAPCAT_EXE.name.lower()
        account = str(bot.qq)
        try:
            candidates = psutil.process_iter(["pid", "name", "cmdline"])
        except psutil.Error:
            return None
        for process in candidates:
            try:
                command_line = [str(item) for item in (process.info.get("cmdline") or [])]
                command = " ".join(command_line).lower()
                name = str(process.info.get("name") or "").lower()
                is_launcher = executable_name in command or name == executable_name
                if is_launcher and account in command_line:
                    return process
            except (psutil.NoSuchProcess, psutil.AccessDenied, TypeError):
                continue
        return None

    def is_running_for_bot(self, bot: BotConfig) -> bool:
        return self.is_running(bot.id) or self.external_process(bot) is not None

    async def stop_external(self, bot: BotConfig) -> None:
        process = self.external_process(bot)
        if process is not None:
            await terminate_process_tree(process.pid)

    async def start(self, bot: BotConfig, quick_login: str | None = None) -> None:
        if self.is_running_for_bot(bot):
            return
        if not self.available:
            raise AdapterUnavailableError(f"找不到 NapCat 启动程序：{runtime_config.NAPCAT_EXE}")
        # Bind every NapCat process to its own QQ profile.  NapCat Shell
        # supports the QQ number as the first positional argument; omitting it
        # makes concurrent launches fall back to the same default instance.
        command = [str(runtime_config.NAPCAT_EXE), quick_login or bot.qq]
        environment = os.environ.copy()
        login_account = quick_login or bot.qq
        environment["ACCOUNT"] = login_account
        environment["NAPCAT_QUICK_ACCOUNT"] = login_account
        environment["NAPCAT_WEBUI_PREFERRED_PORT"] = str(bot.napcat_port)
        password = reveal_secret(bot.password_secret)
        if password:
            environment["NAPCAT_QUICK_PASSWORD"] = password
            environment.pop("NAPCAT_QUICK_PASSWORD_MD5", None)
        else:
            environment.pop("NAPCAT_QUICK_PASSWORD", None)
            environment.pop("NAPCAT_QUICK_PASSWORD_MD5", None)
        process = subprocess.Popen(
            command,
            cwd=runtime_config.NAPCAT_DIR,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=environment,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
        self.register(bot, process)
        await self._sink("INFO", bot.name, "NapCat 已启动，等待 QQ 协议端连接")
