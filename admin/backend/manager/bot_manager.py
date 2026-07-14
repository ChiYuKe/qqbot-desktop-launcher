from __future__ import annotations

import asyncio

from backend.adapter.napcat import NapCatAdapter
from backend.adapter.onebot import OneBotAdapter
from backend.database.repository import BotRepository
from backend.database.stats_repository import MessageStatsRepository
from backend.domain.errors import BotNotFoundError
from backend.domain.models import BotConfig
from backend.event.bus import EventBus


class BotManager:
    def __init__(self, repository: BotRepository, event_bus: EventBus, stats: MessageStatsRepository) -> None:
        self.repository = repository
        self.event_bus = event_bus
        self.stats = stats
        self.napcat = NapCatAdapter(self._emit)
        self.onebot = OneBotAdapter(self._emit)
        self._napcat_start_lock = asyncio.Lock()

    async def _emit(self, level: str, source: str, message: str) -> None:
        event = await self.event_bus.publish(level, source, message)
        bot = next((item for item in self.repository.list() if item.name == source), None)
        if bot:
            occurred_at = None
            timestamp = event.get("timestamp")
            if timestamp:
                from datetime import datetime
                try:
                    occurred_at = datetime.fromisoformat(str(timestamp))
                except ValueError:
                    occurred_at = None
            self.stats.record_from_log(
                bot.id,
                message,
                occurred_at,
                event_key=self.stats.event_key(event),
            )

    def recover_external_logs(self) -> None:
        """Attach log tailers to Bot processes that survived an API restart."""
        for bot in self.repository.list():
            onebot_process = self.onebot.external_process(bot)
            if onebot_process is not None:
                self.onebot.attach_external(bot, onebot_process)
            napcat_process = self.napcat.external_process(bot)
            if napcat_process is not None:
                self.napcat.attach_external(bot, napcat_process)

    def get(self, bot_id: str) -> BotConfig:
        bot = self.repository.get(bot_id)
        if not bot:
            raise BotNotFoundError("Bot 不存在")
        return bot

    def is_running(self, bot_id: str) -> bool:
        bot = self.get(bot_id)
        return self.onebot.is_running_for_bot(bot)

    def uptime(self, bot_id: str) -> int:
        return self.onebot.uptime(bot_id)

    async def start(self, bot_id: str) -> None:
        bot = self.get(bot_id)
        if self.onebot.is_running_for_bot(bot):
            await self._emit("INFO", bot.name, f"检测到 Bot 已在端口 {bot.port} 运行，已接管现有进程")
            return
        self.napcat.sync_onebot_port(bot)
        # Start through NapCat's quick-login flow so it can continue to
        # password fallback or QR login without requiring a manual -q command.
        async with self._napcat_start_lock:
            await self.napcat.start(bot, quick_login=bot.qq)
        try:
            await self.onebot.start(bot)
        except Exception:
            await self.napcat.stop(bot_id)
            raise
        await self._emit("INFO", bot.name, f"Bot 已启动，监听端口 {bot.port}")

    async def quick_login(self, bot_id: str, qq: str) -> None:
        bot = self.get(bot_id)
        if self.napcat.is_running_for_bot(bot):
            await self.napcat.stop(bot.id)
            await self.napcat.stop_external(bot)
        async with self._napcat_start_lock:
            await self.napcat.start(bot, quick_login=qq)
        if not self.onebot.is_running_for_bot(bot):
            await self.onebot.start(bot)
        await self._emit("INFO", bot.name, f"已使用 QQ {qq} 发送快速登录指令")

    async def stop(self, bot_id: str, reason: str = "停止") -> None:
        bot = self.get(bot_id)
        await self.onebot.stop(bot_id)
        await self.onebot.stop_external(bot)
        await self.napcat.stop(bot_id)
        await self.napcat.stop_external(bot)
        if self.onebot.is_running_for_bot(bot) or self.napcat.is_running_for_bot(bot):
            raise RuntimeError(f"Bot「{bot.name}」的进程仍未完全退出，请稍后重试")
        await self._emit("INFO", bot.name, f"Bot 已停止（{reason}）")

    async def restart(self, bot_id: str) -> None:
        await self.stop(bot_id, "重启")
        await self.start(bot_id)

    async def shutdown(self) -> None:
        for bot in self.repository.list():
            if self.onebot.is_running_for_bot(bot) or self.napcat.is_running_for_bot(bot):
                await self.stop(bot.id, "管理服务关闭")
        await self.onebot.shutdown()
        await self.napcat.shutdown()
