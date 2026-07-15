from __future__ import annotations

import re
from pathlib import Path
from uuid import uuid4

import backend.config as runtime_config
from backend.config import DEFAULT_NAPCAT_PORT, SCRIPT_DIR
from backend.database.repository import BotRepository
from backend.database.stats_repository import MessageStatsRepository
from backend.domain.errors import ConflictError
from backend.domain.models import BotConfig
from backend.event.bus import EventBus
from backend.manager.bot_manager import BotManager
from backend.security.secrets import protect_secret
from backend.service.resource_setup import ResourceSetupManager


class BotService:
    def __init__(self, repository: BotRepository, manager: BotManager, event_bus: EventBus, stats: MessageStatsRepository) -> None:
        self.repository = repository
        self.manager = manager
        self.event_bus = event_bus
        self.stats = stats
        self.resource_setup = ResourceSetupManager()

    async def shutdown(self) -> None:
        await self.resource_setup.shutdown()

    def list_bots(self) -> list[dict]:
        return self.manager.list()

    def _present(self, bot: BotConfig) -> dict:
        return self.manager.snapshot(bot)

    def create(
        self,
        name: str,
        qq: str,
        port: int,
        password: str | None = None,
        napcat_port: int | None = None,
        framework: str = "nonebot",
    ) -> BotConfig:
        name = name.strip()
        qq = qq.strip()
        framework = framework.strip().lower()
        if not name or not re.fullmatch(r"\d{5,20}", qq):
            raise ValueError("Bot 名称不能为空，QQ 号必须是 5-20 位数字")
        if framework not in {"nonebot", "astrbot"}:
            raise ValueError("机器人框架必须是 NoneBot 或 AstrBot")
        if self.repository.exists_port(port):
            raise ConflictError(f"端口 {port} 已被占用")
        if self.repository.exists_qq(qq):
            raise ConflictError("这个 QQ 号已经存在")
        selected_napcat_port = napcat_port or self._next_napcat_port()
        if not 1024 <= selected_napcat_port <= 65535:
            raise ValueError("NapCat WebUI 端口必须在 1024-65535 之间")
        if self.repository.exists_napcat_port(selected_napcat_port):
            raise ConflictError(f"NapCat WebUI 端口 {selected_napcat_port} 已被占用")
        bot_id = uuid4().hex[:12]
        script = self._create_script(bot_id, port, framework)
        bot = BotConfig(id=bot_id, name=name, qq=qq, port=port, framework=framework, napcat_port=selected_napcat_port, script=str(script), password_secret=protect_secret(password))
        self.repository.create(bot)
        self.manager.refresh_bot_index()
        self.manager.napcat.sync_onebot_port(bot, runtime_config.ensure_onebot_access_token())
        return bot

    def _next_napcat_port(self) -> int:
        used = {bot.napcat_port for bot in self.repository.list()}
        port = DEFAULT_NAPCAT_PORT
        while port in used and port < 65535:
            port += 1
        return port

    def _create_script(self, bot_id: str, port: int, framework: str) -> Path:
        SCRIPT_DIR.mkdir(parents=True, exist_ok=True)
        script = SCRIPT_DIR / f"{bot_id}.ps1"
        self._write_script(script, bot_id, port, framework)
        return script

    @staticmethod
    def _write_script(script: Path, bot_id: str, port: int, framework: str) -> None:
        root = '$root = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))\n'
        if framework == "astrbot":
            content = (
                root
                + '$astrbot = if ($env:QQ_ASTRBOT_DIR) { $env:QQ_ASTRBOT_DIR } else { Join-Path $root "program\\AstrBot" }\n'
                + f'$instance = if ($env:QQ_ASTRBOT_INSTANCE_DIR) {{ $env:QQ_ASTRBOT_INSTANCE_DIR }} else {{ Join-Path $astrbot "instances\\{bot_id}" }}\n'
                + '$python = Join-Path $astrbot ".venv\\Scripts\\python.exe"\n'
                + 'if (-not (Test-Path $python)) { $python = Join-Path $root ".venv\\Scripts\\python.exe" }\n'
                + 'if (-not (Test-Path $python)) { $python = "python" }\n'
                + 'Set-Location $astrbot\n'
                + '$env:ASTRBOT_ROOT = $instance\n'
                + f'$env:ASTRBOT_BOT_ID = "{bot_id}"\n'
                + f'$env:ASTRBOT_ONEBOT_PORT = "{port}"\n'
                + '$env:PYTHONIOENCODING = "utf-8"\n'
                + '$env:PYTHONUTF8 = "1"\n'
                + '$env:PYTHONUNBUFFERED = "1"\n'
                + '& $python (Join-Path $astrbot "main.py")\n'
            )
        else:
            content = (
                root
                + '$nonebot = if ($env:QQ_NONEBOT_DIR) { $env:QQ_NONEBOT_DIR } else { Join-Path $root "program\\NoneBot" }\n'
                + '$python = Join-Path $root ".venv\\Scripts\\python.exe"\n'
                + 'if (-not (Test-Path $python)) { $python = "python" }\n'
                + 'Set-Location $nonebot\n'
                + '$env:HOST = "127.0.0.1"\n'
                + f'$env:PORT = "{port}"\n'
                + '$env:PYTHONIOENCODING = "utf-8"\n'
                + '$env:PYTHONUTF8 = "1"\n'
                + '$env:PYTHONUNBUFFERED = "1"\n'
                + '& $python (Join-Path $nonebot "bot.py")\n'
            )
        script.write_text(content, encoding="utf-8")

    async def delete(self, bot_id: str) -> None:
        bot = self.manager.get(bot_id)
        await self.manager.stop_now(bot_id, "删除")
        self.repository.delete(bot_id)
        self.manager.refresh_bot_index()
        self.stats.remove_bot(bot_id)
        script = Path(bot.script)
        if script.exists() and script.parent == SCRIPT_DIR:
            script.unlink()
        await self.event_bus.publish("INFO", "系统", f"删除了 Bot「{bot_id}」")

    async def action(self, bot_id: str, action: str) -> dict:
        return await self.manager.request_action(bot_id, action)

    async def update_password(self, bot_id: str, password: str | None) -> None:
        bot = self.manager.get(bot_id)
        self.repository.update_password(bot_id, protect_secret(password))
        await self.event_bus.publish("INFO", bot.name, "已更新密码回退配置")

    async def update_port(self, bot_id: str, port: int) -> None:
        bot = self.manager.get(bot_id)
        if not 1024 <= port <= 65535:
            raise ValueError("端口必须在 1024-65535 之间")
        if self.repository.exists_port(port, exclude_bot_id=bot_id):
            raise ConflictError(f"端口 {port} 已被其他 Bot 占用")
        self._write_script(Path(bot.script), bot.id, port, bot.framework)
        self.repository.update_port(bot_id, port)
        updated = self.repository.get(bot_id)
        if updated:
            self.manager.napcat.sync_onebot_port(updated, runtime_config.ensure_onebot_access_token())
        await self.event_bus.publish("INFO", bot.name, f"已更新 OneBot 端口为 {port}，已同步 NapCat 配置，重启 Bot 后生效")

    async def update_framework(self, bot_id: str, framework: str) -> None:
        bot = self.manager.get(bot_id)
        framework = framework.strip().lower()
        if framework not in {"nonebot", "astrbot"}:
            raise ValueError("机器人框架必须是 NoneBot 或 AstrBot")
        if self.manager.is_running(bot_id):
            raise ValueError("请先停止 Bot，再切换机器人框架")
        self._write_script(Path(bot.script), bot.id, bot.port, framework)
        self.repository.update_framework(bot_id, framework)
        updated = self.repository.get(bot_id)
        if updated:
            self.manager.napcat.sync_onebot_port(updated, runtime_config.ensure_onebot_access_token())
        await self.event_bus.publish("INFO", bot.name, f"已切换机器人框架为 {framework.title()}，重启 Bot 后生效")

    async def update_napcat_port(self, bot_id: str, port: int) -> None:
        bot = self.manager.get(bot_id)
        if not 1024 <= port <= 65535:
            raise ValueError("NapCat WebUI 端口必须在 1024-65535 之间")
        if self.repository.exists_napcat_port(port, exclude_bot_id=bot_id):
            raise ConflictError(f"NapCat WebUI 端口 {port} 已被其他 Bot 占用")
        self.repository.update_napcat_port(bot_id, port)
        await self.event_bus.publish("INFO", bot.name, f"已更新 NapCat WebUI 端口为 {port}，重启 Bot 后生效")

    async def command(self, bot_id: str, command: str) -> dict:
        command = command.strip()
        quick_login = re.fullmatch(r"-q\s+(\d{5,20})", command, flags=re.IGNORECASE)
        if not quick_login:
            quick_index = re.fullmatch(r"-q\s+(\d{1,4})", command, flags=re.IGNORECASE)
            if not quick_index:
                raise ValueError("目前支持的控制指令是：-q QQ号，或使用日志中的序号，例如 -q 2")
            target_index = quick_index.group(1)
            target_qq = None
            for event in self.event_bus.history():
                found = re.search(rf"(?:^|\s){re.escape(target_index)}\.\s*(\d{{5,20}})\s+", str(event.get("message", "")))
                if found:
                    target_qq = found.group(1)
                    break
            if not target_qq:
                raise ValueError(f"历史日志中没有找到快速登录序号 {target_index}")
            quick_login = re.fullmatch(r"(\d{5,20})", target_qq)
        return await self.manager.request_login(bot_id, quick_login.group(1))

    def napcat_status(self) -> dict:
        snapshots = self.manager.list()
        return {
            "available": self.manager.napcat.available,
            "path": str(runtime_config.NAPCAT_EXE),
            "running": sum(bool(item.get("runtime", {}).get("napcat", {}).get("running")) for item in snapshots),
        }

    def resources(self) -> dict:
        return runtime_config.resource_status()

    def update_resource(self, kind: str, path: str) -> dict:
        return runtime_config.set_resource_path(kind, path)

    def start_resource_setup(self, kinds: list[str] | None = None) -> dict:
        return self.resource_setup.start(kinds, self.repository.list())

    def resource_setup_status(self, job_id: str | None = None) -> dict:
        return self.resource_setup.status(job_id)
