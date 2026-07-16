from __future__ import annotations

from contextlib import asynccontextmanager
import logging
import re
from typing import AsyncIterator
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

from backend.api.routes import router as api_router
from backend.config import API_HOST, API_PORT, DATABASE_FILE, EVENT_LOG_FILE, LEGACY_CONFIG_FILE, PROCESS_LOG_DIR
from backend.database.repository import BotRepository
from backend.database.stats_repository import MessageStatsRepository
from backend.domain.errors import DomainError
from backend.event.bus import EventBus
from backend.manager.bot_manager import BotManager
from backend.plugin.registry import PluginRegistry
from backend.service.bot_service import BotService
from backend.security.session import request_authorized
from backend.websocket.routes import router as websocket_router


_LOGGER = logging.getLogger(__name__)
_REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9._-]{8,80}$")


def _request_id(request: Request) -> str:
    return str(getattr(request.state, "request_id", "") or uuid4().hex)


def _error_response(request: Request, status_code: int, detail: str, code: str) -> JSONResponse:
    request_id = _request_id(request)
    return JSONResponse(
        status_code=status_code,
        content={"detail": detail, "code": code, "request_id": request_id},
        headers={"X-Request-ID": request_id},
    )


class RequestContextMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        candidate = request.headers.get("x-request-id", "")
        request.state.request_id = candidate if _REQUEST_ID_RE.fullmatch(candidate) else uuid4().hex
        response = await call_next(request)
        response.headers["X-Request-ID"] = request.state.request_id
        return response


class SessionAuthMiddleware(BaseHTTPMiddleware):
    """Require the desktop session token for every API except health checks."""

    async def dispatch(self, request: Request, call_next):
        if request.url.path.startswith("/api/") and request.url.path != "/api/health":
            if request.method != "OPTIONS" and not request_authorized(request.headers.get("authorization")):
                return _error_response(request, 401, "管理会话令牌无效或缺失", "session_unauthorized")
        return await call_next(request)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    repository = BotRepository(DATABASE_FILE, LEGACY_CONFIG_FILE)
    event_bus = EventBus(storage_path=EVENT_LOG_FILE)
    await event_bus.start()
    stats = MessageStatsRepository(DATABASE_FILE)
    stats.backfill_events(EVENT_LOG_FILE, [bot.to_dict() for bot in repository.list()], PROCESS_LOG_DIR)
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
        await event_bus.stop()


def create_app() -> FastAPI:
    application = FastAPI(
        title="QQ Bot Control Panel",
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    application.add_middleware(
        CORSMiddleware,
        allow_origins=["null", "http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:4173", "http://127.0.0.1:4173"],
        allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allow_headers=["Content-Type", "Authorization"],
    )

    @application.exception_handler(DomainError)
    async def domain_error_handler(_: Request, error: DomainError) -> JSONResponse:
        return _error_response(_, error.status_code, str(error), error.__class__.__name__.removesuffix("Error").lower())

    @application.exception_handler(HTTPException)
    async def http_error_handler(request: Request, error: HTTPException) -> JSONResponse:
        return _error_response(request, error.status_code, str(error.detail), f"http_{error.status_code}")

    @application.exception_handler(RequestValidationError)
    async def validation_error_handler(request: Request, error: RequestValidationError) -> JSONResponse:
        first = error.errors()[0] if error.errors() else {"msg": "请求参数无效"}
        return _error_response(request, 422, str(first.get("msg") or "请求参数无效"), "validation_error")

    @application.exception_handler(Exception)
    async def unexpected_error_handler(request: Request, error: Exception) -> JSONResponse:
        _LOGGER.exception("未处理的管理 API 异常 request_id=%s", _request_id(request), exc_info=error)
        return _error_response(request, 500, "管理服务发生内部错误", "internal_error")

    application.add_middleware(SessionAuthMiddleware)
    application.add_middleware(RequestContextMiddleware)
    application.include_router(api_router)
    application.include_router(websocket_router)
    return application


app = create_app()


if __name__ == "__main__":
    import uvicorn

    server = uvicorn.Server(uvicorn.Config(app, host=API_HOST, port=API_PORT))
    app.state.uvicorn_server = server
    server.run()
