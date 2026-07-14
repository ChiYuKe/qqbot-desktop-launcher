from __future__ import annotations

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from backend.security.session import token_matches


router = APIRouter()


@router.websocket("/ws/events")
async def events_socket(websocket: WebSocket) -> None:
    protocols = list(websocket.scope.get("subprotocols", []))
    session_protocol = next((protocol for protocol in protocols if token_matches(protocol)), None)
    if session_protocol is None:
        await websocket.close(code=1008, reason="管理会话令牌无效或缺失")
        return
    await websocket.accept(subprotocol=session_protocol)
    bus = websocket.app.state.event_bus
    queue = bus.subscribe()
    try:
        await websocket.send_json({"type": "snapshot", "logs": bus.history()})
        while True:
            event = await queue.get()
            await websocket.send_json({"type": "event", "data": event})
    except WebSocketDisconnect:
        pass
    finally:
        bus.unsubscribe(queue)

