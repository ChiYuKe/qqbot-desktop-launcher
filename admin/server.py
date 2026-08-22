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
            # 优雅关闭时最多等 5 秒让存量连接收尾，避免个别挂住的
            # WebSocket 拖住整个停机流程（Bot 进程的终止/保留不受影响）。
            timeout_graceful_shutdown=5,
        )
    )
    app.state.uvicorn_server = server
    server.run()

