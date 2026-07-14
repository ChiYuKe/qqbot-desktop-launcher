from __future__ import annotations

from fastapi import APIRouter, WebSocket, WebSocketDisconnect


router = APIRouter()


@router.websocket("/ws/events")
async def events_socket(websocket: WebSocket) -> None:
    await websocket.accept()
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

