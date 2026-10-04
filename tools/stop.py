"""Request shutdown of this project only; never terminate unrelated processes."""
import sys
import json
from pathlib import Path
import urllib.request
from urllib.parse import urlsplit
import argparse
import time

root = Path(__file__).resolve().parents[1]
if str(root) not in sys.path:
    sys.path.insert(0, str(root))

from template_config import APP_ID  # noqa: E402
parser = argparse.ArgumentParser()
parser.add_argument("--data-dir", type=Path)
args = parser.parse_args()
data_dir = (args.data_dir or root / "instance").resolve()
record = data_dir / "server.json"
if not record.exists():
    print("本项目没有正在运行的工作台。")
    raise SystemExit(0)
try:
    info = json.loads(record.read_text(encoding="utf-8"))
    url = info["url"]
    parsed = urlsplit(url)
    if parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or parsed.username or parsed.password or parsed.path != "/" or parsed.query or parsed.fragment or not parsed.port:
        raise ValueError("本地地址无效")
    with urllib.request.urlopen(url + "api/health", timeout=3) as response:
        health = json.load(response)
    if health.get("app") != APP_ID or Path(health.get("data_dir", "")).resolve() != data_dir:
        raise ValueError("该服务不属于当前项目资料目录，未执行停止")
    with urllib.request.urlopen(url + "api/library", timeout=3) as response:
        token = json.load(response)["csrf_token"]
    request = urllib.request.Request(url + "api/shutdown", data=b"{}", headers={"Content-Type": "application/json", "X-CSRF-Token": token, "X-Stop-Token": info["token"]}, method="POST")
    with urllib.request.urlopen(request, timeout=5) as response:
        response.read()
    deadline = time.monotonic() + 10
    while record.exists() and time.monotonic() < deadline:
        time.sleep(0.1)
    if record.exists():
        raise OSError("停止请求已发送，服务尚未退出，请稍后检查")
    print("已停止本项目工作台。")
except (OSError, KeyError, ValueError) as exc:
    print(f"工作台未响应，可能已经关闭。未终止其他程序。\n{exc}")
    raise SystemExit(1)
