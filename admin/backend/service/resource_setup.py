from __future__ import annotations

import asyncio
import copy
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
SETUP_LABELS = {"nonebot": "NoneBot", "napcat": "NapCat"}
SETUP_ORDER = ("nonebot", "napcat")


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

    def start(self, kinds: list[str] | None = None) -> dict[str, object]:
        selected = self._normalize_kinds(kinds)
        with self._lock:
            if self._job["status"] == "running" and self._job["id"]:
                return copy.deepcopy(self._job)
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
                    {"kind": kind, "label": SETUP_LABELS[kind], "status": "queued", "progress": 0, "message": "等待执行"}
                    for kind in selected
                ],
            }
            self._task = asyncio.create_task(self._run(job_id, selected))
            return copy.deepcopy(self._job)

    @staticmethod
    def _normalize_kinds(kinds: list[str] | None) -> list[str]:
        values = [str(kind).lower() for kind in (kinds or [])]
        if "all" in values:
            values = list(SETUP_ORDER)
        unknown = [kind for kind in values if kind not in SETUP_ORDER]
        if unknown:
            raise ValueError(f"不支持的配置任务：{', '.join(unknown)}")
        return ["nonebot", *[kind for kind in SETUP_ORDER if kind != "nonebot" and kind in values]]

    def status(self, job_id: str | None = None) -> dict[str, object]:
        with self._lock:
            snapshot = copy.deepcopy(self._job)
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
            self._update_task(kind, "running", 0, f"正在准备 {SETUP_LABELS[kind]}…")
            if kind == "nonebot":
                if runtime_config.resource_status()["nonebot"]["valid"]:
                    self._update_task(kind, "succeeded", 100, "已检测到 NoneBot，跳过安装。")
                else:
                    self._prepare_nonebot()
                    self._update_task(kind, "succeeded", 100, "NoneBot 已创建并安装依赖。")
            elif kind == "napcat":
                current = runtime_config.resource_status()
                if current["napcat"]["valid"]:
                    self._update_task(kind, "succeeded", 100, "已检测到 NapCat 和 QQ，跳过下载。")
                elif current["napcat"].get("missing") == "qq":
                    raise RuntimeError("已找到 NapCat 启动器，但缺少 QQ.exe；请先安装 QQ，或选择包含 QQ.exe 的 NapCat 目录")
                else:
                    self._download_napcat(job_id)
                    self._update_task(kind, "succeeded", 100, "NapCat 已下载并配置。")

    def _download_napcat(self, job_id: str) -> None:
        self._update_task("napcat", "running", 5, "正在获取 NapCat 最新官方下载包…")
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
        extract_dir = SETUP_ROOT / f"napcat-{job_id}"
        try:
            expected_size = int(asset.get("size") or 0)
            self._download_file(str(asset["browser_download_url"]), archive, "NapCat", 10, 65, expected_size)
            if extract_dir.exists():
                shutil.rmtree(extract_dir)
            extract_dir.mkdir(parents=True)
            self._update_task("napcat", "running", 70, "正在解压 NapCat…")
            self._safe_extract(archive, extract_dir)
            target = runtime_config.PROGRAM_DIR / "NapCat"
            target.mkdir(parents=True, exist_ok=True)
            shutil.copytree(extract_dir, target, dirs_exist_ok=True)
            executables = list(target.rglob("NapCatWinBootMain.exe"))
            if not executables:
                raise RuntimeError("NapCat 压缩包解压后没有找到 NapCatWinBootMain.exe")
            if not list(target.rglob("QQ.exe")):
                raise RuntimeError("NapCat 官方包不包含 QQ.exe；请先安装 QQ，再选择包含 QQ.exe 和 NapCat 启动器的目录")
            runtime_config.set_resource_path("napcat", str(executables[0].parent))
        finally:
            archive.unlink(missing_ok=True)
            shutil.rmtree(extract_dir, ignore_errors=True)

    def _prepare_nonebot(self) -> None:
        target = runtime_config.PROGRAM_DIR / "NoneBot"
        target.mkdir(parents=True, exist_ok=True)
        self._update_task("nonebot", "running", 15, "正在创建 NoneBot 项目文件…")
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
        python = self._ensure_python()
        self._update_task("nonebot", "running", 55, "正在安装 NoneBot 和 OneBot 适配器…")
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
        self._update_task("nonebot", "running", 90, "NoneBot 依赖安装完成，正在保存资源配置…")

    def _ensure_python(self) -> Path:
        python = runtime_config.ROOT / ".venv" / "Scripts" / "python.exe"
        if python.exists():
            return python
        venv_dir = runtime_config.ROOT / ".venv"
        self._update_task("nonebot", "running", 30, "正在创建项目虚拟环境…")
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

    def _download_file(self, url: str, destination: Path, label: str, start: int, end: int, expected_size: int = 0) -> None:
        request = urllib.request.Request(url, headers={"User-Agent": "QQBot-Control-Panel"})
        with urllib.request.urlopen(request, timeout=60) as response, destination.open("wb") as output:  # noqa: S310 - URL comes from official API
            total = int(response.headers.get("Content-Length", "0") or 0) or expected_size
            received = 0
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                output.write(chunk)
                received += len(chunk)
                percent = start if not total else start + int((end - start) * received / total)
                self._update_task("napcat", "running", min(percent, end), f"正在下载 {label}… {received / 1024 / 1024:.1f} MB")

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

    def _update(self, **values: object) -> None:
        with self._lock:
            self._job.update(values)
