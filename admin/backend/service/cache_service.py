from __future__ import annotations

import hashlib
import re
import shutil
import sqlite3
import tempfile
from pathlib import Path
from typing import Any, Callable

import backend.config as runtime_config


_CACHE_NAME_RE = re.compile(r"(?:^|[^a-z])(?:cache|cached|caches|temp|tmp|temporary)(?:$|[^a-z])", re.IGNORECASE)
_CACHE_TABLE_RE = re.compile(r"(?:^|[^a-z])(?:cache|cached|caches|temp|tmp|temporary)(?:$|[^a-z])", re.IGNORECASE)
_CACHE_FILE_SUFFIXES = {".cache", ".tmp", ".temp"}
_DATABASE_SUFFIXES = {".db", ".sqlite", ".sqlite3"}
_IGNORED_DIRECTORY_NAMES = {
    ".git",
    "__pycache__",
    "backups",
    "backup",
    "logs",
    "log",
    "process-logs",
    "site-packages",
}
_SQLITE_INTERNAL_SUFFIXES = ("_content", "_data", "_docsize", "_idx", "_config")
_MAX_SCAN_DEPTH = 10
_MAX_SCAN_ENTRIES = 100_000


class CacheService:
    """Discover and remove only data that has an unambiguous cache signal."""

    def snapshot(
        self,
        *,
        running_bot_ids: set[str] | None = None,
        running_astrbot_bot_ids: set[str] | None = None,
        setup_running: bool = False,
        nonebot_running: bool = False,
        astrbot_running: bool = False,
        bot_labels: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        running_bot_ids = running_bot_ids or set()
        running_astrbot_bot_ids = running_astrbot_bot_ids or set()
        bot_labels = bot_labels or {}
        items: list[dict[str, Any]] = []
        claimed_directories: set[Path] = set()
        seen_items: set[str] = set()
        seen_paths: set[Path] = set()

        def add(item: dict[str, Any]) -> None:
            path = Path(str(item["path"])).resolve()
            operation = str(item.get("operation") or "")
            if operation == "directory":
                if path in seen_paths or any(
                    path != parent and self._is_relative_to(path, parent)
                    for parent in claimed_directories
                ):
                    return
                claimed_directories.add(path)
                seen_paths.add(path)
            if item["id"] in seen_items:
                return
            seen_items.add(str(item["id"]))
            items.append(item)

        setup_path = runtime_config.DATA_DIR / "setup"
        add(self._directory_item(
            "system:setup",
            "资源配置临时文件",
            "资源下载、解压和配置任务产生的临时文件。",
            setup_path,
            clearable=not setup_running,
            blocked_reason="资源配置进行中，请完成或停止配置后再清理。" if setup_running else "",
        ))

        instances_path = runtime_config.DATA_DIR / "astrbot" / "instances"
        if instances_path.is_dir():
            for instance in sorted(instances_path.iterdir(), key=lambda path: path.name.lower()):
                if not instance.is_dir() or instance.is_symlink():
                    continue
                bot_id = instance.name
                running = bot_id in running_astrbot_bot_ids or bot_id in running_bot_ids
                label = bot_labels.get(bot_id) or f"账号 {bot_id}"
                dashboard_path = instance / "data" / "dist"
                if dashboard_path.exists():
                    add(self._directory_item(
                        f"system:astrbot-dashboard:{bot_id}",
                        f"AstrBot WebUI 缓存（{label}）",
                        "AstrBot WebUI 静态文件；清理后下次启动会重新准备。",
                        dashboard_path,
                        clearable=not running,
                        blocked_reason="对应 AstrBot 正在运行，请先停止后再清理。" if running else "",
                    ))

        for root in self._scan_roots():
            self._scan_root(
                root,
                add,
                running_bot_ids=running_bot_ids,
                running_astrbot_bot_ids=running_astrbot_bot_ids,
                nonebot_running=nonebot_running,
                astrbot_running=astrbot_running,
            )

        for path, label, description, blocked in self._known_temp_paths(
            running_bot_ids=running_bot_ids,
            astrbot_running=astrbot_running,
        ):
            add(self._directory_item(
                f"system:{self._path_id(path)}",
                label,
                description,
                path,
                clearable=not blocked,
                blocked_reason="相关 AstrBot 正在运行，请先停止后再清理。" if blocked else "",
            ))

        # Do not show directories that only exist as an empty scan root. A
        # real cache directory/file/table remains visible even when its size
        # is currently zero, so the user can see what will be regenerated.
        items = [item for item in items if item["available"] or item["files"] or item["bytes"] or item["blocked_reason"]]
        return {
            "total_bytes": sum(int(item["bytes"]) for item in items),
            "total_files": sum(int(item["files"]) for item in items),
            "items": items,
        }

    def clear(
        self,
        cache_id: str,
        *,
        running_bot_ids: set[str] | None = None,
        running_astrbot_bot_ids: set[str] | None = None,
        setup_running: bool = False,
        nonebot_running: bool = False,
        astrbot_running: bool = False,
        bot_labels: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        context = {
            "running_bot_ids": running_bot_ids,
            "running_astrbot_bot_ids": running_astrbot_bot_ids,
            "setup_running": setup_running,
            "nonebot_running": nonebot_running,
            "astrbot_running": astrbot_running,
            "bot_labels": bot_labels,
        }
        snapshot = self.snapshot(**context)
        item = next((entry for entry in snapshot["items"] if entry["id"] == cache_id), None)
        if item is None:
            raise ValueError("找不到这个缓存项目，可能已经被插件删除")
        if not item["clearable"]:
            raise ValueError(str(item["blocked_reason"] or "这个缓存当前不能清理"))
        try:
            cleared_bytes, cleared_files = self._clear_item(item)
        except (OSError, sqlite3.Error) as error:
            raise ValueError(f"清理失败：{error}") from error
        return {
            "ok": True,
            "cleared_bytes": cleared_bytes,
            "cleared_files": cleared_files,
            "cache": self.snapshot(**context),
        }

    def clear_all(
        self,
        *,
        running_bot_ids: set[str] | None = None,
        running_astrbot_bot_ids: set[str] | None = None,
        setup_running: bool = False,
        nonebot_running: bool = False,
        astrbot_running: bool = False,
        bot_labels: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        context = {
            "running_bot_ids": running_bot_ids,
            "running_astrbot_bot_ids": running_astrbot_bot_ids,
            "setup_running": setup_running,
            "nonebot_running": nonebot_running,
            "astrbot_running": astrbot_running,
            "bot_labels": bot_labels,
        }
        snapshot = self.snapshot(**context)
        cleared_bytes = 0
        cleared_files = 0
        blocked: list[str] = []
        for item in snapshot["items"]:
            if not item["clearable"]:
                blocked.append(str(item["label"]))
                continue
            try:
                removed_bytes, removed_files = self._clear_item(item)
                cleared_bytes += removed_bytes
                cleared_files += removed_files
            except (OSError, sqlite3.Error) as error:
                blocked.append(f"{item['label']}：{error}")
        return {
            "ok": True,
            "cleared_bytes": cleared_bytes,
            "cleared_files": cleared_files,
            "blocked": blocked,
            "cache": self.snapshot(**context),
        }

    def _scan_roots(self) -> list[Path]:
        roots = [
            runtime_config.ROOT / "data",
            runtime_config.NONEBOT_DIR / "data",
            runtime_config.ASTRBOT_DIR / "data",
            runtime_config.DATA_DIR / "astrbot" / "instances",
            runtime_config.NONEBOT_DIR / "plugins",
            runtime_config.ASTRBOT_DIR / "plugins",
        ]
        return list(dict.fromkeys(path.resolve() for path in roots if path.is_dir()))

    def _known_temp_paths(
        self,
        *,
        running_bot_ids: set[str],
        astrbot_running: bool,
    ) -> list[tuple[Path, str, str, bool]]:
        system_temp = Path(tempfile.gettempdir())
        return [
            (
                system_temp / "qq-bot-starter",
                "临时图片渲染缓存",
                "成员卡片等临时渲染图片。",
                False,
            ),
            (
                system_temp / ".astrbot",
                "AstrBot 系统临时缓存",
                "AstrBot 使用系统临时目录生成的临时文件。",
                astrbot_running,
            ),
        ]

    def _scan_root(
        self,
        root: Path,
        add: Callable[[dict[str, Any]], None],
        *,
        running_bot_ids: set[str],
        running_astrbot_bot_ids: set[str],
        nonebot_running: bool,
        astrbot_running: bool,
    ) -> None:
        stack: list[tuple[Path, int]] = [(root.resolve(), 0)]
        visited: set[Path] = set()
        scanned_entries = 0
        while stack and scanned_entries < _MAX_SCAN_ENTRIES:
            directory, depth = stack.pop()
            if directory in visited or not directory.is_dir() or directory.is_symlink():
                continue
            visited.add(directory)
            try:
                entries = list(directory.iterdir())
            except OSError:
                continue
            for entry in entries:
                scanned_entries += 1
                if scanned_entries >= _MAX_SCAN_ENTRIES or entry.is_symlink():
                    break
                try:
                    if entry.is_dir():
                        if self._is_cache_directory(entry.name):
                            add(self._directory_item_for_discovered_path(
                                entry,
                                running_bot_ids=running_bot_ids,
                                running_astrbot_bot_ids=running_astrbot_bot_ids,
                                nonebot_running=nonebot_running,
                                astrbot_running=astrbot_running,
                            ))
                            continue
                        if depth < _MAX_SCAN_DEPTH and entry.name.lower() not in _IGNORED_DIRECTORY_NAMES:
                            stack.append((entry, depth + 1))
                        continue
                    if not entry.is_file():
                        continue
                    if self._is_cache_file(entry.name):
                        add(self._file_item_for_discovered_path(
                            entry,
                            running_bot_ids=running_bot_ids,
                            running_astrbot_bot_ids=running_astrbot_bot_ids,
                            nonebot_running=nonebot_running,
                            astrbot_running=astrbot_running,
                        ))
                    if entry.suffix.lower() in _DATABASE_SUFFIXES and entry.resolve() != runtime_config.DATABASE_FILE.resolve():
                        self._scan_sqlite(
                            entry,
                            add,
                            running_bot_ids=running_bot_ids,
                            running_astrbot_bot_ids=running_astrbot_bot_ids,
                            nonebot_running=nonebot_running,
                            astrbot_running=astrbot_running,
                        )
                except OSError:
                    continue

    def _scan_sqlite(
        self,
        path: Path,
        add: Callable[[dict[str, Any]], None],
        *,
        running_bot_ids: set[str],
        running_astrbot_bot_ids: set[str],
        nonebot_running: bool,
        astrbot_running: bool,
    ) -> None:
        try:
            with sqlite3.connect(path, timeout=0.5) as connection:
                tables = connection.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
                ).fetchall()
                cache_tables: list[str] = []
                for (table,) in tables:
                    table = str(table)
                    if not self._is_cache_table(table):
                        continue
                    if table.lower().endswith(_SQLITE_INTERNAL_SUFFIXES):
                        continue
                    columns = [str(row[1]) for row in connection.execute(f"PRAGMA table_info({self._quote_identifier(table)})")]
                    files, size = self._table_size(connection, table, columns)
                    add(self._table_item(
                        path,
                        table,
                        columns,
                        files,
                        size,
                        running_bot_ids=running_bot_ids,
                        running_astrbot_bot_ids=running_astrbot_bot_ids,
                        nonebot_running=nonebot_running,
                        astrbot_running=astrbot_running,
                    ))
                    cache_tables.append(table.lower())

                if any("image" in table or "media" in table for table in cache_tables):
                    for directory_name in ("image", "images", "media"):
                        sibling = path.parent / directory_name
                        if sibling.is_dir():
                            add(self._directory_item_for_discovered_path(
                                sibling,
                                running_bot_ids=running_bot_ids,
                                running_astrbot_bot_ids=running_astrbot_bot_ids,
                                nonebot_running=nonebot_running,
                                astrbot_running=astrbot_running,
                            ))
        except (OSError, sqlite3.Error):
            # A locked or malformed database is not enough evidence to show it
            # as a removable cache. It is simply skipped from discovery.
            return

    def _directory_item_for_discovered_path(
        self,
        path: Path,
        *,
        running_bot_ids: set[str],
        running_astrbot_bot_ids: set[str],
        nonebot_running: bool,
        astrbot_running: bool,
    ) -> dict[str, Any]:
        blocked_reason, running = self._blocked_reason(
            path,
            running_bot_ids=running_bot_ids,
            running_astrbot_bot_ids=running_astrbot_bot_ids,
            nonebot_running=nonebot_running,
            astrbot_running=astrbot_running,
        )
        relative = self._display_path(path)
        return self._directory_item(
            f"directory:{self._path_id(path)}",
            f"缓存目录 · {relative}",
            "插件或运行组件扫描到的缓存/临时目录。",
            path,
            clearable=not running,
            blocked_reason=blocked_reason,
        )

    def _file_item_for_discovered_path(
        self,
        path: Path,
        *,
        running_bot_ids: set[str],
        running_astrbot_bot_ids: set[str],
        nonebot_running: bool,
        astrbot_running: bool,
    ) -> dict[str, Any]:
        blocked_reason, running = self._blocked_reason(
            path,
            running_bot_ids=running_bot_ids,
            running_astrbot_bot_ids=running_astrbot_bot_ids,
            nonebot_running=nonebot_running,
            astrbot_running=astrbot_running,
        )
        relative = self._display_path(path)
        return self._file_item(
            f"file:{self._path_id(path)}",
            f"缓存文件 · {relative}",
            "插件或运行组件扫描到的缓存文件。",
            path,
            clearable=not running,
            blocked_reason=blocked_reason,
        )

    def _table_item(
        self,
        path: Path,
        table: str,
        columns: list[str],
        files: int,
        size: int,
        *,
        running_bot_ids: set[str],
        running_astrbot_bot_ids: set[str],
        nonebot_running: bool,
        astrbot_running: bool,
    ) -> dict[str, Any]:
        blocked_reason, running = self._blocked_reason(
            path,
            running_bot_ids=running_bot_ids,
            running_astrbot_bot_ids=running_astrbot_bot_ids,
            nonebot_running=nonebot_running,
            astrbot_running=astrbot_running,
        )
        return {
            "id": f"table:{self._path_id(path)}:{self._stable_id(table)}",
            "label": f"缓存数据表 · {table}",
            "description": f"从 {self._display_path(path)} 动态发现的缓存表。",
            "path": str(path),
            "files": files,
            "bytes": size,
            "unit": "条记录",
            "size_note": "估算",
            "available": path.is_file(),
            "clearable": not running,
            "blocked_reason": blocked_reason,
            "operation": "table",
            "table": table,
            "columns": columns,
        }

    @staticmethod
    def _directory_item(
        cache_id: str,
        label: str,
        description: str,
        path: Path,
        *,
        clearable: bool = True,
        blocked_reason: str = "",
    ) -> dict[str, Any]:
        files, size = CacheService._directory_size(path)
        return {
            "id": cache_id,
            "label": label,
            "description": description,
            "path": str(path),
            "files": files,
            "bytes": size,
            "unit": "文件",
            "available": path.exists(),
            "clearable": clearable,
            "blocked_reason": blocked_reason,
            "operation": "directory",
        }

    @staticmethod
    def _file_item(
        cache_id: str,
        label: str,
        description: str,
        path: Path,
        *,
        clearable: bool = True,
        blocked_reason: str = "",
    ) -> dict[str, Any]:
        files = 1 if path.is_file() else 0
        return {
            "id": cache_id,
            "label": label,
            "description": description,
            "path": str(path),
            "files": files,
            "bytes": path.stat().st_size if files else 0,
            "unit": "文件",
            "available": path.is_file(),
            "clearable": clearable,
            "blocked_reason": blocked_reason,
            "operation": "file",
        }

    @staticmethod
    def _directory_size(path: Path) -> tuple[int, int]:
        if not path.exists() or path.is_symlink():
            return 0, 0
        files = 0
        size = 0
        pending = [path]
        while pending:
            current = pending.pop()
            try:
                entries = list(current.iterdir()) if current.is_dir() else [current]
            except OSError:
                continue
            for entry in entries:
                if entry.is_symlink():
                    continue
                try:
                    if entry.is_dir():
                        pending.append(entry)
                    elif entry.is_file():
                        files += 1
                        size += entry.stat().st_size
                except OSError:
                    continue
        return files, size

    def _clear_item(self, item: dict[str, Any]) -> tuple[int, int]:
        path = Path(str(item["path"]))
        operation = str(item.get("operation") or "")
        if operation == "table":
            return self._clear_table(path, str(item["table"]), [str(column) for column in item.get("columns", [])])
        if operation == "file":
            return self._clear_file(path)
        return self._clear_directory(path)

    @staticmethod
    def _clear_directory(path: Path) -> tuple[int, int]:
        files, size = CacheService._directory_size(path)
        if not path.exists() or path.is_symlink():
            return 0, 0
        for entry in path.iterdir():
            if entry.is_symlink() or entry.is_file():
                entry.unlink()
            elif entry.is_dir():
                shutil.rmtree(entry)
        return size, files

    @staticmethod
    def _clear_file(path: Path) -> tuple[int, int]:
        if not path.is_file() or path.is_symlink():
            return 0, 0
        size = path.stat().st_size
        path.unlink()
        return size, 1

    @classmethod
    def _clear_table(cls, path: Path, table: str, columns: list[str]) -> tuple[int, int]:
        with sqlite3.connect(path, timeout=2) as connection:
            files, size = cls._table_size(connection, table, columns)
            connection.execute(f"DELETE FROM {cls._quote_identifier(table)}")
            connection.commit()
        return size, files

    @staticmethod
    def _table_size(connection: sqlite3.Connection, table: str, columns: list[str]) -> tuple[int, int]:
        count_row = connection.execute(
            f"SELECT COUNT(*) FROM {CacheService._quote_identifier(table)}"
        ).fetchone()
        if not columns:
            return int(count_row[0] or 0), 0
        expression = " + ".join(
            f"COALESCE(LENGTH(CAST({CacheService._quote_identifier(column)} AS BLOB)), 0)"
            for column in columns
        )
        size_row = connection.execute(
            f"SELECT COALESCE(SUM({expression}), 0) FROM {CacheService._quote_identifier(table)}"
        ).fetchone()
        return int(count_row[0] or 0), int(size_row[0] or 0)

    def _blocked_reason(
        self,
        path: Path,
        *,
        running_bot_ids: set[str],
        running_astrbot_bot_ids: set[str],
        nonebot_running: bool,
        astrbot_running: bool,
    ) -> tuple[str, bool]:
        resolved = path.resolve()
        nonebot_root = runtime_config.NONEBOT_DIR.resolve()
        if nonebot_running and self._is_relative_to(resolved, nonebot_root):
            return "NoneBot 正在运行，请先停止后再清理。", True
        instance_root = (runtime_config.DATA_DIR / "astrbot" / "instances").resolve()
        if self._is_relative_to(resolved, instance_root):
            relative = resolved.relative_to(instance_root)
            bot_id = relative.parts[0] if relative.parts else ""
            if bot_id in running_astrbot_bot_ids or bot_id in running_bot_ids:
                return "对应 AstrBot 正在运行，请先停止后再清理。", True
        if astrbot_running and self._is_relative_to(resolved, runtime_config.ASTRBOT_DIR.resolve()):
            return "AstrBot 正在运行，请先停止后再清理。", True
        return "", False

    @staticmethod
    def _is_cache_directory(name: str) -> bool:
        return name.lower() not in _IGNORED_DIRECTORY_NAMES and bool(
            _CACHE_NAME_RE.search(name.replace("_", " ").replace("-", " "))
        )

    @staticmethod
    def _is_cache_file(name: str) -> bool:
        path = Path(name)
        if path.suffix.lower() in _DATABASE_SUFFIXES:
            return False
        return bool(_CACHE_NAME_RE.search(path.stem.replace("_", " ").replace("-", " "))) or path.suffix.lower() in _CACHE_FILE_SUFFIXES

    @staticmethod
    def _is_cache_table(name: str) -> bool:
        return bool(_CACHE_TABLE_RE.search(name.replace("_", " ").replace("-", " ")))

    @staticmethod
    def _quote_identifier(value: str) -> str:
        return '"' + value.replace('"', '""') + '"'

    @staticmethod
    def _path_id(path: Path) -> str:
        return CacheService._stable_id(str(path.resolve()))

    @staticmethod
    def _stable_id(value: str) -> str:
        return hashlib.sha1(value.encode("utf-8", errors="replace")).hexdigest()[:16]

    @staticmethod
    def _display_path(path: Path) -> str:
        try:
            return str(path.resolve().relative_to(runtime_config.ROOT.resolve()))
        except ValueError:
            return str(path)

    @staticmethod
    def _is_relative_to(path: Path, parent: Path) -> bool:
        try:
            path.relative_to(parent)
            return True
        except ValueError:
            return False
