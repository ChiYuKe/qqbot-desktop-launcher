from __future__ import annotations

import sqlite3
from collections.abc import Callable
from datetime import datetime
from pathlib import Path


Migration = Callable[[sqlite3.Connection], None]
MIGRATION_TABLE = """
CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
);
"""


def migration_applied(connection: sqlite3.Connection, version: str) -> bool:
    table = connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'"
    ).fetchone()
    if table is None:
        return False
    return connection.execute(
        "SELECT 1 FROM schema_migrations WHERE version = ?",
        (version,),
    ).fetchone() is not None


def backup_before_migration(
    connection: sqlite3.Connection,
    database_file: Path,
    version: str,
) -> Path | None:
    """Create a consistent SQLite backup before changing an existing database."""
    if not database_file.exists() or database_file.stat().st_size == 0:
        return None
    backup_dir = database_file.parent / "backups"
    backup_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    safe_version = "".join(char if char.isalnum() or char in "-_" else "-" for char in version)
    destination = backup_dir / f"{database_file.stem}-{timestamp}-{safe_version}.db"
    target = sqlite3.connect(destination)
    try:
        connection.backup(target)
        target.commit()
    finally:
        target.close()
    return destination


def apply_migration(
    connection: sqlite3.Connection,
    database_file: Path,
    version: str,
    migration: Migration,
) -> bool:
    """Apply one idempotent migration and record it in the shared ledger."""
    if migration_applied(connection, version):
        return False
    backup_before_migration(connection, database_file, version)
    connection.executescript(MIGRATION_TABLE)
    migration(connection)
    connection.execute(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
        (version, datetime.now().isoformat(timespec="seconds")),
    )
    return True


def applied_versions(connection: sqlite3.Connection) -> list[str]:
    if connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'"
    ).fetchone() is None:
        return []
    rows = connection.execute("SELECT version FROM schema_migrations ORDER BY applied_at, version").fetchall()
    return [str(row[0]) for row in rows]

