from __future__ import annotations

import hmac
import os


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
