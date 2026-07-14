from __future__ import annotations

import json
import hashlib
import re
import sqlite3
from contextlib import contextmanager
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Iterator, Iterable


SCHEMA = """
CREATE TABLE IF NOT EXISTS message_stats_daily (
    bot_id TEXT NOT NULL,
    day TEXT NOT NULL,
    received INTEGER NOT NULL DEFAULT 0,
    sent INTEGER NOT NULL DEFAULT 0,
    groups INTEGER NOT NULL DEFAULT 0,
    private INTEGER NOT NULL DEFAULT 0,
    media INTEGER NOT NULL DEFAULT 0,
    commands INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (bot_id, day)
);
CREATE TABLE IF NOT EXISTS message_stats_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_message_stats_day ON message_stats_daily(day);
CREATE TABLE IF NOT EXISTS message_stats_events (
    event_key TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL,
    day TEXT NOT NULL,
    direction TEXT NOT NULL,
    message_type TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_message_stats_events_bot_day ON message_stats_events(bot_id, day);
"""


class MessageStatsRepository:
    """Persistent daily message counters used by the runtime dashboard."""

    def __init__(self, database_file: Path) -> None:
        self.database_file = database_file
        self.database_file.parent.mkdir(parents=True, exist_ok=True)
        with self._connection() as connection:
            connection.executescript(SCHEMA)

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database_file, timeout=10)
        connection.row_factory = sqlite3.Row
        return connection

    @contextmanager
    def _connection(self) -> Iterator[sqlite3.Connection]:
        connection = self._connect()
        try:
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    @staticmethod
    def _column_for(direction: str, message_type: str) -> str:
        if direction not in {"received", "sent"}:
            raise ValueError("统计方向必须是 received 或 sent")
        return direction

    def record(
        self,
        bot_id: str,
        direction: str,
        message_type: str = "unknown",
        occurred_at: datetime | None = None,
        event_key: str | None = None,
    ) -> bool:
        day = (occurred_at or datetime.now()).date().isoformat()
        with self._connection() as connection:
            if event_key:
                inserted = connection.execute(
                    "INSERT OR IGNORE INTO message_stats_events "
                    "(event_key, bot_id, day, direction, message_type) VALUES (?, ?, ?, ?, ?)",
                    (event_key, bot_id, day, direction, message_type),
                ).rowcount
                if not inserted:
                    return False
            self._upsert_daily(connection, bot_id, day, direction, message_type)
        return True

    @staticmethod
    def _upsert_daily(
        connection: sqlite3.Connection,
        bot_id: str,
        day: str,
        direction: str,
        message_type: str,
    ) -> None:
        """Increment one daily row; callers own the surrounding transaction."""
        if direction not in {"received", "sent"}:
            raise ValueError("统计方向必须是 received 或 sent")
        connection.execute(
            "INSERT INTO message_stats_daily (bot_id, day, received, sent, groups, private, media, commands) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(bot_id, day) DO UPDATE SET "
            "received = message_stats_daily.received + excluded.received, "
            "sent = message_stats_daily.sent + excluded.sent, "
            "groups = message_stats_daily.groups + excluded.groups, "
            "private = message_stats_daily.private + excluded.private, "
            "media = message_stats_daily.media + excluded.media, "
            "commands = message_stats_daily.commands + excluded.commands",
            (
                bot_id,
                day,
                int(direction == "received"),
                int(direction == "sent"),
                int(message_type in {"group", "group_media"}),
                int(message_type in {"private", "private_media"}),
                int("media" in message_type),
                int(message_type == "command"),
            ),
        )

    @staticmethod
    def event_key(event: dict[str, Any]) -> str:
        """Return a stable key for both new and legacy event records."""
        explicit_id = str(event.get("id", "")).strip()
        if explicit_id:
            return explicit_id
        payload = {
            "time": event.get("time"),
            "timestamp": event.get("timestamp"),
            "level": event.get("level"),
            "source": event.get("source"),
            "message": event.get("message"),
        }
        encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
        return hashlib.sha256(encoded).hexdigest()

    @staticmethod
    def _parse_timestamp(event: dict[str, Any]) -> datetime | None:
        timestamp = event.get("timestamp")
        if not timestamp:
            return None
        try:
            return datetime.fromisoformat(str(timestamp))
        except ValueError:
            return None

    @staticmethod
    def _direction_and_type(message: str) -> tuple[str | None, str]:
        plain = _strip_ansi(message)
        if re.search(r"OneBot V11\b.*\[message\.(?:group|private)\.", plain, flags=re.IGNORECASE):
            return "received", _message_type(plain)
        if re.search(r"接收\s*<-", plain):
            return "received", _message_type(plain)
        if re.search(r"发送\s*->", plain):
            return "sent", _message_type(plain)
        return None, "unknown"

    def _event_rows(self, event_file: Path, bots: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
        source_to_id = {str(bot.get("name")): str(bot.get("id")) for bot in bots}
        rows: list[dict[str, Any]] = []
        if not event_file.exists():
            return rows
        try:
            with event_file.open("r", encoding="utf-8") as stream:
                for raw in stream:
                    try:
                        event = json.loads(raw)
                    except (TypeError, ValueError):
                        continue
                    if not isinstance(event, dict):
                        continue
                    bot_id = source_to_id.get(str(event.get("source", "")))
                    if not bot_id:
                        continue
                    message = str(event.get("message", ""))
                    direction, message_type = self._direction_and_type(message)
                    if direction is None:
                        continue
                    occurred_at = self._parse_timestamp(event)
                    day = (occurred_at or datetime.now()).date().isoformat()
                    rows.append({
                        "key": self.event_key(event),
                        "bot_id": bot_id,
                        "day": day,
                        "direction": direction,
                        "message_type": message_type,
                    })
        except (OSError, UnicodeError):
            return []
        return rows

    def _insert_event(self, connection: sqlite3.Connection, row: dict[str, Any], count_daily: bool) -> bool:
        inserted = connection.execute(
            "INSERT OR IGNORE INTO message_stats_events "
            "(event_key, bot_id, day, direction, message_type) VALUES (?, ?, ?, ?, ?)",
            (row["key"], row["bot_id"], row["day"], row["direction"], row["message_type"]),
        ).rowcount
        if not inserted:
            return False
        if count_daily:
            self._upsert_daily(connection, row["bot_id"], row["day"], row["direction"], row["message_type"])
        return True

    def record_from_log(
        self,
        bot_id: str,
        message: str,
        occurred_at: datetime | None = None,
        event_key: str | None = None,
    ) -> bool:
        """Record a directional console line, ignoring a repeated event key."""
        plain = _strip_ansi(message)
        direction, message_type = self._direction_and_type(plain)
        if direction is None:
            return False
        return self.record(bot_id, direction, message_type, occurred_at, event_key)

    def backfill_events(self, event_file: Path, bots: Iterable[dict[str, Any]]) -> int:
        """Incrementally import event history without double counting on restart."""
        rows = self._event_rows(event_file, bots)
        imported = 0
        with self._connection() as connection:
            marker = connection.execute(
                "SELECT value FROM message_stats_meta WHERE key = 'stats_ledger_v1'"
            ).fetchone()
            if marker:
                for row in rows:
                    if self._insert_event(connection, row, count_daily=True):
                        imported += 1
                return imported

            # Existing versions stored aggregate daily rows but no event keys.
            # Consume those existing counts as a migration budget, then count
            # only events beyond that budget. This preserves old totals while
            # making every event idempotent from this point forward.
            budget: dict[tuple[str, str, str], int] = {}
            for daily in connection.execute(
                "SELECT bot_id, day, received, sent FROM message_stats_daily"
            ).fetchall():
                budget[(str(daily["bot_id"]), str(daily["day"]), "received")] = int(daily["received"] or 0)
                budget[(str(daily["bot_id"]), str(daily["day"]), "sent")] = int(daily["sent"] or 0)

            for row in rows:
                budget_key = (row["bot_id"], row["day"], row["direction"])
                preserve_existing = budget.get(budget_key, 0) > 0
                if preserve_existing:
                    budget[budget_key] -= 1
                if self._insert_event(connection, row, count_daily=not preserve_existing):
                    imported += int(not preserve_existing)

            connection.execute(
                "INSERT OR REPLACE INTO message_stats_meta (key, value) VALUES ('stats_ledger_v1', ?)",
                (str(len(rows)),),
            )
        return imported

    def remove_bot(self, bot_id: str) -> None:
        with self._connection() as connection:
            connection.execute("DELETE FROM message_stats_daily WHERE bot_id = ?", (bot_id,))
            connection.execute("DELETE FROM message_stats_events WHERE bot_id = ?", (bot_id,))

    @staticmethod
    def _period_start(period: str, today: date) -> date:
        if period == "day":
            return today
        if period == "week":
            return today - timedelta(days=today.weekday())
        if period == "month":
            return today.replace(day=1)
        raise ValueError("统计周期必须是 day、week 或 month")

    def _rows_between(self, start: date, end: date) -> list[sqlite3.Row]:
        with self._connection() as connection:
            return connection.execute(
                "SELECT * FROM message_stats_daily WHERE day >= ? AND day <= ? ORDER BY day, bot_id",
                (start.isoformat(), end.isoformat()),
            ).fetchall()

    @staticmethod
    def _totals(rows: Iterable[sqlite3.Row]) -> dict[str, int]:
        result = {"received": 0, "sent": 0, "total": 0, "groups": 0, "private": 0, "media": 0, "commands": 0, "active_days": 0}
        days: set[str] = set()
        for row in rows:
            for key in ("received", "sent", "groups", "private", "media", "commands"):
                result[key] += int(row[key] or 0)
            days.add(str(row["day"]))
        result["total"] = result["received"] + result["sent"]
        result["active_days"] = len(days)
        return result

    def summary(self, bots: Iterable[Any]) -> dict[str, Any]:
        today = datetime.now().date()
        periods: dict[str, dict[str, int]] = {}
        bot_periods: dict[str, list[dict[str, Any]]] = {}
        bot_list = list(bots)
        for period in ("day", "week", "month"):
            rows = self._rows_between(self._period_start(period, today), today)
            periods[period] = self._totals(rows)
            grouped: dict[str, list[sqlite3.Row]] = {}
            for row in rows:
                grouped.setdefault(str(row["bot_id"]), []).append(row)
            bot_periods[period] = []
            for bot in bot_list:
                item = self._totals(grouped.get(str(bot.id), []))
                item.update({"id": bot.id, "name": bot.name, "qq": bot.qq})
                bot_periods[period].append(item)

        series_start = today - timedelta(days=13)
        rows = self._rows_between(series_start, today)
        grouped_days: dict[str, list[sqlite3.Row]] = {}
        for row in rows:
            grouped_days.setdefault(str(row["day"]), []).append(row)
        series = []
        for offset in range(14):
            current = series_start + timedelta(days=offset)
            values = self._totals(grouped_days.get(current.isoformat(), []))
            values["day"] = current.isoformat()
            series.append(values)
        return {"periods": periods, "bots": bot_periods, "series": series, "updated_at": datetime.now().isoformat(timespec="seconds")}


def _strip_ansi(value: str) -> str:
    return re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", value)


def _message_type(message: str) -> str:
    is_group = "群聊" in message or "group" in message.lower()
    is_private = "私聊" in message or "private" in message.lower() or "好友" in message
    is_media = any(token in message.lower() for token in ("[图片]", "[视频]", "[文件]", "[表情", "image:", "video:", "file:"))
    if is_group and is_media:
        return "group_media"
    if is_private and is_media:
        return "private_media"
    if is_group:
        return "group"
    if is_private:
        return "private"
    if is_media:
        return "media"
    if message.lstrip().startswith(("/", "!")) or "命令" in message:
        return "command"
    return "unknown"
