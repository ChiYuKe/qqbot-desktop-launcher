from __future__ import annotations

import ast
import json
import re
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

import backend.config as runtime_config

try:
    import tomllib
except ModuleNotFoundError:  # pragma: no cover - Python 3.10 fallback
    import tomli as tomllib  # type: ignore[no-redef]


_PLUGIN_META_ASSIGNMENT = "__plugin_meta__"
_DEFAULT_PLUGIN_DIR = "plugins"
_MAX_SOURCE_BYTES = 2 * 1024 * 1024


@dataclass
class PluginDefinition:
    """A side-effect-free view of a NoneBot plugin."""

    plugin_id: str
    module_name: str
    name: str
    path: str | None = None
    description: str = ""
    usage: str = ""
    plugin_type: str | None = None
    homepage: str | None = None
    supported_adapters: list[str] | None = None
    extra: dict[str, Any] = field(default_factory=dict)
    enabled: bool = False
    source: str = "local"
    load_mode: str = "unknown"
    toggle_supported: bool = False
    metadata_available: bool = False
    error: str | None = None
    framework: str = "nonebot"
    bot_id: str | None = None
    bot_name: str | None = None
    author: str | None = None
    version: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "plugin_id": self.plugin_id,
            "module_name": self.module_name,
            "name": self.name,
            "path": self.path,
            "description": self.description,
            "usage": self.usage,
            "type": self.plugin_type,
            "homepage": self.homepage,
            "supported_adapters": self.supported_adapters,
            "extra": _json_safe(self.extra),
            "enabled": self.enabled,
            "source": self.source,
            "load_mode": self.load_mode,
            "toggle_supported": self.toggle_supported,
            "metadata_available": self.metadata_available,
            "error": self.error,
            "framework": self.framework,
            "bot_id": self.bot_id,
            "bot_name": self.bot_name,
            "author": self.author,
            "version": self.version,
        }


class PluginRegistry:
    """Discovers NoneBot plugins without importing or executing their code."""

    def __init__(self, root: Path | None = None) -> None:
        self._root = root

    @property
    def root(self) -> Path:
        return (self._root or runtime_config.NONEBOT_DIR).expanduser().resolve()

    def snapshot(self, bots: Iterable[Any] | None = None) -> dict[str, Any]:
        nonebot_snapshot = self._nonebot_snapshot()
        astrbot_snapshot = _scan_astrbot_plugins(bots or [])
        return {
            # Keep the original top-level fields for older desktop clients.
            "project": nonebot_snapshot["project"],
            "plugins": nonebot_snapshot["plugins"],
            "frameworks": {
                "nonebot": nonebot_snapshot,
                "astrbot": astrbot_snapshot,
            },
        }

    def _nonebot_snapshot(self) -> dict[str, Any]:
        root = self.root
        parsed, config_error = _read_project_config(root / "pyproject.toml")
        plugins = self.scan(parsed=parsed, config_error=config_error)
        nonebot_config = parsed.get("tool", {}).get("nonebot", {}) if isinstance(parsed, dict) else {}
        plugin_dirs = nonebot_config.get("plugin_dirs", []) if isinstance(nonebot_config, dict) else []
        if not isinstance(plugin_dirs, list):
            plugin_dirs = []
        return {
            "project": {
                "path": str(root),
                "config_path": str(root / "pyproject.toml"),
                "exists": root.exists(),
                "valid": (root / "bot.py").exists() and (root / "pyproject.toml").exists(),
                "plugin_dirs": [str(item) for item in plugin_dirs],
                "configuration": _configuration_mode(nonebot_config),
            },
            "plugins": [plugin.to_dict() for plugin in plugins.values()],
        }

    def scan(
        self,
        *,
        parsed: dict[str, Any] | None = None,
        config_error: str | None = None,
    ) -> dict[str, PluginDefinition]:
        root = self.root
        if parsed is None:
            parsed, config_error = _read_project_config(root / "pyproject.toml")
        nonebot_config = parsed.get("tool", {}).get("nonebot", {}) if isinstance(parsed, dict) else {}
        if not isinstance(nonebot_config, dict):
            nonebot_config = {}

        configured_modules = _configured_modules(nonebot_config)
        plugin_dirs = _plugin_directories(root, nonebot_config)
        directory_modules = {module for _, module, _ in _discover_directory_plugins(root, plugin_dirs)}
        auto_directory_modules = directory_modules if _uses_directory_loading(nonebot_config) else set()
        mode = _configuration_mode(nonebot_config)
        toggle_supported = mode in {"list", "table"} and not auto_directory_modules
        definitions: dict[str, PluginDefinition] = {}

        for plugin_path, module_name, source_file in _discover_directory_plugins(root, plugin_dirs):
            metadata = _read_plugin_metadata(source_file)
            definition = _definition_from_metadata(
                module_name,
                metadata,
                root=root,
                path=plugin_path,
                enabled=module_name in configured_modules or module_name in auto_directory_modules,
                source="local",
                load_mode="directory" if module_name in auto_directory_modules and module_name not in configured_modules else "explicit",
                toggle_supported=toggle_supported,
            )
            if config_error and not definition.error:
                definition.error = config_error
            definitions[module_name] = definition

        for module_name in configured_modules:
            if module_name in definitions:
                continue
            source_file = _module_source_path(root, module_name)
            metadata = _read_plugin_metadata(source_file) if source_file else None
            definitions[module_name] = _definition_from_metadata(
                module_name,
                metadata,
                root=root,
                path=source_file.parent if source_file and source_file.name == "__init__.py" else source_file,
                enabled=True,
                source="installed" if source_file is None else "local",
                load_mode="explicit",
                toggle_supported=toggle_supported,
            )

        return definitions

    def set_enabled(self, plugin_id: str, enabled: bool, bots: Iterable[Any] | None = None) -> dict[str, Any]:
        root = self.root
        config_path = root / "pyproject.toml"
        parsed, config_error = _read_project_config(config_path)
        if config_error:
            raise ValueError(f"无法读取 pyproject.toml：{config_error}")
        current = self.scan(parsed=parsed)
        plugin = current.get(plugin_id)
        if plugin is None:
            raise ValueError("插件不存在或尚未被扫描到")
        if not plugin.toggle_supported:
            raise ValueError("当前项目通过插件目录自动加载，不能单独切换插件")

        nonebot_config = parsed.get("tool", {}).get("nonebot", {})
        if not isinstance(nonebot_config, dict):
            raise ValueError("pyproject.toml 的 [tool.nonebot] 配置格式无效")
        plugins_value = nonebot_config.get("plugins")
        text = config_path.read_text(encoding="utf-8")
        if isinstance(plugins_value, list):
            values = [str(value) for value in plugins_value if isinstance(value, str) and value != plugin_id]
            if enabled:
                values.append(plugin_id)
            text = _replace_array_assignment(text, "tool.nonebot", "plugins", values)
        elif isinstance(plugins_value, dict):
            groups = {
                str(group): [str(value) for value in values if isinstance(value, str) and value != plugin_id]
                for group, values in plugins_value.items()
                if isinstance(values, list)
            }
            if enabled:
                groups.setdefault("@local", []).append(plugin_id)
            for group, values in groups.items():
                text = _replace_array_assignment(text, "tool.nonebot.plugins", group, values)
        else:
            raise ValueError("当前项目没有可编辑的 NoneBot 插件配置")

        _atomic_write(config_path, text)
        updated = self.snapshot(bots)
        updated["changed"] = {"plugin_id": plugin_id, "enabled": enabled}
        return updated


def _scan_astrbot_plugins(bots: Iterable[Any]) -> dict[str, Any]:
    """Scan the per-account AstrBot plugin stores without importing AstrBot.

    AstrBot resolves ``data/plugins`` relative to ``ASTRBOT_ROOT``.  Managed
    accounts set that root to ``data/admin/astrbot/instances/<bot_id>`` so the
    scanner must use the instance path instead of the shared source checkout.
    """
    projects: list[dict[str, Any]] = []
    definitions: list[PluginDefinition] = []
    seen_bots: set[str] = set()

    for bot in bots:
        if str(getattr(bot, "framework", "nonebot")).lower() != "astrbot":
            continue
        bot_id = str(getattr(bot, "id", "")).strip()
        if not bot_id or bot_id in seen_bots:
            continue
        seen_bots.add(bot_id)
        bot_name = str(getattr(bot, "name", bot_id) or bot_id)
        data_root = (runtime_config.astrbot_instance_dir(bot_id) / "data").resolve()
        plugin_root = data_root / "plugins"
        projects.append(
            {
                "framework": "astrbot",
                "bot_id": bot_id,
                "bot_name": bot_name,
                "path": str(data_root),
                "config_path": str(data_root / "cmd_config.json"),
                "exists": data_root.exists(),
                "valid": plugin_root.is_dir(),
                "plugin_dirs": ["plugins"],
                "configuration": "directory",
            }
        )
        if not plugin_root.is_dir():
            continue
        try:
            entries = sorted(plugin_root.iterdir(), key=lambda path: path.name.lower())
        except OSError:
            continue
        for entry in entries:
            if not entry.is_dir() or entry.name.startswith("_"):
                continue
            if not ((entry / "main.py").is_file() or (entry / f"{entry.name}.py").is_file()):
                continue
            metadata = _read_astrbot_metadata(entry / "metadata.yaml")
            definitions.append(
                _astrbot_definition(
                    entry,
                    metadata,
                    data_root=data_root,
                    bot_id=bot_id,
                    bot_name=bot_name,
                )
            )

    return {
        "projects": projects,
        "plugins": [plugin.to_dict() for plugin in definitions],
    }


def _astrbot_definition(
    plugin_path: Path,
    metadata: dict[str, Any],
    *,
    data_root: Path,
    bot_id: str,
    bot_name: str,
) -> PluginDefinition:
    package_name = str(metadata.get("name") or plugin_path.name)
    author = _metadata_text(metadata.get("author"))
    version = _metadata_text(metadata.get("version"))
    display_name = _metadata_text(metadata.get("display_name")) or package_name
    description = _metadata_text(metadata.get("short_desc")) or _metadata_text(metadata.get("desc")) or "未提供插件描述"
    plugin_id = f"astrbot:{bot_id}:{plugin_path.name}"
    extra = {
        key: value
        for key, value in metadata.items()
        if key not in {"metadata_available", "error", "display_name", "short_desc", "desc", "name", "author", "version"}
    }
    try:
        display_path = str(plugin_path.relative_to(data_root)).replace("\\", "/")
    except ValueError:
        display_path = str(plugin_path)
    supported_platforms = metadata.get("support_platforms")
    if isinstance(supported_platforms, str):
        supported_platforms = [supported_platforms]
    if not isinstance(supported_platforms, list):
        supported_platforms = None
    return PluginDefinition(
        plugin_id=plugin_id,
        module_name=plugin_path.name,
        name=display_name,
        path=display_path,
        description=description,
        usage="由 AstrBot 自动发现并加载，启停请在 AstrBot WebUI 中管理。",
        homepage=_metadata_text(metadata.get("repo")) or None,
        supported_adapters=[str(item) for item in supported_platforms] if supported_platforms else None,
        extra=extra,
        enabled=True,
        source="local",
        load_mode="directory",
        toggle_supported=False,
        metadata_available=bool(metadata.get("metadata_available")),
        error=metadata.get("error"),
        framework="astrbot",
        bot_id=bot_id,
        bot_name=bot_name,
        author=author or None,
        version=version or None,
    )


def _read_astrbot_metadata(path: Path) -> dict[str, Any]:
    """Read the flat metadata.yaml fields used by AstrBot's plugin cards."""
    try:
        if not path.is_file():
            return {"metadata_available": False}
        if path.stat().st_size > 128 * 1024:
            return {"metadata_available": False, "error": "metadata.yaml 超过 128 KB，未读取元信息"}
        lines = path.read_text(encoding="utf-8-sig").splitlines()
    except (OSError, UnicodeError) as error:
        return {"metadata_available": False, "error": f"无法读取 metadata.yaml：{error}"}

    metadata: dict[str, Any] = {"metadata_available": True}
    list_key: str | None = None
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if list_key and stripped.startswith("-"):
            metadata.setdefault(list_key, []).append(_parse_yaml_scalar(stripped[1:].strip()))
            continue
        match = re.match(r"^\s*([A-Za-z_][\w-]*)\s*:\s*(.*?)\s*$", line)
        if not match:
            continue
        key, raw_value = match.groups()
        raw_value = _strip_yaml_comment(raw_value).strip()
        if not raw_value:
            metadata[key] = []
            list_key = key
            continue
        list_key = None
        metadata[key] = _parse_yaml_scalar(raw_value)
    return metadata


def _strip_yaml_comment(value: str) -> str:
    quote = ""
    for index, char in enumerate(value):
        if char in {"'", '"'}:
            quote = "" if quote == char else char if not quote else quote
        elif char == "#" and not quote and (index == 0 or value[index - 1].isspace()):
            return value[:index]
    return value


def _parse_yaml_scalar(value: str) -> Any:
    value = value.strip()
    if not value:
        return ""
    if value[0:1] in {"'", '"'} and value[-1:] == value[0]:
        try:
            return ast.literal_eval(value)
        except (ValueError, SyntaxError):
            return value[1:-1]
    if value.startswith("[") and value.endswith("]"):
        inner = value[1:-1].strip()
        if not inner:
            return []
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, list) else value
        except json.JSONDecodeError:
            return [item.strip().strip("'\"") for item in inner.split(",") if item.strip()]
    if value.lower() in {"true", "false"}:
        return value.lower() == "true"
    if value.lower() in {"null", "none", "~"}:
        return None
    return value


def _metadata_text(value: Any) -> str:
    if isinstance(value, str):
        return value.strip()
    if value is None:
        return ""
    return str(value).strip()


def _read_project_config(path: Path) -> tuple[dict[str, Any], str | None]:
    try:
        if not path.exists():
            return {}, "缺少 pyproject.toml"
        return tomllib.loads(path.read_text(encoding="utf-8")), None
    except (OSError, UnicodeError, ValueError) as error:
        return {}, str(error)


def _configuration_mode(nonebot_config: Any) -> str:
    if not isinstance(nonebot_config, dict):
        return "none"
    plugins = nonebot_config.get("plugins")
    if isinstance(plugins, list):
        return "list"
    if isinstance(plugins, dict):
        return "table"
    if nonebot_config.get("plugin_dirs"):
        return "directory"
    return "none"


def _uses_directory_loading(nonebot_config: dict[str, Any]) -> bool:
    """Return whether NoneBot's TOML configuration loads a directory wholesale."""
    plugin_dirs = nonebot_config.get("plugin_dirs")
    if isinstance(plugin_dirs, list) and plugin_dirs:
        return True
    return _configuration_mode(nonebot_config) == "none"


def _configured_modules(nonebot_config: dict[str, Any]) -> set[str]:
    plugins = nonebot_config.get("plugins")
    if isinstance(plugins, list):
        return {str(value) for value in plugins if isinstance(value, str)}
    if isinstance(plugins, dict):
        return {
            str(value)
            for values in plugins.values()
            if isinstance(values, list)
            for value in values
            if isinstance(value, str)
        }
    return set()


def _plugin_directories(root: Path, nonebot_config: dict[str, Any]) -> list[Path]:
    configured = nonebot_config.get("plugin_dirs")
    raw_paths = configured if isinstance(configured, list) and configured else [_DEFAULT_PLUGIN_DIR]
    directories: list[Path] = []
    for raw_path in raw_paths:
        if not isinstance(raw_path, str) or not raw_path.strip():
            continue
        candidate = Path(raw_path).expanduser()
        if not candidate.is_absolute():
            candidate = root / candidate
        directories.append(candidate.resolve())
    return list(dict.fromkeys(directories))


def _discover_directory_plugins(root: Path, directories: list[Path]) -> list[tuple[Path, str, Path]]:
    discovered: list[tuple[Path, str, Path]] = []
    for directory in directories:
        if not directory.is_dir():
            continue
        try:
            relative_dir = directory.relative_to(root)
            prefix = ".".join(relative_dir.parts)
        except ValueError:
            prefix = directory.name
        try:
            entries = sorted(directory.iterdir(), key=lambda path: path.name.lower())
        except OSError:
            continue
        for entry in entries:
            if entry.name.startswith("_"):
                continue
            if entry.is_file() and entry.suffix == ".py":
                source_file = entry
                name = entry.stem
            elif entry.is_dir() and (entry / "__init__.py").is_file():
                source_file = entry / "__init__.py"
                name = entry.name
            else:
                continue
            module_name = f"{prefix}.{name}" if prefix else name
            discovered.append((entry, module_name, source_file))
    return discovered


def _module_source_path(root: Path, module_name: str) -> Path | None:
    if not re.fullmatch(r"[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*", module_name):
        return None
    parts = module_name.split(".")
    package = root.joinpath(*parts)
    if (package / "__init__.py").is_file():
        return package / "__init__.py"
    module = root.joinpath(*parts).with_suffix(".py")
    return module if module.is_file() else None


def _definition_from_metadata(
    module_name: str,
    metadata: dict[str, Any] | None,
    *,
    root: Path,
    path: Path | None,
    enabled: bool,
    source: str,
    load_mode: str,
    toggle_supported: bool,
) -> PluginDefinition:
    metadata = metadata or {}
    display_name = str(metadata.get("name") or module_name.rsplit(".", 1)[-1])
    display_path = None
    if path:
        try:
            display_path = str(path.relative_to(root)).replace("\\", "/")
        except ValueError:
            display_path = str(path)
    return PluginDefinition(
        plugin_id=module_name,
        module_name=module_name,
        name=display_name,
        path=display_path,
        description=str(metadata.get("description") or "未提供插件描述"),
        usage=str(metadata.get("usage") or "未提供使用方法"),
        plugin_type=str(metadata["type"]) if metadata.get("type") is not None else None,
        homepage=str(metadata["homepage"]) if metadata.get("homepage") else None,
        supported_adapters=metadata.get("supported_adapters"),
        extra=metadata.get("extra") if isinstance(metadata.get("extra"), dict) else {},
        enabled=enabled,
        source=source,
        load_mode=load_mode,
        toggle_supported=toggle_supported,
        metadata_available=bool(metadata.get("metadata_available")),
        error=metadata.get("error"),
    )


def _read_plugin_metadata(source_file: Path | None) -> dict[str, Any] | None:
    if source_file is None:
        return None
    try:
        if source_file.stat().st_size > _MAX_SOURCE_BYTES:
            return {"error": "插件入口文件超过 2 MB，未读取元信息"}
        tree = ast.parse(source_file.read_text(encoding="utf-8"), filename=str(source_file))
    except (OSError, UnicodeError, SyntaxError) as error:
        return {"error": f"无法读取插件元信息：{error}"}

    assignment: ast.expr | None = None
    for node in tree.body:
        target: ast.expr | None = None
        value: ast.expr | None = None
        if isinstance(node, ast.Assign):
            value = node.value
            if any(isinstance(item, ast.Name) and item.id == _PLUGIN_META_ASSIGNMENT for item in node.targets):
                target = node.targets[0]
        elif isinstance(node, ast.AnnAssign):
            value = node.value
            target = node.target
        if isinstance(target, ast.Name) and target.id == _PLUGIN_META_ASSIGNMENT and value is not None:
            assignment = value
            break
    if not isinstance(assignment, ast.Call) or not _is_plugin_metadata_call(assignment.func):
        return {"metadata_available": False}

    metadata: dict[str, Any] = {"metadata_available": True}
    fields = {keyword.arg: keyword.value for keyword in assignment.keywords if keyword.arg}
    for key in ("name", "description", "usage", "type", "homepage", "extra"):
        if key in fields:
            value = _literal_value(fields[key])
            if value is not None:
                metadata[key] = value
    if "supported_adapters" in fields:
        value = _literal_value(fields["supported_adapters"])
        if isinstance(value, str):
            metadata["supported_adapters"] = [value]
        elif isinstance(value, (list, tuple, set)):
            metadata["supported_adapters"] = sorted(str(item) for item in value)
    return metadata


def _is_plugin_metadata_call(node: ast.expr) -> bool:
    return isinstance(node, ast.Name) and node.id == "PluginMetadata" or isinstance(node, ast.Attribute) and node.attr == "PluginMetadata"


def _literal_value(node: ast.expr) -> Any:
    try:
        value = ast.literal_eval(node)
    except (ValueError, TypeError, SyntaxError):
        return None
    return _json_safe(value)


def _json_safe(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_json_safe(item) for item in value]
    return str(value)


def _section_bounds(text: str, section: str) -> tuple[int, int] | None:
    match = re.search(rf"(?m)^\s*\[{re.escape(section)}\]\s*$", text)
    if not match:
        return None
    body_start = match.end()
    next_section = re.search(r"(?m)^\s*\[[^\]]+\]\s*$", text[body_start:])
    body_end = body_start + next_section.start() if next_section else len(text)
    return body_start, body_end


def _replace_array_assignment(text: str, section: str, key: str, values: list[str]) -> str:
    bounds = _section_bounds(text, section)
    rendered = _render_array(values)
    if bounds is None:
        separator = "" if not text or text.endswith("\n") else "\n"
        return f"{text}{separator}\n[{section}]\n{_toml_key(key)} = {rendered}\n"
    body_start, body_end = bounds
    body = text[body_start:body_end]
    key_pattern = rf"(?m)^(\s*{re.escape(_toml_key(key))}\s*=\s*)"
    match = re.search(key_pattern, body)
    if not match:
        insertion = f"\n{_toml_key(key)} = {rendered}\n"
        return text[:body_end] + insertion + text[body_end:]
    value_start = body_start + match.end()
    array_start = text.find("[", value_start, body_end)
    if array_start < 0:
        raise ValueError(f"[{section}] 中的 {key} 不是数组")
    array_end = _matching_bracket(text, array_start, body_end)
    return text[:array_start] + rendered + text[array_end:]


def _toml_key(key: str) -> str:
    return key if re.fullmatch(r"[A-Za-z0-9_-]+", key) else json.dumps(key, ensure_ascii=False)


def _render_array(values: list[str]) -> str:
    if not values:
        return "[]"
    return "[\n" + "\n".join(f"    {json.dumps(value, ensure_ascii=False)}," for value in values) + "\n]"


def _matching_bracket(text: str, start: int, limit: int) -> int:
    depth = 0
    quote = ""
    escaped = False
    for index in range(start, limit):
        char = text[index]
        if quote:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                quote = ""
            continue
        if char in {'"', "'"}:
            quote = char
        elif char == "[":
            depth += 1
        elif char == "]":
            depth -= 1
            if depth == 0:
                return index + 1
    raise ValueError("TOML 数组没有闭合")


def _atomic_write(path: Path, text: str) -> None:
    path = path.resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, prefix=f".{path.name}.", suffix=".tmp", delete=False) as handle:
        temporary = Path(handle.name)
        handle.write(text)
    try:
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)
