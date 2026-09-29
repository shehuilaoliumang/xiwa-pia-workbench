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


def electron_processes():
    import ctypes

    class PROCESSENTRY32W(ctypes.Structure):
        _fields_ = [("dwSize", ctypes.c_ulong), ("cntUsage", ctypes.c_ulong), ("th32ProcessID", ctypes.c_ulong),
                    ("th32DefaultHeapID", ctypes.c_void_p), ("th32ModuleID", ctypes.c_ulong),
                    ("cntThreads", ctypes.c_ulong), ("th32ParentProcessID", ctypes.c_ulong),
                    ("pcPriClassBase", ctypes.c_long), ("dwFlags", ctypes.c_ulong),
                    ("szExeFile", ctypes.c_wchar * 260)]

    result = []
    snapshot = ctypes.windll.kernel32.CreateToolhelp32Snapshot(0x00000002, 0)  # TH32CS_SNAPPROCESS
    if snapshot == -1:
        return result
    try:
        entry = PROCESSENTRY32W()
        entry.dwSize = ctypes.sizeof(entry)
        if ctypes.windll.kernel32.Process32FirstW(snapshot, ctypes.byref(entry)):
            while True:
                if entry.szExeFile.lower() == "electron.exe":
                    result.append(entry.th32ProcessID)
                if not ctypes.windll.kernel32.Process32NextW(snapshot, ctypes.byref(entry)):
                    break
    finally:
        ctypes.windll.kernel32.CloseHandle(snapshot)
    return result


def electron_renderer_pids():
    """Return electron PIDs whose command line marks them as renderer processes
    (i.e. a BrowserWindow was actually created)."""
    import subprocess as sp
    try:
        script = ("Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'electron.exe' -and "
                  "$_.CommandLine -match '--type=renderer' } | ForEach-Object { $_.ProcessId }")
        output = sp.run(["powershell", "-NoProfile", "-Command", script],
                        capture_output=True, timeout=20, text=True)
        if output.returncode == 0:
            return [int(line.strip()) for line in output.stdout.splitlines() if line.strip().isdigit()]
    except Exception:
        pass
    return []


def main():
    base = Path(tempfile.mkdtemp(prefix="fan-desktop-test-"))
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
                    break
            except Exception:
                pass
            time.sleep(0.5)
        else:
            raise RuntimeError("service did not start")
        status, page = fetch("GET", base_url + "/")
        assert status == 200 and "喜娃剧本粉丝编辑器" in page.decode("utf-8")
        match = re.search(r'<meta name="csrf" content="([0-9a-f]+)">', page.decode("utf-8"))
        assert match
        csrf = match.group(1)

        # Electron shell should spawn and release next to the base directory.
        for _ in range(60):
            if electron_processes():
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
        assert electron_processes(), "electron shell died unexpectedly"
        renderer = electron_renderer_pids()
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
            if not electron_processes():
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
        print("  entry script executed (desktop-user-data), window renderer created,")
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
        import shutil
        shutil.rmtree(base, ignore_errors=True)


if __name__ == "__main__":
    main()
