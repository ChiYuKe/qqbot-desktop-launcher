"""Runtime compatibility hooks injected into managed Python processes."""

from __future__ import annotations

import os


def _full_message_description(event) -> str:
    message = event.original_message
    try:
        rich_message = message.to_rich_text(truncate=None)
    except TypeError:
        rich_message = str(message)

    from nonebot.adapters.onebot.utils import highlight_rich_message

    highlighted = "".join(highlight_rich_message(repr(rich_message)))
    if getattr(event, "message_type", "") == "group":
        return f"Message {event.message_id} from {event.user_id}@[群:{event.group_id}] {highlighted}"
    return f"Message {event.message_id} from {event.user_id} {highlighted}"


def _install_nonebot_message_logging() -> None:
    try:
        from nonebot.adapters.onebot.v11 import GroupMessageEvent, PrivateMessageEvent
    except Exception:
        return

    GroupMessageEvent.get_event_description = _full_message_description
    PrivateMessageEvent.get_event_description = _full_message_description


def _astrbot_image_token(component) -> str | None:
    candidates = [getattr(component, "url", None), getattr(component, "file", None)]
    url = next((str(value).strip() for value in candidates if str(value or "").strip().lower().startswith(("http://", "https://"))), "")
    if not url:
        return None
    file_name = str(getattr(component, "file", "") or "qq-image").strip()
    return f"[image:summary=图片,file={file_name},url={url}]"


def _install_astrbot_message_logging() -> None:
    if not os.environ.get("ASTRBOT_ROOT"):
        return
    try:
        from astrbot.core.message.components import Image
        from astrbot.core.platform.astr_message_event import AstrMessageEvent
    except Exception:
        return
    if getattr(AstrMessageEvent, "_qq_console_media_hook", False):
        return

    original_outline = AstrMessageEvent._outline_chain

    def outline_with_media(self, chain) -> str:
        if not chain:
            return ""
        parts = []
        for component in chain:
            if isinstance(component, Image):
                parts.append(_astrbot_image_token(component) or "[图片]")
                continue
            try:
                value = original_outline(self, [component]).strip()
            except Exception:
                value = f"[{getattr(component, 'type', '消息')}]"
            if value:
                parts.append(value)
        return " ".join(parts)

    AstrMessageEvent._outline_chain = outline_with_media
    AstrMessageEvent._qq_console_media_hook = True


try:
    _install_nonebot_message_logging()
    _install_astrbot_message_logging()
except Exception:
    # A compatibility hook must never prevent a user's bot from starting.
    pass
