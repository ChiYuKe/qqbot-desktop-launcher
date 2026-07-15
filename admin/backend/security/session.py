from __future__ import annotations

import hmac
import os
import secrets
import time


_WEBSOCKET_TICKETS: dict[str, float] = {}
_WEBSOCKET_TICKET_TTL = 30.0


SESSION_TOKEN_ENV = "QQ_CONSOLE_TOKEN"


def configured_token() -> str:
    return os.getenv(SESSION_TOKEN_ENV, "").strip()


def token_matches(candidate: str | None) -> bool:
    expected = configured_token()
    return bool(expected and candidate and hmac.compare_digest(candidate, expected))


def bearer_token(value: str | None) -> str:
    if not value:
        return ""
    scheme, separator, token = value.partition(" ")
    return token.strip() if separator and scheme.lower() == "bearer" else ""


def request_authorized(authorization: str | None) -> bool:
    return token_matches(bearer_token(authorization))


def create_websocket_ticket() -> str:
    now = time.monotonic()
    expired = [ticket for ticket, expires_at in _WEBSOCKET_TICKETS.items() if expires_at <= now]
    for ticket in expired:
        _WEBSOCKET_TICKETS.pop(ticket, None)
    ticket = secrets.token_urlsafe(24)
    _WEBSOCKET_TICKETS[ticket] = now + _WEBSOCKET_TICKET_TTL
    return ticket


def consume_websocket_ticket(ticket: str | None) -> bool:
    if not ticket:
        return False
    expires_at = _WEBSOCKET_TICKETS.pop(ticket, None)
    return expires_at is not None and expires_at > time.monotonic()
