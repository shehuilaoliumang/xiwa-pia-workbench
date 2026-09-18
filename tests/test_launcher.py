"""Exercise the real portable launcher with isolated data, including races."""
import json
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
PYTHON = ROOT / "runtime/python.exe"


@unittest.skipUnless(sys.platform == "win32", "Windows portable launch contract")
class LauncherTests(unittest.TestCase):
    def test_duplicate_port_conflict_copy_stop_and_shutdown(self):
        (ROOT / ".qa").mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="启动 含空格-", dir=ROOT / ".qa") as temp:
            data = Path(temp) / "独立资料"
            blocker = socket.socket()
            blocker.bind(("127.0.0.1", 0))
            first_port = blocker.getsockname()[1]
            if first_port > 65525:
                self.skipTest("ephemeral port too near range boundary")
            blocker.listen(1)
            command = [str(PYTHON), "-X", "utf8", str(ROOT / "run.py"), "--no-browser", "--data-dir", str(data), "--port", str(first_port)]
            log = (Path(temp) / "server.log").open("w", encoding="utf-8")
            process = subprocess.Popen(command, cwd=temp, stdout=log, stderr=subprocess.STDOUT, creationflags=subprocess.CREATE_NO_WINDOW)
            try:
                deadline = time.monotonic() + 25
                while time.monotonic() < deadline:
                    if process.poll() is not None:
                        log.flush()
                        self.fail((Path(temp) / "server.log").read_text(encoding="utf-8"))
                    try:
                        info = json.loads((data / "server.json").read_text(encoding="utf-8"))
                        with urllib.request.urlopen(info["url"] + "api/health", timeout=1) as response:
                            health = json.load(response)
                        break
                    except (OSError, ValueError):
                        time.sleep(0.1)
                else:
                    self.fail("launcher did not become ready")
                self.assertEqual(health["app"], "xiwa-workbench")
                self.assertEqual(Path(health["data_dir"]), data)
                self.assertNotIn(f":{first_port}/", info["url"])

                def get(route):
                    with urllib.request.urlopen(info["url"] + route, timeout=5) as response:
                        return json.load(response)

                token = get("api/library")["csrf_token"]

                def post(route, payload):
                    request = urllib.request.Request(info["url"] + route, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json", "X-CSRF-Token": token}, method="POST")
                    with urllib.request.urlopen(request, timeout=5) as response:
                        return json.load(response)

                post("api/apply", {"mode": "script", "script_id": "script-01", "orientation": "portrait", "layout": {"body_mode": "scroll"}})
                playing = post("api/command", {"action": "play"})
                duplicate = subprocess.run(command[:-1] + [str(first_port + 20 if first_port < 65505 else first_port - 20)], cwd=temp, capture_output=True, timeout=15, creationflags=subprocess.CREATE_NO_WINDOW)
                self.assertEqual(duplicate.returncode, 0, duplicate.stderr.decode("utf-8", errors="replace"))
                self.assertEqual(get("api/state")["revision"], playing["revision"])
                self.assertTrue(get("api/state")["playing"])

                copied = Path(temp) / "复制资料"
                copied.mkdir()
                shutil.copy2(data / "server.json", copied / "server.json")
                wrong_stop = subprocess.run([str(PYTHON), "-X", "utf8", str(ROOT / "tools/stop.py"), "--data-dir", str(copied)], capture_output=True, timeout=10, creationflags=subprocess.CREATE_NO_WINDOW)
                self.assertNotEqual(wrong_stop.returncode, 0)
                self.assertTrue(get("api/state")["playing"])
                correct_stop = subprocess.run([str(PYTHON), "-X", "utf8", str(ROOT / "tools/stop.py"), "--data-dir", str(data)], capture_output=True, timeout=10, creationflags=subprocess.CREATE_NO_WINDOW)
                self.assertEqual(correct_stop.returncode, 0, correct_stop.stdout.decode("utf-8", errors="replace"))
                process.wait(timeout=10)
                self.assertFalse((data / "server.json").exists())
            finally:
                if process.poll() is None:
                    process.terminate()
                    process.wait(timeout=10)
                blocker.close()
                log.close()


if __name__ == "__main__":
    unittest.main()
