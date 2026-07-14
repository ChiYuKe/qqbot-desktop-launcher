from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class BotConfig:
    id: str
    name: str
    qq: str
    port: int
    script: str
    napcat_port: int = 6099
    password_secret: str = ""
    groups: int = 0
    plugins: int = 0

    @classmethod
    def from_row(cls, row: Any) -> "BotConfig":
        return cls(
            id=str(row["id"]),
            name=str(row["name"]),
            qq=str(row["qq"]),
            port=int(row["port"]),
            napcat_port=int(row["napcat_port"] or 6099) if "napcat_port" in row.keys() else 6099,
            script=str(row["script"]),
            password_secret=str(row["password_secret"] or "") if "password_secret" in row.keys() else "",
            groups=int(row["groups"] or 0),
            plugins=int(row["plugins"] or 0),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "qq": self.qq,
            "port": self.port,
            "napcat_port": self.napcat_port,
            "script": self.script,
            "groups": self.groups,
            "plugins": self.plugins,
        }
