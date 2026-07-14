import unittest
from unittest.mock import patch
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

RULES_PATH = Path(__file__).resolve().parents[1] / "program" / "NoneBot" / "plugins" / "group_chat" / "rules.py"
RULES_SPEC = spec_from_file_location("group_chat_rules", RULES_PATH)
if RULES_SPEC is None or RULES_SPEC.loader is None:
    raise RuntimeError("无法加载 group_chat rules.py")
rules = module_from_spec(RULES_SPEC)
RULES_SPEC.loader.exec_module(rules)


class GroupChatRulesTest(unittest.TestCase):
    def test_configured_bot_user_ids_from_env(self) -> None:
        with patch.dict("os.environ", {"GROUP_CHAT_BOT_USER_IDS": "123, 456，789"}, clear=False):
            self.assertEqual(rules.configured_bot_user_ids(), {"123", "456", "789"})

    def test_repeat_request_detection(self) -> None:
        self.assertTrue(rules.is_repeat_request("复述一遍这句话"))
        self.assertTrue(rules.is_repeat_request("将引用的这段话再发一遍"))
        self.assertTrue(rules.is_repeat_request("原话照着发"))
        self.assertFalse(rules.is_repeat_request("你怎么看这个问题"))

    def test_should_consider_auto_reply_filters_low_value_messages(self) -> None:
        self.assertFalse(rules.should_consider_auto_reply("/help"))
        self.assertFalse(rules.should_consider_auto_reply("https://example.com"))
        self.assertFalse(rules.should_consider_auto_reply("？？？"))
        self.assertFalse(rules.should_consider_auto_reply("草"))
        self.assertTrue(rules.should_consider_auto_reply("这个怎么修"))
        self.assertTrue(rules.should_consider_auto_reply("猫猫在吗"))

    def test_is_addressed_by_text_detects_natural_calls(self) -> None:
        self.assertTrue(rules.is_addressed_by_text("猫猫你怎么看"))
        self.assertTrue(rules.is_addressed_by_text("帮我看看这个报错"))
        self.assertTrue(rules.is_addressed_by_text("这个你觉得呢"))
        self.assertFalse(rules.is_addressed_by_text("大家怎么看"))

    def test_select_context_messages_keeps_related_and_latest_messages(self) -> None:
        messages = [
            {"message_id": "1", "user_id": "1", "text": "今晚吃火锅", "is_bot_like": False},
            {"message_id": "2", "user_id": "2", "text": "python 报错怎么修", "is_bot_like": False},
            {"message_id": "3", "user_id": "3", "text": "狗子喵呜", "is_bot_like": True},
            {"message_id": "4", "user_id": "4", "text": "这个 python import 报错你怎么看", "is_bot_like": False},
        ]

        selected = rules.select_context_messages(
            messages,
            current_text="这个 python import 报错你怎么看",
            limit=3,
        )
        selected_texts = [item["text"] for item in selected]

        self.assertIn("python 报错怎么修", selected_texts)
        self.assertNotIn("狗子喵呜", selected_texts)
        self.assertEqual(selected[-1]["message_id"], "4")

    def test_find_repeat_target_prefers_quoted_text(self) -> None:
        messages = [
            {
                "message_id": "1",
                "user_id": "100",
                "text": "普通消息",
                "quoted_texts": [],
                "is_bot_like": False,
            },
            {
                "message_id": "2",
                "user_id": "200",
                "text": "[引用消息:1 内容:要复述的原文] 复述一遍",
                "quoted_texts": ["要复述的原文"],
                "is_bot_like": False,
            },
        ]

        self.assertEqual(
            rules.find_repeat_target("复述引用的那句话", messages, current_user_id="200"),
            "要复述的原文",
        )

    def test_find_repeat_target_skips_bot_like_messages(self) -> None:
        messages = [
            {"message_id": "1", "user_id": "300", "text": "真人上一句", "is_bot_like": False},
            {"message_id": "2", "user_id": "bot", "text": "喵呜互夸", "is_bot_like": True},
            {"message_id": "3", "user_id": "200", "text": "复述上一句", "is_bot_like": False},
        ]

        self.assertEqual(
            rules.find_repeat_target("复述上一句", messages, current_user_id="200"),
            "真人上一句",
        )

    def test_likely_bot_message_by_config_name_and_text(self) -> None:
        self.assertTrue(
            rules.is_likely_bot_message(
                user_id="123",
                self_id="999",
                speaker_name="普通群友",
                text="你好",
                bot_user_ids={"123"},
            )
        )
        self.assertTrue(
            rules.is_likely_bot_message(
                user_id="124",
                self_id="999",
                speaker_name="狗子",
                text="你好",
                bot_user_ids=set(),
            )
        )
        self.assertTrue(
            rules.is_likely_bot_message(
                user_id="125",
                self_id="999",
                speaker_name="普通群友",
                text="喵呜~被管理员大人摸头了",
                bot_user_ids=set(),
            )
        )
        self.assertFalse(
            rules.is_likely_bot_message(
                user_id="126",
                self_id="999",
                speaker_name="小明",
                text="这个报错怎么修",
                bot_user_ids=set(),
            )
        )

    def test_bot_loop_risk_requires_two_bot_like_messages_in_window(self) -> None:
        self.assertFalse(
            rules.is_bot_loop_risk(
                [
                    {"is_bot_like": False},
                    {"is_bot_like": True},
                    {"is_bot_like": False},
                    {"is_bot_like": False},
                ]
            )
        )

    def test_clean_group_reply_removes_ai_and_markdown_noise(self) -> None:
        reply = """
        # 回答
        作为一个AI语言模型，我是群里的猫娘「猫猫」，这个问题可以这样看。
        - 第一，先别急。
        ```python
        print("too much")
        ```
        """

        cleaned = rules.clean_group_reply(reply)

        self.assertNotIn("AI语言模型", cleaned)
        self.assertNotIn("```", cleaned)
        self.assertNotIn("#", cleaned)
        self.assertIn("这个问题可以这样看", cleaned)

    def test_clean_group_reply_limits_length(self) -> None:
        cleaned = rules.clean_group_reply("这是一句很长的话" * 40, max_chars=30)

        self.assertLessEqual(len(cleaned), 33)
        self.assertTrue(cleaned.endswith("..."))
        self.assertTrue(
            rules.is_bot_loop_risk(
                [
                    {"is_bot_like": True},
                    {"is_bot_like": False},
                    {"is_bot_like": True},
                    {"is_bot_like": False},
                ]
            )
        )


if __name__ == "__main__":
    unittest.main()
