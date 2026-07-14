import asyncio
import tempfile
import unittest
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path


STORAGE_PATH = Path(__file__).resolve().parents[1] / "program" / "NoneBot" / "plugins" / "auto_learn" / "storage.py"
STORAGE_SPEC = spec_from_file_location("auto_learn_storage", STORAGE_PATH)
if STORAGE_SPEC is None or STORAGE_SPEC.loader is None:
    raise RuntimeError("无法加载 auto_learn storage.py")
storage = module_from_spec(STORAGE_SPEC)
STORAGE_SPEC.loader.exec_module(storage)
AutoLearnStore = storage.AutoLearnStore


class AutoLearnStorageTest(unittest.TestCase):
    def test_ignore_question_removes_learned_and_pending_rules(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = AutoLearnStore(tmp)
            try:
                asyncio.run(store.learn("你不是我兄弟", "典", "1", ds_review_func=None))
                asyncio.run(store.learn("你不是我兄弟", "典", "1", ds_review_func=None))
                asyncio.run(store.learn("你不是我兄弟吧", "绷不住了", "1", ds_review_func=None))

                self.assertEqual(store.stats("1")["learned_count"], 1)
                self.assertEqual(store.stats("1")["pending_count"], 1)

                removed = store.ignore_question("1", "你不是我兄弟")

                self.assertEqual(removed, {"learned": 1, "pending": 1})
                self.assertTrue(store.is_ignored("1", "你不是我兄弟"))
                self.assertIsNone(
                    asyncio.run(store.learn("你不是我兄弟", "又学回来了", "1", ds_review_func=None))
                )
                self.assertEqual(store.stats("1")["learned_count"], 0)
                self.assertEqual(store.stats("1")["pending_count"], 0)
            finally:
                store._conn.close()

    def test_shared_match_only_uses_rules_marked_shared(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = AutoLearnStore(tmp)
            try:
                asyncio.run(store.learn("共享问题", "共享答案", "source", ds_review_func=None))
                asyncio.run(store.learn("共享问题", "共享答案", "source", ds_review_func=None))
                asyncio.run(store.learn("私有问题", "私有答案", "private", ds_review_func=None))
                asyncio.run(store.learn("私有问题", "私有答案", "private", ds_review_func=None))

                store.enable_share("source")
                store.enable_share("target")

                self.assertEqual(store.match("共享问题", "target")["answer"], "共享答案")
                self.assertIsNone(store.match("私有问题", "target"))
            finally:
                store._conn.close()

    def test_image_only_answer_is_stored_as_matchable_answer(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = AutoLearnStore(tmp)
            try:
                self.assertIsNone(
                    asyncio.run(
                        store.learn("这张图", "", "1", images=["{IMG:abc123}"], ds_review_func=None)
                    )
                )
                result = asyncio.run(
                    store.learn("这张图", "", "1", images=["{IMG:abc123}"], ds_review_func=None)
                )

                self.assertIsNotNone(result)
                self.assertEqual(result["answer"], "{IMG:abc123}")
                self.assertEqual(store.match("这张图", "1")["answer"], "{IMG:abc123}")
            finally:
                store._conn.close()


if __name__ == "__main__":
    unittest.main()
