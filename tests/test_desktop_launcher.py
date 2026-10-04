"""Desktop routing tests without opening daily data or real UI."""
from pathlib import Path
import os
import tempfile
import unittest
from unittest.mock import Mock, patch
import run


def alive_process():
    """A stand-in for a desktop host that keeps running."""
    process = Mock()
    process.poll.return_value = None
    return process


def dead_process(code=0):
    """A stand-in for a desktop host that exits immediately."""
    process = Mock()
    process.poll.return_value = code
    return process


class DesktopLauncherTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.data = self.root / "资料 含空格"
        self.data.mkdir()
        self.root_patch = patch.object(run, "ROOT", self.root)
        self.root_patch.start()
        # 启动宽限期在测试里设为 0，避免真的等待；存活判定由 mock 的 poll() 决定。
        self.grace_patch = patch.object(run, "DESKTOP_STARTUP_GRACE_SECONDS", 0)
        self.grace_patch.start()
    def tearDown(self):
        self.grace_patch.stop()
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
        launch.return_value = alive_process()
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
    @patch("run.webbrowser.open")
    @patch("run.subprocess.Popen")
    def test_desktop_host_that_exits_immediately_retries_with_compatibility_flags(self, launch, browser):
        """部分电脑无法初始化 Chromium 沙箱，Electron 会无声退出；必须重试一次。"""
        self.add_desktop()
        second = alive_process()
        launch.side_effect = [dead_process(), second]
        with patch.object(run, "DESKTOP_SANDBOX_RETRY_ARGS", ["--no-sandbox"]):
            self.assertIs(run.open_interface("http://127.0.0.1:8930/", self.data), second)
        self.assertEqual(launch.call_count, 2)
        self.assertNotIn("--no-sandbox", launch.call_args_list[0][0][0])
        self.assertIn("--no-sandbox", launch.call_args_list[1][0][0])
        browser.assert_not_called()
    @patch("run.webbrowser.open")
    @patch("run.subprocess.Popen")
    def test_desktop_host_that_keeps_dying_falls_back_to_browser(self, launch, browser):
        """两次都起不来时必须退回浏览器版，保证界面一定能打开。"""
        self.add_desktop()
        launch.side_effect = [dead_process(), dead_process()]
        with patch.object(run, "DESKTOP_SANDBOX_RETRY_ARGS", ["--no-sandbox"]):
            self.assertIsNone(run.open_interface("http://127.0.0.1:8930/", self.data))
        self.assertEqual(launch.call_count, 2)
        browser.assert_called_once_with("http://127.0.0.1:8930/")

if __name__ == "__main__":
    unittest.main()
