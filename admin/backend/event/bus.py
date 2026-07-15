from __future__ import annotations

import asyncio
import json
import logging
import time
from collections import deque
from contextlib import suppress
from datetime import datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from backend.config import EVENT_HISTORY_LIMIT


_LOGGER = logging.getLogger(__name__)


class EventBus:
    """Bounded in-memory event stream with serialized background persistence."""

    def __init__(self, history_limit: int = EVENT_HISTORY_LIMIT, storage_path: Path | None = None) -> None:
        self._history = deque[dict[str, Any]](maxlen=history_limit)
        self._subscribers: set[asyncio.Queue[dict[str, Any]]] = set()
        self._storage_path = storage_path
        self._events_since_compaction = 0
        self._storage_queue: asyncio.Queue[dict[str, Any] | None] | None = None
        self._storage_task: asyncio.Task[None] | None = None
        self._storage_lock = asyncio.Lock()
        self._load_history()

    def _load_history(self) -> None:
        if self._storage_path is None or not self._storage_path.exists():
            return
        try:
            with self._storage_path.open("r", encoding="utf-8") as stream:
                for raw_line in stream:
                    try:
                        event = json.loads(raw_line)
                    except (TypeError, ValueError):
                        continue
                    if isinstance(event, dict) and {"time", "level", "source", "message"} <= event.keys():
                        self._history.appendleft(event)
        except (OSError, UnicodeError):
            return
        self._compact_if_needed(force=True)

    async def start(self) -> None:
        if self._storage_path is None or self._storage_task is not None:
            return
        self._storage_queue = asyncio.Queue(maxsize=2000)
        self._storage_task = asyncio.create_task(self._storage_loop())

    async def stop(self) -> None:
        queue = self._storage_queue
        task = self._storage_task
        if queue is None or task is None:
            return
        await queue.join()
        await queue.put(None)
        with suppress(asyncio.CancelledError):
            await task
        self._storage_queue = None
        self._storage_task = None

    async def _storage_loop(self) -> None:
        queue = self._storage_queue
        if queue is None:
            return
        while True:
            event = await queue.get()
            try:
                if event is None:
                    return
                async with self._storage_lock:
                    try:
                        await asyncio.to_thread(self._append_to_storage, event)
                    except asyncio.CancelledError:
                        raise
                    except Exception:  # noqa: BLE001 - persistence must not stop the event stream
                        _LOGGER.exception("持久化管理日志失败")
            finally:
                queue.task_done()

    def _append_to_storage(self, event: dict[str, Any]) -> None:
        if self._storage_path is None:
            return
        try:
            self._storage_path.parent.mkdir(parents=True, exist_ok=True)
            with self._storage_path.open("a", encoding="utf-8") as stream:
                stream.write(json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n")
            self._events_since_compaction += 1
            self._compact_if_needed()
        except (OSError, UnicodeError):
            return

    def _compact_if_needed(self, force: bool = False) -> None:
        if self._storage_path is None or not self._storage_path.exists():
            return
        try:
            size = self._storage_path.stat().st_size
        except OSError:
            return
        threshold = max(1024 * 1024, len(self._history) * 4096)
        if not force and (size <= threshold or self._events_since_compaction < 100):
            return
        temporary_path = self._storage_path.with_suffix(f"{self._storage_path.suffix}.tmp")
        try:
            with temporary_path.open("w", encoding="utf-8") as stream:
                for event in reversed(self._history):
                    stream.write(json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n")
            temporary_path.replace(self._storage_path)
            self._events_since_compaction = 0
        except (OSError, UnicodeError):
            with suppress(OSError):
                temporary_path.unlink(missing_ok=True)

    async def publish(self, level: str, source: str, message: str) -> dict[str, Any]:
        event = {
            "id": uuid4().hex,
            "time": time.strftime("%H:%M:%S"),
            "timestamp": datetime.now().isoformat(timespec="seconds"),
            "level": level.upper(),
            "source": source,
            "message": message,
        }
        self._history.appendleft(event)
        queue = self._storage_queue
        if queue is None:
            self._append_to_storage(event)
        else:
            # Log persistence must never hold up process-tail tasks or the
            # control API. If disk is temporarily slower than the log stream,
            # retain the newest events in memory and discard the oldest queued
            # persistence item instead of blocking every lifecycle request.
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                with suppress(asyncio.QueueEmpty):
                    queue.get_nowait()
                    queue.task_done()
                with suppress(asyncio.QueueFull):
                    queue.put_nowait(event)
        for subscriber in tuple(self._subscribers):
            try:
                subscriber.put_nowait(event)
            except asyncio.QueueFull:
                with suppress(asyncio.QueueEmpty):
                    subscriber.get_nowait()
                with suppress(asyncio.QueueFull):
                    subscriber.put_nowait(event)
        return event

    def history(self) -> list[dict[str, Any]]:
        return list(self._history)

    async def clear(self) -> None:
        queue = self._storage_queue
        if queue is not None:
            while True:
                try:
                    queue.get_nowait()
                except asyncio.QueueEmpty:
                    break
                else:
                    queue.task_done()
        self._history.clear()
        self._events_since_compaction = 0
        if self._storage_path is None:
            return
        async with self._storage_lock:
            await asyncio.to_thread(self._storage_path.unlink, missing_ok=True)

    def subscribe(self) -> asyncio.Queue[dict[str, Any]]:
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=100)
        self._subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue[dict[str, Any]]) -> None:
        self._subscribers.discard(queue)
