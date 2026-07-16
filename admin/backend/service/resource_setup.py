from __future__ import annotations

import asyncio
import copy
import hashlib
import hmac
import json
import re
import shutil
import stat
import subprocess
import sys
import threading
import time
import tempfile
import urllib.request
import uuid
import zipfile
from pathlib import Path

import backend.config as runtime_config
from backend.adapter.napcat import NapCatAdapter
from backend.domain.models import BotConfig


NAPCAT_RELEASE_API = "https://api.github.com/repos/NapNeko/NapCatQQ/releases/latest"
ASTRBOT_RELEASE_API = "https://api.github.com/repos/AstrBotDevs/AstrBot/releases/latest"
NAPCAT_ONEKEY_ASSET_NAME = "NapCat.Shell.Windows.OneKey.zip"
NAPCAT_SHELL_ASSET_NAME = "NapCat.Shell.zip"
SETUP_ROOT = runtime_config.DATA_DIR / "setup"
SETUP_LABELS = {"nonebot": "NoneBot", "astrbot": "AstrBot", "napcat": "NapCat"}
SETUP_ORDER = ("nonebot", "astrbot", "napcat")
SETUP_STEPS = {
    "nonebot": (
        ("python", "检查 Python 环境"),
        ("project", "准备 NoneBot 项目"),
        ("dependencies", "安装 NoneBot 与 OneBot 适配器"),
        ("environment", "写入反向 WS 配置"),
        ("verify", "验证 NoneBot 配置"),
    ),
    "astrbot": (
        ("release", "获取官方 AstrBot 源码"),
        ("download", "下载源码包"),
        ("extract", "解压 AstrBot 源码"),
        ("python", "准备 AstrBot 虚拟环境"),
        ("dependencies", "安装 AstrBot 依赖"),
        ("config", "生成 OneBot 配置"),
        ("verify", "验证 AstrBot 配置"),
    ),
    "napcat": (
        ("release", "获取官方 NapCat 发布包"),
        ("download", "下载并校验一键安装包"),
        ("extract", "解压一键安装包"),
        ("installer", "执行 NapCatInstaller 安装器"),
        ("qq", "部署并检测内置 QQ"),
        ("webui", "配置 NapCat WebUI"),
        ("onebot", "配置 OneBot 反向 WS"),
        ("verify", "验证 NapCat 资源"),
    ),
}
MAX_ARCHIVE_BYTES = 1_000_000_000
MAX_EXTRACTED_BYTES = 4_000_000_000
MAX_ARCHIVE_MEMBERS = 20_000
MAX_COMPRESSION_RATIO = 1_000


class SetupCancelled(RuntimeError):
    pass


class NapCatInstallerFailure(RuntimeError):
    def __init__(self, message: str, *, qq_download_failed: bool = False) -> None:
        super().__init__(message)
        self.qq_download_failed = qq_download_failed


class ResourceSetupManager:
    """Runs the first-time resource setup outside the FastAPI event loop."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._task: asyncio.Task | None = None
        self._cancel_event = threading.Event()
        self._process: subprocess.Popen[str] | None = None
        self._job: dict[str, object] = {
            "id": None,
            "status": "idle",
            "step": "",
            "message": "",
            "progress": 0,
            "error": None,
            "installer_log_url": "",
        }
        # Keep a complete last-known state so status requests never wait
        # indefinitely for a worker that is performing filesystem work.
        self._status_snapshot: dict[str, object] = copy.deepcopy(self._job)
        self._bots: list[BotConfig] = []
        self._napcat = NapCatAdapter(self._sink)

    async def _sink(self, _level: str, _source: str, _message: str) -> None:
        return

    def start(self, kinds: list[str] | None = None, bots: list[BotConfig] | None = None) -> dict[str, object]:
        selected = self._normalize_kinds(kinds)
        with self._lock:
            if self._job["status"] == "running" and self._job["id"]:
                return copy.deepcopy(self._job)
            self._cancel_event.clear()
            self._bots = list(bots or [])
            job_id = uuid.uuid4().hex[:12]
            self._job = {
                "id": job_id,
                "status": "running",
                "step": SETUP_LABELS[selected[0]],
                "message": "正在准备配置任务…",
                "progress": 0,
                "error": None,
                "kind": "workflow",
                "kinds": selected,
                "current_task": selected[0],
                "tasks": [
                    {
                        "kind": kind,
                        "label": SETUP_LABELS[kind],
                        "status": "queued",
                        "progress": 0,
                        "message": "等待执行",
                        "steps": [
                            {"id": step_id, "label": label, "status": "queued", "progress": 0, "message": "等待执行"}
                            for step_id, label in SETUP_STEPS[kind]
                        ],
                    }
                    for kind in selected
                ],
            }
            self._task = asyncio.create_task(self._run(job_id, selected))
            self._cache_snapshot_locked()
            return copy.deepcopy(self._status_snapshot)

    @staticmethod
    def _normalize_kinds(kinds: list[str] | None) -> list[str]:
        values = [str(kind).lower() for kind in (kinds or [])]
        if "all" in values:
            values = list(SETUP_ORDER)
        unknown = [kind for kind in values if kind not in SETUP_ORDER]
        if unknown:
            raise ValueError(f"不支持的配置任务：{', '.join(unknown)}")
        return [kind for kind in SETUP_ORDER if kind in values] or ["nonebot"]

    def status(self, job_id: str | None = None) -> dict[str, object]:
        if self._lock.acquire(timeout=0.5):
            try:
                snapshot = copy.deepcopy(self._job)
                self._status_snapshot = snapshot
            finally:
                self._lock.release()
        else:
            # Do not let a stalled setup worker block the API event loop.
            snapshot = copy.deepcopy(self._status_snapshot)
        if job_id and snapshot.get("id") != job_id:
            return {"id": job_id, "status": "missing", "step": "", "message": "找不到配置任务", "progress": 0, "error": "任务不存在或已重启"}
        return snapshot

    def _cache_snapshot_locked(self) -> None:
        self._status_snapshot = copy.deepcopy(self._job)

    async def shutdown(self) -> None:
        self._cancel_event.set()
        with self._lock:
            process = self._process
        if process and process.poll() is None:
            try:
                process.terminate()
            except OSError:
                pass
        task = self._task
        if task and not task.done():
            try:
                await asyncio.wait_for(asyncio.shield(task), timeout=10)
            except asyncio.TimeoutError:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)

    async def _run(self, job_id: str, kinds: list[str]) -> None:
        try:
            await asyncio.to_thread(self._run_sync, job_id, kinds)
            labels = "、".join(SETUP_LABELS[kind] for kind in kinds)
            self._update(status="succeeded", step="完成", message=f"{labels} 已配置完成。", current_task=None, progress=100, error=None)
        except asyncio.CancelledError:
            raise
        except Exception as error:  # noqa: BLE001 - surfaced in the setup panel
            with self._lock:
                current = self._job.get("current_task")
            if current:
                self._update_task(str(current), "failed", message=str(error))
            self._update(status="failed", step="配置失败", message="配置流程没有完成。", error=str(error), current_task=None)

    def _run_sync(self, job_id: str, kinds: list[str]) -> None:
        SETUP_ROOT.mkdir(parents=True, exist_ok=True)
        for kind in kinds:
            self._check_cancelled()
            self._update_task(kind, "running", 0, f"正在准备 {SETUP_LABELS[kind]}…")
            if kind == "nonebot":
                self._prepare_nonebot()
                self._update_task(kind, "succeeded", 100, "NoneBot 已安装、配置并通过校验。")
            elif kind == "astrbot":
                self._prepare_astrbot(job_id)
                self._update_task(kind, "succeeded", 100, "AstrBot 已安装、配置并通过校验。")
            elif kind == "napcat":
                current = runtime_config.resource_status()
                if current["napcat"].get("valid"):
                    self._mark_existing_napcat()
                elif runtime_config.napcat_installer_path():
                    self._mark_existing_onekey()
                    try:
                        package_root = self._run_napcat_installer(runtime_config.napcat_installer_path())
                        runtime_config.set_resource_path("napcat", str(package_root))
                        self._update_step("napcat", "qq", "succeeded", 100, "内置 QQ.exe 和 NapCat 启动器已就绪。")
                    except NapCatInstallerFailure as error:
                        if not error.qq_download_failed:
                            raise
                        self._update_step("napcat", "installer", "running", 80, "本机 OneKey 安装器下载 QQ 失败，正在重新获取官方 Shell 备用包…")
                        self._download_napcat(job_id)
                else:
                    self._download_napcat(job_id)
                self._configure_napcat()
                status = runtime_config.resource_status()["napcat"]
                if not status.get("valid"):
                    raise RuntimeError("NapCat 安装未完成：需要 NapCatWinBootMain.exe 和可用的 QQ.exe")
                self._update_task(kind, "succeeded", 100, "NapCat 已安装 QQ、完成配置并通过校验。")

    def _prepare_astrbot(self, job_id: str) -> None:
        status = runtime_config.resource_status()["astrbot"]
        if not status.get("valid"):
            self._download_astrbot(job_id)
        else:
            for step_id, message in {
                "release": "已检测到本机 AstrBot 源码。",
                "download": "使用本机已准备的 AstrBot 源码。",
                "extract": "已检测到 AstrBot 项目文件。",
            }.items():
                self._update_step("astrbot", step_id, "succeeded", 100, message)
        target = runtime_config.ASTRBOT_DIR
        python = self._ensure_astrbot_python(target)
        self._update_step("astrbot", "python", "succeeded", 100, f"已准备 AstrBot Python：{python.name}。")
        requirements = target / "requirements.txt"
        if requirements.exists():
            self._update_step("astrbot", "dependencies", "running", 10, "正在安装 AstrBot 依赖…")
            returncode, stdout, _ = self._run_process(
                [str(python), "-m", "pip", "install", "--disable-pip-version-check", "-r", str(requirements)],
                cwd=target,
                timeout=1200,
            )
            if returncode != 0:
                detail = (stdout or "pip 没有返回具体错误").strip().splitlines()[-1]
                raise RuntimeError(f"AstrBot 依赖安装失败：{detail}")
        self._update_step("astrbot", "dependencies", "succeeded", 100, "AstrBot 依赖安装完成。")
        self._update_step("astrbot", "config", "running", 10, "正在写入 AstrBot OneBot 反向 WebSocket 配置…")
        token = runtime_config.ensure_onebot_access_token()
        for bot in self._bots:
            if bot.framework == "astrbot":
                runtime_config.ensure_astrbot_config(bot.id, bot.port, bot.napcat_port, token)
        self._update_step("astrbot", "config", "succeeded", 100, "AstrBot 配置文件已准备。")
        self._update_step("astrbot", "verify", "running", 10, "正在导入 AstrBot 核心并检查项目文件…")
        if not (target / "main.py").exists() or not (target / "pyproject.toml").exists():
            raise RuntimeError("AstrBot 项目文件不完整")
        returncode, output, _ = self._run_process(
            [str(python), "-c", "import astrbot; print(astrbot.__version__)"],
            cwd=target,
            timeout=120,
        )
        if returncode != 0:
            detail = output.strip().splitlines()[-1] if output.strip() else "AstrBot 核心导入失败"
            raise RuntimeError(f"AstrBot 配置校验失败：{detail}")
        self._update_step("astrbot", "verify", "succeeded", 100, "AstrBot 核心导入和配置校验通过。")

    def _download_astrbot(self, job_id: str) -> None:
        self._update_step("astrbot", "release", "running", 5, "正在获取 AstrBot 最新稳定版本…")
        request = urllib.request.Request(ASTRBOT_RELEASE_API, headers={"User-Agent": "QQBot-Control-Panel"})
        with urllib.request.urlopen(request, timeout=30) as response:  # noqa: S310 - fixed official HTTPS endpoint
            release = json.loads(response.read().decode("utf-8"))
        tag = str(release.get("tag_name") or "").strip()
        if not tag:
            raise RuntimeError("AstrBot 官方接口没有返回稳定版本")
        self._update_step("astrbot", "release", "succeeded", 100, f"已找到 AstrBot {tag}。")
        staging_root = SETUP_ROOT / job_id / "astrbot"
        archive = staging_root / "astrbot.zip"
        extract_dir = staging_root / "staging"
        staging_root.mkdir(parents=True, exist_ok=True)
        try:
            self._download_unverified(
                f"https://codeload.github.com/AstrBotDevs/AstrBot/zip/refs/tags/{tag}",
                archive,
                "AstrBot",
                10,
                60,
            )
            extract_dir.mkdir(parents=True, exist_ok=True)
            self._update_step("astrbot", "extract", "running", 65, "正在解压 AstrBot 源码…")
            self._safe_extract(archive, extract_dir)
            source = next((path for path in extract_dir.iterdir() if path.is_dir() and (path / "main.py").exists()), None)
            if source is None:
                raise RuntimeError("AstrBot 源码包解压后没有找到 main.py")
            target = runtime_config.ASTRBOT_DIR
            if target.exists() and any(target.iterdir()):
                raise RuntimeError("AstrBot 目录已存在但不是有效项目，请先选择或清理该目录")
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(source, target, dirs_exist_ok=True)
            runtime_config.set_resource_path("astrbot", str(target))
            self._update_step("astrbot", "download", "succeeded", 100, "AstrBot 源码包下载完成。")
            self._update_step("astrbot", "extract", "succeeded", 100, "AstrBot 源码已解压到程序目录。")
        finally:
            shutil.rmtree(staging_root, ignore_errors=True)

    def _download_unverified(self, url: str, destination: Path, label: str, start: int, end: int) -> None:
        request = urllib.request.Request(url, headers={"User-Agent": "QQBot-Control-Panel"})
        with urllib.request.urlopen(request, timeout=60) as response, destination.open("wb") as output:  # noqa: S310 - fixed official HTTPS endpoint
            total = int(response.headers.get("Content-Length", "0") or 0)
            if total > MAX_ARCHIVE_BYTES:
                raise RuntimeError("下载包超过大小限制")
            received = 0
            while True:
                self._check_cancelled()
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                output.write(chunk)
                received += len(chunk)
                if received > MAX_ARCHIVE_BYTES:
                    raise RuntimeError("下载包超过大小限制")
                progress = start if not total else start + int((end - start) * received / total)
                self._update_step("astrbot", "download", "running", min(progress, end), f"正在下载 {label}… {received / 1024 / 1024:.1f} MB")
            if received <= 0:
                raise RuntimeError(f"{label} 下载为空")

    def _ensure_astrbot_python(self, target: Path) -> Path:
        python = target / ".venv" / "Scripts" / "python.exe"
        if python.exists():
            return python
        if sys.version_info < (3, 10):
            raise RuntimeError("AstrBot 要求 Python 3.10 或更高版本")
        venv_dir = target / ".venv"
        self._update_step("astrbot", "python", "running", 30, "正在创建 AstrBot 虚拟环境…")
        returncode, _, _ = self._run_process([sys.executable, "-m", "venv", str(venv_dir)], timeout=300)
        if returncode != 0 or not python.exists():
            raise RuntimeError("无法创建 AstrBot Python 虚拟环境")
        return python
    def _check_cancelled(self) -> None:
        if self._cancel_event.is_set():
            raise SetupCancelled("配置任务已取消")

    def _download_napcat(self, job_id: str) -> None:
        self._update_step("napcat", "release", "running", 5, "正在获取 NapCat 最新官方下载包…")
        request = urllib.request.Request(NAPCAT_RELEASE_API, headers={"User-Agent": "QQBot-Control-Panel"})
        with urllib.request.urlopen(request, timeout=30) as response:  # noqa: S310 - fixed official HTTPS endpoint
            release = json.loads(response.read().decode("utf-8"))
        assets = [asset for asset in release.get("assets", []) if isinstance(asset, dict)]
        asset = next(
            (item for item in assets if str(item.get("name", "")).lower() == NAPCAT_ONEKEY_ASSET_NAME.lower()),
            None,
        )
        if not asset:
            raise RuntimeError(f"NapCat 官方最新版本没有找到 {NAPCAT_ONEKEY_ASSET_NAME}")
        shell_asset = next(
            (item for item in assets if str(item.get("name", "")).lower() == NAPCAT_SHELL_ASSET_NAME.lower()),
            None,
        )
        digest = self._asset_sha256(asset)
        if not digest:
            raise RuntimeError("NapCat 官方资源没有提供 SHA-256 校验值，已停止安装")
        self._update_step(
            "napcat",
            "release",
            "succeeded",
            100,
            f"已找到官方 {release.get('tag_name', 'latest')} 资源 NapCat.Shell.Windows.OneKey.zip。",
        )
        staging_root = SETUP_ROOT / job_id
        archive = staging_root / "napcat.zip"
        extract_dir = staging_root / "staging"
        backup_dir = staging_root / "backup"
        staging_root.mkdir(parents=True, exist_ok=True)
        target = runtime_config.PROGRAM_DIR / "NapCat"
        committed = False
        try:
            expected_size = int(asset.get("size") or 0)
            self._download_file(str(asset["browser_download_url"]), archive, "NapCat", 10, 65, expected_size, digest)
            self._update_step(
                "napcat",
                "download",
                "succeeded",
                100,
                "已下载 NapCat.Shell.Windows.OneKey.zip，SHA-256 校验通过。",
            )
            if extract_dir.exists():
                shutil.rmtree(extract_dir)
            extract_dir.mkdir(parents=True)
            self._update_step("napcat", "extract", "running", 70, "正在解压 NapCat…")
            self._safe_extract(archive, extract_dir)
            installer = self._find_napcat_installer(extract_dir)
            if installer is None:
                raise RuntimeError("NapCat 一键包解压后没有找到 NapCatInstaller.exe")
            self._update_step("napcat", "extract", "succeeded", 100, "一键包已解压，找到 NapCatInstaller.exe。")
            shell_fallback = False
            try:
                package_root = self._run_napcat_installer(installer, extract_dir)
            except NapCatInstallerFailure as error:
                if not error.qq_download_failed:
                    raise
                if not shell_asset:
                    raise RuntimeError(f"{error}；官方 Release 没有提供 {NAPCAT_SHELL_ASSET_NAME} 备用包") from error
                self._update_step("napcat", "installer", "running", 80, "OneKey 安装器下载 QQ 失败，正在切换官方 Shell 版…")
                shutil.rmtree(extract_dir, ignore_errors=True)
                extract_dir.mkdir(parents=True)
                self._download_shell_fallback(shell_asset, staging_root, extract_dir)
                shell_fallback = True
                self._update_step("napcat", "installer", "succeeded", 100, "OneKey 安装器下载 QQ 失败，已切换官方 Shell 版。")
            if not shell_fallback:
                self._update_step("napcat", "installer", "succeeded", 100, "NapCatInstaller.exe 已完成自动部署。")
            if not shell_fallback and self._find_napcat_installation(extract_dir) is None:
                raise RuntimeError("NapCatInstaller.exe 执行后没有生成 QQ.exe 和 NapCatWinBootMain.exe")
            if shell_fallback:
                self._update_step("napcat", "qq", "succeeded", 100, "Shell 版已就绪，将使用本机已安装的 QQ.exe。")
            else:
                self._update_step("napcat", "qq", "succeeded", 100, "内置 QQ.exe 和 NapCat 启动器已就绪。")
            if target.exists():
                target.rename(backup_dir)
            try:
                extract_dir.rename(target)
                runtime_config.set_resource_path("napcat", str(target))
                committed = True
            except Exception:
                if target.exists():
                    shutil.rmtree(target, ignore_errors=True)
                if backup_dir.exists():
                    backup_dir.rename(target)
                raise
        finally:
            archive.unlink(missing_ok=True)
            shutil.rmtree(extract_dir, ignore_errors=True)
            if committed:
                shutil.rmtree(backup_dir, ignore_errors=True)
            elif backup_dir.exists():
                if target.exists():
                    shutil.rmtree(target, ignore_errors=True)
                if not target.exists():
                    backup_dir.rename(target)
            shutil.rmtree(staging_root, ignore_errors=True)

    def _mark_existing_napcat(self) -> None:
        messages = {
            "release": "已检测到完整 NapCat 一键安装结果，跳过下载。",
            "download": "已使用本机已下载的 NapCat 资源。",
            "extract": "已检测到已解压的 NapCat 目录。",
            "installer": "已完成 NapCatInstaller.exe 部署。",
            "qq": "已检测到内置 QQ.exe 和 NapCat 启动器。",
        }
        for step_id, message in messages.items():
            self._update_step("napcat", step_id, "succeeded", 100, message)

    def _mark_existing_onekey(self) -> None:
        messages = {
            "release": "已找到本机 NapCat 一键包。",
            "download": "使用本机已下载的一键安装包。",
            "extract": "使用本机已解压的一键包目录。",
        }
        for step_id, message in messages.items():
            self._update_step("napcat", step_id, "succeeded", 100, message)

    @staticmethod
    def _find_napcat_installer(root: Path) -> Path | None:
        if not root.exists():
            return None
        for candidate in root.rglob("*.exe"):
            if candidate.name.lower() == "napcatinstaller.exe":
                return candidate
        return None

    @staticmethod
    def _find_napcat_installation(root: Path) -> Path | None:
        if not root.exists():
            return None
        launchers = [
            candidate
            for candidate in root.rglob("*.exe")
            if candidate.name.lower() == "napcatwinbootmain.exe"
        ]
        for launcher in launchers:
            current = launcher.parent
            while True:
                if any(item.name.lower() == "qq.exe" for item in current.iterdir() if item.is_file()):
                    return current
                if current == root:
                    break
                if root not in current.parents:
                    break
                current = current.parent
        return None

    @staticmethod
    def _find_napcat_shell_installation(root: Path) -> Path | None:
        """Find the official Shell package, which intentionally has no QQ.exe."""
        if not root.exists():
            return None
        for launcher in root.rglob("NapCatWinBootMain.exe"):
            package_root = launcher.parent
            required = ("launcher.bat", "napcat.mjs", "NapCatWinBootHook.dll", "qqnt.json")
            if all((package_root / filename).is_file() for filename in required):
                return package_root
        return None

    def _download_shell_fallback(
        self,
        asset: dict[str, object],
        staging_root: Path,
        extract_dir: Path,
    ) -> Path:
        qq_path = runtime_config.installed_qq_path()
        if qq_path is None:
            raise RuntimeError(
                "OneKey 安装器下载 QQ 失败；官方 Shell 备用流程要求本机已安装 QQ.exe，当前未检测到。"
                "请先安装 Windows x64 QQ 后重新配置。"
            )
        digest = self._asset_sha256(asset)
        if not digest:
            raise RuntimeError(f"NapCat 官方资源没有提供 {NAPCAT_SHELL_ASSET_NAME} 的 SHA-256 校验值")
        archive = staging_root / "napcat-shell.zip"
        expected_size = int(asset.get("size") or 0)
        self._download_file(
            str(asset["browser_download_url"]),
            archive,
            NAPCAT_SHELL_ASSET_NAME,
            10,
            65,
            expected_size,
            digest,
        )
        self._update_step(
            "napcat",
            "download",
            "succeeded",
            100,
            f"已下载 {NAPCAT_SHELL_ASSET_NAME}，SHA-256 校验通过；使用本机 QQ.exe：{qq_path}。",
        )
        self._update_step("napcat", "extract", "running", 70, f"正在解压 {NAPCAT_SHELL_ASSET_NAME}…")
        self._safe_extract(archive, extract_dir)
        package_root = self._find_napcat_shell_installation(extract_dir)
        if package_root is None:
            raise RuntimeError(f"{NAPCAT_SHELL_ASSET_NAME} 解压后没有找到完整 Shell 启动目录")
        self._update_step("napcat", "extract", "succeeded", 100, "Shell 版已解压，找到 NapCatWinBootMain.exe。")
        return package_root

    def _run_napcat_installer(self, installer: Path, output_root: Path | None = None) -> Path:
        root = (output_root or installer.parent).resolve()
        self._check_cancelled()
        log_path = runtime_config.PROCESS_LOG_DIR / "napcat-installer.log"
        runtime_config.PROCESS_LOG_DIR.mkdir(parents=True, exist_ok=True)
        with self._lock:
            self._job["installer_log_url"] = "/api/runtime/setup/installer-log"
        self._update_step("napcat", "installer", "running", 80, "正在执行 NapCatInstaller.exe，下载并部署内置 QQ…")
        try:
            # Each setup run gets a fresh installer log. Reading stale output from a
            # previous failed run could otherwise trigger the waiting/error detector
            # before the current installer has produced any output.
            with log_path.open("w", encoding="gb18030", buffering=1) as log:
                log.write(f"\n=== NapCatInstaller {time.strftime('%Y-%m-%d %H:%M:%S')} ===\n")
                log.write(f"installer={installer.resolve()}\n")
                log.write(f"cwd={installer.parent.resolve()}\n")
                log.flush()
                try:
                    process = subprocess.Popen(
                        [str(installer.resolve())],
                        cwd=installer.parent,
                        stdin=subprocess.DEVNULL,
                        stdout=log,
                        stderr=subprocess.STDOUT,
                        creationflags=getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0),
                    )
                except OSError as error:
                    raise RuntimeError(f"无法启动 NapCatInstaller.exe：{error}；日志：{log_path}") from error
                with self._lock:
                    self._process = process
                started = time.monotonic()
                exited_at: float | None = None
                try:
                    while True:
                        self._check_cancelled()
                        package_root = self._find_napcat_installation(root)
                        returncode = process.poll()
                        output = self._read_installer_log(log_path)
                        if package_root is not None and returncode is not None:
                            log.write(f"returncode={self._format_returncode(returncode)}\n")
                            return package_root
                        if self._installer_waiting_after_failure(output, returncode, started):
                            self._terminate_process(process)
                            raise NapCatInstallerFailure(
                                self._installer_failure_detail(returncode, log_path, output),
                                qq_download_failed=self._find_install_error(output) is not None,
                            )
                        if returncode is not None:
                            exited_at = exited_at or time.monotonic()
                            if time.monotonic() - exited_at > 15:
                                log.write(f"returncode={self._format_returncode(returncode)}\n")
                                raise NapCatInstallerFailure(
                                    self._installer_failure_detail(returncode, log_path, output),
                                    qq_download_failed=self._find_install_error(output) is not None,
                                )
                        if time.monotonic() - started > 1200:
                            self._terminate_process(process)
                            raise RuntimeError(f"NapCatInstaller.exe 执行超时，QQ 下载或部署未完成；日志：{log_path}")
                        time.sleep(0.5)
                except SetupCancelled:
                    self._terminate_process(process)
                    raise
                finally:
                    with self._lock:
                        if self._process is process:
                            self._process = None
        except RuntimeError:
            raise
        except OSError as error:
            raise RuntimeError(f"无法写入 NapCatInstaller 日志：{error}") from error

    @staticmethod
    def _read_installer_log(path: Path) -> str:
        try:
            return path.read_text(encoding="gb18030", errors="replace")
        except OSError:
            return ""

    @staticmethod
    def _format_returncode(returncode: int | None) -> str:
        if returncode is None:
            return "未知"
        unsigned = int(returncode) & 0xFFFFFFFF
        return f"{unsigned} (0x{unsigned:08X})"

    @staticmethod
    def _installer_waiting_after_failure(output: str, returncode: int | None, started: float) -> bool:
        if returncode is not None or time.monotonic() - started < 3:
            return False
        return bool(re.search(r"Press any key|按任意键", output, flags=re.IGNORECASE)) and ResourceSetupManager._find_install_error(output) is not None

    @staticmethod
    def _find_install_error(output: str) -> str | None:
        if re.search(r"HTTP状态码\s*[:：]\s*404|HTTP错误[^\n]*404|下载\s*QQ\s*失败", output, flags=re.IGNORECASE):
            return "官方一键包内置的 QQ 下载地址返回 HTTP 404，安装器无法下载 QQ。"
        if re.search(r"HTTP状态码\s*[:：]\s*\d+|HTTP错误|下载\s*QQ\s*失败", output, flags=re.IGNORECASE):
            return "NapCatInstaller.exe 下载 QQ 失败。"
        return None

    @classmethod
    def _installer_failure_detail(cls, returncode: int | None, log_path: Path, output: str) -> str:
        detail = cls._find_install_error(output)
        if detail:
            return (
                f"NapCat.Shell.Windows.OneKey.zip 已下载并校验成功，但其内部 NapCatInstaller.exe 报错：{detail} "
                f"当前 NapCat 一键包的内置下载链接已失效，请更新 NapCat 一键包，"
                f"或先从腾讯 QQ 官方下载页安装兼容的 Windows x64 QQ，再选择完整 QQ/NapCat 目录；日志：{log_path}"
            )
        tail = " / ".join(line.strip() for line in output.splitlines()[-3:] if line.strip())
        suffix = f"；安装器输出：{tail[:240]}" if tail else ""
        return (
            f"NapCatInstaller.exe 已退出（代码 {cls._format_returncode(returncode)}），"
            f"但没有检测到完整 QQ/NapCat 目录{suffix}；日志：{log_path}"
        )

    def _configure_napcat(self) -> None:
        self._check_cancelled()
        self._update_step("napcat", "webui", "running", 10, "正在写入本机 WebUI 端口配置…")
        self._napcat.configure_webui(runtime_config.DEFAULT_NAPCAT_PORT)
        self._update_step("napcat", "webui", "succeeded", 100, "WebUI 已配置为本机端口 6099。")

        self._update_step("napcat", "onebot", "running", 10, "正在生成 OneBot 反向 WebSocket 配置…")
        nonebot_port = self._bots[0].port if self._bots else runtime_config.DEFAULT_NONEBOT_PORT
        environment = runtime_config.ensure_nonebot_environment(nonebot_port)
        token = environment["ONEBOT_ACCESS_TOKEN"]
        if self._bots:
            for bot in self._bots:
                self._napcat.configure_onebot(bot.qq, bot.port, bot.name, token, bot.framework)
            message = f"已为 {len(self._bots)} 个 Bot 写入反向 WS 配置。"
        else:
            self._napcat.configure_onebot(None, nonebot_port, "QQBot", token)
            message = "已生成 OneBot 默认配置模板，创建 QQ 账号后会写入账号专属配置。"
        self._update_step("napcat", "onebot", "succeeded", 100, message)

        self._update_step("napcat", "verify", "running", 10, "正在检查 QQ 主程序、启动器与配置文件…")
        status = runtime_config.resource_status()
        if not status["napcat"].get("valid"):
            raise RuntimeError("NapCat 资源校验失败：需要 NapCatWinBootMain.exe 和可用的 QQ.exe")
        config_dir = runtime_config.napcat_config_directory()
        if config_dir is None or not (config_dir / "webui.json").exists():
            raise RuntimeError("NapCat WebUI 配置文件校验失败")
        self._update_step("napcat", "verify", "succeeded", 100, "QQ、NapCat 启动器和配置文件校验通过。")

    @staticmethod
    def _asset_sha256(asset: dict[str, object]) -> str:
        digest = str(asset.get("digest") or asset.get("sha256") or "").lower().strip()
        if digest.startswith("sha256:"):
            digest = digest[7:]
        return digest if len(digest) == 64 and all(char in "0123456789abcdef" for char in digest) else ""

    def _prepare_nonebot(self) -> None:
        target = runtime_config.PROGRAM_DIR / "NoneBot"
        target.mkdir(parents=True, exist_ok=True)
        self._update_step("nonebot", "project", "running", 15, "正在创建 NoneBot 项目文件…")
        bot_file = target / "bot.py"
        project_file = target / "pyproject.toml"
        if not bot_file.exists():
            bot_file.write_text(
                "import nonebot\n"
                "from nonebot.adapters.onebot.utils import highlight_rich_message\n"
                "from nonebot.adapters.onebot.v11 import Adapter, GroupMessageEvent, PrivateMessageEvent\n\n"
                "nonebot.init()\n"
                "driver = nonebot.get_driver()\n"
                "driver.register_adapter(Adapter)\n"
                "nonebot.load_plugins(\"plugins\")\n\n"
                "def _install_full_message_logging() -> None:\n"
                "    def group_description(event: GroupMessageEvent) -> str:\n"
                "        return (\n"
                "            f\"Message {event.message_id} from {event.user_id}@[群:{event.group_id}] \"\n"
                "            f\"{''.join(highlight_rich_message(repr(event.original_message.to_rich_text(truncate=None))))}\"\n"
                "        )\n\n"
                "    def private_description(event: PrivateMessageEvent) -> str:\n"
                "        return (\n"
                "            f\"Message {event.message_id} from {event.user_id} \"\n"
                "            f\"{''.join(highlight_rich_message(repr(event.original_message.to_rich_text(truncate=None))))}\"\n"
                "        )\n\n"
                "    GroupMessageEvent.get_event_description = group_description\n"
                "    PrivateMessageEvent.get_event_description = private_description\n\n"
                "\n_install_full_message_logging()\n\n"
                "if __name__ == \"__main__\":\n"
                "    nonebot.run()\n",
                encoding="utf-8",
            )
        if not project_file.exists():
            project_file.write_text(
                "[project]\n"
                "name = \"qqbot-nonebot\"\n"
                "version = \"0.1.0\"\n"
                "requires-python = \">=3.10\"\n"
                "dependencies = [\"nonebot2>=2.4.0\", \"nonebot-adapter-onebot>=2.4.0\"]\n",
                encoding="utf-8",
            )
        (target / "plugins").mkdir(parents=True, exist_ok=True)
        self._update_step("nonebot", "project", "succeeded", 100, "项目入口、依赖文件和 plugins 目录已准备。")
        self._update_step("nonebot", "python", "running", 10, "正在检查 Python 3.10+ 与项目虚拟环境…")
        python = self._ensure_python()
        self._update_step("nonebot", "python", "succeeded", 100, f"已准备 Python：{python.name}。")
        self._update_step("nonebot", "dependencies", "running", 10, "正在安装 NoneBot 和 OneBot 适配器…")
        returncode, stdout, stderr = self._run_process(
            [
                str(python),
                "-m",
                "pip",
                "install",
                "--disable-pip-version-check",
                "-e",
                str(target),
                "nonebot2>=2.4.0",
                "nonebot-adapter-onebot>=2.4.0",
            ],
            cwd=target,
            timeout=900,
        )
        if returncode != 0:
            detail = (stderr or stdout or "pip 没有返回具体错误").strip().splitlines()[-1]
            raise RuntimeError(f"NoneBot 依赖安装失败：{detail}")
        self._update_step("nonebot", "dependencies", "succeeded", 100, "NoneBot 与 OneBot V11 适配器安装完成。")
        runtime_config.set_resource_path("nonebot", str(target))
        default_port = self._bots[0].port if self._bots else runtime_config.DEFAULT_NONEBOT_PORT
        self._update_step("nonebot", "environment", "running", 10, "正在写入 HOST、PORT 和 OneBot 访问 token…")
        environment = runtime_config.ensure_nonebot_environment(default_port)
        self._update_step("nonebot", "environment", "succeeded", 100, f"已保存 {Path(environment['path']).name}，反向 WS 路径为 /onebot/v11/ws。")
        self._update_step("nonebot", "verify", "running", 10, "正在导入适配器并检查 Python 依赖…")
        self._validate_nonebot(python, target)
        self._update_step("nonebot", "verify", "succeeded", 100, "NoneBot 配置校验通过，可以启动。")

    def _validate_nonebot(self, python: Path, target: Path) -> None:
        if not (target / "bot.py").exists() or not (target / "pyproject.toml").exists():
            raise RuntimeError("NoneBot 项目文件不完整")
        returncode, output, _ = self._run_process(
            [
                str(python),
                "-c",
                "import nonebot; from nonebot.adapters.onebot.v11 import Adapter; print(Adapter.get_name())",
            ],
            cwd=target,
            timeout=60,
        )
        if returncode != 0:
            detail = output.strip().splitlines()[-1] if output.strip() else "适配器导入失败"
            raise RuntimeError(f"NoneBot 配置校验失败：{detail}")
        returncode, output, _ = self._run_process([str(python), "-m", "pip", "check"], cwd=target, timeout=60)
        if returncode != 0:
            detail = output.strip().splitlines()[-1] if output.strip() else "pip check 失败"
            raise RuntimeError(f"NoneBot 依赖校验失败：{detail}")

    def _run_process(self, args: list[str], cwd: Path | None = None, timeout: float = 300) -> tuple[int, str, str]:
        with tempfile.TemporaryFile() as capture:
            process = subprocess.Popen(args, cwd=cwd, stdout=capture, stderr=subprocess.STDOUT)
            with self._lock:
                self._process = process
            try:
                started = time.monotonic()
                while process.poll() is None:
                    self._check_cancelled()
                    if time.monotonic() - started > timeout:
                        self._terminate_process(process)
                        raise RuntimeError("外部安装进程超时")
                    time.sleep(0.2)
                capture.seek(0)
                output = capture.read().decode("utf-8", errors="replace")
                return process.returncode or 0, output, ""
            except SetupCancelled:
                self._terminate_process(process)
                raise
            finally:
                with self._lock:
                    if self._process is process:
                        self._process = None

    @staticmethod
    def _terminate_process(process: subprocess.Popen[str]) -> None:
        if process.poll() is not None:
            return
        try:
            process.terminate()
            process.wait(timeout=5)
        except (OSError, subprocess.TimeoutExpired):
            try:
                process.kill()
            except OSError:
                pass

    def _ensure_python(self) -> Path:
        python = runtime_config.ROOT / ".venv" / "Scripts" / "python.exe"
        if python.exists():
            returncode, output, _ = self._run_process(
                [str(python), "-c", "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"],
                timeout=30,
            )
            version = output.strip().splitlines()[-1] if output.strip() else ""
            try:
                major, minor = (int(part) for part in version.split(".", 1))
            except (TypeError, ValueError):
                major, minor = 0, 0
            if returncode != 0 or (major, minor) < (3, 10):
                raise RuntimeError("NoneBot CLI/项目要求 Python 3.10 或更高版本")
            return python
        if sys.version_info < (3, 10):
            raise RuntimeError("NoneBot CLI/项目要求 Python 3.10 或更高版本")
        venv_dir = runtime_config.ROOT / ".venv"
        self._update_step("nonebot", "python", "running", 30, "正在创建项目虚拟环境…")
        returncode, _, _ = self._run_process([sys.executable, "-m", "venv", str(venv_dir)], timeout=300)
        if returncode != 0 or not python.exists():
            raise RuntimeError("无法创建 Python 虚拟环境，请先安装 Python 3.10-3.12")
        return python

    def _safe_extract(self, archive: Path, destination: Path) -> None:
        root = destination.resolve()
        with zipfile.ZipFile(archive) as zipped:
            members = zipped.infolist()
            if len(members) > MAX_ARCHIVE_MEMBERS:
                raise RuntimeError("下载包包含过多文件，已停止解压")
            extracted_size = 0
            for member in members:
                self._check_cancelled()
                target = (destination / member.filename).resolve()
                if target != root and root not in target.parents:
                    raise RuntimeError("下载包包含不安全的文件路径")
                if member.is_dir():
                    continue
                if member.create_system == 3 and stat.S_ISLNK(member.external_attr >> 16):
                    raise RuntimeError("下载包包含不安全的符号链接")
                extracted_size += member.file_size
                if extracted_size > MAX_EXTRACTED_BYTES:
                    raise RuntimeError("下载包解压后超过大小限制")
                if member.compress_size and member.file_size / member.compress_size > MAX_COMPRESSION_RATIO:
                    raise RuntimeError("下载包压缩比异常，已停止解压")
            for member in members:
                self._check_cancelled()
                zipped.extract(member, destination)

    def _download_file(
        self,
        url: str,
        destination: Path,
        label: str,
        start: int,
        end: int,
        expected_size: int = 0,
        expected_sha256: str = "",
        kind: str = "napcat",
    ) -> None:
        if expected_size <= 0 or expected_size > MAX_ARCHIVE_BYTES:
            raise RuntimeError("下载包大小无效或超过限制")
        request = urllib.request.Request(url, headers={"User-Agent": "QQBot-Control-Panel"})
        with urllib.request.urlopen(request, timeout=60) as response, destination.open("wb") as output:  # noqa: S310 - URL comes from official API
            total = int(response.headers.get("Content-Length", "0") or 0) or expected_size
            if total > MAX_ARCHIVE_BYTES:
                raise RuntimeError("下载包超过大小限制")
            received = 0
            digest = hashlib.sha256()
            while True:
                self._check_cancelled()
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                output.write(chunk)
                digest.update(chunk)
                received += len(chunk)
                if received > MAX_ARCHIVE_BYTES:
                    raise RuntimeError("下载包超过大小限制")
                percent = start if not total else start + int((end - start) * received / total)
                self._update_step(kind, "download", "running", min(percent, end), f"正在下载 {label}… {received / 1024 / 1024:.1f} MB")
            if received != expected_size:
                raise RuntimeError("下载包大小校验失败")
            if not hmac.compare_digest(digest.hexdigest(), expected_sha256):
                raise RuntimeError("下载包 SHA-256 校验失败")

    def _update_step(self, kind: str, step_id: str, status: str, progress: int, message: str) -> None:
        with self._lock:
            tasks = self._job.get("tasks")
            if not isinstance(tasks, list):
                return
            task = next((item for item in tasks if isinstance(item, dict) and item.get("kind") == kind), None)
            if task is None:
                return
            steps = task.get("steps")
            if not isinstance(steps, list):
                return
            step = next((item for item in steps if isinstance(item, dict) and item.get("id") == step_id), None)
            if step is None:
                return
            step.update({"status": status, "progress": max(0, min(100, int(progress))), "message": message})
            task["status"] = "running" if status == "running" else task.get("status", "queued")
            task["message"] = message
            task["progress"] = int(sum(int(item.get("progress", 0)) for item in steps if isinstance(item, dict)) / len(steps))
            if status == "failed":
                task["status"] = "failed"
            elif all(isinstance(item, dict) and item.get("status") == "succeeded" for item in steps):
                task["status"] = "succeeded"
            if status == "running":
                self._job["current_task"] = kind
                self._job["step"] = step.get("label", step_id)
            self._job["message"] = message
            self._job["progress"] = int(sum(int(item.get("progress", 0)) for item in tasks if isinstance(item, dict)) / len(tasks))
            self._cache_snapshot_locked()

    def _update_task(self, kind: str, status: str, progress: int | None = None, message: str | None = None) -> None:
        with self._lock:
            tasks = self._job.get("tasks")
            if not isinstance(tasks, list):
                return
            for task in tasks:
                if not isinstance(task, dict) or task.get("kind") != kind:
                    continue
                task["status"] = status
                if progress is not None:
                    task["progress"] = max(0, min(100, progress))
                if message is not None:
                    task["message"] = message
                break
            self._job["current_task"] = kind if status == "running" else self._job.get("current_task")
            self._job["step"] = SETUP_LABELS.get(kind, kind)
            self._job["message"] = message or self._job.get("message", "")
            progress_values = [int(task.get("progress", 0)) for task in tasks if isinstance(task, dict)]
            self._job["progress"] = int(sum(progress_values) / len(progress_values)) if progress_values else 0
            self._cache_snapshot_locked()

    def _update(self, **values: object) -> None:
        with self._lock:
            self._job.update(values)
            self._cache_snapshot_locked()
