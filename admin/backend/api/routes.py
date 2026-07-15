from __future__ import annotations

import asyncio
import base64
import hashlib
import mimetypes
import re
import sqlite3
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, Request as UrlRequest, build_opener
from typing import Any

import psutil
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field

from backend.domain.errors import DomainError
from backend.security.session import create_websocket_ticket
import backend.config as runtime_config


class BotCreatePayload(BaseModel):
    name: str = Field(min_length=1, max_length=40)
    qq: str = Field(min_length=5, max_length=20)
    port: int = Field(ge=1024, le=65535)
    framework: str = Field(default="nonebot", pattern="^(nonebot|astrbot)$")
    napcat_port: int | None = Field(default=None, ge=1024, le=65535)
    password: str | None = Field(default=None, max_length=256)


class BotCommandPayload(BaseModel):
    command: str = Field(min_length=1, max_length=100)


class BotPasswordPayload(BaseModel):
    password: str | None = Field(default=None, max_length=256)


class BotPortPayload(BaseModel):
    port: int = Field(ge=1024, le=65535)


class BotFrameworkPayload(BaseModel):
    framework: str = Field(pattern="^(nonebot|astrbot)$")


class ResourcePathPayload(BaseModel):
    path: str = Field(min_length=1, max_length=1000)


class ResourceSetupPayload(BaseModel):
    kinds: list[str] = Field(default_factory=lambda: ["nonebot"])


class PluginTogglePayload(BaseModel):
    enabled: bool


class StatsRecordPayload(BaseModel):
    bot_id: str = Field(min_length=1, max_length=80)
    direction: str = Field(pattern="^(received|sent)$")
    message_type: str = Field(default="unknown", pattern="^(group|private|media|group_media|private_media|command|unknown)$")


router = APIRouter(prefix="/api")
_MEDIA_HOSTS = {"multimedia.nt.qq.com.cn", "gchat.qpic.cn", "c2cpicdw.qpic.cn"}
_MAX_MEDIA_BYTES = 20 * 1024 * 1024
API_PROTOCOL_VERSION = 4


def service(request: Request):
    return request.app.state.bot_service


@router.get("/health")
async def health() -> dict[str, Any]:
    return {
        "ok": True,
        "api_version": API_PROTOCOL_VERSION,
        "cpu": psutil.cpu_percent(interval=None),
        "memory": psutil.virtual_memory().percent,
    }


@router.post("/ws/ticket")
async def websocket_ticket() -> dict[str, str]:
    return {"ticket": create_websocket_ticket()}


@router.get("/napcat")
async def napcat_status(request: Request) -> dict[str, Any]:
    return await asyncio.to_thread(service(request).napcat_status)


@router.get("/runtime/resources")
async def runtime_resources(request: Request) -> dict[str, Any]:
    return await asyncio.to_thread(service(request).resources)


@router.get("/stats")
async def message_stats(request: Request) -> dict[str, Any]:
    repository = request.app.state.repository
    stats = request.app.state.stats
    bots = await asyncio.to_thread(repository.list)
    return await asyncio.to_thread(stats.summary, bots)


@router.post("/stats/record")
async def record_message_stat(payload: StatsRecordPayload, request: Request) -> dict[str, bool]:
    if request.app.state.repository.get(payload.bot_id) is None:
        raise HTTPException(404, "Bot 不存在")
    await asyncio.to_thread(request.app.state.stats.record, payload.bot_id, payload.direction, payload.message_type)
    return {"ok": True}


@router.put("/runtime/resources/{kind}")
async def update_runtime_resource(kind: str, payload: ResourcePathPayload, request: Request) -> dict[str, Any]:
    try:
        return service(request).update_resource(kind, payload.path)
    except ValueError as error:
        raise HTTPException(400, str(error)) from error


@router.post("/runtime/setup")
async def start_runtime_setup(request: Request, payload: ResourceSetupPayload | None = None) -> dict[str, Any]:
    try:
        return service(request).start_resource_setup(payload.kinds if payload else ["nonebot"])
    except ValueError as error:
        raise HTTPException(400, str(error)) from error


@router.get("/runtime/setup/installer-log")
async def runtime_setup_installer_log() -> FileResponse:
    log_path = runtime_config.PROCESS_LOG_DIR / "napcat-installer.log"
    if not log_path.is_file():
        raise HTTPException(404, "还没有 NapCatInstaller.exe 日志")
    return FileResponse(log_path, media_type="text/plain; charset=gb18030", filename="napcat-installer.log")


@router.get("/runtime/setup/{job_id}")
async def runtime_setup_status(job_id: str, request: Request) -> dict[str, Any]:
    return service(request).resource_setup_status(job_id)


@router.post("/internal/shutdown")
async def request_shutdown(request: Request) -> dict[str, bool]:
    server = getattr(request.app.state, "uvicorn_server", None)
    if server is None:
        raise HTTPException(503, "当前管理服务不支持优雅关闭")
    server.should_exit = True
    return {"ok": True}


@router.get("/plugins")
async def list_plugins(request: Request) -> dict[str, Any]:
    return await asyncio.to_thread(request.app.state.plugin_registry.snapshot)


@router.put("/plugins/{plugin_id}")
async def update_plugin(plugin_id: str, payload: PluginTogglePayload, request: Request) -> dict[str, Any]:
    try:
        result = request.app.state.plugin_registry.set_enabled(plugin_id, payload.enabled)
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    action = "启用" if payload.enabled else "停用"
    await request.app.state.event_bus.publish("INFO", "系统", f"已{action} NoneBot 插件「{plugin_id}」，重启 Bot 后生效")
    return result


@router.get("/napcat/qrcode")
async def napcat_qrcode() -> FileResponse:
    candidates = list(runtime_config.NAPCAT_DIR.rglob("qrcode.png")) if runtime_config.NAPCAT_DIR.exists() else []
    if not candidates:
        raise HTTPException(status_code=404, detail="当前没有可用的 NapCat 登录二维码")
    latest = max(candidates, key=lambda item: item.stat().st_mtime)
    return FileResponse(latest, media_type="image/png", headers={"Cache-Control": "no-store"})


def _safe_media_filename(value: str) -> str:
    filename = re.sub(r"[^A-Za-z0-9._-]+", "_", value or "qq-image").strip("._")
    return (filename or "qq-image")[:120]


def _is_allowed_media_url(value: str) -> bool:
    try:
        parsed = urlparse(value)
        hostname = (parsed.hostname or "").lower().rstrip(".")
        return parsed.scheme.lower() == "https" and hostname in _MEDIA_HOSTS and parsed.port in (None, 443)
    except ValueError:
        return False


class _SafeMediaRedirectHandler(HTTPRedirectHandler):
    def redirect_request(self, request, file, code, message, headers, newurl):
        if not _is_allowed_media_url(newurl):
            raise URLError("图片地址重定向到了不受信任的域名")
        return super().redirect_request(request, file, code, message, headers, newurl)


def _download_media(url: str) -> tuple[bytes, str]:
    request = UrlRequest(url, headers={"User-Agent": "QQBotControlPanel/1.0"})
    opener = build_opener(_SafeMediaRedirectHandler)
    with opener.open(request, timeout=20) as response:  # noqa: S310 - host is validated before this call
        content_length = response.headers.get("Content-Length")
        if content_length and int(content_length) > _MAX_MEDIA_BYTES:
            raise ValueError("图片文件超过 20 MB，无法保存")
        data = response.read(_MAX_MEDIA_BYTES + 1)
        if len(data) > _MAX_MEDIA_BYTES:
            raise ValueError("图片文件超过 20 MB，无法保存")
        media_type = response.headers.get_content_type() or "application/octet-stream"
    return data, media_type


def _read_cached_media(filename: str) -> tuple[bytes, str] | None:
    database = runtime_config.NONEBOT_DIR / "data" / "auto_learn" / "rules.db"
    if not database.exists() or not filename:
        return None
    media_hash = "{IMG:" + hashlib.md5(filename.encode("utf-8")).hexdigest()[:10] + "}"
    try:
        with sqlite3.connect(database, timeout=2) as connection:
            row = connection.execute(
                "SELECT data_base64 FROM image_cache WHERE media_hash = ?",
                (media_hash,),
            ).fetchone()
    except (OSError, sqlite3.Error):
        return None
    if not row or not row[0]:
        return None
    try:
        data = base64.b64decode(str(row[0]), validate=True)
    except (ValueError, TypeError):
        return None
    media_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
    return data, media_type


@router.get("/media/download")
async def media_download(url: str, filename: str = "qq-image") -> Response:
    if not _is_allowed_media_url(url):
        raise HTTPException(status_code=400, detail="只允许保存 QQ 图片链接")
    try:
        data, media_type = await asyncio.to_thread(_download_media, url)
    except HTTPError as error:
        raise HTTPException(status_code=502, detail=f"图片服务器返回 HTTP {error.code}") from error
    except (URLError, OSError, ValueError, TypeError) as error:
        raise HTTPException(status_code=502, detail=f"图片下载失败：{error}") from error
    safe_filename = _safe_media_filename(filename)
    return Response(
        content=data,
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{safe_filename}"'},
    )


@router.get("/media/cache")
async def media_cache(file: str, download: bool = False) -> Response:
    cached = await asyncio.to_thread(_read_cached_media, file)
    if cached is None:
        raise HTTPException(status_code=404, detail="本地没有找到这张图片的缓存")
    data, media_type = cached
    headers = {"Cache-Control": "private, max-age=3600"}
    if download:
        headers["Content-Disposition"] = f'attachment; filename="{_safe_media_filename(file)}"'
    return Response(content=data, media_type=media_type, headers=headers)


@router.get("/bots")
async def list_bots(request: Request) -> list[dict[str, Any]]:
    return await asyncio.to_thread(service(request).list_bots)


@router.get("/operations/{operation_id}")
async def operation_status(operation_id: str, request: Request) -> dict[str, Any]:
    operation = request.app.state.bot_manager.operation(operation_id)
    if operation is None:
        raise HTTPException(404, "操作不存在或已过期")
    return operation


@router.post("/bots")
async def create_bot(payload: BotCreatePayload, request: Request) -> dict[str, Any]:
    try:
        bot = service(request).create(payload.name, payload.qq, payload.port, payload.password, payload.napcat_port, payload.framework)
        await request.app.state.event_bus.publish("INFO", "系统", f"创建了 Bot「{bot.name}」，NapCat WebUI 端口 {bot.napcat_port}，OneBot 端口 {bot.port}")
        return {"ok": True, "id": bot.id}
    except DomainError as error:
        raise HTTPException(error.status_code, str(error)) from error
    except ValueError as error:
        raise HTTPException(400, str(error)) from error


@router.delete("/bots/{bot_id}")
async def delete_bot(bot_id: str, request: Request) -> dict[str, bool]:
    try:
        await service(request).delete(bot_id)
        return {"ok": True}
    except DomainError as error:
        raise HTTPException(error.status_code, str(error)) from error


@router.post("/bots/{bot_id}/command")
async def bot_command(bot_id: str, payload: BotCommandPayload, request: Request) -> dict[str, Any]:
    try:
        return await service(request).command(bot_id, payload.command)
    except DomainError as error:
        raise HTTPException(error.status_code, str(error)) from error
    except ValueError as error:
        raise HTTPException(400, str(error)) from error


@router.put("/bots/{bot_id}/password")
async def update_bot_password(bot_id: str, payload: BotPasswordPayload, request: Request) -> dict[str, bool]:
    try:
        await service(request).update_password(bot_id, payload.password)
        return {"ok": True}
    except DomainError as error:
        raise HTTPException(error.status_code, str(error)) from error
    except ValueError as error:
        raise HTTPException(400, str(error)) from error


@router.put("/bots/{bot_id}/port")
async def update_bot_port(bot_id: str, payload: BotPortPayload, request: Request) -> dict[str, bool]:
    try:
        await service(request).update_port(bot_id, payload.port)
        return {"ok": True}
    except DomainError as error:
        raise HTTPException(error.status_code, str(error)) from error
    except ValueError as error:
        raise HTTPException(400, str(error)) from error


@router.put("/bots/{bot_id}/framework")
async def update_bot_framework(bot_id: str, payload: BotFrameworkPayload, request: Request) -> dict[str, bool]:
    try:
        await service(request).update_framework(bot_id, payload.framework)
        return {"ok": True}
    except DomainError as error:
        raise HTTPException(error.status_code, str(error)) from error
    except ValueError as error:
        raise HTTPException(400, str(error)) from error


@router.put("/bots/{bot_id}/napcat-port")
async def update_bot_napcat_port(bot_id: str, payload: BotPortPayload, request: Request) -> dict[str, bool]:
    try:
        await service(request).update_napcat_port(bot_id, payload.port)
        return {"ok": True}
    except DomainError as error:
        raise HTTPException(error.status_code, str(error)) from error
    except ValueError as error:
        raise HTTPException(400, str(error)) from error


@router.post("/bots/{bot_id}/{action}")
async def bot_action(bot_id: str, action: str, request: Request) -> dict[str, Any]:
    try:
        return await service(request).action(bot_id, action)
    except DomainError as error:
        raise HTTPException(error.status_code, str(error)) from error
    except ValueError as error:
        raise HTTPException(400, str(error)) from error


@router.get("/system")
async def system_info(request: Request) -> dict[str, Any]:
    snapshots = await asyncio.to_thread(request.app.state.bot_manager.list)
    return {
        "cpu": psutil.cpu_percent(interval=None),
        "memory": psutil.virtual_memory().percent,
        "memory_total": psutil.virtual_memory().total,
        "running_bots": sum(item["status"] in {"running", "login_required"} for item in snapshots),
    }


@router.get("/logs")
async def list_logs(request: Request) -> list[dict[str, Any]]:
    return request.app.state.event_bus.history()


@router.post("/logs/clear")
async def clear_logs(request: Request) -> dict[str, bool]:
    await request.app.state.event_bus.clear()
    return {"ok": True}
