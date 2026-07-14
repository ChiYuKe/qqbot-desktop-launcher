from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

from backend.domain.models import BotConfig


SCHEMA = """
CREATE TABLE IF NOT EXISTS bots (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    qq TEXT NOT NULL UNIQUE,
    port INTEGER NOT NULL UNIQUE,
    napcat_port INTEGER NOT NULL DEFAULT 6099,
    script TEXT NOT NULL,
    password_secret TEXT NOT NULL DEFAULT '',
    groups INTEGER NOT NULL DEFAULT 0,
    plugins INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
"""


class BotRepository:
    """SQLite repository with a one-time migration from the old bots.json file."""

    def __init__(self, database_file: Path, legacy_file: Path) -> None:
        self.database_file = database_file
        self.legacy_file = legacy_file
        self.database_file.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()
        self._migrate_legacy_json()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database_file)
        connection.row_factory = sqlite3.Row
        return connection

    def _initialize(self) -> None:
        with self._connect() as connection:
            connection.executescript(SCHEMA)
            columns = {row["name"] for row in connection.execute("PRAGMA table_info(bots)").fetchall()}
            if "password_secret" not in columns:
                connection.execute("ALTER TABLE bots ADD COLUMN password_secret TEXT NOT NULL DEFAULT ''")
            if "napcat_port" not in columns:
                connection.execute("ALTER TABLE bots ADD COLUMN napcat_port INTEGER NOT NULL DEFAULT 6099")
            rows = connection.execute("SELECT id, napcat_port FROM bots ORDER BY created_at, id").fetchall()
            used: set[int] = set()
            next_port = 6099
            for row in rows:
                port = int(row["napcat_port"] or 0)
                if port < 1024 or port in used:
                    while next_port in used:
                        next_port += 1
                    port = next_port
                    connection.execute("UPDATE bots SET napcat_port = ? WHERE id = ?", (port, row["id"]))
                used.add(port)
                next_port = max(next_port, port + 1)

    def _migrate_legacy_json(self) -> None:
        with self._connect() as connection:
            has_rows = connection.execute("SELECT 1 FROM bots LIMIT 1").fetchone() is not None
            if has_rows or not self.legacy_file.exists():
                return
            try:
                raw = json.loads(self.legacy_file.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                return
            if not isinstance(raw, dict):
                return
            for bot_id, config in raw.items():
                if not isinstance(config, dict):
                    continue
                try:
                    connection.execute(
                        "INSERT OR IGNORE INTO bots (id, name, qq, port, napcat_port, script, password_secret, groups, plugins) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        (bot_id, config["name"], str(config["qq"]), int(config["port"]), int(config.get("napcat_port", 6099)), config.get("script", ""), config.get("password_secret", ""), int(config.get("groups", 0)), int(config.get("plugins", 0))),
                    )
                except (KeyError, TypeError, ValueError, sqlite3.IntegrityError):
                    continue

    def list(self) -> list[BotConfig]:
        with self._connect() as connection:
            rows = connection.execute("SELECT * FROM bots ORDER BY created_at, id").fetchall()
        return [BotConfig.from_row(row) for row in rows]

    def get(self, bot_id: str) -> BotConfig | None:
        with self._connect() as connection:
            row = connection.execute("SELECT * FROM bots WHERE id = ?", (bot_id,)).fetchone()
        return BotConfig.from_row(row) if row else None

    def exists_port(self, port: int, exclude_bot_id: str | None = None) -> bool:
        with self._connect() as connection:
            if exclude_bot_id:
                return connection.execute("SELECT 1 FROM bots WHERE port = ? AND id != ?", (port, exclude_bot_id)).fetchone() is not None
            return connection.execute("SELECT 1 FROM bots WHERE port = ?", (port,)).fetchone() is not None

    def exists_qq(self, qq: str) -> bool:
        with self._connect() as connection:
            return connection.execute("SELECT 1 FROM bots WHERE qq = ?", (qq,)).fetchone() is not None

    def exists_napcat_port(self, port: int, exclude_bot_id: str | None = None) -> bool:
        with self._connect() as connection:
            if exclude_bot_id:
                return connection.execute("SELECT 1 FROM bots WHERE napcat_port = ? AND id != ?", (port, exclude_bot_id)).fetchone() is not None
            return connection.execute("SELECT 1 FROM bots WHERE napcat_port = ?", (port,)).fetchone() is not None

    def create(self, bot: BotConfig) -> BotConfig:
        with self._connect() as connection:
            connection.execute(
                "INSERT INTO bots (id, name, qq, port, napcat_port, script, password_secret, groups, plugins) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (bot.id, bot.name, bot.qq, bot.port, bot.napcat_port, bot.script, bot.password_secret, bot.groups, bot.plugins),
            )
        return bot

    def update_password(self, bot_id: str, password_secret: str) -> None:
        with self._connect() as connection:
            connection.execute("UPDATE bots SET password_secret = ? WHERE id = ?", (password_secret, bot_id))

    def update_port(self, bot_id: str, port: int) -> None:
        with self._connect() as connection:
            connection.execute("UPDATE bots SET port = ? WHERE id = ?", (port, bot_id))

    def update_napcat_port(self, bot_id: str, port: int) -> None:
        with self._connect() as connection:
            connection.execute("UPDATE bots SET napcat_port = ? WHERE id = ?", (port, bot_id))

    def delete(self, bot_id: str) -> None:
        with self._connect() as connection:
            connection.execute("DELETE FROM bots WHERE id = ?", (bot_id,))
