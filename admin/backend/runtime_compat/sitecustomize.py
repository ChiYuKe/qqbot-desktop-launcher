"""Runtime compatibility hooks injected into managed Python processes."""

from __future__ import annotations


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


try:
    _install_nonebot_message_logging()
except Exception:
    # A compatibility hook must never prevent a user's bot from starting.
    pass
