import json
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "admin"))

from backend.database.stats_repository import MessageStatsRepository  # noqa: E402


class MessageStatsRepositoryTest(unittest.TestCase):
    def test_backfill_migrates_old_totals_and_is_incremental(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database = root / "bots.db"
            events = root / "events.jsonl"
            bot = {"id": "cat", "name": "猫猫", "qq": "2685186725"}
            day = datetime.now().date().isoformat()
            old_events = [
                {"time": "10:00:00", "timestamp": f"{day}T10:00:00", "level": "INFO", "source": "猫猫", "message": "接收 <- 群聊 | 旧消息"},
                {"time": "10:01:00", "timestamp": f"{day}T10:01:00", "level": "INFO", "source": "猫猫", "message": "接收 <- 群聊 | 另一条旧消息"},
                {"time": "10:02:00", "timestamp": f"{day}T10:02:00", "level": "INFO", "source": "猫猫", "message": "发送 -> 群聊 | 旧回复"},
            ]
            events.write_text("".join(json.dumps(item, ensure_ascii=False) + "\n" for item in old_events), encoding="utf-8")

            repository = MessageStatsRepository(database)
            repository.record("cat", "received", "group")
            repository.record("cat", "received", "group")
            repository.record("cat", "sent", "group")
            self.assertEqual(repository.backfill_events(events, [bot]), 0)
            summary = repository.summary([type("Bot", (), bot)()])
            self.assertEqual(summary["periods"]["day"]["received"], 2)
            self.assertEqual(summary["periods"]["day"]["sent"], 1)

            new_event = {"time": "10:03:00", "timestamp": f"{day}T10:03:00", "level": "INFO", "source": "猫猫", "message": "接收 <- 群聊 | 新消息"}
            with events.open("a", encoding="utf-8") as stream:
                stream.write(json.dumps(new_event, ensure_ascii=False) + "\n")
            self.assertEqual(repository.backfill_events(events, [bot]), 1)
            self.assertEqual(repository.backfill_events(events, [bot]), 0)
            summary = repository.summary([type("Bot", (), bot)()])
            self.assertEqual(summary["periods"]["day"]["received"], 3)
            self.assertEqual(summary["periods"]["day"]["sent"], 1)

    def test_event_key_makes_live_record_idempotent(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repository = MessageStatsRepository(Path(directory) / "bots.db")
            key = "event-1"
            message = "发送 -> 群聊 | 回复"
            self.assertTrue(repository.record_from_log("cat", message, event_key=key))
            self.assertFalse(repository.record_from_log("cat", message, event_key=key))


if __name__ == "__main__":
    unittest.main()
