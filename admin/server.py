"""Compatibility entry point for the layered backend.

Existing commands can continue to use ``uvicorn server:app`` from ``admin``.
The implementation now lives under ``backend/``.
"""

from backend.main import app

__all__ = ["app"]


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=6700)

