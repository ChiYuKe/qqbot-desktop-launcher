from __future__ import annotations

import json
import os
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
PROGRAM_DIR = ROOT / "program"
NONEBOT_DIR = PROGRAM_DIR / "NoneBot"
NAPCAT_ROOT = PROGRAM_DIR / "NapCat"
DATA_DIR = ROOT / "data" / "admin"
DATABASE_FILE = DATA_DIR / "bots.db"
LEGACY_CONFIG_FILE = DATA_DIR / "bots.json"
EVENT_LOG_FILE = DATA_DIR / "events.jsonl"
RESOURCE_CONFIG_FILE = DATA_DIR / "resources.json"
SCRIPT_DIR = DATA_DIR / "scripts"

DEFAULT_NONEBOT_DIR = PROGRAM_DIR / "NoneBot"
DEFAULT_NAPCAT_DIR = NAPCAT_ROOT / "app" / "NapCat.44498.Shell"


def _load_resource_paths() -> dict[str, str]:
    try:
        raw = json.loads(RESOURCE_CONFIG_FILE.read_text(encoding="utf-8"))
        return raw if isinstance(raw, dict) else {}
    except (OSError, UnicodeError, ValueError):
        return {}


_resource_paths = _load_resource_paths()
NONEBOT_DIR = Path(os.getenv("NONEBOT_DIR", _resource_paths.get("nonebot_dir") or DEFAULT_NONEBOT_DIR))


def _resolve_napcat_paths(configured_path: Path) -> tuple[Path, Path]:
    """Resolve the NapCat working directory and launcher executable.

    NapCat packages normally keep QQ.exe in the package root and the launcher
    in a nested ``bootmain`` directory.  Older resource records in this
    project stored that nested directory as ``napcat_dir``; using it as the
    process cwd makes NapCat look for ``bootmain/QQ.exe`` and fail with
    Windows error 2.  Prefer the executable whose parent tree also contains
    QQ.exe and use that package root as the cwd.
    """
    configured_path = configured_path.expanduser().resolve()
    search_roots = [configured_path]
    if configured_path.parent != configured_path:
        search_roots.append(configured_path.parent)

    candidates: list[Path] = []
    for root in search_roots:
        if root.is_file() and root.name.lower() == "napcatwinbootmain.exe":
            candidates.append(root)
        elif root.exists():
            direct = root / "NapCatWinBootMain.exe"
            if direct.exists():
                candidates.append(direct)
            candidates.extend(root.rglob("NapCatWinBootMain.exe"))

    unique_candidates = list(dict.fromkeys(path.resolve() for path in candidates))
    valid_candidates: list[tuple[int, Path, Path]] = []
    for executable in unique_candidates:
        direct_root = executable.parent
        if (direct_root / "QQ.exe").exists():
            # NapCat.44498.Shell is the self-contained pair of launcher and
            # QQ.exe. Prefer it over the outer app\bootmain helper directory.
            priority = 100 if "napcat" in direct_root.name.lower() else 90
            valid_candidates.append((priority, direct_root, executable))
            continue
        package_root = executable.parent.parent if executable.parent.name.lower() == "bootmain" else direct_root
        if (package_root / "QQ.exe").exists():
            valid_candidates.append((70, package_root, executable))

    if valid_candidates:
        _, package_root, executable = max(valid_candidates, key=lambda item: item[0])
        return package_root, executable

    if unique_candidates:
        executable = unique_candidates[0]
        return executable.parent, executable

    return configured_path, configured_path / "NapCatWinBootMain.exe"


NAPCAT_DIR, NAPCAT_EXE = _resolve_napcat_paths(
    Path(os.getenv("NAPCAT_DIR", _resource_paths.get("napcat_dir") or DEFAULT_NAPCAT_DIR))
)

API_HOST = os.getenv("QQ_CONSOLE_HOST", "127.0.0.1")
API_PORT = int(os.getenv("QQ_CONSOLE_PORT", "6700"))
EVENT_HISTORY_LIMIT = 500
DEFAULT_NAPCAT_PORT = 6099


def resource_status() -> dict[str, object]:
    napcat_exe = NAPCAT_EXE
    nonebot_valid = (NONEBOT_DIR / "bot.py").exists() and (NONEBOT_DIR / "pyproject.toml").exists()
    napcat_valid = napcat_exe.exists()
    return {
        "initialized": nonebot_valid and napcat_valid,
        "nonebot": {"path": str(NONEBOT_DIR), "exists": NONEBOT_DIR.exists(), "valid": nonebot_valid},
        "napcat": {"path": str(NAPCAT_DIR), "exists": NAPCAT_DIR.exists(), "valid": napcat_valid},
        "defaults": {"nonebot": str(DEFAULT_NONEBOT_DIR), "napcat": str(DEFAULT_NAPCAT_DIR)},
        "official": {
            "nonebot": "https://nonebot.dev/docs/start/installation",
            "napcat": "https://github.com/NapNeko/NapCatQQ/releases",
        },
    }


def set_resource_path(kind: str, path: str) -> dict[str, object]:
    global NONEBOT_DIR, NAPCAT_DIR, NAPCAT_EXE, _resource_paths
    if kind not in {"nonebot", "napcat"}:
        raise ValueError("资源类型必须是 nonebot 或 napcat")
    candidate = Path(path).expanduser().resolve()
    if kind == "nonebot":
        if not (candidate / "bot.py").exists() or not (candidate / "pyproject.toml").exists():
            raise ValueError("选择的目录不是有效的 NoneBot 项目目录（缺少 bot.py 或 pyproject.toml）")
        NONEBOT_DIR = candidate
        _resource_paths["nonebot_dir"] = str(candidate)
    else:
        candidate, executable = _resolve_napcat_paths(candidate)
        if not executable.exists():
            raise ValueError("选择的目录不是有效的 NapCat 目录（找不到 NapCatWinBootMain.exe）")
        NAPCAT_DIR = candidate
        NAPCAT_EXE = executable
        _resource_paths["napcat_dir"] = str(candidate)
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    RESOURCE_CONFIG_FILE.write_text(json.dumps(_resource_paths, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return resource_status()
