from __future__ import annotations

from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from backend.api.routes import router as api_router
from backend.config import API_HOST, API_PORT, DATABASE_FILE, EVENT_LOG_FILE, LEGACY_CONFIG_FILE
from backend.database.repository import BotRepository
from backend.database.stats_repository import MessageStatsRepository
from backend.domain.errors import DomainError
from backend.event.bus import EventBus
from backend.manager.bot_manager import BotManager
from backend.plugin.registry import PluginRegistry
from backend.service.bot_service import BotService
from backend.websocket.routes import router as websocket_router


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    repository = BotRepository(DATABASE_FILE, LEGACY_CONFIG_FILE)
    event_bus = EventBus(storage_path=EVENT_LOG_FILE)
    stats = MessageStatsRepository(DATABASE_FILE)
    stats.backfill_events(EVENT_LOG_FILE, [{"id": bot.id, "name": bot.name, "qq": bot.qq} for bot in repository.list()])
    manager = BotManager(repository, event_bus, stats)
    app.state.repository = repository
    app.state.event_bus = event_bus
    app.state.stats = stats
    app.state.bot_manager = manager
    app.state.bot_service = BotService(repository, manager, event_bus, stats)
    app.state.plugin_registry = PluginRegistry()
    manager.recover_external_logs()
    await event_bus.publish("INFO", "系统", f"管理 API 已启动，已加载 {len(repository.list())} 个 Bot")
    try:
        yield
    finally:
        await app.state.bot_service.shutdown()
        await manager.shutdown()


def create_app() -> FastAPI:
    application = FastAPI(title="QQ Bot Control Panel", lifespan=lifespan)
    application.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

    @application.exception_handler(DomainError)
    async def domain_error_handler(_: Request, error: DomainError) -> JSONResponse:
        return JSONResponse(status_code=error.status_code, content={"detail": str(error)})

    application.include_router(api_router)
    application.include_router(websocket_router)
    return application


app = create_app()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=API_HOST, port=API_PORT)
