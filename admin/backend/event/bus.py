from __future__ import annotations

import asyncio
import json
import time
from collections import deque
from datetime import datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from backend.config import EVENT_HISTORY_LIMIT


class EventBus:
    def __init__(self, history_limit: int = EVENT_HISTORY_LIMIT, storage_path: Path | None = None) -> None:
        self._history_limit = history_limit
        self._history: deque[dict[str, Any]] = deque(maxlen=history_limit)
        self._subscribers: set[asyncio.Queue[dict[str, Any]]] = set()
        self._storage_path = storage_path
        self._events_since_compaction = 0
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
                        # The file is written oldest-to-newest while the in-memory
                        # history is exposed newest-first.
                        self._history.appendleft(event)
        except (OSError, UnicodeError):
            # A damaged or temporarily unavailable log file must not prevent the
            # management API from starting.
            return

        self._compact_if_needed(force=True)

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
            # Logging should remain best-effort and must never take down a Bot.
            return

    def _compact_if_needed(self, force: bool = False) -> None:
        if self._storage_path is None or not self._storage_path.exists():
            return
        try:
            size = self._storage_path.stat().st_size
        except OSError:
            return

        threshold = max(1024 * 1024, self._history_limit * 4096)
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
            try:
                temporary_path.unlink(missing_ok=True)
            except OSError:
                pass

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
        self._append_to_storage(event)
        for queue in tuple(self._subscribers):
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                try:
                    queue.get_nowait()
                    queue.put_nowait(event)
                except asyncio.QueueEmpty:
                    pass
        return event

    def history(self) -> list[dict[str, Any]]:
        return list(self._history)

    def clear(self) -> None:
        self._history.clear()
        self._events_since_compaction = 0
        for queue in tuple(self._subscribers):
            while True:
                try:
                    queue.get_nowait()
                except asyncio.QueueEmpty:
                    break
        if self._storage_path is None:
            return
        try:
            self._storage_path.unlink(missing_ok=True)
        except OSError:
            # Clearing the in-memory view is still useful if the file is locked
            # by another process; the next event will try to persist normally.
            return

    def subscribe(self) -> asyncio.Queue[dict[str, Any]]:
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=100)
        self._subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue[dict[str, Any]]) -> None:
        self._subscribers.discard(queue)
