"""Download and verify the optional portable desktop runtime; maintenance only."""
from pathlib import Path, PurePosixPath
import hashlib
import json
import shutil
import sys
import urllib.request
import uuid
import zipfile

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from template_config import APP_SLUG, DESKTOP_MARKER  # noqa: E402

def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()

def main():
    if sys.platform != "win32":
        raise SystemExit("桌面便携版面向 Windows x64。其他平台仍可使用浏览器版。")
    lock = json.loads((ROOT / "tools/desktop-runtime-lock.json").read_text(encoding="utf-8"))
    runtime = ROOT / "desktop/runtime"
    marker = runtime / DESKTOP_MARKER
    if marker.exists():
        installed = json.loads(marker.read_text(encoding="utf-8"))
        if installed.get("archive_sha256") == lock["sha256"] and (runtime / "electron.exe").is_file() and digest(runtime / "electron.exe") == installed.get("executable_sha256"):
            print("展示窗口运行环境已经准备好。", flush=True)
            return
    if runtime.exists():
        raise SystemExit("desktop/runtime 已存在但校验不符。请先关闭桌面工作台，备份并移走该目录后再重建。")
    vendor = ROOT / "vendor"
    vendor.mkdir(exist_ok=True)
    archive = vendor / lock["file"]
    if not archive.exists():
        temporary = vendor / (lock["file"] + ".partial")
        print("正在下载官方 Electron 运行环境（约151 MB）……", flush=True)
        request = urllib.request.Request(lock["source"], headers={"User-Agent": APP_SLUG + "-build"})
        with urllib.request.urlopen(request, timeout=90) as response, temporary.open("wb") as output:
            shutil.copyfileobj(response, output, 1024 * 1024)
        if temporary.stat().st_size != lock["bytes"] or digest(temporary) != lock["sha256"]:
            raise SystemExit("下载校验失败，未解压；保留 .partial 供排查。")
        temporary.replace(archive)
    if archive.stat().st_size != lock["bytes"] or digest(archive) != lock["sha256"]:
        raise SystemExit("Electron 压缩包 SHA-256 不匹配，未解压。")
    staging = ROOT / "desktop" / (".runtime-" + uuid.uuid4().hex)
    staging.mkdir(parents=True)
    with zipfile.ZipFile(archive) as package:
        for entry in package.infolist():
            relative = PurePosixPath(entry.filename)
            target = (staging / entry.filename).resolve()
            if relative.is_absolute() or ".." in relative.parts or ":" in entry.filename or "\\" in entry.filename or not target.is_relative_to(staging.resolve()):
                raise SystemExit("运行环境压缩包包含不安全路径，已停止。")
        package.extractall(staging)
    if not (staging / "electron.exe").is_file():
        raise SystemExit("运行环境缺少 electron.exe。")
    (staging / DESKTOP_MARKER).write_text(json.dumps({"version":lock["version"], "archive_sha256":lock["sha256"], "executable_sha256":digest(staging / "electron.exe")},indent=2),encoding="utf-8")
    staging.rename(runtime)
    print("Electron " + lock["version"] + " 校验并解压完成；无需用户安装 Node.js。", flush=True)

if __name__ == "__main__":
    main()
