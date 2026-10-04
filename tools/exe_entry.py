"""Single-file workbench entry used by PyInstaller.

Frozen (onefile) mode:
  - bundled pages/resources (templates/, static/, data/seed.json, desktop/) live
    inside sys._MEIPASS and are read-only.
  - user data lives NEXT TO THE EXE (<base>/instance) and is created on first
    run; an existing folder is reused untouched.
  - the Electron desktop host is copied next to the exe once (<base>/desktop),
    then reused so every later start is fast.
  - closing the desktop window stops the whole workbench; 停止工作台.cmd still
    works when the exe sits in the project folder.

Development mode: behaves like run.py with the project folder as base.
"""
from __future__ import annotations

import argparse
import json
import os
import secrets
import shutil
import sys
import threading
import time
from pathlib import Path

FROZEN = bool(getattr(sys, "frozen", False))
MEIPASS = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
EXE_DIR = Path(sys.executable).resolve().parent if FROZEN else Path(__file__).resolve().parent

from template_config import APP_NAME  # noqa: E402

LOG_FILE = None  # assigned once the data directory is known


def log(message):
    line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {message}"
    try:
        if sys.stdout is not None:
            print(line, flush=True)
    except Exception:
        pass
    try:
        if LOG_FILE is not None:
            with open(LOG_FILE, "a", encoding="utf-8") as handle:
                handle.write(line + "\n")
    except Exception:
        pass


def _writable(directory):
    try:
        directory.mkdir(parents=True, exist_ok=True)
        probe = directory / (".write-test-" + secrets.token_hex(4))
        probe.write_text("ok", encoding="utf-8")
        probe.unlink()
        return True
    except OSError:
        return False


def resolve_base():
    """Writable folder that owns data and the released desktop component."""
    if not FROZEN:
        return EXE_DIR
    if _writable(EXE_DIR):
        return EXE_DIR
    fallback = Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / APP_NAME
    log(f"exe 所在目录不可写，运行文件将保存在：{fallback}")
    return fallback


def ensure_desktop(base):
    """Copy the bundled Electron host next to the exe once; never touch an
    existing desktop/ folder that already contains the runtime."""
    if not FROZEN:
        return
    source = MEIPASS / "desktop"
    destination = base / "desktop"
    marker = destination / "runtime" / "electron.exe"
    if not source.is_dir() or marker.is_file():
        return
    log("首次运行：正在释放桌面展示组件（约 1 分钟，仅此一次）……")
    try:
        if destination.exists():
            shutil.rmtree(destination)  # our own incomplete release only
        shutil.copytree(source, destination)
        if not marker.is_file():
            raise OSError("桌面组件释放后校验失败")
    except OSError as error:
        log(f"桌面组件释放失败（{error}），本次使用浏览器模式；可重新双击 exe 重试。")


class _NullWriter:
    """Swallow prints when a windowed build has no console."""
    def write(self, *_args):
        pass

    def flush(self):
        pass


def main():
    parser = argparse.ArgumentParser(description="内容管理 本地工作台（单文件版）")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true", help="只运行本地服务，不打开界面")
    parser.add_argument("--browser", action="store_true", help="使用浏览器界面，不启动桌面组件")
    parser.add_argument("--data-dir", type=Path, help="独立资料目录（测试与迁移用）")
    args = parser.parse_args()
    if not 1024 <= args.port <= 65525:
        parser.error("端口范围为 1024–65525")

    base = resolve_base()
    data_dir = (args.data_dir or base / "instance").resolve()
    data_dir.mkdir(parents=True, exist_ok=True)
    global LOG_FILE
    LOG_FILE = data_dir / "launcher.log"
    # Windowed builds have no console; run.py prints go nowhere and the
    # launcher log keeps exactly one copy of each event.
    if sys.stdout is None:
        sys.stdout = _NullWriter()
    if sys.stderr is None:
        sys.stderr = _NullWriter()
    log(f"工作台（单文件版）启动，数据目录：{data_dir}")

    import run as run_mod
    run_mod.ROOT = base
    ensure_desktop(base)

    instance_lock = run_mod.acquire_instance(data_dir, args.no_browser, args.browser)
    if instance_lock is None:
        log("已有工作台在运行，直接打开现有界面。")
        return

    from app import create_app
    from flask import jsonify, request, abort
    from waitress import create_server

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
    log(f"工作台已启动：{url}")
    electron = None if args.no_browser else run_mod.open_interface(url, data_dir, args.browser)

    try:
        while not stop_event.wait(0.5):
            if not worker.is_alive():
                break
            if electron is not None and electron.poll() is not None:
                log("桌面工作台窗口已关闭，正在停止服务。")
                break
    except KeyboardInterrupt:
        log("收到停止请求，正在停止工作台……")
    finally:
        server.close()
        try:
            if json.loads(server_record.read_text(encoding="utf-8")).get("pid") == os.getpid():
                server_record.unlink()
        except (OSError, ValueError):
            pass
        instance_lock.close()
        log("工作台已停止，资料已保存在本地。")


if __name__ == "__main__":
    main()
