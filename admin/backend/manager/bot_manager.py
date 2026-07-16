from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
import logging
import re
import time
from contextlib import suppress
from typing import Any
from uuid import uuid4

from backend.adapter.napcat import NapCatAdapter
from backend.adapter.onebot import OneBotAdapter
from backend.adapter.process import find_listening_process, terminate_processes
from backend.database.repository import BotRepository
from backend.database.stats_repository import MessageStatsRepository, parse_process_log_timestamp
from backend.domain.errors import BotNotFoundError, ConflictError, OperationError
from backend.domain.models import BotConfig
from backend.event.bus import EventBus


ACTIVE_OPERATION_STATES = {"queued", "running"}
TRANSITION_STATES = {"starting", "stopping", "restarting", "logging_in"}
DEFAULT_FRAMEWORK_STARTUP_TIMEOUT = 20.0
ASTRBOT_STARTUP_TIMEOUT = 180.0
_ANSI_RE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
_LOGGER = logging.getLogger(__name__)


StatsRecord = tuple[str, str, Any, str]


@dataclass
class BotRuntime:
    lifecycle: str = "stopped"
    operation_id: str | None = None
    operation_action: str | None = None
    last_error: str | None = None
    login_state: str = "unknown"
    last_log_at: float | None = None
    qr_login_requested: bool = False
    stop_requested: bool = False


@dataclass
class BotOperation:
    id: str
    bot_id: str
    action: str
    status: str = "queued"
    error: str | None = None
    created_at: float = field(default_factory=time.time)
    finished_at: float | None = None

    def payload(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "bot_id": self.bot_id,
            "action": self.action,
            "status": self.status,
            "error": self.error,
            "created_at": self.created_at,
            "finished_at": self.finished_at,
        }


class BotManager:
    """Own Bot lifecycle state and serialize every operation per account."""

    def __init__(self, repository: BotRepository, event_bus: EventBus, stats: MessageStatsRepository) -> None:
        self.repository = repository
        self.event_bus = event_bus
        self.stats = stats
        self.napcat = NapCatAdapter(self._emit)
        self.onebot = OneBotAdapter(self._emit)
        self._runtime: dict[str, BotRuntime] = {}
        self._operations: dict[str, BotOperation] = {}
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._probe_cache: dict[str, tuple[float, Any, Any]] = {}
        self._bot_by_source: dict[str, BotConfig] = {}
        self._stats_queue: asyncio.Queue[StatsRecord | None] | None = None
        self._stats_task: asyncio.Task[None] | None = None
        self._napcat_start_lock = asyncio.Lock()
        self.refresh_bot_index()

    def _runtime_for(self, bot_id: str) -> BotRuntime:
        return self._runtime.setdefault(bot_id, BotRuntime())

    def _lock_for(self, bot_id: str) -> asyncio.Lock:
        return self._locks.setdefault(bot_id, asyncio.Lock())

    def refresh_bot_index(self) -> None:
        self._bot_by_source = {bot.name: bot for bot in self.repository.list()}

    async def _emit(self, level: str, source: str, message: str) -> None:
        # NapCat and the selected bot framework both write message lines for
        # the same event. Keep framework output canonical and retain NapCat's
        # connection/login diagnostics.
        bot = self._bot_by_source.get(source)
        if self._is_napcat_message(message):
            # AstrBot's framework log does not include a direction marker;
            # its paired NapCat line is therefore the only reliable source
            # for message statistics. NoneBot already emits a directional
            # framework event, so keep the old de-duplication behavior there.
            if bot is not None and bot.framework == "astrbot":
                self._queue_stats_record(
                    bot.id,
                    message,
                    parse_process_log_timestamp(message),
                    self.stats.event_key({"source": source, "message": message}),
                )
            return
        try:
            event = await self.event_bus.publish(level, source, message)
        except Exception:  # noqa: BLE001 - a log sink must never kill a process tailer
            _LOGGER.exception("发布 Bot 日志事件失败：source=%s", source)
            return
        if bot is None:
            return
        runtime = self._runtime_for(bot.id)
        runtime.last_log_at = time.time()
        self._observe_log(runtime, message)
        if "密码回退需要验证码" in _ANSI_RE.sub("", message) and not runtime.qr_login_requested:
            runtime.qr_login_requested = True
            asyncio.create_task(self._queue_qr_login(bot.id))
        timestamp = event.get("timestamp")
        occurred_at = None
        if timestamp:
            from datetime import datetime

            try:
                occurred_at = datetime.fromisoformat(str(timestamp))
            except ValueError:
                pass
        self._queue_stats_record(
            bot.id,
            message,
            occurred_at,
            self.stats.event_key(event),
        )

    def _queue_stats_record(
        self,
        bot_id: str,
        message: str,
        occurred_at: Any,
        event_key: str,
    ) -> None:
        """Queue statistics separately so SQLite cannot stall log delivery."""
        if self._stats_queue is None:
            self._stats_queue = asyncio.Queue(maxsize=2000)
        if self._stats_task is None or self._stats_task.done():
            self._stats_task = asyncio.create_task(self._stats_loop())
        item: StatsRecord = (bot_id, message, occurred_at, event_key)
        try:
            self._stats_queue.put_nowait(item)
        except asyncio.QueueFull:
            # Dashboard logs are more important than an optional counter. Drop
            # only the oldest statistics item when the database is slower than
            # the Bot output.
            with suppress(asyncio.QueueEmpty):
                self._stats_queue.get_nowait()
                self._stats_queue.task_done()
            with suppress(asyncio.QueueFull):
                self._stats_queue.put_nowait(item)

    async def _stats_loop(self) -> None:
        queue = self._stats_queue
        if queue is None:
            return
        while True:
            item = await queue.get()
            try:
                if item is None:
                    return
                await asyncio.to_thread(self.stats.record_from_log, *item)
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - statistics must not affect Bot control
                _LOGGER.exception("写入 Bot 消息统计失败")
            finally:
                queue.task_done()

    @staticmethod
    def _is_napcat_message(message: str) -> bool:
        plain = _ANSI_RE.sub("", message)
        return bool(re.search(r"\|\s*(?:接收\s*<-|发送\s*->)\s*", plain))

    @staticmethod
    def _observe_log(runtime: BotRuntime, message: str) -> None:
        plain = _ANSI_RE.sub("", message)
        if any(token in plain for token in ("登录成功", "登录完成", "账号已登录", "安全验证成功")):
            runtime.login_state = "connected"
        elif "OneBot V11" in plain and ("connected" in plain.lower() or "连接成功" in plain):
            runtime.login_state = "connected"
        elif any(token in plain for token in ("需要验证码", "登录态已失效", "用户身份已失效", "密码回退需要验证码")):
            runtime.login_state = "verification_required"
        elif "连接错误" in plain or "ECONNREFUSED" in plain:
            runtime.login_state = "disconnected"

    def recover_external_logs(self) -> None:
        history = self.event_bus.history()
        for bot in self.repository.list():
            runtime = self._runtime_for(bot.id)
            for event in history:
                if str(event.get("source", "")) != bot.name:
                    continue
                self._observe_log(runtime, str(event.get("message", "")))
                if runtime.login_state != "unknown":
                    break
            onebot = self.onebot.discover(bot)
            napcat = self.napcat.discover(bot)
            self._probe_cache[bot.id] = (time.monotonic(), onebot, napcat)

    def get(self, bot_id: str) -> BotConfig:
        bot = self.repository.get(bot_id)
        if not bot:
            raise BotNotFoundError("Bot 不存在")
        return bot

    def is_running(self, bot_id: str) -> bool:
        bot = self.get(bot_id)
        onebot, _ = self._probe(bot, force=True)
        return onebot is not None

    def uptime(self, bot_id: str) -> int:
        return self.onebot.uptime(bot_id)

    def snapshot(self, bot: BotConfig) -> dict[str, Any]:
        runtime = self._runtime_for(bot.id)
        operation = self._active_operation(bot.id)
        onebot, napcat = self._probe(bot)

        if operation is not None:
            status = {
                "start": "starting",
                "stop": "stopping",
                "restart": "restarting",
                "login": "logging_in",
            }.get(operation.action, "starting")
        elif onebot is not None:
            status = "login_required" if runtime.login_state == "verification_required" else "running"
        elif runtime.last_error:
            status = "error"
        elif napcat is not None and runtime.login_state == "disconnected":
            # NapCat can remain alive after the framework process exits. Do
            # not present that orphaned protocol process as a successful start.
            framework_label = "AstrBot" if bot.framework == "astrbot" else "NoneBot"
            runtime.last_error = f"{framework_label} 未监听端口 {bot.port}"
            status = "error"
        elif napcat is not None:
            status = "starting"
        else:
            status = "stopped"

        runtime.lifecycle = status
        return {
            "id": bot.id,
            "name": bot.name,
            "qq": bot.qq,
            "port": bot.port,
            "framework": bot.framework,
            "framework_label": "AstrBot" if bot.framework == "astrbot" else "NoneBot",
            "napcat_port": bot.napcat_port,
            "status": status,
            "state": status,
            "groups": bot.groups,
            "plugins": bot.plugins,
            "password_configured": bool(bot.password_secret),
            "uptime_seconds": self.onebot.uptime(bot.id),
            "managed": True,
            "login_state": runtime.login_state,
            "error": runtime.last_error,
            "operation": operation.payload() if operation else None,
            "runtime": {
                "framework": {"running": onebot is not None, "pid": onebot.pid if onebot else None},
                "napcat": {"running": napcat is not None, "pid": napcat.pid if napcat else None},
            },
        }

    def list(self) -> list[dict[str, Any]]:
        return [self.snapshot(bot) for bot in self.repository.list()]

    def _probe(self, bot: BotConfig, force: bool = False) -> tuple[Any, Any]:
        now = time.monotonic()
        cached = self._probe_cache.get(bot.id)
        if not force and cached is not None and now - cached[0] < 1.0:
            return cached[1], cached[2]
        onebot = self.onebot.discover(bot)
        napcat = self.napcat.discover(bot)
        self._probe_cache[bot.id] = (now, onebot, napcat)
        return onebot, napcat

    def _invalidate_probe(self, bot_id: str) -> None:
        self._probe_cache.pop(bot_id, None)

    def _active_operation(self, bot_id: str) -> BotOperation | None:
        runtime = self._runtime_for(bot_id)
        if not runtime.operation_id:
            return None
        operation = self._operations.get(runtime.operation_id)
        if operation and operation.status in ACTIVE_OPERATION_STATES:
            return operation
        return None

    def _new_operation(self, bot_id: str, action: str) -> BotOperation:
        operation = BotOperation(uuid4().hex[:16], bot_id, action)
        runtime = self._runtime_for(bot_id)
        runtime.operation_id = operation.id
        runtime.operation_action = action
        runtime.last_error = None
        self._invalidate_probe(bot_id)
        self._operations[operation.id] = operation
        return operation

    async def request_action(self, bot_id: str, action: str) -> dict[str, Any]:
        if action not in {"start", "stop", "restart"}:
            raise ValueError("无效的操作")
        bot = self.get(bot_id)
        async with self._lock_for(bot_id):
            active = self._active_operation(bot_id)
            if active is not None:
                if active.action == action:
                    return self._action_response(bot_id, action, active)
                if action == "stop":
                    # Stop has priority over an in-flight start/login. Queue the
                    # cleanup immediately and cancel the current task outside
                    # this lock so a stuck readiness wait cannot block cleanup.
                    runtime = self._runtime_for(bot_id)
                    runtime.stop_requested = True
                    operation = self._new_operation(bot_id, action)
                    active_task = self._tasks.get(active.id)
                    if active_task is not None and not active_task.done():
                        active_task.cancel()
                    task = asyncio.create_task(self._run_operation(operation, active_task))
                    self._tasks[operation.id] = task
                    return self._action_response(bot_id, action, operation)
                raise ConflictError(f"Bot「{bot.name}」正在执行{_action_label(active.action)}，请稍后重试")

            # A stop request must not perform a synchronous psutil probe before
            # it is acknowledged. Even if the cached status is stale, the
            # cleanup operation is idempotent and can safely discover that no
            # process remains.
            if action != "stop":
                current = self.snapshot(bot)
                if action == "start" and current["status"] in {"running", "login_required"}:
                    return self._action_response(bot_id, action, None)

            runtime = self._runtime_for(bot_id)
            if action in {"start", "restart"}:
                runtime.stop_requested = False
            elif action == "stop":
                runtime.stop_requested = True
            operation = self._new_operation(bot_id, action)
            task = asyncio.create_task(self._run_operation(operation))
            self._tasks[operation.id] = task
            return self._action_response(bot_id, action, operation)

    def _action_response(self, bot_id: str, action: str, operation: BotOperation | None) -> dict[str, Any]:
        runtime = self._runtime_for(bot_id)
        status = {
            "start": "starting",
            "stop": "stopping",
            "restart": "restarting",
        }.get(action, runtime.lifecycle)
        if operation is None:
            status = runtime.lifecycle
        return {
            "ok": True,
            "bot_id": bot_id,
            "action": action,
            "status": status,
            "operation_id": operation.id if operation else None,
            "operation": operation.payload() if operation else None,
        }

    async def _run_operation(self, operation: BotOperation, wait_for: asyncio.Task[None] | None = None) -> None:
        bot = self.get(operation.bot_id)
        runtime = self._runtime_for(bot.id)
        operation.status = "running"
        runtime.lifecycle = {
            "start": "starting",
            "stop": "stopping",
            "restart": "restarting",
        }.get(operation.action, "starting")
        try:
            if wait_for is not None:
                await asyncio.gather(wait_for, return_exceptions=True)
            if operation.action == "start":
                await self._start_now(bot)
                await self._emit("INFO", bot.name, f"Bot 已启动，监听端口 {bot.port}")
            elif operation.action == "stop":
                await self._stop_now(bot)
                await self._emit("INFO", bot.name, "Bot 已停止（停止）")
            elif operation.action == "restart":
                await self._stop_now(bot)
                await self._start_now(bot)
                await self._emit("INFO", bot.name, f"Bot 已重启，监听端口 {bot.port}")
            operation.status = "succeeded"
            runtime.last_error = None
        except asyncio.CancelledError:
            operation.status = "cancelled"
            raise
        except Exception as error:  # noqa: BLE001 - surfaced in operation status and event log
            operation.status = "failed"
            operation.error = str(error)
            runtime.last_error = str(error)
            await self._emit("ERROR", bot.name, f"Bot 操作失败：{error}")
        finally:
            operation.finished_at = time.time()
            if runtime.operation_id == operation.id:
                runtime.operation_id = None
                runtime.operation_action = None
            self._tasks.pop(operation.id, None)
            self._trim_operations()

    async def _start_now(self, bot: BotConfig, quick_login: str | None = None) -> None:
        if self.onebot.discover(bot) is not None:
            return
        runtime = self._runtime_for(bot.id)
        runtime.login_state = "unknown"
        runtime.qr_login_requested = False
        self.onebot.prepare(bot)
        self.napcat.sync_onebot_port(bot)
        async with self._napcat_start_lock:
            await self.napcat.start(bot, quick_login=quick_login or bot.qq)
        try:
            await self.onebot.start(bot)
            await self._wait_for_ready(bot)
        except Exception:
            await self._stop_now(bot)
            raise
        self._invalidate_probe(bot.id)

    async def _wait_for_ready(self, bot: BotConfig, timeout: float | None = None) -> None:
        framework_label = "AstrBot" if bot.framework == "astrbot" else "NoneBot"
        startup_timeout = timeout if timeout is not None else (
            ASTRBOT_STARTUP_TIMEOUT if bot.framework == "astrbot" else DEFAULT_FRAMEWORK_STARTUP_TIMEOUT
        )
        deadline = time.monotonic() + startup_timeout
        framework_ready = False
        napcat_ready = False
        while time.monotonic() < deadline:
            framework_ready = find_listening_process(bot.port) is not None and self.onebot.discover(bot) is not None
            napcat_ready = self.napcat.discover(bot) is not None
            if framework_ready and napcat_ready:
                return
            if not framework_ready and self.onebot.tracked_process(bot.id) is None:
                raise OperationError(
                    f"Bot「{bot.name}」启动失败：{framework_label} 进程已退出，端口 {bot.port} 未监听"
                )
            await asyncio.sleep(0.25)
        if not framework_ready:
            raise OperationError(f"Bot「{bot.name}」启动超时：{framework_label} 未在端口 {bot.port} 监听")
        raise OperationError(f"Bot「{bot.name}」启动超时：NapCat 进程未保持运行")

    async def _stop_now(self, bot: BotConfig) -> None:
        pids = self.onebot.process_ids_for_bot(bot) | self.napcat.process_ids_for_bot(bot)
        remaining = await terminate_processes(pids, timeout=7.0)
        self.onebot.forget(bot.id)
        self.napcat.forget(bot.id)
        self._invalidate_probe(bot.id)
        if remaining:
            raise OperationError(f"Bot「{bot.name}」仍有进程未退出：{', '.join(str(pid) for pid in sorted(remaining))}")

    async def request_login(
        self,
        bot_id: str,
        qq: str,
        use_password: bool = True,
        wait_for_active: bool = False,
    ) -> dict[str, Any]:
        bot = self.get(bot_id)
        active_task: asyncio.Task[None] | None = None
        async with self._lock_for(bot_id):
            active = self._active_operation(bot_id)
            if active is not None:
                if not wait_for_active:
                    raise ConflictError(f"Bot「{bot.name}」正在执行{_action_label(active.action)}，请稍后重试")
                if active.action == "stop":
                    raise ConflictError(f"Bot「{bot.name}」正在停止，请稍后重试")
                active_task = self._tasks.get(active.id)

        # Never hold the per-bot lock while waiting for another lifecycle task.
        if active_task is not None:
            await asyncio.gather(active_task, return_exceptions=True)

        async with self._lock_for(bot_id):
            active = self._active_operation(bot_id)
            if active is not None:
                if active.action == "stop":
                    raise ConflictError(f"Bot「{bot.name}」正在停止，请稍后重试")
                raise ConflictError(f"Bot「{bot.name}」正在执行{_action_label(active.action)}，请稍后重试")
            runtime = self._runtime_for(bot_id)
            if wait_for_active and runtime.stop_requested:
                raise ConflictError(f"Bot「{bot.name}」正在停止，请稍后重试")
            if not wait_for_active:
                runtime.stop_requested = False
            if use_password:
                runtime.qr_login_requested = False
            operation = self._new_operation(bot_id, "login")
            task = asyncio.create_task(self._run_login(operation, qq, use_password))
            self._tasks[operation.id] = task
            return {
                "ok": True,
                "bot_id": bot_id,
                "command": f"-q {qq}",
                "status": "logging_in",
                "operation_id": operation.id,
                "operation": operation.payload(),
            }

    async def _run_login(self, operation: BotOperation, qq: str, use_password: bool = True) -> None:
        bot = self.get(operation.bot_id)
        runtime = self._runtime_for(bot.id)
        operation.status = "running"
        runtime.lifecycle = "logging_in"
        if not use_password:
            runtime.login_state = "verification_required"
        try:
            napcat_pids = self.napcat.process_ids_for_bot(bot)
            await terminate_processes(napcat_pids, timeout=7.0)
            self.napcat.forget(bot.id)
            if runtime.stop_requested:
                operation.status = "cancelled"
                return
            async with self._napcat_start_lock:
                await self.napcat.start(bot, quick_login=qq, use_password=use_password)
            if runtime.stop_requested:
                operation.status = "cancelled"
                return
            if self.onebot.discover(bot) is None:
                await self.onebot.start(bot)
            await self._wait_for_ready(bot)
            runtime.login_state = "unknown" if use_password else "verification_required"
            self._invalidate_probe(bot.id)
            operation.status = "succeeded"
            message = f"已使用 QQ {qq} 发送快速登录指令" if use_password else f"已切换为 QQ {qq} 二维码登录"
            await self._emit("INFO", bot.name, message)
        except asyncio.CancelledError:
            operation.status = "cancelled"
            raise
        except Exception as error:  # noqa: BLE001 - surfaced in operation status and event log
            operation.status = "failed"
            operation.error = str(error)
            runtime.last_error = str(error)
            await self._emit("ERROR", bot.name, f"快速登录失败：{error}")
        finally:
            operation.finished_at = time.time()
            if runtime.operation_id == operation.id:
                runtime.operation_id = None
                runtime.operation_action = None
            self._tasks.pop(operation.id, None)
            self._trim_operations()

    async def _queue_qr_login(self, bot_id: str) -> None:
        try:
            bot = self.get(bot_id)
            if self._runtime_for(bot_id).stop_requested:
                return
            await self.request_login(bot_id, bot.qq, use_password=False, wait_for_active=True)
        except asyncio.CancelledError:
            raise
        except Exception as error:  # noqa: BLE001 - surfaced in the event log
            if self._runtime_for(bot_id).stop_requested:
                return
            bot = self.repository.get(bot_id)
            if bot is not None:
                await self._emit("ERROR", bot.name, f"自动切换二维码登录失败：{error}")

    async def stop_now(self, bot_id: str, reason: str = "停止") -> None:
        bot = self.get(bot_id)
        task: asyncio.Task[None] | None = None
        async with self._lock_for(bot_id):
            self._runtime_for(bot_id).stop_requested = True
            active = self._active_operation(bot_id)
            if active is not None:
                task = self._tasks.get(active.id)
                if task is not None and not task.done():
                    task.cancel()
        # Wait without holding the same lock used by lifecycle requests.
        if task is not None:
            await asyncio.gather(task, return_exceptions=True)
        async with self._lock_for(bot_id):
            await self._stop_now(bot)
            await self._emit("INFO", bot.name, f"Bot 已停止（{reason}）")

    def operation(self, operation_id: str) -> dict[str, Any] | None:
        operation = self._operations.get(operation_id)
        return operation.payload() if operation else None

    def _trim_operations(self) -> None:
        if len(self._operations) <= 100:
            return
        finished = [item for item in self._operations.values() if item.status not in ACTIVE_OPERATION_STATES]
        finished.sort(key=lambda item: item.finished_at or item.created_at)
        for item in finished[: max(0, len(self._operations) - 100)]:
            self._operations.pop(item.id, None)

    async def shutdown(self) -> None:
        tasks = tuple(self._tasks.values())
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        stats_task = self._stats_task
        stats_queue = self._stats_queue
        if stats_task is not None and not stats_task.done():
            if stats_queue is not None:
                with suppress(asyncio.QueueFull):
                    stats_queue.put_nowait(None)
            with suppress(asyncio.CancelledError, asyncio.TimeoutError):
                await asyncio.wait_for(stats_task, timeout=2.0)
        self._stats_task = None
        self._stats_queue = None
        # Only processes started by this backend belong to its shutdown scope.
        # Discovered external processes must remain available for the next session.
        await self.onebot.shutdown()
        await self.napcat.shutdown()


def _action_label(action: str) -> str:
    return {"start": "启动", "stop": "停止", "restart": "重启", "login": "登录"}.get(action, action)
