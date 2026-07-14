from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable


@dataclass(frozen=True)
class PluginDefinition:
    """插件管理元数据；插件实际执行仍由 Bot 运行时负责。"""

    plugin_id: str
    name: str
    version: str = "0.1.0"
    enabled: bool = True
    handler: Callable[[dict[str, Any]], Any] | None = None


class PluginRegistry:
    """为后续插件发现、启停和生命周期管理提供统一注册边界。"""

    def __init__(self) -> None:
        self._plugins: dict[str, PluginDefinition] = {}

    def register(self, plugin: PluginDefinition) -> None:
        self._plugins[plugin.plugin_id] = plugin

    def unregister(self, plugin_id: str) -> None:
        self._plugins.pop(plugin_id, None)

    def get(self, plugin_id: str) -> PluginDefinition | None:
        return self._plugins.get(plugin_id)

    def list(self) -> list[PluginDefinition]:
        return list(self._plugins.values())
