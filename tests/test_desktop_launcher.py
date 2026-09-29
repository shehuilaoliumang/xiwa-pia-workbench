"""Desktop routing tests without opening daily data or real UI."""
from pathlib import Path
import os
import tempfile
import unittest
from unittest.mock import patch
import run

class DesktopLauncherTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.data = self.root / "资料 含空格"
        self.data.mkdir()
        self.root_patch = patch.object(run, "ROOT", self.root)
        self.root_patch.start()
    def tearDown(self):
        self.root_patch.stop()
        self.temporary.cleanup()
    def add_desktop(self):
        (self.root / "desktop/runtime").mkdir(parents=True)
        (self.root / "desktop/runtime/electron.exe").touch()
        (self.root / "desktop/main.cjs").touch()
    @patch("run.webbrowser.open")
    @patch("run.subprocess.Popen")
    def test_desktop_launch_uses_local_arguments_and_sanitized_environment(self, launch, browser):
        self.add_desktop()
        with patch.dict(os.environ, {"ELECTRON_RUN_AS_NODE":"1", "NODE_OPTIONS":"--inspect=9229"}):
            self.assertIs(run.open_interface("http://127.0.0.1:8930/", self.data), launch.return_value)
        args, kwargs = launch.call_args
        self.assertEqual(args[0][0], str(self.root / "desktop/runtime/electron.exe"))
        self.assertEqual(args[0][-2:], ["--url=http://127.0.0.1:8930/", "--data-dir=" + str(self.data)])
        self.assertNotIn("ELECTRON_RUN_AS_NODE", kwargs["env"])
        self.assertNotIn("NODE_OPTIONS", kwargs["env"])
        self.assertFalse(kwargs.get("shell", False))
        browser.assert_not_called()
    @patch("run.webbrowser.open")
    @patch("run.subprocess.Popen")
    def test_explicit_browser_and_missing_component_fallback(self, launch, browser):
        run.open_interface("http://127.0.0.1:8930/", self.data)
        self.add_desktop()
        run.open_interface("http://127.0.0.1:8930/", self.data, browser=True)
        launch.assert_not_called()
        self.assertEqual(browser.call_count, 2)
    @patch("run.webbrowser.open")
    @patch("run.subprocess.Popen", side_effect=OSError("unavailable"))
    def test_launch_failure_keeps_service_usable_in_browser(self, launch, browser):
        self.add_desktop()
        self.assertIsNone(run.open_interface("http://127.0.0.1:8930/", self.data))
        browser.assert_called_once_with("http://127.0.0.1:8930/")

if __name__ == "__main__":
    unittest.main()
