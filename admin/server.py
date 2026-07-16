"""Managed backend entry point used by the desktop supervisor."""

from backend.main import app

__all__ = ["app"]


if __name__ == "__main__":
    import os
    import uvicorn

    server = uvicorn.Server(
        uvicorn.Config(
            app,
            host=os.getenv("QQ_CONSOLE_HOST", "127.0.0.1"),
            port=int(os.getenv("QQ_CONSOLE_PORT", "6700")),
        )
    )
    app.state.uvicorn_server = server
    server.run()

