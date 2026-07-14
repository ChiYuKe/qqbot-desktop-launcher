import os
import tempfile
import unittest
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path


SERVICE_PATH = Path(__file__).resolve().parents[1] / "program" / "NoneBot" / "plugins" / "access_control" / "service.py"
SERVICE_SPEC = spec_from_file_location("access_control_service", SERVICE_PATH)
if SERVICE_SPEC is None or SERVICE_SPEC.loader is None:
    raise RuntimeError("无法加载 access_control service.py")
service_module = module_from_spec(SERVICE_SPEC)
SERVICE_SPEC.loader.exec_module(service_module)
AccessControlService = service_module.AccessControlService


class AccessControlServiceTest(unittest.TestCase):
    def test_chat_settings_persist_and_reload(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            old_cwd = os.getcwd()
            try:
                os.chdir(temp_dir)
                service = AccessControlService()
                service.add_allow_group("138359583")
                service.set_chat_enabled("138359583", True)
                service.set_response_probability("138359583", 1.5)
                service.set_cooldown_seconds("138359583", -10)
                service.set_blocked_bot_user_ids("138359583", ["123", "123", " 456 "])

                reloaded = AccessControlService()
                settings = reloaded.get_chat_settings("138359583")

                self.assertTrue(reloaded.is_group_whitelisted("138359583"))
                self.assertTrue(settings["enabled"])
                self.assertEqual(settings["response_probability"], 1.0)
                self.assertEqual(settings["cooldown_seconds"], 0)
                self.assertEqual(settings["blocked_bot_user_ids"], ["123", "456"])
            finally:
                os.chdir(old_cwd)

    def test_invalid_model_is_normalized_to_default(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            old_cwd = os.getcwd()
            try:
                os.chdir(temp_dir)
                service = AccessControlService()
                service.add_allow_group("1")
                service._data["chat_settings_by_group"]["1"]["model"] = "bad-model"
                service._save()

                reloaded = AccessControlService()
                self.assertEqual(reloaded.get_chat_settings("1")["model"], "")
            finally:
                os.chdir(old_cwd)


if __name__ == "__main__":
    unittest.main()
