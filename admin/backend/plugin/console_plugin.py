"""控制台自身的插件扩展边界。

与 ``registry.py``（扫描 NoneBot/AstrBot 机器人插件）不同，本模块负责桌面
控制台自身的插件系统。插件放在项目根目录的 ``plugins/`` 下，每个插件是一个
目录，包含：

- ``plugin.json``    插件清单（id、名称、版本、前端/后端入口、导航声明）
- ``frontend.js``    前端入口，向 ``window.__DSH_PLUGINS__`` 注册 React 页面组件
- ``backend.py``     后端入口，定义 ``register(app)`` 向 FastAPI 应用挂载路由
- 其他静态资源（CSS、图片等），通过 ``/plugin-assets/<id>/...`` 提供

运行期加载语义：

- 后端：管理服务启动时扫描并 ``import`` 每个插件的 ``backend.py``，调用
  ``register(app)``；修改后端代码后需要重启管理服务（桌面端会托管重启）。
- 前端：控制台页面加载时从 ``/api/console-plugins`` 读取清单，再从
  ``/plugin-assets/<id>/frontend.js`` 动态加载脚本；修改前端代码后刷新页面即可。
"""

from __future__ import annotations

import importlib.util
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
from pathlib import Path
from urllib.parse import urlparse
from typing import Any

from fastapi import APIRouter, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse

import backend.config as runtime_config


_LOGGER = logging.getLogger(__name__)
_PLUGIN_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
# 插件前端入口和静态资源只允许这些扩展名，避免把 backend.py 等文件暴露出去。
_ASSET_SUFFIXES = {".js", ".mjs", ".css", ".json", ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".woff", ".woff2"}
_MAX_MANIFEST_BYTES = 128 * 1024
_MAX_DOCUMENTATION_BYTES = 512 * 1024
_GIT_CLONE_TIMEOUT_SECONDS = 120
_GIT_REF_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/@+-]{0,127}$")
_GIT_SCP_URL_RE = re.compile(r"^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s\\]+$")
_RESERVED_WINDOWS_NAMES = {"CON", "PRN", "AUX", "NUL", *(f"COM{index}" for index in range(1, 10)), *(f"LPT{index}" for index in range(1, 10))}

assets_router = APIRouter()


@assets_router.get("/plugin-assets/{plugin_id}/{filename:path}")
async def serve_plugin_asset(plugin_id: str, filename: str, request: Request) -> FileResponse:
    """Serve a plugin frontend asset without requiring the session token.

    The browser cannot attach an ``Authorization`` header to a plain
    ``<script src>`` tag, so plugin scripts must be reachable outside the
    ``/api/`` auth boundary.  The path is strictly confined to the plugin's own
    directory and only a small set of static file types is served.
    """
    registry: ConsolePluginRegistry | None = getattr(request.app.state, "console_plugin_registry", None)
    if registry is None or plugin_id not in registry.plugins or not registry.is_enabled(plugin_id):
        raise HTTPException(404, "插件不存在或已停用")
    path = registry.resolve_asset(plugin_id, filename)
    if path is None:
        raise HTTPException(404, "插件资源不存在或类型不允许")
    return FileResponse(path)


class ConsolePluginRegistry:
    """Discover, load, and expose console plugins from the ``plugins/`` directory."""

    def __init__(self, plugins_dir: Path | None = None) -> None:
        # 打包版可能同时存在内置插件（resources/plugins）与用户插件（data 根目录）。
        # 用户插件优先级更高，同名 id 覆盖内置插件。
        self.plugins_dir = (plugins_dir or runtime_config.PLUGINS_DIR).expanduser().resolve()
        self.bundled_plugins_dir = (
            runtime_config.BUNDLED_PLUGINS_DIR.resolve()
            if runtime_config.BUNDLED_PLUGINS_DIR and runtime_config.BUNDLED_PLUGINS_DIR.is_dir()
            else None
        )
        self.plugins: dict[str, dict[str, Any]] = {}
        self.errors: dict[str, str] = {}
        self._states: dict[str, bool] = {}
        self._app: FastAPI | None = None
        self._install_lock = threading.Lock()
        self._load_states()
        self.discover()

    def discover(self) -> None:
        """Scan plugin directories and read their manifests.

        Discovery never imports plugin code; that only happens in
        :meth:`load_backend`.  A broken plugin is recorded in ``self.errors``
        and skipped rather than taking the whole control panel down.
        """
        self.plugins = {}
        self.errors = {}
        # 先扫用户插件目录，再扫内置插件目录；用户插件覆盖内置同名插件。
        for directory in (self.plugins_dir, self.bundled_plugins_dir):
            if directory is None or not directory.is_dir():
                continue
            for entry in sorted(directory.iterdir(), key=lambda item: item.name.lower()):
                if not entry.is_dir() or entry.name.startswith((".", "_")):
                    continue
                manifest = self._read_manifest(entry)
                if manifest is None:
                    self.errors.setdefault(entry.name, "plugin.json 缺失或无效")
                    continue
                plugin_id = str(manifest.get("id") or entry.name)
                if not _PLUGIN_ID_RE.fullmatch(plugin_id):
                    self.errors.setdefault(entry.name, f"插件 id 不合法：{plugin_id}")
                    continue
                # 先扫描用户目录，再扫描内置目录，用户插件优先覆盖同 id 的内置插件。
                if plugin_id in self.plugins and directory == self.bundled_plugins_dir:
                    continue
                manifest["id"] = plugin_id
                manifest["_dir"] = str(entry)
                manifest["_bundled"] = directory == self.bundled_plugins_dir
                self.plugins[plugin_id] = manifest

    def _read_manifest(self, directory: Path) -> dict[str, Any] | None:
        path = directory / "plugin.json"
        try:
            if not path.is_file():
                return None
            if path.stat().st_size > _MAX_MANIFEST_BYTES:
                return None
            raw = json.loads(path.read_text(encoding="utf-8-sig"))
            if not isinstance(raw, dict):
                return None
        except (OSError, UnicodeError, json.JSONDecodeError):
            return None
        return raw

    def snapshot(self) -> dict[str, Any]:
        """Return the plugin list for the frontend, omitting internal fields."""
        return {
            "plugins": [
                {
                    **{key: value for key, value in manifest.items() if not key.startswith("_")},
                    "folder": Path(str(manifest["_dir"])).name,
                    "enabled": self.is_enabled(plugin_id),
                }
                for plugin_id, manifest in self.plugins.items()
            ],
            "errors": self.errors,
            "directory": str(self.plugins_dir),
        }

    # ---- 启用 / 停用状态 -------------------------------------------------

    def _load_states(self) -> None:
        """加载插件启停状态文件；文件缺失或损坏时全部视为启用。"""
        try:
            raw = json.loads(runtime_config.CONSOLE_PLUGIN_STATE_FILE.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                self._states = {str(key): bool(value) for key, value in raw.items()}
        except (OSError, UnicodeError, ValueError):
            self._states = {}

    def _save_states(self) -> None:
        """原子写启停状态文件。"""
        try:
            runtime_config.DATA_DIR.mkdir(parents=True, exist_ok=True)
            temporary = runtime_config.CONSOLE_PLUGIN_STATE_FILE.with_suffix(".json.tmp")
            temporary.write_text(
                json.dumps(self._states, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            temporary.replace(runtime_config.CONSOLE_PLUGIN_STATE_FILE)
        except OSError:
            _LOGGER.exception("控制台插件启停状态写入失败")

    def is_enabled(self, plugin_id: str) -> bool:
        """插件是否启用。未记录状态时默认启用。"""
        return self._states.get(plugin_id, True)

    def set_enabled(self, plugin_id: str, enabled: bool) -> None:
        """记录插件启停状态；启用时若后端尚未注册则补加载。"""
        if plugin_id not in self.plugins:
            raise ValueError(f"插件不存在：{plugin_id}")
        self._states[plugin_id] = bool(enabled)
        self._save_states()
        if enabled:
            # 插件可能在停用期间未注册后端路由，启用时补加载。
            if self._app is not None:
                self._load_backend_for(plugin_id, self._app)

    # ---- 后端加载 -------------------------------------------------------

    def load_backend(self, app: FastAPI) -> None:
        """Import each plugin's ``backend.py`` and call ``register(app)``.

        Plugins are loaded on the management-service startup path.  The plugin
        directory is added to ``sys.path`` so a plugin can import sibling
        modules.  Each backend module is expected to expose ``register(app)``.
        Disabled plugins are skipped so their routes stay unregistered.
        """
        self._app = app
        if str(self.plugins_dir) not in sys.path:
            sys.path.insert(0, str(self.plugins_dir))
        for plugin_id, manifest in self.plugins.items():
            if not self.is_enabled(plugin_id):
                _LOGGER.info("控制台插件 %s 已停用，跳过其后端加载", plugin_id)
                continue
            self._load_backend_for(plugin_id, app)

    def _load_backend_for(self, plugin_id: str, app: FastAPI) -> bool:
        """加载单个插件后端并注册到 app；成功返回 True。"""
        manifest = self.plugins.get(plugin_id)
        if manifest is None:
            return False
        backend_name = str(manifest.get("backend") or "").strip()
        if not backend_name:
            return True
        module_name = backend_name[:-3] if backend_name.endswith(".py") else backend_name
        module_path = self.resolve_asset(plugin_id, f"{module_name}.py", allow_python=True)
        if module_path is None:
            self.errors[plugin_id] = f"后端入口不存在：{backend_name}"
            return False
        try:
            # 插件 id 可能包含连字符等字符，不适合直接作为 Python 模块名。
            safe_module_name = re.sub(r"[^A-Za-z0-9_]", "_", f"console_plugin_{plugin_id}")
            spec = importlib.util.spec_from_file_location(safe_module_name, module_path)
            if spec is None or spec.loader is None:
                raise ImportError("无法解析后端入口")
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            register = getattr(module, "register", None)
            if not callable(register):
                raise ImportError("backend.py 缺少 register(app) 函数")
            register(app)
            _LOGGER.info("已加载控制台插件后端 %s", plugin_id)
            return True
        except Exception as error:  # noqa: BLE001 - a broken plugin must not kill the console
            self.errors[plugin_id] = f"后端加载失败：{error}"
            _LOGGER.exception("控制台插件 %s 后端加载失败", plugin_id)
            return False

    def read_documentation(self, plugin_id: str) -> dict[str, Any]:
        """Read the plugin's Markdown documentation for the authenticated detail view."""
        manifest = self.plugins.get(plugin_id)
        if manifest is None:
            raise KeyError(plugin_id)
        filename = str(manifest.get("readme") or "README.md").strip()
        if not filename or "\x00" in filename or Path(filename).suffix.lower() not in {".md", ".markdown"}:
            raise ValueError("插件说明文件必须是 Markdown 文件")
        directory = Path(str(manifest["_dir"])).resolve()
        path = (directory / filename).resolve()
        try:
            path.relative_to(directory)
        except ValueError as error:
            raise ValueError("插件说明文件路径不合法") from error
        if not path.is_file():
            return {"filename": filename, "exists": False, "markdown": ""}
        try:
            if path.stat().st_size > _MAX_DOCUMENTATION_BYTES:
                raise ValueError("插件说明文件超过 512 KiB 限制")
            return {
                "filename": filename,
                "exists": True,
                "markdown": path.read_text(encoding="utf-8-sig"),
            }
        except (OSError, UnicodeError) as error:
            raise ValueError("无法读取插件说明文件") from error

    @staticmethod
    def _validate_git_url(value: str) -> str:
        """Allow remote Git URLs without permitting local paths or shell syntax."""
        url = str(value or "").strip()
        if not url or len(url) > 2048 or "\x00" in url:
            raise ValueError("Git 仓库地址不能为空且不能超过 2048 个字符")
        if _GIT_SCP_URL_RE.fullmatch(url):
            path = url.split(":", 1)[1]
            if any(part in {"", ".", ".."} for part in path.replace("\\", "/").split("/")):
                raise ValueError("Git 仓库地址包含不合法路径")
            return url
        try:
            parsed = urlparse(url)
        except ValueError as error:
            raise ValueError("Git 仓库地址格式不正确") from error
        if parsed.scheme not in {"https", "ssh"} or not parsed.hostname or parsed.query or parsed.fragment:
            raise ValueError("仅支持 https://、ssh:// 或 git@host:path 格式的 Git 仓库地址")
        if parsed.scheme == "https" and (parsed.username or parsed.password):
            raise ValueError("HTTPS 地址不能直接携带账号或密码，请使用 Git 凭据管理器")
        if parsed.password:
            raise ValueError("SSH 地址不能携带密码，请使用 SSH Key")
        if any(part in {".", ".."} for part in parsed.path.replace("\\", "/").split("/")):
            raise ValueError("Git 仓库地址包含不合法路径")
        return url

    @staticmethod
    def _validate_git_ref(value: str | None) -> str | None:
        ref = str(value or "").strip()
        if not ref:
            return None
        if not _GIT_REF_RE.fullmatch(ref) or ".." in ref or ref.endswith((".", "/")):
            raise ValueError("分支或 Tag 名称格式不正确")
        return ref

    @staticmethod
    def _remove_path(path: Path) -> None:
        if path.is_symlink() or path.is_file():
            path.unlink(missing_ok=True)
        elif path.is_dir():
            shutil.rmtree(path, ignore_errors=True)

    def _validate_git_manifest(self, checkout: Path) -> dict[str, Any]:
        manifest = self._read_manifest(checkout)
        if manifest is None:
            raise ValueError("Git 仓库根目录必须包含有效的 plugin.json")
        plugin_id = str(manifest.get("id") or "").strip()
        if not _PLUGIN_ID_RE.fullmatch(plugin_id):
            raise ValueError("plugin.json 中的 id 不合法")
        name = str(manifest.get("name") or "").strip()
        if not name or len(name) > 120:
            raise ValueError("plugin.json 中必须提供不超过 120 个字符的 name")
        for field, suffixes in {
            "frontend": {".js", ".mjs"},
            "backend": {".py"},
            "readme": {".md", ".markdown"},
        }.items():
            raw_path = manifest.get(field)
            if raw_path is None:
                continue
            if not isinstance(raw_path, str) or not raw_path.strip():
                raise ValueError(f"plugin.json 的 {field} 路径无效")
            relative = raw_path.strip().replace("\\", "/")
            candidate = (checkout / relative).resolve()
            try:
                candidate.relative_to(checkout.resolve())
            except ValueError as error:
                raise ValueError(f"plugin.json 的 {field} 路径不能离开插件目录") from error
            if Path(relative).suffix.lower() not in suffixes or not candidate.is_file():
                raise ValueError(f"plugin.json 声明的 {field} 文件不存在或类型不正确")
        return manifest

    def _clone_git_repository(self, url: str, ref: str | None, checkout: Path) -> None:
        git = shutil.which("git")
        if not git:
            raise ValueError("当前环境没有找到 Git，请先安装 Git 并加入 PATH")
        command = [git, "-c", "protocol.file.allow=never", "clone", "--depth", "1"]
        if ref:
            command.extend(["--branch", ref])
        command.extend(["--", url, str(checkout)])
        environment = {
            **os.environ,
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_TERMINAL_PROMPT": "0",
            "GCM_INTERACTIVE": "Never",
            "GIT_LFS_SKIP_SMUDGE": "1",
        }
        try:
            result = subprocess.run(
                command,
                cwd=str(self.plugins_dir),
                env=environment,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=_GIT_CLONE_TIMEOUT_SECONDS,
                check=False,
            )
        except subprocess.TimeoutExpired as error:
            raise ValueError("Git 仓库下载超时（超过 120 秒）") from error
        except OSError as error:
            raise ValueError("无法启动 Git，请检查 Git 安装和权限") from error
        if result.returncode != 0:
            _LOGGER.warning("Git 插件克隆失败，仓库主机=%s，返回码=%s", urlparse(url).hostname or "ssh", result.returncode)
            raise ValueError("Git 仓库克隆失败，请检查地址、分支或 Tag，以及本机 Git 凭据配置")

    def install_from_git(self, url: str, ref: str | None = None, replace: bool = False) -> dict[str, Any]:
        """Clone, validate, and atomically install a console plugin from Git."""
        repository = self._validate_git_url(url)
        branch_or_tag = self._validate_git_ref(ref)
        with self._install_lock:
            self.plugins_dir.mkdir(parents=True, exist_ok=True)
            with tempfile.TemporaryDirectory(prefix=".git-install-", dir=str(self.plugins_dir)) as temporary:
                staging_root = Path(temporary)
                checkout = staging_root / "checkout"
                self._clone_git_repository(repository, branch_or_tag, checkout)
                manifest = self._validate_git_manifest(checkout)
                plugin_id = str(manifest["id"])
                target_path = self.plugins_dir / plugin_id
                resolved_target = target_path.resolve()
                try:
                    resolved_target.relative_to(self.plugins_dir.resolve())
                except ValueError as error:
                    raise ValueError("插件 id 不能作为安全的插件目录名") from error
                first_name = plugin_id.split(".", 1)[0].upper()
                if plugin_id.endswith(".") or first_name in _RESERVED_WINDOWS_NAMES:
                    raise ValueError("插件 id 不能作为 Windows 保留目录名")
                target = target_path
                existing = target.exists() or target.is_symlink()
                if existing and not replace:
                    raise ValueError(f"插件「{plugin_id}」已存在，请确认覆盖安装")
                backup = self.plugins_dir / f".backup-{plugin_id}-{os.getpid()}"
                if backup.exists() or backup.is_symlink():
                    self._remove_path(backup)
                if existing:
                    target.rename(backup)
                committed = False
                try:
                    checkout.rename(target)
                    committed = True
                except OSError as error:
                    if target.exists() or target.is_symlink():
                        self._remove_path(target)
                    if backup.exists() or backup.is_symlink():
                        backup.rename(target)
                    raise ValueError("插件文件替换失败，请关闭正在使用该插件文件的进程后重试") from error
                finally:
                    if committed and (backup.exists() or backup.is_symlink()):
                        self._remove_path(backup)

            self.discover()
            enabled = self.is_enabled(plugin_id)
            backend_declared = bool(manifest.get("backend"))
            backend_loaded = False
            restart_required = backend_declared and (existing or self._app is None)
            if backend_declared and enabled and not existing and self._app is not None:
                backend_loaded = self._load_backend_for(plugin_id, self._app)
                restart_required = not backend_loaded
            plugin = next(item for item in self.snapshot()["plugins"] if item["id"] == plugin_id)
            return {
                "plugin": plugin,
                "replaced": existing,
                "backend_loaded": backend_loaded,
                "restart_required": restart_required,
                "backend_error": self.errors.get(plugin_id, ""),
            }

    def resolve_asset(self, plugin_id: str, relative_path: str, *, allow_python: bool = False) -> Path | None:
        """Resolve an asset path inside a plugin directory and validate its type.

        Returns ``None`` for anything outside the plugin directory, a missing
        file, or a disallowed file type (unless ``allow_python`` is set for
        backend entry resolution).
        """
        if plugin_id not in self.plugins:
            return None
        directory = Path(str(self.plugins[plugin_id]["_dir"])).resolve()
        if not relative_path or "\x00" in relative_path:
            return None
        candidate = (directory / relative_path).resolve()
        try:
            candidate.relative_to(directory)
        except ValueError:
            return None
        if not candidate.is_file():
            return None
        suffix = candidate.suffix.lower()
        if allow_python:
            return candidate if suffix == ".py" else None
        return candidate if suffix in _ASSET_SUFFIXES else None
