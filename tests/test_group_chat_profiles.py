import tempfile
import sys
import unittest
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path


PROFILES_PATH = Path(__file__).resolve().parents[1] / "program" / "NoneBot" / "plugins" / "group_chat" / "profiles.py"
sys.path.insert(0, str(PROFILES_PATH.parent))
PROFILES_SPEC = spec_from_file_location("group_chat_profiles", PROFILES_PATH)
if PROFILES_SPEC is None or PROFILES_SPEC.loader is None:
    raise RuntimeError("无法加载 group_chat profiles.py")
profiles_module = module_from_spec(PROFILES_SPEC)
PROFILES_SPEC.loader.exec_module(profiles_module)
MemberProfileStore = profiles_module.MemberProfileStore


class GroupChatProfilesTest(unittest.TestCase):
    def test_member_id_is_stable_and_group_scoped(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            store = MemberProfileStore(Path(temp_dir) / "profiles.json")

            first = store.member_id("group-a", "10001")
            second = store.member_id("group-a", "10001")
            other_group = store.member_id("group-b", "10001")

            self.assertEqual(first, second)
            self.assertNotEqual(first, other_group)

    def test_update_member_accumulates_profile(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "profiles.json"
            store = MemberProfileStore(path)

            first = store.update_member(
                group_id="1",
                user_id="10001",
                speaker="小明",
                role="群主",
                text="python 报错怎么修",
            )
            second = store.update_member(
                group_id="1",
                user_id="10001",
                speaker="明明",
                role="管理员",
                text="import 失败",
            )

            self.assertEqual(first["member_id"], second["member_id"])
            self.assertEqual(second["message_count"], 2)
            self.assertEqual(second["role"], "管理员")
            self.assertEqual(second["affinity"], 50)
            self.assertIn("小明", second["names"])
            self.assertIn("明明", second["names"])
            self.assertIn("python", second["recent_keywords"])
            self.assertIn("import", second["recent_keywords"])

            reloaded = MemberProfileStore(path)
            self.assertEqual(reloaded.get_member("1", "10001")["message_count"], 2)

    def test_affinity_can_be_set_adjusted_and_clamped(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            store = MemberProfileStore(Path(temp_dir) / "profiles.json")

            profile = store.set_affinity("1", "10001", 120)
            self.assertEqual(profile["affinity"], 100)
            self.assertEqual(store.affinity_reply_factor(profile), 1.2)

            profile = store.adjust_affinity("1", "10001", -90)
            self.assertEqual(profile["affinity"], 10)
            self.assertEqual(store.affinity_reply_factor(profile), 0.05)
            self.assertTrue(store.should_roast(profile))

            hint = store.format_profile_hint(profile)
            self.assertIn("好感度:10", hint)


if __name__ == "__main__":
    unittest.main()
