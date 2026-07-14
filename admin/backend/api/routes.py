from __future__ import annotations

from typing import Any

import psutil
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from backend.domain.errors import DomainError
import backend.config as runtime_config


class BotCreatePayload(BaseModel):
    name: str = Field(min_length=1, max_length=40)
    qq: str = Field(min_length=5, max_length=20)
    port: int = Field(ge=1024, le=65535)
    napcat_port: int | None = Field(default=None, ge=1024, le=65535)
    password: str | None = Field(default=None, max_length=256)


class BotCommandPayload(BaseModel):
    command: str = Field(min_length=1, max_length=100)


class BotPasswordPayload(BaseModel):
    password: str | None = Field(default=None, max_length=256)


class BotPortPayload(BaseModel):
    port: int = Field(ge=1024, le=65535)


class ResourcePathPayload(BaseModel):
    path: str = Field(min_length=1, max_length=1000)


class StatsRecordPayload(BaseModel):
    bot_id: str = Field(min_length=1, max_length=80)
    direction: str = Field(pattern="^(received|sent)$")
    message_type: str = Field(default="unknown", pattern="^(group|private|media|group_media|private_media|command|unknown)$")


router = APIRouter(prefix="/api")


def service(request: Request):
    return request.app.state.bot_service


@router.get("/health")
async def health() -> dict[str, Any]:
    return {"ok": True, "cpu": psutil.cpu_percent(interval=None), "memory": psutil.virtual_memory().percent}


@router.get("/napcat")
async def napcat_status(request: Request) -> dict[str, Any]:
    return service(request).napcat_status()


@router.get("/runtime/resources")
async def runtime_resources(request: Request) -> dict[str, Any]:
    return service(request).resources()


@router.get("/stats")
async def message_stats(request: Request) -> dict[str, Any]:
    return request.app.state.stats.summary(request.app.state.repository.list())


@router.post("/stats/record")
async def record_message_stat(payload: StatsRecordPayload, request: Request) -> dict[str, bool]:
    if request.app.state.repository.get(payload.bot_id) is None:
        raise HTTPException(404, "Bot 不存在")
    request.app.state.stats.record(payload.bot_id, payload.direction, payload.message_type)
    return {"ok": True}


@router.put("/runtime/resources/{kind}")
async def update_runtime_resource(kind: str, payload: ResourcePathPayload, request: Request) -> dict[str, Any]:
    try:
        return service(request).update_resource(kind, payload.path)
    except ValueError as error:
        raise HTTPException(400, str(error)) from error


@router.post("/runtime/setup")
async def start_runtime_setup(request: Request) -> dict[str, Any]:
    return service(request).start_resource_setup()


@router.get("/runtime/setup/{job_id}")
async def runtime_setup_status(job_id: str, request: Request) -> dict[str, Any]:
    return service(request).resource_setup_status(job_id)


@router.get("/napcat/qrcode")
async def napcat_qrcode() -> FileResponse:
    candidates = list(runtime_config.NAPCAT_DIR.rglob("qrcode.png")) if runtime_config.NAPCAT_DIR.exists() else []
    if not candidates:
        raise HTTPException(status_code=404, detail="当前没有可用的 NapCat 登录二维码")
    latest = max(candidates, key=lambda item: item.stat().st_mtime)
    return FileResponse(latest, media_type="image/png", headers={"Cache-Control": "no-store"})


@router.get("/bots")
async def list_bots(request: Request) -> list[dict[str, Any]]:
    return service(request).list_bots()


@router.post("/bots")
async def create_bot(payload: BotCreatePayload, request: Request) -> dict[str, Any]:
    try:
        bot = service(request).create(payload.name, payload.qq, payload.port, payload.password, payload.napcat_port)
        await request.app.state.event_bus.publish("INFO", "系统", f"创建了 Bot「{bot.name}」，OneBot 端口 {bot.port}，NapCat WebUI 端口 {bot.napcat_port}")
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


@router.get("/bots/{bot_id}/password")
async def reveal_bot_password(bot_id: str, request: Request) -> dict[str, str]:
    try:
        return {"password": service(request).get_password(bot_id)}
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
    repository = request.app.state.repository
    manager = request.app.state.bot_manager
    bots = repository.list()
    return {
        "cpu": psutil.cpu_percent(interval=None),
        "memory": psutil.virtual_memory().percent,
        "memory_total": psutil.virtual_memory().total,
        "running_bots": sum(manager.is_running(bot.id) for bot in bots),
    }


@router.get("/logs")
async def list_logs(request: Request) -> list[dict[str, Any]]:
    return request.app.state.event_bus.history()


@router.post("/logs/clear")
async def clear_logs(request: Request) -> dict[str, bool]:
    request.app.state.event_bus.clear()
    return {"ok": True}
