from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class ApiModel(BaseModel):
    model_config = ConfigDict(extra="allow")


class ErrorResponse(ApiModel):
    detail: str
    code: str
    request_id: str


class HealthResponse(ApiModel):
    ok: bool = True
    api_version: int
    cpu: float
    memory: float


class SessionResponse(ApiModel):
    ok: bool = True


class WebSocketTicketResponse(ApiModel):
    ticket: str


class DiagnosticCheck(ApiModel):
    id: str
    label: str
    status: Literal["pass", "warn", "fail"]
    message: str
    details: dict[str, Any] = Field(default_factory=dict)


class DiagnosticsResponse(ApiModel):
    status: Literal["healthy", "degraded", "unhealthy"]
    generated_at: str
    versions: dict[str, str]
    paths: dict[str, str]
    database: dict[str, Any]
    checks: list[DiagnosticCheck]

