"""Local-only launcher. Uses the portable runtime shipped beside this file."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import secrets
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent


def acquire_instance(data_dir, no_browser):
    """Hold a kernel lock before create_app can reset playback on startup."""
    import msvcrt
    lock = (data_dir / "server.lock").open("a+b")
    if lock.tell() == 0:
        lock.write(b"0")
        lock.flush()
    lock.seek(0)
    try:
        msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        return lock
    except OSError:
        lock.close()
    for _ in range(40):
        try:
            record = json.loads((data_dir / "server.json").read_text(encoding="utf-8"))
            parsed = urlsplit(record["url"])
            if parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or parsed.username or parsed.password or parsed.path != "/" or parsed.query or parsed.fragment or not parsed.port:
                raise ValueError("invalid local URL")
            with urllib.request.urlopen(record["url"] + "api/health", timeout=0.5) as response:
                info = json.load(response)
            if info.get("app") == "xiwa-workbench" and Path(info.get("data_dir", "")).resolve() == data_dir:
                print(f"工作台已在运行：{record['url']}", flush=True)
                if not no_browser:
                    webbrowser.open(record["url"])
                return None
        except (OSError, ValueError, KeyError):
            pass
        time.sleep(0.1)
    print("工作台正在启动或已有实例占用此资料目录，请稍后再打开。当前展示未被重置。", flush=True)
    return None


def main():
    parser = argparse.ArgumentParser(description="喜娃微 PIA 本地工作台")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--data-dir", type=Path, help="独立资料目录，供迁移与测试使用")
    args = parser.parse_args()
    if not 1024 <= args.port <= 65525:
        parser.error("端口范围为 1024–65525")
    os.chdir(ROOT)
    from app import create_app
    from flask import jsonify, request, abort
    from waitress import create_server

    data_dir = (args.data_dir or ROOT / "instance").resolve()
    data_dir.mkdir(parents=True, exist_ok=True)
    instance_lock = acquire_instance(data_dir, args.no_browser)
    if instance_lock is None:
        return
    config = {"DATABASE": str(data_dir / "workbench.sqlite3"), "INSTANCE_PATH": str(data_dir)}
    stop_event = threading.Event()
    stop_token = secrets.token_urlsafe(32)
    server_record = data_dir / "server.json"

    app = create_app(config)

    @app.post("/api/shutdown")
    def shutdown():
        if not secrets.compare_digest(request.headers.get("X-Stop-Token", ""), stop_token):
            abort(403)
        threading.Timer(0.3, stop_event.set).start()
        return jsonify(ok=True)

    server = None
    for port in range(args.port, args.port + 10):
        try:
            server = create_server(app, host="127.0.0.1", port=port, threads=6)
            break
        except OSError:
            continue
    if server is None:
        raise SystemExit("端口均被占用，请关闭旧实例，或使用 --port 指定其他端口。")

    url = f"http://127.0.0.1:{port}/"
    server_record.write_text(json.dumps({"pid": os.getpid(), "url": url, "token": stop_token}, ensure_ascii=False), encoding="utf-8")
    worker = threading.Thread(target=server.run, daemon=True, name="local-web-server")
    worker.start()
    print(f"喜娃微 PIA 工作台已启动：{url}", flush=True)
    print("仅本机可访问。关闭时按 Ctrl+C，或双击“停止工作台.cmd”。", flush=True)
    if not args.no_browser:
        webbrowser.open(url)
    try:
        while not stop_event.wait(0.5):
            if not worker.is_alive():
                break
    except KeyboardInterrupt:
        print("正在停止工作台……", flush=True)
    finally:
        server.close()
        try:
            if json.loads(server_record.read_text(encoding="utf-8")).get("pid") == os.getpid():
                server_record.unlink()
        except (OSError, ValueError):
            pass
        instance_lock.close()
        print("工作台已停止，资料已保存在本地。", flush=True)


if __name__ == "__main__":
    main()
