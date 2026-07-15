from __future__ import annotations

import json
import os
import re
import secrets
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
PROGRAM_DIR = ROOT / "program"
NONEBOT_DIR = PROGRAM_DIR / "NoneBot"
ASTRBOT_DIR = PROGRAM_DIR / "AstrBot"
NAPCAT_ROOT = PROGRAM_DIR / "NapCat"
DATA_DIR = ROOT / "data" / "admin"
DATABASE_FILE = DATA_DIR / "bots.db"
LEGACY_CONFIG_FILE = DATA_DIR / "bots.json"
EVENT_LOG_FILE = DATA_DIR / "events.jsonl"
RESOURCE_CONFIG_FILE = DATA_DIR / "resources.json"
SCRIPT_DIR = DATA_DIR / "scripts"
PROCESS_LOG_DIR = DATA_DIR / "process-logs"

DEFAULT_NONEBOT_DIR = PROGRAM_DIR / "NoneBot"
DEFAULT_ASTRBOT_DIR = PROGRAM_DIR / "AstrBot"
DEFAULT_NAPCAT_DIR = NAPCAT_ROOT / "app" / "NapCat.44498.Shell"


def _load_resource_paths() -> dict[str, str]:
    try:
        raw = json.loads(RESOURCE_CONFIG_FILE.read_text(encoding="utf-8"))
        return raw if isinstance(raw, dict) else {}
    except (OSError, UnicodeError, ValueError):
        return {}


_resource_paths = _load_resource_paths()
NONEBOT_DIR = Path(os.getenv("NONEBOT_DIR", _resource_paths.get("nonebot_dir") or DEFAULT_NONEBOT_DIR))
ASTRBOT_DIR = Path(os.getenv("ASTRBOT_DIR", _resource_paths.get("astrbot_dir") or DEFAULT_ASTRBOT_DIR))


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
    # Searching the whole parent directory can select a stale NapCat package
    # beside the user's chosen Shell directory. Only widen the search when the
    # configured path itself is an executable file.
    if configured_path.is_file():
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


def installed_qq_path(package_root: Path | None = None) -> Path | None:
    """Find QQ for both the self-contained OneKey layout and Shell layout.

    The official Shell package keeps QQ outside the NapCat directory and its
    launcher resolves QQ from the Windows uninstall registry entry. Mirror that
    behavior so a Shell fallback can use an existing QQ installation.
    """
    roots = [package_root or NAPCAT_DIR]
    direct_candidates = [root / "QQ.exe" for root in roots]
    configured = os.getenv("NAPCAT_QQ_EXE", "").strip() or str(_resource_paths.get("qq_exe") or "")
    if configured:
        direct_candidates.append(Path(configured).expanduser())
    for candidate in direct_candidates:
        if candidate.is_file():
            return candidate.resolve()

    if os.name != "nt":
        return None
    try:
        import winreg

        registry_paths = (
            r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\QQ",
            r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\QQ",
        )
        for registry_path in registry_paths:
            try:
                with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, registry_path) as key:
                    value, _ = winreg.QueryValueEx(key, "UninstallString")
            except OSError:
                continue
            raw_value = str(value).strip()
            if raw_value.startswith('"'):
                end_quote = raw_value.find('"', 1)
                uninstall_value = raw_value[1:end_quote] if end_quote > 1 else ""
            else:
                match = re.match(r"^\s*(.*?\.exe)(?:\s|$)", raw_value, flags=re.IGNORECASE)
                uninstall_value = match.group(1) if match else raw_value.split()[0] if raw_value else ""
            if not uninstall_value:
                continue
            uninstall_path = Path(uninstall_value)
            candidate = uninstall_path.parent / "QQ.exe"
            if candidate.is_file():
                return candidate.resolve()
    except (ImportError, OSError):
        return None
    return None


NAPCAT_QQ_EXE = installed_qq_path()

API_HOST = os.getenv("QQ_CONSOLE_HOST", "127.0.0.1")
API_PORT = int(os.getenv("QQ_CONSOLE_PORT", "6700"))
EVENT_HISTORY_LIMIT = 500
DEFAULT_NAPCAT_PORT = 6099
DEFAULT_NONEBOT_PORT = 8082
DEFAULT_ASTRBOT_PORT = 6199
ONEBOT_TOKEN_FILE = DATA_DIR / "onebot-access-token"


def nonebot_env_file() -> Path:
    return NONEBOT_DIR / ".env"


def astrbot_instance_dir(bot_id: str) -> Path:
    return DATA_DIR / "astrbot" / "instances" / bot_id


def astrbot_config_file(bot_id: str) -> Path:
    return astrbot_instance_dir(bot_id) / "data" / "cmd_config.json"


def astrbot_dashboard_port(napcat_port: int) -> int:
    candidate = int(napcat_port) + 10000
    return candidate if candidate <= 65535 else max(1024, int(napcat_port) - 1000)


def _read_env_value(path: Path, key: str) -> str:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError):
        return ""
    prefix = f"{key}="
    for line in lines:
        value = line.strip()
        if value.startswith(prefix):
            return value[len(prefix):].strip().strip('"').strip("'")
    return ""


def ensure_nonebot_environment(port: int = DEFAULT_NONEBOT_PORT, host: str = "127.0.0.1") -> dict[str, str]:
    """Create the local NoneBot environment used by the reverse WebSocket link."""
    path = nonebot_env_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
    except (OSError, UnicodeError):
        lines = []
    token = ensure_onebot_access_token()
    values = {
        "HOST": host,
        "PORT": str(int(port)),
        "ONEBOT_ACCESS_TOKEN": token,
    }
    updated: list[str] = []
    seen: set[str] = set()
    for line in lines:
        stripped = line.strip()
        key = stripped.split("=", 1)[0].strip() if "=" in stripped and not stripped.startswith("#") else ""
        if key in values:
            if key not in seen:
                updated.append(f"{key}={values[key]}")
                seen.add(key)
            continue
        updated.append(line)
    for key, value in values.items():
        if key not in seen:
            updated.append(f"{key}={value}")
    path.write_text("\n".join(updated).rstrip() + "\n", encoding="utf-8")
    return {"path": str(path), **values}


def onebot_access_token() -> str:
    try:
        return _read_env_value(nonebot_env_file(), "ONEBOT_ACCESS_TOKEN") or ONEBOT_TOKEN_FILE.read_text(encoding="utf-8").strip()
    except (OSError, UnicodeError):
        return ""


def ensure_onebot_access_token() -> str:
    token = onebot_access_token()
    if not token:
        token = secrets.token_urlsafe(32)
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        ONEBOT_TOKEN_FILE.write_text(token + "\n", encoding="utf-8")
    return token


def ensure_astrbot_config(
    bot_id: str,
    onebot_port: int,
    napcat_port: int,
    token: str | None = None,
) -> dict[str, str | int]:
    """Create the per-account AstrBot OneBot reverse-WebSocket configuration."""
    root = astrbot_instance_dir(bot_id)
    path = astrbot_config_file(bot_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        raw = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ValueError(f"AstrBot 配置文件无法解析：{path}") from error
    config = raw if isinstance(raw, dict) else {}
    platforms = config.setdefault("platform", [])
    if not isinstance(platforms, list):
        platforms = []
        config["platform"] = platforms
    platform_id = f"qqbot-{bot_id}"
    platform = next((item for item in platforms if isinstance(item, dict) and item.get("id") == platform_id), None)
    if not isinstance(platform, dict):
        platform = {}
        platforms.append(platform)
    platform.update(
        {
            "id": platform_id,
            "type": "aiocqhttp",
            "enable": True,
            "ws_reverse_host": "127.0.0.1",
            "ws_reverse_port": int(onebot_port),
            "ws_reverse_token": token if token is not None else ensure_onebot_access_token(),
        }
    )
    dashboard = config.setdefault("dashboard", {})
    if not isinstance(dashboard, dict):
        dashboard = {}
        config["dashboard"] = dashboard
    dashboard.update({"enable": True, "host": "127.0.0.1", "port": astrbot_dashboard_port(napcat_port)})
    config.setdefault("config_version", 2)
    path.write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return {
        "root": str(root),
        "path": str(path),
        "platform_id": platform_id,
        "port": int(onebot_port),
        "dashboard_port": astrbot_dashboard_port(napcat_port),
    }


def napcat_installer_path() -> Path | None:
    """Find the official Windows one-key installer in existing package layouts."""
    if not NAPCAT_DIR.exists():
        return None
    roots = [NAPCAT_DIR]
    if NAPCAT_DIR == NAPCAT_ROOT or NAPCAT_ROOT in NAPCAT_DIR.parents:
        roots.append(NAPCAT_ROOT)
    for root in dict.fromkeys(path.resolve() for path in roots if path.exists()):
        direct = root / "NapCatInstaller.exe"
        if direct.is_file():
            return direct
        for candidate in root.rglob("NapCatInstaller.exe"):
            if candidate.is_file():
                return candidate
    return None


def napcat_config_directory(create: bool = False) -> Path | None:
    """Locate NapCat's config directory across Shell package layouts."""
    if not NAPCAT_DIR.exists():
        return None
    candidates: list[Path] = []
    for filename in ("webui.json", "onebot11.json"):
        candidates.extend(path.parent for path in NAPCAT_DIR.rglob(filename))
    for directory in NAPCAT_DIR.rglob("config"):
        if directory.is_dir() and directory.parent.name.lower() == "napcat":
            candidates.append(directory)
    candidates.extend(
        [
            NAPCAT_DIR / "config",
            NAPCAT_DIR / "resources" / "app" / "app_launcher" / "napcat" / "config",
            NAPCAT_DIR / "resources" / "app" / "napcat" / "config",
            NAPCAT_DIR / "app" / "app_launcher" / "napcat" / "config",
            NAPCAT_DIR / "app" / "napcat" / "config",
        ]
    )
    for candidate in dict.fromkeys(path.resolve() for path in candidates):
        if candidate.exists() or create:
            if create:
                candidate.mkdir(parents=True, exist_ok=True)
            return candidate
    return None


def resource_status() -> dict[str, object]:
    global NAPCAT_QQ_EXE
    napcat_exe = NAPCAT_EXE
    qq_exe = installed_qq_path()
    NAPCAT_QQ_EXE = qq_exe
    installer = napcat_installer_path()
    nonebot_valid = (NONEBOT_DIR / "bot.py").exists() and (NONEBOT_DIR / "pyproject.toml").exists()
    astrbot_valid = (ASTRBOT_DIR / "main.py").exists() and (ASTRBOT_DIR / "pyproject.toml").exists()
    napcat_launcher_exists = napcat_exe.exists()
    napcat_qq_exists = qq_exe is not None
    napcat_valid = napcat_launcher_exists and napcat_qq_exists
    napcat_missing = "" if napcat_valid else "qq" if napcat_launcher_exists and not napcat_qq_exists else "launcher"
    direct_qq = NAPCAT_DIR / "QQ.exe"
    mode = "onekey" if direct_qq.is_file() else "shell" if napcat_launcher_exists else ""
    return {
        "initialized": (nonebot_valid or astrbot_valid) and napcat_valid,
        "setup_scope": "per-resource",
        "nonebot": {"path": str(NONEBOT_DIR), "exists": NONEBOT_DIR.exists(), "valid": nonebot_valid},
        "astrbot": {"path": str(ASTRBOT_DIR), "exists": ASTRBOT_DIR.exists(), "valid": astrbot_valid},
        "napcat": {
            "path": str(NAPCAT_DIR),
            "exists": NAPCAT_DIR.exists(),
            "valid": napcat_valid,
            "launcher_exists": napcat_launcher_exists,
            "qq_exists": napcat_qq_exists,
            "qq_path": str(qq_exe) if qq_exe else "",
            "mode": mode,
            "installer_exists": installer is not None,
            "installer_path": str(installer) if installer else "",
            "missing": napcat_missing,
        },
        "defaults": {
            "nonebot": str(DEFAULT_NONEBOT_DIR),
            "astrbot": str(DEFAULT_ASTRBOT_DIR),
            "napcat": str(DEFAULT_NAPCAT_DIR),
        },
        "official": {
            "nonebot": "https://nonebot.dev/docs/quick-start",
            "astrbot": "https://docs.astrbot.app/deploy/astrbot/cli.html",
            "napcat": "https://github.com/NapNeko/NapCatQQ/releases",
        },
    }


def set_resource_path(kind: str, path: str) -> dict[str, object]:
    global NONEBOT_DIR, ASTRBOT_DIR, NAPCAT_DIR, NAPCAT_EXE, NAPCAT_QQ_EXE, _resource_paths
    if kind not in {"nonebot", "astrbot", "napcat"}:
        raise ValueError("资源类型必须是 nonebot、astrbot 或 napcat")
    candidate = Path(path).expanduser().resolve()
    if kind == "nonebot":
        if not (candidate / "bot.py").exists() or not (candidate / "pyproject.toml").exists():
            raise ValueError("选择的目录不是有效的 NoneBot 项目目录（缺少 bot.py 或 pyproject.toml）")
        NONEBOT_DIR = candidate
        _resource_paths["nonebot_dir"] = str(candidate)
    elif kind == "astrbot":
        if not (candidate / "main.py").exists() or not (candidate / "pyproject.toml").exists():
            raise ValueError("选择的目录不是有效的 AstrBot 项目目录（缺少 main.py 或 pyproject.toml）")
        ASTRBOT_DIR = candidate
        _resource_paths["astrbot_dir"] = str(candidate)
    elif kind == "napcat":
        candidate, executable = _resolve_napcat_paths(candidate)
        if not executable.exists():
            raise ValueError("选择的目录不是有效的 NapCat 目录（找不到 NapCatWinBootMain.exe）")
        qq_exe = installed_qq_path(candidate)
        if qq_exe is None:
            raise ValueError("未检测到 QQ.exe，请先安装 QQ，或选择同时包含 QQ.exe 和 NapCatWinBootMain.exe 的目录")
        NAPCAT_DIR = candidate
        NAPCAT_EXE = executable
        NAPCAT_QQ_EXE = qq_exe
        _resource_paths["napcat_dir"] = str(candidate)
        _resource_paths["qq_exe"] = str(qq_exe)
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    RESOURCE_CONFIG_FILE.write_text(json.dumps(_resource_paths, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return resource_status()
