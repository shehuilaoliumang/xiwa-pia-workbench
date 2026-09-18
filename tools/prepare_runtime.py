"""Recreate this project's portable Windows runtime with verified offline files.

Run with any installed Python 3.10+ after a source-only checkout. The delivered
project already contains runtime/ and does not need this preparation step.
"""
from pathlib import Path
import hashlib
import json
import subprocess
import sys
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
VERSION = "3.14.7"
URL = f"https://www.python.org/ftp/python/{VERSION}/python-{VERSION}-embed-amd64.zip"
SHA256 = "d297e5ff019966817ad8502465176139f2d3d840fa4ed84b13bed399a6ab1f15"


def main():
    if sys.platform != "win32":
        raise SystemExit("此便携环境面向 Windows x64；其他系统请用 requirements.txt 建立环境。")
    if Path(sys.executable).resolve().is_relative_to((ROOT / "runtime").resolve()):
        raise SystemExit("重建需先停止工作台，并使用其他已安装的 Python；不能替换正在运行的 runtime/python.exe。")
    if (ROOT / "instance/server.json").exists():
        raise SystemExit("请先停止工作台，再重建运行环境。")
    vendor = ROOT / "vendor"
    vendor.mkdir(exist_ok=True)
    archive = vendor / f"python-{VERSION}-embed-amd64.zip"
    if not archive.exists():
        print("下载 Python 官方便携环境……")
        with urllib.request.urlopen(URL, timeout=60) as response:
            archive.write_bytes(response.read())
    if hashlib.sha256(archive.read_bytes()).hexdigest() != SHA256:
        raise SystemExit("Python 安装包校验失败，未解压；请重新下载该文件。")
    runtime = ROOT / "runtime"
    runtime.mkdir(exist_ok=True)
    with zipfile.ZipFile(archive) as package:
        package.extractall(runtime)
    (runtime / "python314._pth").write_text("python314.zip\n.\n..\nLib/site-packages\nimport site\n", encoding="utf-8")
    wheels = vendor / "wheels"
    wheels.mkdir(exist_ok=True)
    # An offline bundle includes every pinned wheel. Fresh source checkouts
    # download only the packages named by the project's lock file.
    pins = [line.strip() for line in (ROOT / "requirements.txt").read_text().splitlines() if line.strip() and not line.startswith("#")]
    lock = json.loads((ROOT / "tools/runtime-lock.json").read_text(encoding="utf-8"))
    entries = lock["wheels"]
    normalize = lambda value: value.lower().replace("-", "_")
    required = {normalize(pin.replace("==", "-")) for pin in pins}
    locked = {normalize("-".join(entry["file"].split("-")[:2])) for entry in entries}
    if required != locked:
        raise SystemExit("requirements.txt 与依赖校验清单不一致，需要先更新锁定清单")
    if any(not (wheels / entry["file"]).exists() for entry in entries):
        subprocess.run([sys.executable, "-m", "pip", "download", "--dest", str(wheels), "--only-binary=:all:", "--platform", "win_amd64", "--python-version", "3.14", "--implementation", "cp", "--abi", "cp314", "-r", str(ROOT / "requirements.txt")], check=True)
    for entry in entries:
        file = wheels / entry["file"]
        if hashlib.sha256(file.read_bytes()).hexdigest() != entry["sha256"]:
            raise SystemExit(f"依赖包校验失败：{file.name}")
    target = runtime / "Lib" / "site-packages"
    target.mkdir(parents=True, exist_ok=True)
    for entry in entries:
        file = wheels / entry["file"]
        with zipfile.ZipFile(file) as package:
            for entry in package.infolist():
                path = (target / entry.filename).resolve()
                if not path.is_relative_to(target.resolve()):
                    raise SystemExit("依赖包中含非法路径")
                if ".data/" in entry.filename:
                    raise SystemExit("依赖布局已变化，需要重新检查打包方式")
            package.extractall(target)
    subprocess.run([str(runtime / "python.exe"), "-c", "import flask,waitress,jinja2,sqlite3,PIL; print('独立环境验证通过')"], check=True)
    print("现在可以双击 启动工作台.cmd。")


if __name__ == "__main__":
    main()
