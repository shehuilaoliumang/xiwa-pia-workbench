"""Desktop smoke test for the fan editor (Electron shell).

Starts the service, launches the Electron desktop shell hidden (--no-show),
verifies the desktop assets are released and the shell process comes up,
then shuts the service down and confirms the shell exits.
Run in dev mode (python) or against the frozen exe (FAN_EXE env).
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

PORT = 9412


def fetch(method, url, data=None, headers=None):
    request = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()


def _electron_snapshot():
    """Read process identity only; this test never stops another Electron app."""
    script = (
        "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); "
        "@(Get-CimInstance Win32_Process -Filter \"Name = 'electron.exe'\" | "
        "Select-Object ProcessId,ParentProcessId,CommandLine) | ConvertTo-Json -Compress"
    )
    result = subprocess.run(["powershell", "-NoProfile", "-Command", script],
                            capture_output=True, timeout=20, encoding="utf-8", errors="replace")
    if result.returncode != 0:
        raise RuntimeError("Cannot inspect the test desktop process tree")
    try:
        records = json.loads(result.stdout.strip() or "[]")
    except ValueError as error:
        raise RuntimeError("Invalid desktop process inventory") from error
    return records if isinstance(records, list) else [records]


def _owned_electrons(data_dir, records):
    data_key = str(Path(data_dir).resolve()).replace("\\", "/").casefold()
    marker = re.compile(re.escape(data_key) + r'(?=[/"\s]|$)')
    owned = {int(row["ProcessId"]) for row in records
             if marker.search(str(row.get("CommandLine") or "").replace("\\", "/").casefold())}
    # Renderer/GPU children sometimes omit the data path; follow only a main
    # process already proven to belong to this uniquely named test directory.
    while True:
        children = {int(row["ProcessId"]) for row in records
                    if int(row.get("ParentProcessId") or 0) in owned}
        if children <= owned:
            break
        owned.update(children)
    return [row for row in records if int(row["ProcessId"]) in owned]


def electron_processes(data_dir):
    return [int(row["ProcessId"]) for row in _owned_electrons(data_dir, _electron_snapshot())]


def electron_renderer_pids(data_dir):
    return [int(row["ProcessId"]) for row in _owned_electrons(data_dir, _electron_snapshot())
            if "--type=renderer" in str(row.get("CommandLine") or "")]


def _safe_cleanup(base):
    import shutil
    resolved = Path(base).resolve()
    temp_root = Path(tempfile.gettempdir()).resolve()
    if (resolved.parent != temp_root or not resolved.name.startswith("fan-desktop-test-")
            or not resolved.is_relative_to(temp_root)):
        raise RuntimeError("Refusing cleanup outside this test's temporary directory")
    shutil.rmtree(resolved, ignore_errors=True)


def main():
    # Never attach to, shut down or borrow evidence from an occupied service.
    import socket
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        try:
            probe.bind(("127.0.0.1", PORT))
        except OSError as error:
            raise RuntimeError(f"QA port {PORT} is occupied; existing services were not touched") from error
    base = Path(tempfile.mkdtemp(prefix="fan-desktop-test-")).resolve()
    data_dir = base / "fan-data"
    fan_exe = os.environ.get("FAN_EXE")
    if fan_exe:
        command = [fan_exe, "--port", str(PORT), "--no-show", "--data-dir", str(data_dir)]
        cwd = str(Path(fan_exe).parent)
    else:
        command = [sys.executable, str(Path(__file__).resolve().parents[1] / "fan_entry.py"),
                   "--port", str(PORT), "--no-show", "--data-dir", str(data_dir)]
        cwd = str(Path(__file__).resolve().parents[1])
    proc = subprocess.Popen(command, cwd=cwd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    base_url = f"http://127.0.0.1:{PORT}"
    csrf = ""
    try:
        for _ in range(90):
            try:
                status, body = fetch("GET", base_url + "/api/health")
                if status == 200:
                    health = json.loads(body)
                    assert health.get("app") == "content-editor", "health belongs to a different service"
                    assert health.get("ok") is True and health.get("version") == "0.2.1", "unexpected fan service version"
                    assert isinstance(health.get("data_dir"), str), "health is missing the workspace identity"
                    assert Path(health["data_dir"]).resolve() == data_dir.resolve(), "health belongs to another workspace"
                    break
            except (urllib.error.URLError, OSError):
                pass
            time.sleep(0.5)
        else:
            raise RuntimeError("service did not start")
        status, page = fetch("GET", base_url + "/")
        assert status == 200 and "内容编辑器" in page.decode("utf-8")
        match = re.search(r'<meta name="csrf" content="([0-9a-f]+)">', page.decode("utf-8"))
        assert match
        csrf = match.group(1)

        # Electron shell should spawn and release next to the base directory.
        for _ in range(60):
            if electron_processes(data_dir):
                break
            time.sleep(0.5)
        else:
            log = data_dir / "desktop.log"
            detail = log.read_text(encoding="utf-8", errors="replace")[-2000:] if log.exists() else "(no desktop.log)"
            raise RuntimeError("electron shell did not start\n" + detail)
        # The entry script must actually execute: it creates desktop-user-data in the
        # data directory as its first action. A silently non-loading entry (require.main
        # trap) leaves this missing while the electron process idles -- regression guard.
        for _ in range(60):
            if (data_dir / "desktop-user-data").exists():
                break
            time.sleep(0.5)
        else:
            log = data_dir / "desktop.log"
            detail = log.read_text(encoding="utf-8", errors="replace")[-2000:] if log.exists() else "(no desktop.log)"
            raise RuntimeError("desktop entry script did not execute (desktop-user-data missing)\n" + detail)
        time.sleep(3)
        assert electron_processes(data_dir), "electron shell died unexpectedly"
        renderer = electron_renderer_pids(data_dir)
        assert renderer, "no renderer process -> window was not created"

        # Page still served (CSP + external assets intact).
        status, page = fetch("GET", base_url + "/")
        assert status == 200 and 'src="/static/editor.js"' in page.decode("utf-8")
        status, css = fetch("GET", base_url + "/static/editor.css")
        assert status == 200
        status, js = fetch("GET", base_url + "/static/editor.js")
        assert status == 200 and "音视频配本" in js.decode("utf-8")

        # Graceful shutdown: service stops -> desktop shell notices and quits.
        fetch("POST", base_url + "/api/shutdown", headers={"X-CSRF-Token": csrf})
        for _ in range(60):
            if not electron_processes(data_dir):
                break
            time.sleep(0.5)
        else:
            raise RuntimeError("electron shell did not quit after service stop")
        proc.wait(timeout=20)
        log = data_dir / "fan.log"
        assert log.exists() and "已退出" in log.read_text(encoding="utf-8")
        assert not (data_dir / "server.json").exists()
        print("DESKTOP SMOKE OK")
        print("  service up, desktop assets released, electron shell spawned (hidden),")
        print("  entry script executed (desktop-user-data), owned window renderer created:", renderer)
        print("  shutdown -> shell quit -> service exited -> server.json removed")
    finally:
        try:
            if csrf:
                fetch("POST", base_url + "/api/shutdown", headers={"X-CSRF-Token": csrf})
        except Exception:
            pass
        if proc.poll() is None:
            proc.terminate()
        proc.wait(timeout=10)
        _safe_cleanup(base)


if __name__ == "__main__":
    main()
