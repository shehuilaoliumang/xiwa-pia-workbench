"""Single-file entry for the fan-side script editor (PyInstaller + Electron desktop).

Frozen (onefile) mode:
  - the editor page and the desktop shell are bundled inside sys._MEIPASS.
  - user workspaces live NEXT TO THE EXE (<base>/fan-data/workspaces/...).
  - the desktop shell is released once to <base>/desktop/ (Electron runtime
    is bundled into the exe); the desktop window loads the editor page.
  - closing the window stops the service and exits the exe; the page's
    "安全退出" button stops the service, the desktop shell then quits.

Development mode: behaves the same with the project folder as base; the
Electron runtime is taken from the anchor workbench's desktop/runtime if the
fan desktop has no runtime folder yet.
"""
from __future__ import annotations

import argparse
import ctypes
import json
import os
import secrets
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

FROZEN = bool(getattr(sys, "frozen", False))
EXE_DIR = Path(sys.executable).resolve().parent if FROZEN else Path(__file__).resolve().parent

LOG_FILE = None


class _NullWriter:
    def write(self, *_args):
        pass

    def flush(self):
        pass


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
    if not FROZEN:
        return EXE_DIR
    if _writable(EXE_DIR):
        return EXE_DIR
    fallback = Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "喜娃剧本粉丝编辑器"
    log(f"exe 所在目录不可写，工作区将保存在：{fallback}")
    return fallback


def bundled_desktop_dir():
    bundle_root = getattr(sys, "_MEIPASS", None)
    if bundle_root:
        return Path(bundle_root) / "desktop"
    return Path(__file__).resolve().parent / "desktop"


def ensure_desktop(base):
    """Release the desktop shell (main.cjs + Electron runtime) next to the exe.

    A complete release is detected by the electron.exe + main.cjs markers and
    reused as-is; anything incomplete or missing is discarded and copied fresh,
    so a partial first release or a stale shell can never leave a broken window
    (V8 snapshot, entry script missing, etc.).
    """
    target = base / "desktop"
    if (target / "runtime" / "electron.exe").exists() and (target / "main.cjs").exists():
        return target
    bundled = bundled_desktop_dir()
    if (bundled / "runtime" / "electron.exe").exists():
        # Frozen mode: main.cjs + runtime are all bundled; release them once.
        if target.exists():
            shutil.rmtree(target)
        shutil.copytree(bundled, target)
        log(f"已释放桌面组件：{bundled} → {target}")
    else:
        # Development mode: the fan shell already lives at <project>/desktop/
        # (same directory as target); borrow the Electron runtime fresh from the
        # anchor workbench's desktop folder.
        anchor_runtime = Path(__file__).resolve().parents[1] / "desktop" / "runtime"
        runtime_target = target / "runtime"
        if runtime_target.exists():
            shutil.rmtree(runtime_target)
        shutil.copytree(anchor_runtime, runtime_target)
        log(f"已复制 Electron 运行时：{anchor_runtime} → {runtime_target}")
    if not (target / "runtime" / "electron.exe").exists():
        raise SystemExit("桌面组件缺失，无法启动窗口。请重新安装本工具。")
    return target


def native_error(title, message):
    try:
        ctypes.windll.user32.MessageBoxW(None, message, title, 0x10)
    except Exception:
        pass


def acquire_instance(data_dir):
    """Hold a kernel lock on the data directory; return the handle when
    acquired, or None when another instance is already running there."""
    import msvcrt
    try:
        lock = (data_dir / "server.lock").open("a+b")
    except OSError:
        return None
    try:
        if lock.tell() == 0:
            lock.write(b"0")
            lock.flush()
        lock.seek(0)
        msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        return lock
    except OSError:
        try:
            lock.close()
        except OSError:
            pass
        return None


def main():
    parser = argparse.ArgumentParser(description="喜娃剧本粉丝编辑器（桌面版）")
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument("--no-browser", action="store_true", help="只运行本地服务，不启动桌面窗口（测试用）")
    parser.add_argument("--no-show", action="store_true", help="启动桌面窗口但不显示（窗口冒烟测试用）")
    parser.add_argument("--data-dir", type=Path, help="独立工作区目录（测试与迁移用）")
    args = parser.parse_args()
    if not 1024 <= args.port <= 65525:
        parser.error("端口范围为 1024–65525")

    base = resolve_base()
    data_dir = (args.data_dir or base / "fan-data").resolve()
    data_dir.mkdir(parents=True, exist_ok=True)
    global LOG_FILE
    LOG_FILE = data_dir / "fan.log"
    if sys.stdout is None:
        sys.stdout = _NullWriter()
    if sys.stderr is None:
        sys.stderr = _NullWriter()
    instance_lock = acquire_instance(data_dir)
    if instance_lock is None:
        native_error("喜娃剧本粉丝编辑器", "另一个实例已在运行。\n请切换到已打开的窗口，或先关闭它再启动。")
        raise SystemExit("已有实例在运行，本次启动已取消。")
    log(f"粉丝编辑器启动，工作区目录：{data_dir}")

    from fan_app import create_app
    from flask import jsonify
    from waitress import create_server

    stop_event = threading.Event()
    server_record = data_dir / "server.json"

    app = create_app(data_dir)

    @app.post("/api/shutdown")
    def shutdown():
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
        native_error("喜娃剧本粉丝编辑器", "端口均被占用，请先关闭其他实例后重试。")
        raise SystemExit("端口均被占用，请关闭旧实例，或使用 --port 指定其他端口。")

    url = f"http://127.0.0.1:{port}/"
    server_record.write_text(json.dumps({"pid": os.getpid(), "url": url}, ensure_ascii=False), encoding="utf-8")
    worker = threading.Thread(target=server.run, daemon=True, name="fan-web-server")
    worker.start()
    log(f"粉丝编辑器已启动：{url}")

    desktop_proc = None
    desktop = None
    try:
        if not args.no_browser:
            desktop = ensure_desktop(base)
            electron = desktop / "runtime" / "electron.exe"
            entry = desktop / "main.cjs"
            environment = os.environ.copy()
            # An Electron-based parent (for example this editor) may export
            # these; the fan tool must run the desktop host, not Node's CLI.
            environment.pop("ELECTRON_RUN_AS_NODE", None)
            environment.pop("NODE_OPTIONS", None)
            command = [str(electron), str(entry), "--url=" + url, "--data-dir=" + str(data_dir)]
            if args.no_show:
                command.append("--no-show")
            with (data_dir / "desktop.log").open("ab") as desktop_log_handle:
                desktop_proc = subprocess.Popen(command, cwd=str(desktop), env=environment,
                                                stdout=desktop_log_handle, stderr=subprocess.STDOUT,
                                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            log(f"已启动桌面窗口：{electron.name} (pid={desktop_proc.pid})")

        while not stop_event.wait(0.5):
            if not worker.is_alive():
                break
            if desktop_proc is not None and desktop_proc.poll() is not None:
                # 窗口已关闭：由入口负责关停服务。
                break
        if stop_event.is_set() and desktop_proc is not None and desktop_proc.poll() is None:
            try:
                desktop_proc.wait(timeout=6)
            except subprocess.TimeoutExpired:
                desktop_proc.terminate()
    except KeyboardInterrupt:
        log("收到停止请求，正在关闭……")
    finally:
        if desktop_proc is not None and desktop_proc.poll() is None:
            try:
                desktop_proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                try:
                    desktop_proc.terminate()
                except OSError:
                    pass
        server.close()
        try:
            if json.loads(server_record.read_text(encoding="utf-8")).get("pid") == os.getpid():
                server_record.unlink()
        except (OSError, ValueError):
            pass
        if instance_lock is not None:
            try:
                instance_lock.close()
            except OSError:
                pass
        log("粉丝编辑器已退出，编辑内容已保存在本地工作区。")


if __name__ == "__main__":
    main()
