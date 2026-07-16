from __future__ import annotations

import json
import os
from pathlib import Path
import re
import subprocess

import psutil

from backend.adapter.process import EventSink, OutputProcessAdapter, find_listening_process
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
        return runtime_config.napcat_config_directory()

    @staticmethod
    def _load_json(path: Path) -> dict[str, object]:
        if not path.exists():
            return {}
        try:
            raw = path.read_text(encoding="utf-8")
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError:
                # NapCat's documentation uses JSON5 examples, so existing
                # configs may contain comments and trailing commas.
                payload = json.loads(NapCatAdapter._strip_json5(raw))
        except (OSError, UnicodeError, json.JSONDecodeError) as error:
            raise ValueError(f"NapCat 配置文件无法解析：{path.name}") from error
        return payload if isinstance(payload, dict) else {}

    @staticmethod
    def _strip_json5(raw: str) -> str:
        """Remove JSON5 comments/trailing commas without touching URL strings."""
        output: list[str] = []
        in_string = False
        escaped = False
        in_line_comment = False
        in_block_comment = False
        index = 0
        while index < len(raw):
            char = raw[index]
            next_char = raw[index + 1] if index + 1 < len(raw) else ""
            if in_line_comment:
                if char in "\r\n":
                    in_line_comment = False
                    output.append(char)
                index += 1
                continue
            if in_block_comment:
                if char == "*" and next_char == "/":
                    in_block_comment = False
                    output.append(" ")
                    index += 2
                else:
                    output.append("\n" if char == "\n" else " ")
                    index += 1
                continue
            if in_string:
                output.append(char)
                if escaped:
                    escaped = False
                elif char == "\\":
                    escaped = True
                elif char == '"':
                    in_string = False
                index += 1
                continue
            if char == '"':
                in_string = True
                output.append(char)
                index += 1
                continue
            if char == "/" and next_char == "/":
                in_line_comment = True
                index += 2
                continue
            if char == "/" and next_char == "*":
                in_block_comment = True
                index += 2
                continue
            output.append(char)
            index += 1
        cleaned = "".join(output)
        return re.sub(r",\s*([}\]])", r"\1", cleaned)

    @staticmethod
    def _write_json(path: Path, payload: dict[str, object]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    def configure_webui(self, port: int = runtime_config.DEFAULT_NAPCAT_PORT) -> Path:
        directory = runtime_config.napcat_config_directory(create=True)
        if directory is None:
            raise ValueError("找不到 NapCat 配置目录")
        path = directory / "webui.json"
        config = self._load_json(path)
        config.update({"host": "127.0.0.1", "port": int(port), "loginRate": int(config.get("loginRate") or 3)})
        self._write_json(path, config)
        return path

    def configure_onebot(
        self,
        qq: str | None,
        port: int,
        name: str,
        token: str = "",
        framework: str = "nonebot",
    ) -> Path:
        """Write NapCat's reverse WebSocket client config from the official schema."""
        directory = runtime_config.napcat_config_directory(create=True)
        if directory is None:
            raise ValueError("找不到 NapCat 配置目录")
        filename = f"onebot11_{qq}.json" if qq else "onebot11.json"
        path = directory / filename
        config = self._load_json(path)
        network = config.setdefault("network", {})
        if not isinstance(network, dict):
            network = {}
            config["network"] = network
        for key in ("httpServers", "httpClients", "websocketServers", "websocketClients"):
            if not isinstance(network.get(key), list):
                network[key] = []
        clients = network["websocketClients"]
        client = next((item for item in clients if isinstance(item, dict) and item.get("name") == name), None)
        if not isinstance(client, dict):
            client = {}
            clients.append(client)
        client.update(
            {
                "name": name,
                "enable": True,
                "url": f"ws://127.0.0.1:{int(port)}{'/ws' if framework == 'astrbot' else '/onebot/v11/ws'}",
                "messagePostFormat": "array",
                "reportSelfMessage": False,
                "token": token,
                "debug": False,
                "reconnectInterval": 3000,
                "heartInterval": 30000,
            }
        )
        config.setdefault("musicSignUrl", "")
        config.setdefault("enableLocalFile2Url", False)
        config.setdefault("parseMultMsg", False)
        self._write_json(path, config)
        return path

    def sync_onebot_port(self, bot: BotConfig, token: str | None = None) -> bool:
        config_directory = self._config_directory()
        if config_directory is None:
            return False
        try:
            self.configure_onebot(
                bot.qq,
                bot.port,
                bot.name,
                token if token is not None else runtime_config.onebot_access_token(),
                bot.framework,
            )
            return True
        except (OSError, UnicodeError, TypeError, ValueError):
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
        status = runtime_config.resource_status()["napcat"]
        if not status.get("valid"):
            raise AdapterUnavailableError("NapCat 资源不完整：需要 NapCatWinBootMain.exe 和可用的 QQ.exe")

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

        shell_mode = status.get("mode") == "shell"
        command = [str(runtime_config.NAPCAT_EXE), login_account]
        if shell_mode:
            qq_path = Path(str(status.get("qq_path") or ""))
            hook_path = runtime_config.NAPCAT_DIR / "NapCatWinBootHook.dll"
            main_path = runtime_config.NAPCAT_DIR / "napcat.mjs"
            load_path = runtime_config.NAPCAT_DIR / "loadNapCat.js"
            if not qq_path.is_file() or not hook_path.is_file() or not main_path.is_file():
                raise AdapterUnavailableError("NapCat Shell 资源不完整：需要 QQ.exe、NapCatWinBootHook.dll 和 napcat.mjs")
            load_path.write_text(
                f'(async () => {{await import("file:///{main_path.as_posix()}")}})()\n',
                encoding="utf-8",
            )
            environment.update(
                {
                    "NAPCAT_PATCH_PACKAGE": str(runtime_config.NAPCAT_DIR / "qqnt.json"),
                    "NAPCAT_LOAD_PATH": str(load_path),
                    "NAPCAT_INJECT_PATH": str(hook_path),
                    "NAPCAT_LAUNCHER_PATH": str(runtime_config.NAPCAT_EXE),
                    "NAPCAT_MAIN_PATH": main_path.as_posix(),
                }
            )
            command = [str(runtime_config.NAPCAT_EXE), str(qq_path), str(hook_path), "-q", login_account]

        log_path = self.prepare_log_path(bot)
        start_position = log_path.stat().st_size
        with log_path.open("a", encoding="utf-8", buffering=1) as output:
            process = subprocess.Popen(
                command,
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
