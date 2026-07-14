from __future__ import annotations

import asyncio
import json
import shutil
import subprocess
import sys
import threading
import urllib.request
import uuid
import zipfile
from pathlib import Path

import backend.config as runtime_config


NAPCAT_RELEASE_API = "https://api.github.com/repos/NapNeko/NapCatQQ/releases/latest"
SETUP_ROOT = runtime_config.DATA_DIR / "setup"


class ResourceSetupManager:
    """Runs the first-time resource setup outside the FastAPI event loop."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._task: asyncio.Task | None = None
        self._job: dict[str, object] = {
            "id": None,
            "status": "idle",
            "step": "",
            "message": "",
            "progress": 0,
            "error": None,
        }

    def start(self) -> dict[str, object]:
        with self._lock:
            if self._job["status"] == "running" and self._job["id"]:
                return dict(self._job)
            job_id = uuid.uuid4().hex[:12]
            self._job = {
                "id": job_id,
                "status": "running",
                "step": "准备中",
                "message": "正在检查本机运行资源…",
                "progress": 0,
                "error": None,
            }
            self._task = asyncio.create_task(self._run(job_id))
            return dict(self._job)

    def status(self, job_id: str | None = None) -> dict[str, object]:
        with self._lock:
            snapshot = dict(self._job)
        if job_id and snapshot.get("id") != job_id:
            return {"id": job_id, "status": "missing", "step": "", "message": "找不到配置任务", "progress": 0, "error": "任务不存在或已重启"}
        return snapshot

    async def shutdown(self) -> None:
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    async def _run(self, job_id: str) -> None:
        try:
            await asyncio.to_thread(self._run_sync, job_id)
            self._update(status="succeeded", step="完成", message="NapCat 和 NoneBot 已配置完成，可以创建 Bot。", progress=100, error=None)
        except asyncio.CancelledError:
            raise
        except Exception as error:  # noqa: BLE001 - surfaced in the setup panel
            self._update(status="failed", step="配置失败", message="一键配置没有完成。", error=str(error))

    def _run_sync(self, job_id: str) -> None:
        SETUP_ROOT.mkdir(parents=True, exist_ok=True)
        current = runtime_config.resource_status()
        if not current["napcat"]["valid"]:
            self._download_napcat(job_id)
        else:
            self._update(step="NapCat", message="已检测到 NapCat，跳过下载。", progress=5)
        if not runtime_config.resource_status()["nonebot"]["valid"]:
            self._prepare_nonebot()
        else:
            self._update(step="NoneBot", message="已检测到 NoneBot，跳过安装。", progress=88)

    def _download_napcat(self, job_id: str) -> None:
        self._update(step="NapCat", message="正在获取 NapCat 最新官方下载包…", progress=8)
        request = urllib.request.Request(NAPCAT_RELEASE_API, headers={"User-Agent": "QQBot-Control-Panel"})
        with urllib.request.urlopen(request, timeout=30) as response:  # noqa: S310 - fixed official HTTPS endpoint
            release = json.loads(response.read().decode("utf-8"))
        assets = [asset for asset in release.get("assets", []) if str(asset.get("name", "")).lower().endswith(".zip")]
        assets = [asset for asset in assets if "source" not in str(asset.get("name", "")).lower()]
        if not assets:
            raise RuntimeError("NapCat 官方发布页没有找到可下载的 Windows 压缩包")
        assets.sort(key=lambda asset: ("onekey" not in str(asset.get("name", "")).lower(), str(asset.get("name", ""))))
        asset = assets[0]
        archive = SETUP_ROOT / f"napcat-{job_id}.zip"
        self._download_file(str(asset["browser_download_url"]), archive, "NapCat", 10, 65)
        extract_dir = SETUP_ROOT / f"napcat-{job_id}"
        if extract_dir.exists():
            shutil.rmtree(extract_dir)
        extract_dir.mkdir(parents=True)
        self._update(step="NapCat", message="正在解压 NapCat…", progress=68)
        self._safe_extract(archive, extract_dir)
        target = runtime_config.PROGRAM_DIR / "NapCat"
        target.mkdir(parents=True, exist_ok=True)
        shutil.copytree(extract_dir, target, dirs_exist_ok=True)
        executables = list(target.rglob("NapCatWinBootMain.exe"))
        if not executables:
            raise RuntimeError("NapCat 压缩包解压后没有找到 NapCatWinBootMain.exe")
        runtime_config.set_resource_path("napcat", str(executables[0].parent))
        self._update(step="NapCat", message="NapCat 已下载并配置。", progress=78)
        archive.unlink(missing_ok=True)
        shutil.rmtree(extract_dir, ignore_errors=True)

    def _prepare_nonebot(self) -> None:
        target = runtime_config.PROGRAM_DIR / "NoneBot"
        target.mkdir(parents=True, exist_ok=True)
        self._update(step="NoneBot", message="正在创建 NoneBot 项目文件…", progress=82)
        bot_file = target / "bot.py"
        project_file = target / "pyproject.toml"
        if not bot_file.exists():
            bot_file.write_text(
                "import nonebot\n"
                "from nonebot.adapters.onebot.v11 import Adapter\n\n"
                "nonebot.init()\n"
                "driver = nonebot.get_driver()\n"
                "driver.register_adapter(Adapter)\n"
                "nonebot.load_plugins(\"plugins\")\n\n"
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
        python = self._ensure_python()
        self._update(step="NoneBot", message="正在安装 NoneBot 和 OneBot 适配器…", progress=87)
        result = subprocess.run(
            [str(python), "-m", "pip", "install", "-e", str(target)],
            cwd=target,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=900,
            check=False,
        )
        if result.returncode != 0:
            detail = (result.stderr or result.stdout or "pip 没有返回具体错误").strip().splitlines()[-1]
            raise RuntimeError(f"NoneBot 依赖安装失败：{detail}")
        runtime_config.set_resource_path("nonebot", str(target))
        self._update(step="NoneBot", message="NoneBot 已创建并安装依赖。", progress=96)

    def _ensure_python(self) -> Path:
        python = runtime_config.ROOT / ".venv" / "Scripts" / "python.exe"
        if python.exists():
            return python
        venv_dir = runtime_config.ROOT / ".venv"
        self._update(step="Python 环境", message="正在创建项目虚拟环境…", progress=84)
        result = subprocess.run([sys.executable, "-m", "venv", str(venv_dir)], capture_output=True, text=True, timeout=300, check=False)
        if result.returncode != 0 or not python.exists():
            raise RuntimeError("无法创建 Python 虚拟环境，请先安装 Python 3.10-3.12")
        return python

    @staticmethod
    def _safe_extract(archive: Path, destination: Path) -> None:
        root = destination.resolve()
        with zipfile.ZipFile(archive) as zipped:
            for member in zipped.infolist():
                target = (destination / member.filename).resolve()
                if target != root and root not in target.parents:
                    raise RuntimeError("下载包包含不安全的文件路径")
            zipped.extractall(destination)

    def _download_file(self, url: str, destination: Path, label: str, start: int, end: int) -> None:
        request = urllib.request.Request(url, headers={"User-Agent": "QQBot-Control-Panel"})
        with urllib.request.urlopen(request, timeout=60) as response, destination.open("wb") as output:  # noqa: S310 - URL comes from official API
            total = int(response.headers.get("Content-Length", "0") or 0)
            received = 0
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                output.write(chunk)
                received += len(chunk)
                percent = start if not total else start + int((end - start) * received / total)
                self._update(step=label, message=f"正在下载 {label}… {received / 1024 / 1024:.1f} MB", progress=min(percent, end))

    def _update(self, **values: object) -> None:
        with self._lock:
            self._job.update(values)
