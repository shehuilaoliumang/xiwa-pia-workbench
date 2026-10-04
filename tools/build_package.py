#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""一键封装「免安装交付包」（通用模板版）。

用途
----
把当前项目打成一个可以整包解压、双击即用的 Windows 免安装交付包：

    1. 版本读取与校验：只从配置中心（``template_config.py`` / ``config/template.json``）
       读取应用名、版本、短名、包格式名与备份前缀；配置中心缺失时回退到内置默认值，
       并在输出与清单里说明回退原因。
    2. 运行时与依赖检查：确认 ``runtime/python.exe`` 与 ``runtime/Lib/site-packages``
       里的 Flask / waitress / jinja2 / PIL 齐备；缺失时提示先运行
       ``python tools/prepare_runtime.py`` 并中止。
    3. 主工作台单文件 EXE（可选，默认尝试）：用 ``runtime/python.exe -m PyInstaller``
       打包 ``tools/exe_entry.py``；没有 PyInstaller 就跳过（除非 --install-pyinstaller）。
    4. 可选打包「内容编辑器」子项目 EXE（--with-editor）：复用子项目 ``build/`` 下
       已有的 ``.spec`` 配方（SPECPATH 相对路径，换机器可用）。
    5. 收集资源到临时交付目录，排除用户资料（instance/）与所有临时/证据目录。
    6. 打成 ``<slug>-portable-<version>-<yyyymmdd>.zip`` 输出到 ``dist/``。
    7. 写出 ``dist/<zip 名>.manifest.json`` 交付清单并在控制台打印摘要。
    8. 产物自检：ZIP 结构校验 + 用 ``runtime/python.exe`` 在临时数据目录里启动服务，
       断言 ``/api/health`` 的 ``ok`` 与 ``data_dir``，并访问 / 、/control 、/manage；
       已构建 EXE 时对 EXE 做同样的健康检查。任一步失败即中止（退出码非 0），
       不产出「看起来成功」的清单。

边界：本工具只在本机产出文件，不发布、不推送、不 git commit，也不修改 .gitignore。

环境约束：所有临时目录都建在项目根下的 ``.build-tmp-<pid>/``（不使用
``tempfile.mkdtemp()``），结束时删除；子进程一律继承/重定向到文件，不使用管道。
"""

from __future__ import annotations

import argparse
import hashlib
import http.client
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import zipfile
from datetime import datetime
from pathlib import Path, PurePosixPath

# --------------------------------------------------------------------------
# 内置默认值：只在配置中心缺失/损坏时使用（与 config/template.json 保持一致，
# 全部是通用命名，不含任何品牌词）。
# --------------------------------------------------------------------------
ROOT = Path(__file__).resolve().parents[1]
DEFAULTS = {
    "app_name": "内容管理工作台",
    "slug": "content-workbench",
    "version": "0.1.0",
    "package_format": "content-package",
    "package_temp_prefix": "content-package-",
    "backup_prefix": "content-backup-",
    "desktop_marker": "desktop-runtime.json",
    "editor_directory": "内容编辑器",
    "editor_app_id": "content-editor",
    "editor_version": "0.2.1",
}

CONFIG_JSON = Path("config") / "template.json"
CONFIG_READER = "template_config.py"
PREPARE_RUNTIME_HINT = "python tools/prepare_runtime.py"
PREPARE_DESKTOP_HINT = "python tools/prepare_desktop_runtime.py"

LAUNCH_SCRIPTS = ("启动工作台.cmd", "停止工作台.cmd", "浏览器模式.cmd")
HEALTH_PATH = "/api/health"
#: 主工作台必须可访问的页面（同时验证模板与静态资源真的在包里）。
SMOKE_PAGES = ("/", "/control", "/manage")
#: 子项目「内容编辑器」只有编辑页；页面集合与主工作台不同。
EDITOR_SMOKE_PAGES = ("/",)

#: 交付包必须包含的关键条目（ZIP 自检用）。
REQUIRED_MEMBERS = ("run.py", "启动工作台.cmd", "data/seed.json")

#: 收集的资源目录（相对项目根）。
RESOURCE_DIRS = (
    "templates",
    "static",
    "data",
    "docs",
    "runtime",
    "vendor",
    "desktop",
    "tools",
    "config",
)
#: 收集的单个文件。
RESOURCE_FILES = ("README.md", "requirements.txt", "run.py", "app.py")

#: 永远不进交付包的目录名（出现即排除，任意层级）。
EXCLUDED_DIR_NAMES = {
    ".git": "版本库元数据，不是交付物",
    ".backup": "本地备份目录",
    ".local-archive": "本地归档目录",
    "instance": "用户资料（数据库、媒体、content-backup-*.zip 内容备份），绝不进交付包",
    "evidence": "验收证据目录",
    ".qa": "质量检查过程产物",
    "__pycache__": "Python 字节码缓存",
    "tests": "测试代码",
    "node_modules": "前端依赖目录",
}
#: 文件名/目录名前缀（构建过程产生的临时物）。
EXCLUDED_NAME_PREFIXES = (".build-tmp-", ".tmp-", ".runtime-")
#: 排除的文件后缀。
EXCLUDED_SUFFIXES = (".pyc", ".pyo")
#: 额外的相对路径排除规则。
#: 改造过程记录与上游同步文档会引用旧品牌名/原始仓库名，属内部资料，
#: 不是模板产品的一部分，因此不随交付包分发。
_INTERNAL_RECORD_REASON = "内部记录（含旧品牌名或原始仓库名），不随模板交付"
EXTRA_EXCLUDED_PATHS = (
    ("tools/exe-build", "本机构建配方与产物（含机器相关绝对路径），不进交付包"),
    ("docs/模板改造-变更清单.md", _INTERNAL_RECORD_REASON),
    ("docs/模板改造-残留清单.md", _INTERNAL_RECORD_REASON),
    ("docs/模板改造-测试与验收记录.md", _INTERNAL_RECORD_REASON),
    ("docs/上游同步流程.md", _INTERNAL_RECORD_REASON),
)
#: 第三方载荷前缀：ZIP 复检时不套用项目排除规则（避免第三方包自带 tests/ 之类误报）。
THIRD_PARTY_PREFIXES = ("runtime/Lib/site-packages/", "vendor/wheels/", "desktop/runtime/")

CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


class BuildError(RuntimeError):
    """构建过程中的可预期失败：中止并给出明确原因。"""


# --------------------------------------------------------------------------
# 基础工具
# --------------------------------------------------------------------------
def emit(message: str = "") -> None:
    """打印一行中文输出（UTF-8，控制台安全）。"""
    try:
        print(message, flush=True)
    except Exception:  # 极端情况下控制台不可写也不能中断构建
        pass


def section(title: str) -> None:
    emit("")
    emit("=" * 4 + " " + title + " " + "=" * 4)


def digest_file(path: Path, chunk: int = 1024 * 1024) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as stream:
        while True:
            block = stream.read(chunk)
            if not block:
                break
            hasher.update(block)
    return hasher.hexdigest()


def digest_stream(stream, chunk: int = 1024 * 1024) -> tuple[str, int]:
    hasher = hashlib.sha256()
    size = 0
    while True:
        block = stream.read(chunk)
        if not block:
            break
        size += len(block)
        hasher.update(block)
    return hasher.hexdigest(), size


def human_bytes(size: int) -> str:
    value = float(size)
    for unit in ("B", "KB", "MB", "GB"):
        if value < 1024 or unit == "GB":
            return f"{value:.1f} {unit}" if unit != "B" else f"{int(value)} B"
        value /= 1024
    return f"{value:.1f} GB"


def same_path(left, right) -> bool:
    """宽松比较两个路径是否指向同一位置（Windows 大小写/斜杠差异）。"""
    try:
        return os.path.normcase(str(Path(left).resolve())) == os.path.normcase(str(Path(right).resolve()))
    except (OSError, ValueError):
        return False


def free_port() -> int:
    """向系统要一个空闲端口（绑定后再释放，随后由被测服务占用）。"""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def sanitize_slug(value: str) -> str:
    """把配置里的短名规范成可安全用于文件名的形式。"""
    cleaned = []
    for char in (value or "").strip().lower():
        if char.isascii() and (char.isalnum() or char in "._-"):
            cleaned.append(char)
        elif char in " \t/\\":
            cleaned.append("-")
    slug = "".join(cleaned).strip("-._")
    while "--" in slug:
        slug = slug.replace("--", "-")
    return slug


def sanitize_version(value: str) -> str:
    """版本号只保留文件名安全字符。"""
    cleaned = [char if (char.isascii() and (char.isalnum() or char in "._+")) else "-" for char in (value or "").strip()]
    return "".join(cleaned).strip("-._")


def sanitize_filename(value: str) -> str:
    """把应用名规范成可用的文件名（保留中文，去掉 Windows 非法字符）。"""
    cleaned = [char for char in (value or "").strip() if char not in '\\/:*?"<>|' and ord(char) >= 32]
    return "".join(cleaned).strip().strip(".")


def ask_yes_no(question: str, default: bool = False) -> bool:
    """交互式询问；非交互环境直接返回默认值。"""
    if not (sys.stdin is not None and sys.stdin.isatty()):
        return default
    suffix = " [y/N] " if not default else " [Y/n] "
    try:
        answer = input(question + suffix).strip().lower()
    except (EOFError, KeyboardInterrupt):
        emit("")
        return default
    if not answer:
        return default
    return answer in {"y", "yes", "是", "1"}


def walk_files(base: Path, on_error=None) -> list[Path]:
    """递归列文件；遇到无权限/不可读的目录只记录并跳过，绝不中断构建。"""
    found: list[Path] = []
    stack = [base]
    while stack:
        current = stack.pop()
        try:
            entries = sorted(current.iterdir(), key=lambda item: item.name)
        except OSError as error:
            if on_error is not None:
                on_error(current, error)
            continue
        for entry in entries:
            try:
                if entry.is_dir() and not entry.is_symlink():
                    stack.append(entry)
                elif entry.is_file() or entry.is_symlink():
                    found.append(entry)
                else:
                    if on_error is not None:
                        on_error(entry, OSError("不是普通文件或目录"))
            except OSError as error:
                if on_error is not None:
                    on_error(entry, error)
    return sorted(found)


# --------------------------------------------------------------------------
# 配置中心：只读，缺失时优雅回退
# --------------------------------------------------------------------------
def _dotted(data, path: str, default=None):
    node = data
    for part in path.split("."):
        if not isinstance(node, dict) or part not in node:
            return default
        node = node[part]
    return node


def _clean(value):
    if isinstance(value, str):
        value = value.strip()
        return value or None
    if isinstance(value, (int, float)):
        return str(value)
    return None


def read_config_center(root: Path) -> dict:
    """读取应用名/版本等配置，返回 {'values':..., 'sources':[...], 'notes':[...]}。"""
    values: dict = {}
    sources: list[str] = []
    notes: list[str] = []

    reader = root / CONFIG_READER
    if reader.is_file():
        module = _import_reader(reader, notes)
        if module is not None:
            found = _values_from_reader(module)
            if found:
                values.update(found)
                sources.append(CONFIG_READER)
                notes.append(f"应用名与版本来自配置读取器 {CONFIG_READER}。")
            else:
                notes.append(f"{CONFIG_READER} 存在但没有可识别的配置项，改用 config/template.json。")
        else:
            notes.append(f"{CONFIG_READER} 无法导入，改用 config/template.json。")
    else:
        notes.append(f"未找到配置读取器 {CONFIG_READER}，改用 config/template.json 或内置默认值。")

    json_path = root / CONFIG_JSON
    json_values: dict = {}
    if json_path.is_file():
        try:
            raw = json.loads(json_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            notes.append(f"{CONFIG_JSON.as_posix()} 读取失败（{error}），使用已有值或内置默认值。")
            raw = None
        if isinstance(raw, dict):
            json_values = {
                "app_name": _clean(_dotted(raw, "app.name")),
                "slug": _clean(_dotted(raw, "app.slug")) or _clean(_dotted(raw, "app.app_id")),
                "version": _clean(_dotted(raw, "app.version")),
                "package_format": _clean(_dotted(raw, "package.format")),
                "package_temp_prefix": _clean(_dotted(raw, "package.temp_prefix")),
                "backup_prefix": _clean(_dotted(raw, "backup.filename_prefix")),
                "desktop_marker": _clean(_dotted(raw, "runtime.desktop_marker")),
                "editor_directory": _clean(_dotted(raw, "editor.directory")),
                "editor_app_id": _clean(_dotted(raw, "editor.app_id")),
                "editor_version": _clean(_dotted(raw, "editor.version")),
            }
            json_values = {key: value for key, value in json_values.items() if value}
            if json_values:
                sources.append(CONFIG_JSON.as_posix())
    else:
        notes.append(f"未找到 {CONFIG_JSON.as_posix()}。")

    for key, value in json_values.items():
        values.setdefault(key, value)

    missing = []
    for key, fallback in DEFAULTS.items():
        if not values.get(key):
            values[key] = fallback
            missing.append(key)
    if missing:
        if not sources:
            notes.append("配置中心不可用，已整体回退到内置默认值：" + "、".join(sorted(missing)) + "。")
        else:
            notes.append("以下配置项缺失，已回退到内置默认值：" + "、".join(sorted(missing)) + "。")

    slug = sanitize_slug(values["slug"])
    if slug != values["slug"]:
        notes.append(f"短名 {values['slug']!r} 含文件名不安全字符，已规范为 {slug!r}。")
    values["slug"] = slug or DEFAULTS["slug"]

    version = sanitize_version(values["version"])
    if version != values["version"]:
        notes.append(f"版本号 {values['version']!r} 含文件名不安全字符，已规范为 {version!r}。")
    values["version"] = version or DEFAULTS["version"]

    values["config_sources"] = sources
    values["config_notes"] = notes
    return {"values": values, "sources": sources, "notes": notes}


def _import_reader(path: Path, notes: list):
    """按文件路径导入 template_config.py（不依赖 sys.path）。"""
    import importlib.util

    previous = sys.dont_write_bytecode
    # 读配置不该在项目里留下 __pycache__。
    sys.dont_write_bytecode = True
    try:
        spec = importlib.util.spec_from_file_location("_build_package_template_config", path)
        if spec is None or spec.loader is None:
            return None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    except Exception as error:  # 配置读取器不得阻断打包
        notes.append(f"{path.name} 导入失败（{error!r}）。")
        return None
    finally:
        sys.dont_write_bytecode = previous


def _values_from_reader(module) -> dict:
    """兼容多种读取器写法：value()/load_config()/扁平常量。"""
    found: dict = {}

    reader = getattr(module, "value", None)
    if callable(reader):
        for key, dotted in (
            ("app_name", "app.name"),
            ("slug", "app.slug"),
            ("version", "app.version"),
            ("package_format", "package.format"),
            ("package_temp_prefix", "package.temp_prefix"),
            ("backup_prefix", "backup.filename_prefix"),
            ("desktop_marker", "runtime.desktop_marker"),
            ("editor_directory", "editor.directory"),
            ("editor_app_id", "editor.app_id"),
            ("editor_version", "editor.version"),
        ):
            try:
                found[key] = _clean(reader(dotted))
            except Exception:
                continue
        found = {key: value for key, value in found.items() if value}
        if found:
            return found

    loader = getattr(module, "load_config", None)
    if callable(loader):
        try:
            data = loader()
        except Exception:
            data = None
        if isinstance(data, dict):
            for key, dotted in (
                ("app_name", "app.name"),
                ("slug", "app.slug"),
                ("version", "app.version"),
                ("package_format", "package.format"),
                ("package_temp_prefix", "package.temp_prefix"),
                ("backup_prefix", "backup.filename_prefix"),
                ("desktop_marker", "runtime.desktop_marker"),
                ("editor_directory", "editor.directory"),
                ("editor_app_id", "editor.app_id"),
                ("editor_version", "editor.version"),
            ):
                found.setdefault(key, _clean(_dotted(data, dotted)))
            found = {key: value for key, value in found.items() if value}
            if found:
                return found

    for key, names in (
        ("app_name", ("APP_NAME", "APPLICATION_NAME")),
        ("slug", ("APP_SLUG", "APP_ID", "SLUG")),
        ("version", ("APP_VERSION", "VERSION")),
        ("package_format", ("PACKAGE_FORMAT",)),
        ("package_temp_prefix", ("PACKAGE_TEMP_PREFIX",)),
        ("backup_prefix", ("BACKUP_PREFIX",)),
        ("desktop_marker", ("DESKTOP_MARKER",)),
        ("editor_directory", ("EDITOR_DIRECTORY",)),
        ("editor_app_id", ("EDITOR_APP_ID",)),
        ("editor_version", ("EDITOR_VERSION",)),
    ):
        for name in names:
            value = _clean(getattr(module, name, None))
            if value:
                found[key] = value
                break
    return found


# --------------------------------------------------------------------------
# 子进程辅助（一律继承 stdio 或重定向到文件，不使用管道）
# --------------------------------------------------------------------------
def child_env(tmp_dir: Path | None) -> dict:
    env = os.environ.copy()
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8:replace"
    # 冒烟测试会在临时交付目录里导入项目模块；禁止写字节码，避免 __pycache__ 混进 ZIP。
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env.pop("ELECTRON_RUN_AS_NODE", None)
    env.pop("NODE_OPTIONS", None)
    if tmp_dir is not None:
        try:
            scratch = tmp_dir / "tmp"
            scratch.mkdir(parents=True, exist_ok=True)
            env["TMP"] = str(scratch)
            env["TEMP"] = str(scratch)
        except OSError:
            pass
    return env


def run_command(command, cwd: Path | None = None, env: dict | None = None, allow_fail: bool = False,
                quiet: bool = False, log_file: Path | None = None) -> int:
    """运行外部命令并显示其输出（继承 stdio；quiet 丢弃输出；log_file 重定向到文件）。"""
    preview = " ".join(str(part) for part in command)
    if "\n" in preview:
        preview = preview.splitlines()[0] + " …（内联脚本已省略）"
    emit("  $ " + preview)
    kwargs = {"cwd": str(cwd) if cwd else None, "env": env}
    handle = None
    if log_file is not None:
        handle = log_file.open("ab")
        kwargs["stdout"] = handle
        kwargs["stderr"] = subprocess.STDOUT
        kwargs["stdin"] = subprocess.DEVNULL
    elif quiet:
        kwargs["stdout"] = subprocess.DEVNULL
        kwargs["stderr"] = subprocess.DEVNULL
        kwargs["stdin"] = subprocess.DEVNULL
    try:
        code = subprocess.run([str(part) for part in command], check=False, **kwargs).returncode
    finally:
        if handle is not None:
            handle.close()
    if code != 0 and not allow_fail:
        raise BuildError("命令执行失败（退出码 %d）：%s" % (code, " ".join(str(part) for part in command)))
    return code


def file_tail(path: Path, lines: int = 20) -> str:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return "（没有可用的日志文件）"
    tail = [line for line in text.splitlines() if line.strip()][-lines:]
    return "\n".join("      | " + line for line in tail) if tail else "（日志为空）"


def run_python_probe(python: Path, script: str, report_path: Path, env: dict, label: str) -> dict:
    """让目标 Python 把探测结果写成 JSON 文件再读回来（避免管道）。"""
    # json.dumps 生成合法的 Python 字符串字面量，避免 Windows 路径里的 \r \t \u 被当成转义。
    code = script.replace("__REPORT__", json.dumps(str(report_path)))
    code = "import json, sys\n" + code
    log_path = report_path.with_suffix(".log")
    for stale in (report_path, log_path):
        try:
            stale.unlink()
        except OSError:
            pass
    code_result = run_command([str(python), "-X", "utf8", "-c", code], env=env, allow_fail=True,
                              log_file=log_path)
    if code_result != 0:
        raise BuildError(f"{label}失败：目标解释器退出码 {code_result}。\n      " + file_tail(log_path))
    try:
        return json.loads(report_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise BuildError(f"{label}失败：无法读取探测结果（{error}）。\n      " + file_tail(log_path)) from None


DEPENDENCY_PROBE = """
import importlib.metadata as metadata
import importlib.util as util
report = {}
report["python"] = sys.version.split()[0]
report["executable"] = sys.executable
missing = [name for name in ("flask", "waitress", "jinja2", "PIL") if util.find_spec(name) is None]
report["missing"] = missing
versions = {}
for module_name, package_name in (("flask", "Flask"), ("waitress", "waitress"), ("jinja2", "Jinja2"), ("PIL", "Pillow")):
    try:
        versions[module_name] = metadata.version(package_name)
    except Exception:
        versions[module_name] = None
report["versions"] = versions
report["sqlite3"] = util.find_spec("sqlite3") is not None
with open(__REPORT__, "w", encoding="utf-8") as handle:
    json.dump(report, handle, ensure_ascii=False)
"""

PYINSTALLER_PROBE = """
report = {}
try:
    import PyInstaller
    report["present"] = True
    report["version"] = getattr(PyInstaller, "__version__", "unknown")
    report["path"] = getattr(PyInstaller, "__file__", "")
except Exception as error:
    report["present"] = False
    report["error"] = repr(error)
with open(__REPORT__, "w", encoding="utf-8") as handle:
    json.dump(report, handle, ensure_ascii=False)
"""


# --------------------------------------------------------------------------
# 打包主流程
# --------------------------------------------------------------------------
class Packager:
    def __init__(self, args, config: dict, output_dir: Path):
        self.args = args
        self.config = config
        self.values = config["values"]
        self.output_dir = output_dir
        self.started = time.monotonic()
        self.steps: list[dict] = []
        self.excludes: dict[tuple[str, str], dict] = {}
        self.notes: list[str] = []
        self.unreadable: list[str] = []
        self.tmp_root: Path | None = None
        self.stage: Path | None = None
        self.work: Path | None = None
        self.smoke_dir: Path | None = None
        self.zip_path: Path | None = None
        self.zip_name = ""
        self.python: Path = ROOT / "runtime" / "python.exe"
        self.runtime_info: dict = {}
        self.desktop: dict = {}
        self.exe_info: dict | None = None
        self.editor_info: dict | None = None
        self.smoke_results: list[dict] = []
        self.archive_info: dict = {}
        self.members: list[dict] = []

    # -- 记录 -------------------------------------------------------------
    def step(self, name: str, status: str, detail: str = "") -> None:
        record = {"name": name, "status": status, "detail": detail,
                  "elapsed_seconds": round(time.monotonic() - self.started, 2)}
        self.steps.append(record)
        marker = {"done": "[完成]", "reused": "[复用]", "skipped": "[跳过]", "failed": "[失败]"}.get(status, f"[{status}]")
        emit(f"{marker} {name}" + (f"：{detail}" if detail else ""))

    def exclude(self, pattern: str, reason: str, example: str = "") -> int:
        record = self.excludes.setdefault((pattern, reason), {"pattern": pattern, "reason": reason, "count": 0,
                                                              "examples": []})
        record["count"] += 1
        if example and len(record["examples"]) < 3 and example not in record["examples"]:
            record["examples"].append(example)
        return record["count"]

    def note(self, message: str) -> None:
        self.notes.append(message)

    def walk_error(self, path: Path, error: OSError) -> None:
        """收集阶段遇到不可读的路径：记录到排除清单，不中断构建。"""
        try:
            relative = PurePosixPath(path.relative_to(ROOT).as_posix())
        except ValueError:
            relative = PurePosixPath(path.name)
        pattern = relative.as_posix()
        self.exclude("不可读路径", "无访问权限，已跳过（不影响交付包其余内容）", pattern)
        if pattern not in self.unreadable:
            self.unreadable.append(pattern)
            emit(f"  [!] 跳过不可读路径：{pattern}（{error}）")

    # -- 准备 -------------------------------------------------------------
    def prepare_output(self) -> None:
        self.output_dir.mkdir(parents=True, exist_ok=True)
        # 交付包文件名：<slug>-portable-<version>-<yyyymmdd>.zip
        self.zip_name = f"{self.values['slug']}-portable-{self.values['version']}-{datetime.now():%Y%m%d}.zip"
        self.zip_path = self.output_dir / self.zip_name

    def gate_existing_zip(self) -> None:
        """目标 ZIP 已存在时先询问；非交互环境中止而不是静默覆盖。"""
        if self.zip_path is None or not self.zip_path.exists() or self.args.rebuild:
            return
        interactive = sys.stdin is not None and sys.stdin.isatty()
        question = f"目标 ZIP 已存在：{self.zip_path}。是否覆盖重建？"
        overwrite = ask_yes_no(question, default=False) if interactive else False
        if not overwrite:
            raise BuildError(
                f"目标 ZIP 已存在，未覆盖：{self.zip_path}\n"
                "      如需覆盖请加 --rebuild（交互式运行时会先询问）。"
            )

    def prepare_tmp(self) -> None:
        base = ROOT / f".build-tmp-{os.getpid()}"
        candidate = base
        index = 1
        while candidate.exists():
            index += 1
            candidate = ROOT / f".build-tmp-{os.getpid()}-{index}"
        candidate.mkdir(parents=True)
        self.tmp_root = candidate
        self.stage = candidate / "stage"
        self.work = candidate / "work"
        self.smoke_dir = candidate / "smoke"
        for path in (self.stage, self.work, self.smoke_dir):
            path.mkdir(parents=True, exist_ok=True)
        emit(f"临时工作目录：{candidate}")

    def cleanup(self) -> None:
        if self.tmp_root is None:
            return
        if self.args.keep_staging:
            emit(f"保留临时目录（--keep-staging）：{self.tmp_root}")
            return
        target = self.tmp_root.resolve()
        if target.parent != ROOT.resolve() or not target.name.startswith(".build-tmp-"):
            emit(f"安全检查未通过，未删除临时目录：{target}")
            return
        shutil.rmtree(target, ignore_errors=True)

    # -- 1. 运行时检查 -----------------------------------------------------
    def check_runtime(self) -> None:
        section("检查便携运行时与依赖")
        site = ROOT / "runtime" / "Lib" / "site-packages"
        if not self.python.is_file():
            raise BuildError(
                "未找到便携运行环境 runtime/python.exe。\n"
                f"      请先运行：{PREPARE_RUNTIME_HINT}\n"
                "      （该脚本会用 Python 官网嵌入式包重建运行环境，需要已安装的 Python 3.10+。）"
            )
        if not site.is_dir():
            raise BuildError(
                "未找到 runtime/Lib/site-packages，运行环境不完整。\n"
                f"      请先运行：{PREPARE_RUNTIME_HINT}"
            )

        names = {entry.name.lower() for entry in site.iterdir()}
        required = (("flask", "Flask"), ("waitress", "waitress"), ("jinja2", "jinja2"), ("pil", "PIL"))
        absent = [label for folder, label in required if folder not in names]
        if absent:
            raise BuildError(
                "便携运行环境缺少依赖：" + "、".join(absent) + "。\n"
                f"      请先运行：{PREPARE_RUNTIME_HINT}"
            )

        report_path = self.work / "runtime-report.json"
        report = run_python_probe(self.python, DEPENDENCY_PROBE, report_path, child_env(self.work),
                                  "运行时依赖探测")
        if report.get("missing"):
            raise BuildError(
                "便携运行环境无法导入依赖：" + "、".join(report["missing"]) + "。\n"
                f"      请先运行：{PREPARE_RUNTIME_HINT}"
            )
        if not report.get("sqlite3"):
            raise BuildError("便携运行环境缺少 sqlite3 模块；请重新运行 " + PREPARE_RUNTIME_HINT + "。")

        self.runtime_info = report
        versions = "、".join(
            f"{name} {report.get('versions', {}).get(module) or '未知'}"
            for module, name in (("flask", "Flask"), ("waitress", "waitress"), ("jinja2", "jinja2"), ("PIL", "Pillow"))
        )
        emit(f"  便携 Python：{report.get('python')}")
        emit(f"  依赖版本：{versions}")
        self.step("运行时与依赖检查", "done", f"Python {report.get('python')}，依赖齐备")

        warnings = self.cross_check_lock()
        for warning in warnings:
            emit("  [!] " + warning)
            self.note(warning)

    def cross_check_lock(self) -> list[str]:
        """对照 requirements.txt 与 tools/runtime-lock.json（只提示，不阻断）。"""
        messages: list[str] = []
        requirements = ROOT / "requirements.txt"
        lock_path = ROOT / "tools" / "runtime-lock.json"
        if not requirements.is_file() or not lock_path.is_file():
            messages.append("未同时找到 requirements.txt 与 tools/runtime-lock.json，跳过依赖锁定交叉核对。")
            return messages
        try:
            pins = [line.strip() for line in requirements.read_text(encoding="utf-8").splitlines()
                    if line.strip() and not line.strip().startswith("#")]
            lock = json.loads(lock_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            messages.append(f"依赖锁定文件读取失败（{error}），跳过交叉核对。")
            return messages
        normalize = lambda value: value.lower().replace("-", "_")
        required = {normalize(pin.replace("==", "-")) for pin in pins}
        locked = {normalize("-".join(str(entry.get("file", "")).split("-")[:2])) for entry in lock.get("wheels", [])}
        if required and locked and required != locked:
            messages.append("requirements.txt 与 tools/runtime-lock.json 不一致；"
                            "运行环境可能需要用 tools/prepare_runtime.py 重建。")
        self.runtime_info["requirements_pins"] = len(pins)
        self.runtime_info["locked_wheels"] = len(lock.get("wheels", []))
        return messages

    def desktop_info(self) -> dict:
        """检查可选的 Electron 桌面壳运行时。"""
        section("检查桌面壳运行时")
        runtime = ROOT / "desktop" / "runtime"
        executable = runtime / "electron.exe"
        info = {"path": "desktop/runtime", "present": executable.is_file()}
        if info["present"]:
            marker = self.read_desktop_marker(runtime)
            if marker:
                info["marker"] = marker.get("name")
                if marker.get("version"):
                    info["version"] = marker["version"]
            info["executable_sha256"] = digest_file(executable)
            emit(f"  已找到 desktop/runtime/electron.exe"
                 + (f"（版本 {info.get('version')}）" if info.get("version") else ""))
            self.step("桌面壳运行时检查", "done", "desktop/runtime 已就绪，将整体收进交付包")
        else:
            emit("  [!] 未找到 desktop/runtime/electron.exe：交付包将只有浏览器模式。")
            emit(f"      如需桌面壳，请先运行：{PREPARE_DESKTOP_HINT}")
            self.note("交付包缺少 desktop/runtime/electron.exe，用户只能使用浏览器模式。")
            self.step("桌面壳运行时检查", "skipped", "缺少 desktop/runtime/electron.exe（可先运行 " + PREPARE_DESKTOP_HINT + "）")
        self.desktop = info
        return info

    def read_desktop_marker(self, runtime: Path):
        """按配置中心的标记名读取运行时说明文件；找不到就退化为扫描 *.json。"""
        candidates = []
        marker_name = self.values.get("desktop_marker")
        if marker_name:
            candidates.append(runtime / marker_name)
        candidates.extend(sorted(runtime.glob("*.json")))
        for candidate in candidates:
            if not candidate.is_file():
                continue
            try:
                data = json.loads(candidate.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if isinstance(data, dict) and ("version" in data or "sha256" in data or "archive_sha256" in data):
                data.setdefault("name", candidate.name)
                return data
        return None

    # -- 2. PyInstaller ----------------------------------------------------
    def pyinstaller_report(self) -> dict:
        report_path = self.work / "pyinstaller-report.json"
        return run_python_probe(self.python, PYINSTALLER_PROBE, report_path, child_env(self.work),
                                "PyInstaller 探测")

    def ensure_pyinstaller(self) -> bool:
        report = self.pyinstaller_report()
        if report.get("present"):
            emit(f"  已检测到 PyInstaller {report.get('version')}（无需安装）。")
            return True
        emit("  当前便携运行环境没有 PyInstaller。")
        if not self.args.install_pyinstaller:
            emit("  本工具默认不联网安装；本次跳过 EXE 构建。")
            emit(f"  如需安装，可加参数 --install-pyinstaller，或手动执行：")
            emit(f'    "{self.python}" -m pip install pyinstaller')
            return False
        return self.install_pyinstaller()

    def install_pyinstaller(self) -> bool:
        emit("  已指定 --install-pyinstaller，开始安装（需要网络）……")
        env = child_env(self.work)
        pip_ok = run_command([str(self.python), "-m", "pip", "--version"], env=env, allow_fail=True,
                             quiet=True) == 0
        if not pip_ok:
            emit("  运行环境没有 pip（嵌入式 Python 默认不带），尝试 ensurepip ……")
            run_command([str(self.python), "-m", "ensurepip", "--upgrade", "--default-pip"], env=env,
                        allow_fail=True)
            pip_ok = run_command([str(self.python), "-m", "pip", "--version"], env=env, allow_fail=True,
                                 quiet=True) == 0
        if not pip_ok:
            emit("  ensurepip 不可用，尝试官方 get-pip.py ……")
            bootstrap = self.work / "get-pip.py"
            self.download("https://bootstrap.pypa.io/get-pip.py", bootstrap)
            run_command([str(self.python), str(bootstrap), "--no-warn-script-location"], env=env, allow_fail=True)
            pip_ok = run_command([str(self.python), "-m", "pip", "--version"], env=env, allow_fail=True,
                                 quiet=True) == 0
        if not pip_ok:
            raise BuildError(
                "无法为便携运行环境准备 pip，PyInstaller 安装中止。\n"
                f'      可手动执行："{self.python}" -m ensurepip 后重试，'
                "或用已安装的 Python 把 pyinstaller 安装到 runtime/Lib/site-packages。"
            )
        code = run_command([str(self.python), "-m", "pip", "install", "--no-warn-script-location",
                            "--disable-pip-version-check", "pyinstaller"], env=env, allow_fail=True)
        report = self.pyinstaller_report()
        if code != 0 or not report.get("present"):
            raise BuildError("PyInstaller 安装失败（退出码 %d）；请检查网络后重试，或手动安装。" % code)
        emit(f"  PyInstaller {report.get('version')} 安装完成。")
        return True

    def download(self, url: str, target: Path) -> None:
        emit(f"  下载 {url}")
        request = urllib.request.Request(url, headers={"User-Agent": self.values["slug"] + "-build"})
        try:
            with urllib.request.urlopen(request, timeout=120) as response, target.open("wb") as output:
                shutil.copyfileobj(response, output, 1024 * 1024)
        except (OSError, urllib.error.URLError) as error:
            raise BuildError(f"下载失败：{url}（{error}）") from None

    def existing_exe(self) -> Path | None:
        candidate = ROOT / "tools" / "exe-build" / "dist" / (self.exe_name + ".exe")
        return candidate if candidate.is_file() else None

    @property
    def exe_name(self) -> str:
        name = sanitize_filename(self.values["app_name"]) or "workbench"
        return name

    def write_spec(self) -> Path:
        """生成主工作台单文件 EXE 的 PyInstaller 配方。"""
        root = ROOT
        datas = []
        for folder in ("templates", "static"):
            if (root / folder).is_dir():
                datas.append((str(root / folder), folder))
        seed = root / "data" / "seed.json"
        if seed.is_file():
            datas.append((str(seed), "data"))
        for name in ("main.cjs", "preload.cjs", "package.json"):
            asset = root / "desktop" / name
            if asset.is_file():
                datas.append((str(asset), "desktop"))
        binaries = []
        if self.args.exe_embed_desktop_runtime:
            desktop_runtime = root / "desktop" / "runtime"
            if not (desktop_runtime / "electron.exe").is_file():
                raise BuildError(
                    "--exe-embed-desktop-runtime 需要 desktop/runtime/electron.exe。\n"
                    f"      请先运行：{PREPARE_DESKTOP_HINT}"
                )
            binaries.append((str(desktop_runtime), "desktop/runtime"))
        hidden = ["app", "run", "storage", "import_parser", "script_package", "script_merge"]
        lines = [
            "# -*- mode: python ; coding: utf-8 -*-",
            "# 由 tools/build_package.py 自动生成（仅本次构建使用，可随时删除）。",
            "from pathlib import Path",
            "",
            f"ROOT = Path({str(root)!r})",
            "ENTRY = ROOT / 'tools' / 'exe_entry.py'",
            f"DATAS = {datas!r}",
            f"BINARIES = {binaries!r}",
            "",
            "a = Analysis(",
            "    [str(ENTRY)],",
            "    pathex=[str(ROOT)],",
            "    binaries=BINARIES,",
            "    datas=DATAS,",
            f"    hiddenimports={hidden!r},",
            "    hookspath=[],",
            "    hooksconfig={},",
            "    runtime_hooks=[],",
            "    excludes=[],",
            "    noarchive=False,",
            "    optimize=0,",
            ")",
            "pyz = PYZ(a.pure)",
            "",
            "exe = EXE(",
            "    pyz,",
            "    a.scripts,",
            "    a.binaries,",
            "    a.datas,",
            "    [],",
            f"    name={self.exe_name!r},",
            "    debug=False,",
            "    bootloader_ignore_signals=False,",
            "    strip=False,",
            "    upx=False,",
            "    upx_exclude=[],",
            "    runtime_tmpdir=None,",
            f"    console={bool(self.args.exe_console)!r},",
            "    disable_windowed_traceback=False,",
            "    argv_emulation=False,",
            "    target_arch=None,",
            "    codesign_identity=None,",
            "    entitlements_file=None,",
            ")",
        ]
        spec_path = self.work / (self.exe_name + ".spec")
        spec_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        emit(f"  已生成打包配方：{spec_path.name}")
        return spec_path

    def build_workbench_exe(self) -> dict:
        section("构建主工作台单文件 EXE")
        if self.args.skip_exe:
            self.step("主工作台 EXE", "skipped", "已指定 --skip-exe")
            return {"status": "skipped", "reason": "--skip-exe"}
        existing = self.existing_exe()
        if existing is not None and not self.args.rebuild:
            interactive = sys.stdin is not None and sys.stdin.isatty()
            question = f"检测到已有 EXE：{existing}。是否重新构建（覆盖）？"
            if interactive:
                rebuild = ask_yes_no(question, default=False)
            else:
                rebuild = False
                emit(f"  非交互环境：默认不覆盖已有 EXE（加 --rebuild 可强制重建）。")
            if not rebuild:
                target = self.stage / (self.exe_name + ".exe")
                shutil.copy2(existing, target)
                self.step("主工作台 EXE", "reused", f"复用已有产物 {existing}（未重新构建）")
                self.note(f"EXE 未重新构建，复用 {existing}；如需重建请加 --rebuild。")
                return {"status": "reused", "source": str(existing), "path": target, "name": target.name,
                        "size": target.stat().st_size, "sha256": digest_file(target)}

        if not self.ensure_pyinstaller():
            self.step("主工作台 EXE", "skipped", "便携运行环境没有 PyInstaller（未指定 --install-pyinstaller）")
            self.note("未构建 EXE：便携运行环境缺少 PyInstaller。交付包仍可用 run.py / 启动工作台.cmd 运行。")
            return {"status": "skipped", "reason": "缺少 PyInstaller"}

        spec_path = self.write_spec()
        dist_dir = self.work / "exe-dist"
        build_dir = self.work / "exe-build"
        command = [str(self.python), "-X", "utf8", "-m", "PyInstaller", "--noconfirm", "--clean",
                   "--distpath", str(dist_dir), "--workpath", str(build_dir), str(spec_path)]
        run_command(command, cwd=ROOT, env=child_env(self.work))
        produced = sorted(path for path in dist_dir.glob("*.exe") if path.is_file())
        if not produced:
            raise BuildError(f"PyInstaller 未产出 EXE（目录：{dist_dir}）；请检查上面的构建输出。")
        built = produced[0]
        if len(produced) > 1:
            self.note("PyInstaller 产出了多个 EXE，使用第一个：" + "、".join(path.name for path in produced))
        keep_dir = ROOT / "tools" / "exe-build" / "dist"
        keep_dir.mkdir(parents=True, exist_ok=True)
        keep = keep_dir / (self.exe_name + ".exe")
        shutil.copy2(built, keep)
        target = self.stage / (self.exe_name + ".exe")
        shutil.copy2(built, target)
        info = {"status": "built", "source": str(built), "path": target, "name": target.name,
                "size": target.stat().st_size, "sha256": digest_file(target), "reuse_copy": str(keep),
                "console": bool(self.args.exe_console),
                "embedded_desktop_runtime": bool(self.args.exe_embed_desktop_runtime)}
        self.step("主工作台 EXE", "done", f"{target.name}（{human_bytes(info['size'])}）")
        self.note(f"EXE 已构建并留档到 {keep}，下次可复用（默认不覆盖，除非加 --rebuild）。")
        return info

    # -- 3. 编辑器 EXE -----------------------------------------------------
    def editor_dir(self) -> Path | None:
        if self.args.editor_dir:
            candidate = Path(self.args.editor_dir)
            candidate = candidate if candidate.is_absolute() else (ROOT / candidate)
            return candidate.resolve() if candidate.is_dir() else None
        configured = self.values.get("editor_directory") or DEFAULTS["editor_directory"]
        candidate = ROOT / configured
        if candidate.is_dir():
            return candidate
        # 兜底：扫描项目根下带 build/*.spec 的子项目（不依赖具体目录名）。
        for child in sorted(ROOT.iterdir()):
            if child.is_dir() and not child.name.startswith(".") and (child / "build").is_dir():
                if any((child / "build").glob("*.spec")):
                    self.note(f"配置的编辑器目录 {configured!r} 不存在，改用发现的子项目 {child.name!r}。")
                    return child
        return None

    def editor_spec(self, editor: Path) -> Path | None:
        specs = sorted((editor / "build").glob("*.spec")) if (editor / "build").is_dir() else []
        if not specs:
            return None
        preferred = [path for path in specs if path.stem == editor.name]
        if preferred:
            return preferred[0]
        if len(specs) > 1:
            self.note("编辑器目录有多个 .spec，使用第一个：" + "、".join(path.name for path in specs))
        return specs[0]

    def build_editor_exe(self) -> dict | None:
        if not self.args.with_editor:
            return None
        section("构建内容编辑器 EXE（--with-editor）")
        editor = self.editor_dir()
        if editor is None:
            self.step("内容编辑器 EXE", "skipped", "未找到编辑器子项目目录（可用 --editor-dir 指定）")
            return {"status": "skipped", "reason": "未找到编辑器子项目目录"}
        spec_path = self.editor_spec(editor)
        if spec_path is None:
            emit(f"  {editor} 下没有 build/*.spec 配方。")
            self.step("内容编辑器 EXE", "skipped", "子项目没有可复用的 PyInstaller 配方（build/*.spec）")
            return {"status": "skipped", "reason": "没有 build/*.spec 配方", "editor_dir": str(editor)}
        desktop_runtime = ROOT / "desktop" / "runtime" / "electron.exe"
        if not desktop_runtime.is_file():
            emit(f"  配方需要 {desktop_runtime}，当前不存在。")
            self.step("内容编辑器 EXE", "skipped", "缺少 desktop/runtime/electron.exe（先运行 " + PREPARE_DESKTOP_HINT + "）")
            return {"status": "skipped", "reason": "缺少 desktop/runtime/electron.exe", "editor_dir": str(editor)}
        if not self.ensure_pyinstaller():
            self.step("内容编辑器 EXE", "skipped", "便携运行环境没有 PyInstaller（未指定 --install-pyinstaller）")
            return {"status": "skipped", "reason": "缺少 PyInstaller", "editor_dir": str(editor)}

        dist_dir = self.work / "editor-dist"
        build_dir = self.work / "editor-build"
        command = [str(self.python), "-X", "utf8", "-m", "PyInstaller", "--noconfirm", "--clean",
                   "--distpath", str(dist_dir), "--workpath", str(build_dir), str(spec_path)]
        run_command(command, cwd=editor, env=child_env(self.work))
        produced = sorted(path for path in dist_dir.glob("*.exe") if path.is_file())
        if not produced:
            raise BuildError(f"编辑器配方未产出 EXE（目录：{dist_dir}）；请检查上面的构建输出。")
        built = produced[0]
        if len(produced) > 1:
            self.note("编辑器配方产出了多个 EXE，使用第一个：" + "、".join(path.name for path in produced))
        folder = self.stage / editor.name
        folder.mkdir(parents=True, exist_ok=True)
        target = folder / built.name
        shutil.copy2(built, target)
        info = {"status": "built", "editor_dir": str(editor), "spec": str(spec_path), "source": str(built),
                "path": target, "name": target.name, "package_folder": editor.name,
                "size": target.stat().st_size, "sha256": digest_file(target),
                "app_id": self.values.get("editor_app_id"), "version": self.values.get("editor_version")}
        self.step("内容编辑器 EXE", "done", f"{editor.name}/{target.name}（{human_bytes(info['size'])}）")
        return info

    # -- 4. 收集资源 -------------------------------------------------------
    def exclusion_reason(self, relative: PurePosixPath) -> tuple[str, str] | None:
        for part in relative.parts:
            if part in EXCLUDED_DIR_NAMES:
                return (part + "/", f"排除目录：{EXCLUDED_DIR_NAMES[part]}")
            for prefix in EXCLUDED_NAME_PREFIXES:
                if part.startswith(prefix):
                    return (prefix + "*", "临时/构建过程目录，不进交付包")
        name = relative.name
        if name.lower().endswith(EXCLUDED_SUFFIXES):
            return ("*.pyc/*.pyo", "Python 编译缓存")
        text = relative.as_posix()
        for extra, reason in EXTRA_EXCLUDED_PATHS:
            if text == extra or text.startswith(extra + "/"):
                return (extra + "/", reason)
        if relative.parts and relative.parts[0] == "vendor" and name.lower().endswith(".zip"):
            if not self.args.with_vendor_archives:
                return ("vendor/*.zip", "大型离线归档（仅维护用；重建运行环境时按官方来源重新下载）")
        return None

    def collect(self) -> list[str]:
        section("收集交付资源")
        assert self.stage is not None and self.tmp_root is not None
        copied: list[str] = []
        output_resolved = self.output_dir.resolve()
        tmp_resolved = self.tmp_root.resolve()

        sources: list[Path] = [ROOT / name for name in RESOURCE_DIRS]
        sources += [ROOT / name for name in RESOURCE_FILES]
        sources += sorted(ROOT.glob("*.py"))
        for name in LAUNCH_SCRIPTS:
            sources.append(ROOT / name)

        seen: set[str] = set()
        for source in sources:
            if not source.exists():
                absents = self.exclude(source.name, "项目里不存在，本次未收集", source.name)
                if absents == 1:
                    self.note(f"未找到 {source.name}，交付包中不含该项。")
                continue
            if source.is_dir():
                candidates = walk_files(source, self.walk_error)
            else:
                candidates = [source]
            for path in candidates:
                if not path.is_file() and not path.is_symlink():
                    continue
                try:
                    relative = PurePosixPath(path.relative_to(ROOT).as_posix())
                except ValueError:
                    self.exclude("项目外的路径", "资源必须位于项目目录内", str(path))
                    continue
                if path.is_symlink():
                    self.exclude("符号链接", "链接目标需人工确认", relative.as_posix())
                    continue
                reason = self.exclusion_reason(relative)
                if reason:
                    self.exclude(reason[0], reason[1], relative.as_posix())
                    continue
                try:
                    resolved = path.resolve()
                except OSError:
                    resolved = path
                if resolved.is_relative_to(output_resolved) or resolved.is_relative_to(tmp_resolved):
                    self.exclude("dist/ 与临时目录", "构建输出自身，不进交付包", relative.as_posix())
                    continue
                key = relative.as_posix()
                if key in seen:
                    continue
                seen.add(key)
                target = self.stage / Path(*relative.parts)
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(path, target)
                copied.append(key)

        if self.exe_info and self.exe_info.get("path"):
            copied.append(Path(self.exe_info["path"]).name)
        if self.editor_info and self.editor_info.get("path"):
            copied.append(Path(self.editor_info["path"]).relative_to(self.stage).as_posix())

        emit(f"  已收集 {len(copied)} 个文件到临时交付目录。")
        for record in sorted(self.excludes.values(), key=lambda item: item["pattern"]):
            emit(f"  排除 {record['pattern']}（{record['count']} 项）：{record['reason']}")
        self.step("收集交付资源", "done", f"{len(copied)} 个文件")
        return copied

    # -- 5. 冒烟测试 -------------------------------------------------------
    def smoke(self, label: str, command: list[str], cwd: Path, data_dir: Path, expect_data_dir: Path,
              timeout: float, extra_notes: str = "", pages=SMOKE_PAGES) -> dict:
        """在临时数据目录里启动服务并断言健康检查与页面可用。"""
        log_path = self.smoke_dir / (sanitize_filename(label).replace(" ", "_") + ".log")
        data_dir.mkdir(parents=True, exist_ok=True)
        for leftover in ("server.json", "server.lock"):
            try:
                (data_dir / leftover).unlink()
            except OSError:
                pass
        port = free_port()
        command = [str(part) for part in command] + ["--no-browser", "--port", str(port),
                                                     "--data-dir", str(data_dir)]
        emit(f"  启动：{' '.join(command)}")
        started = time.monotonic()
        handle = log_path.open("ab")
        process = subprocess.Popen(command, cwd=str(cwd), stdin=subprocess.DEVNULL, stdout=handle,
                                   stderr=subprocess.STDOUT, env=child_env(self.smoke_dir),
                                   creationflags=CREATE_NO_WINDOW)
        try:
            base_url, payload = self.wait_for_health(process, data_dir, port, timeout, log_path, label)
            if payload.get("ok") is not True:
                raise BuildError(f"{label}：/api/health 未返回 ok=true（实际：{payload!r}）{extra_notes}")
            reported = payload.get("data_dir")
            if not reported or not same_path(reported, expect_data_dir):
                raise BuildError(
                    f"{label}：/api/health 的 data_dir 与临时数据目录不一致。\n"
                    f"      期望：{expect_data_dir}\n      实际：{reported}{extra_notes}"
                )
            page_results = []
            for page in pages:
                status = self.http_status(base_url.rstrip("/") + page, timeout=10.0)
                page_results.append({"path": page, "status": status})
                if status != 200:
                    raise BuildError(f"{label}：GET {page} 返回 {status}，期望 200{extra_notes}")
            elapsed = round(time.monotonic() - started, 2)
            emit(f"  健康检查通过（app={payload.get('app')!r}，data_dir 一致），页面 "
                 + "、".join(f"{item['path']}={item['status']}" for item in page_results))
            app_id = payload.get("app")
            configured = self.values.get("slug")
            if app_id and configured and app_id != configured:
                message = (f"{label} 报告的应用标识 {app_id!r} 与配置中心的短名 {configured!r} 不一致；"
                           "如果品牌替换还没做完，请确认这是预期状态。")
                emit("  [!] " + message)
                self.note(message)
            return {"label": label, "command": command, "cwd": str(cwd), "data_dir": str(data_dir),
                    "port": port, "health": payload, "pages": page_results, "elapsed_seconds": elapsed,
                    "log": str(log_path), "status": "passed"}
        finally:
            self.stop_process(process, data_dir, handle, log_path, label)

    def wait_for_health(self, process, data_dir: Path, port: int, timeout: float, log_path: Path, label: str):
        deadline = time.monotonic() + timeout
        candidates = [port + offset for offset in range(0, 11)]
        while time.monotonic() < deadline:
            record = self.read_server_record(data_dir)
            urls = []
            if record and record.get("url"):
                urls.append(str(record["url"]))
            urls += [f"http://127.0.0.1:{item}/" for item in candidates]
            for url in urls:
                payload = self.http_json(url.rstrip("/") + HEALTH_PATH, timeout=1.5)
                if isinstance(payload, dict) and payload.get("ok") is not None:
                    return url.rstrip("/"), payload
            if process.poll() is not None:
                raise BuildError(
                    f"{label}：进程在提供服务前已退出（退出码 {process.returncode}）。\n"
                    + self.log_tail(log_path)
                )
            time.sleep(0.4)
        raise BuildError(f"{label}：等待 {int(timeout)} 秒仍未就绪。\n" + self.log_tail(log_path))

    def read_server_record(self, data_dir: Path):
        try:
            return json.loads((data_dir / "server.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    def stop_process(self, process, data_dir: Path, handle, log_path: Path, label: str) -> None:
        """先请求优雅退出（带 CSRF 凭据），再兜底结束进程树。"""
        graceful = "未尝试"
        try:
            if process.poll() is None:
                record = self.read_server_record(data_dir) or {}
                url = str(record.get("url") or "").rstrip("/")
                if url.startswith("http://127.0.0.1"):
                    headers = {"X-Stop-Token": str(record.get("token", ""))}
                    token = self.csrf_token_for(url)
                    if token:
                        headers["X-CSRF-Token"] = token
                    status = self.http_post(url + "/api/shutdown", headers=headers, timeout=5.0)
                    graceful = f"POST /api/shutdown -> {status}"
                    if status != 200:
                        emit(f"  {label} 优雅停止未生效（{graceful}），改用强制结束。")
                    for _ in range(30):
                        if process.poll() is not None:
                            break
                        time.sleep(0.2)
        finally:
            try:
                handle.close()
            except OSError:
                pass

            if process.poll() is not None:
                if graceful.startswith("POST /api/shutdown -> 200"):
                    emit(f"  {label} 已优雅停止。")
            else:
                emit(f"  {label} 仍在运行（{graceful}），强制结束进程树。")
                subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], check=False,
                               stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                for _ in range(50):
                    if process.poll() is not None:
                        break
                    time.sleep(0.2)
                if process.poll() is None:
                    try:
                        process.kill()
                        process.wait(timeout=10)
                    except (OSError, subprocess.TimeoutExpired):
                        emit(f"  [!] {label} 进程仍未结束（PID {process.pid}），请手动检查。")

    def isolated_exe_copy(self, exe_path: Path, tag: str) -> Path:
        """把 EXE 复制到临时目录后再运行，避免它就地释放/覆盖交付目录里的内容。"""
        folder = self.smoke_dir / tag
        folder.mkdir(parents=True, exist_ok=True)
        target = folder / exe_path.name
        shutil.copy2(exe_path, target)
        return target

    def run_smoke_tests(self) -> None:
        section("产物冒烟测试")
        if self.args.skip_smoke:
            self.step("冒烟测试", "skipped", "已指定 --skip-smoke")
            self.note("已跳过冒烟测试（--skip-smoke），交付包只做了 ZIP 结构校验。")
            return
        timeout = float(self.args.smoke_timeout)
        staged_run = self.stage / "run.py"
        if not staged_run.is_file():
            raise BuildError("临时交付目录缺少 run.py，无法做冒烟测试。")
        data_dir = self.smoke_dir / "python-data"
        result = self.smoke("run.py（交付包源码，浏览器模式）", [str(self.python), "-X", "utf8", "run.py"],
                            self.stage, data_dir, data_dir, timeout)
        self.smoke_results.append(result)
        self.step("冒烟测试 run.py", "done", f"健康检查与页面均通过（{result['elapsed_seconds']} 秒）")

        if self.exe_info and self.exe_info.get("path"):
            staged_exe = Path(self.exe_info["path"])
            run_exe = self.isolated_exe_copy(staged_exe, "exe-run")
            data_dir = self.smoke_dir / "exe-data"
            note = "\n      提示：EXE 若无法启动，请查看数据目录下的 launcher.log，或先用 run.py 验证。"
            result = self.smoke(f"{staged_exe.stem}.exe（单文件版）", [str(run_exe)], run_exe.parent, data_dir,
                                data_dir, max(timeout, 180.0), extra_notes=note)
            self.smoke_results.append(result)
            self.exe_info["smoke"] = "passed"
            self.exe_info["smoke_copy"] = str(run_exe)
            self.step("冒烟测试 主 EXE", "done", f"健康检查与页面均通过（{result['elapsed_seconds']} 秒）")
        else:
            self.step("冒烟测试 主 EXE", "skipped", "本次没有构建或复用 EXE")

        if self.editor_info and self.editor_info.get("path"):
            staged_exe = Path(self.editor_info["path"])
            run_exe = self.isolated_exe_copy(staged_exe, "editor-run")
            data_dir = self.smoke_dir / "editor-data"
            result = self.smoke(f"{staged_exe.stem}.exe（编辑器）", [str(run_exe)], run_exe.parent, data_dir,
                                data_dir, max(timeout, 180.0), pages=EDITOR_SMOKE_PAGES)
            self.smoke_results.append(result)
            self.editor_info["smoke"] = "passed"
            self.editor_info["smoke_copy"] = str(run_exe)
            self.step("冒烟测试 编辑器 EXE", "done", f"健康检查通过（{result['elapsed_seconds']} 秒）")

    def http_json(self, url: str, timeout: float):
        try:
            request = urllib.request.Request(url, headers={"Accept": "application/json"})
            with urllib.request.urlopen(request, timeout=timeout) as response:
                if response.status != 200:
                    return None
                return json.loads(response.read().decode("utf-8", "replace"))
        except (OSError, ValueError, urllib.error.URLError, http.client.HTTPException):
            return None

    def http_status(self, url: str, timeout: float) -> int:
        try:
            request = urllib.request.Request(url, headers={"Accept": "text/html"})
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return int(response.status)
        except urllib.error.HTTPError as error:
            return int(error.code)
        except (OSError, ValueError, urllib.error.URLError, http.client.HTTPException):
            return 0

    def http_text(self, url: str, timeout: float) -> str:
        try:
            with urllib.request.urlopen(url, timeout=timeout) as response:
                return response.read().decode("utf-8", "replace")
        except (OSError, ValueError, urllib.error.URLError, http.client.HTTPException):
            return ""

    def http_post(self, url: str, headers: dict, timeout: float, payload: bytes = b"{}") -> int:
        """POST 并返回状态码（0 表示连接失败）；不抛异常。"""
        merged = {"Content-Type": "application/json", "Accept": "application/json"}
        merged.update(headers)
        try:
            request = urllib.request.Request(url, data=payload, headers=merged, method="POST")
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return int(response.status)
        except urllib.error.HTTPError as error:
            return int(error.code)
        except (OSError, ValueError, urllib.error.URLError, http.client.HTTPException):
            return 0

    def csrf_token_for(self, base_url: str) -> str | None:
        """取本机页面的 CSRF 凭据：先试 /api/library，再从首页 HTML 里找。"""
        payload = self.http_json(base_url + "/api/library", timeout=5.0)
        if isinstance(payload, dict):
            token = payload.get("csrf_token")
            if isinstance(token, str) and token.strip():
                return token.strip()
        page = self.http_text(base_url + "/", timeout=5.0)
        # 兼容 <meta name="csrf" content="…">、csrf_token = "…" 等写法。
        match = re.search(r"csrf[^\n]{0,80}?[\"']([A-Za-z0-9._-]{16,})[\"']", page, re.IGNORECASE)
        return match.group(1) if match else None

    @staticmethod
    def log_tail(path: Path, lines: int = 30) -> str:
        return f"      日志尾部（{path.name}）：\n" + file_tail(path, lines)

    # -- 6. 打包 ZIP 与校验 ------------------------------------------------
    def make_zip(self) -> dict:
        section("打包 ZIP 并校验")
        assert self.stage is not None and self.zip_path is not None
        partial = self.zip_path.with_name(self.zip_path.name + ".partial")
        for stale in (partial,):
            try:
                stale.unlink()
            except OSError:
                pass
        prefix = self.zip_path.stem
        count = 0
        with zipfile.ZipFile(partial, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
            for path in sorted(item for item in self.stage.rglob("*") if item.is_file()):
                relative = PurePosixPath(path.relative_to(self.stage).as_posix())
                late = self.exclusion_reason(relative)
                if late:
                    # 只可能是冒烟测试之后才出现的构建残留（如字节码缓存），丢弃并记录。
                    self.exclude(late[0], late[1] + "（打包阶段再次过滤）", relative.as_posix())
                    continue
                archive.write(path, arcname=f"{prefix}/{relative.as_posix()}")
                count += 1
        if count == 0:
            raise BuildError("临时交付目录里没有任何文件，打包中止。")
        emit(f"  已写入 {count} 个文件，开始校验 ZIP ……")
        self.archive_info = self.verify_zip(partial, prefix)
        partial.replace(self.zip_path)
        self.archive_info["path"] = str(self.zip_path)
        self.archive_info["file"] = self.zip_path.name
        self.archive_info["size"] = self.zip_path.stat().st_size
        self.archive_info["size_human"] = human_bytes(self.archive_info["size"])
        self.archive_info["sha256"] = digest_file(self.zip_path)
        self.step("打包 ZIP", "done", f"{self.zip_path.name}（{self.archive_info['size_human']}）")
        self.step("ZIP 产物校验", "done",
                  f"{self.archive_info['members']} 个成员，关键文件齐备，无排除项泄漏")
        return self.archive_info

    def verify_zip(self, zip_path: Path, prefix: str) -> dict:
        """逐成员解压并计算 sha256：同时验证 ZIP 可读、CRC 正确、且没有混入排除项。"""
        names: list[str] = []
        members: list[dict] = []
        third_party_skipped = 0
        try:
            with zipfile.ZipFile(zip_path) as archive:
                for info in archive.infolist():
                    if info.is_dir():
                        continue
                    names.append(info.filename)
                    # 读到 EOF 时 ZipExtFile 会校验 CRC-32，损坏会抛 BadZipFile。
                    with archive.open(info) as stream:
                        sha256, size = digest_stream(stream)
                    if size != info.file_size:
                        raise BuildError(f"ZIP 校验失败：{info.filename} 解压后大小与目录不一致。")
                    relative = info.filename
                    if relative.startswith(prefix + "/"):
                        relative = relative[len(prefix) + 1:]
                    members.append({"path": relative, "size": size, "sha256": sha256,
                                    "compressed_size": info.compress_size})
        except zipfile.BadZipFile as error:
            raise BuildError(f"ZIP 无法打开或已损坏：{error}") from None

        if not names:
            raise BuildError("ZIP 里没有任何文件。")
        prefixes = {name.split("/", 1)[0] for name in names if "/" in name}
        if prefixes != {prefix}:
            raise BuildError(f"ZIP 顶层目录异常：期望只有 {prefix!r}，实际 {sorted(prefixes)!r}。")

        top = {name[len(prefix) + 1:] for name in names if name.startswith(prefix + "/")}
        for required in REQUIRED_MEMBERS:
            if required not in top:
                raise BuildError(f"ZIP 缺少关键文件：{required}")
        if not any(name.startswith("templates/") and name.endswith(".html") for name in top):
            raise BuildError("ZIP 缺少 templates/ 下的页面模板。")
        if not any(name.startswith("static/") for name in top):
            raise BuildError("ZIP 缺少 static/ 静态资源。")
        if not any(name.startswith("runtime/") for name in top):
            raise BuildError("ZIP 缺少 runtime/ 便携运行环境。")

        for name in top:
            relative = PurePosixPath(name)
            if relative.as_posix().startswith(THIRD_PARTY_PREFIXES):
                # 第三方载荷（运行时 wheel/Electron 自带文件）不套用项目排除规则，
                # 否则某个包自带 tests/ 时会误报；用户资料不可能出现在这里。
                third_party_skipped += 1
                continue
            reason = self.exclusion_reason(relative)
            if reason:
                raise BuildError(f"ZIP 里出现本应排除的内容：{name}（{reason[0]}）")

        self.members = sorted(members, key=lambda item: item["path"])
        return {
            "root_prefix": prefix,
            "members": len(members),
            "unpacked_bytes": sum(item["size"] for item in members),
            "unpacked_human": human_bytes(sum(item["size"] for item in members)),
            "compression": "deflate",
            "third_party_members_exempt_from_exclusion_rules": third_party_skipped,
            "crc_verified": True,
        }

    # -- 7. 清单与摘要 -----------------------------------------------------
    def manifest(self) -> dict:
        skipped = [{"step": item["name"], "reason": item["detail"]}
                   for item in self.steps if item["status"] == "skipped"]
        return {
            "format": self.values["package_format"],
            "tool": "tools/build_package.py",
            "built_at": datetime.now().astimezone().isoformat(timespec="seconds"),
            "build_seconds": round(time.monotonic() - self.started, 2),
            "host": {
                "platform": sys.platform,
                "python": sys.version.split()[0],
                "executable": sys.executable,
                "cwd": str(Path.cwd()),
            },
            "application": {
                "name": self.values["app_name"],
                "slug": self.values["slug"],
                "version": self.values["version"],
                "package_format": self.values["package_format"],
                "backup_filename_prefix": self.values["backup_prefix"],
                "editor_directory": self.values["editor_directory"],
                "editor_app_id": self.values["editor_app_id"],
            },
            "config_center": {
                "sources": self.values["config_sources"],
                "reader": CONFIG_READER if (ROOT / CONFIG_READER).is_file() else None,
                "json": CONFIG_JSON.as_posix() if (ROOT / CONFIG_JSON).is_file() else None,
                "notes": self.values["config_notes"],
            },
            "runtime": self.runtime_info,
            "desktop": self.desktop,
            "archive": {
                "file": self.zip_name,
                "path": str(self.zip_path) if self.zip_path else None,
                "size": self.archive_info.get("size"),
                "size_human": self.archive_info.get("size_human"),
                "sha256": self.archive_info.get("sha256"),
                "root_prefix": self.archive_info.get("root_prefix"),
                "members": self.archive_info.get("members"),
                "unpacked_bytes": self.archive_info.get("unpacked_bytes"),
                "unpacked_human": self.archive_info.get("unpacked_human"),
                "compression": self.archive_info.get("compression"),
                "crc_verified": self.archive_info.get("crc_verified"),
                "third_party_members_exempt_from_exclusion_rules":
                    self.archive_info.get("third_party_members_exempt_from_exclusion_rules"),
            },
            "files": self.members,
            "excluded": [
                {"pattern": record["pattern"], "reason": record["reason"], "count": record["count"],
                 "examples": record["examples"]}
                for record in sorted(self.excludes.values(), key=lambda item: item["pattern"])
            ],
            "skipped_steps": skipped,
            "steps": self.steps,
            "exe": self.exe_info,
            "editor_exe": self.editor_info,
            "smoke_tests": self.smoke_results,
            "notes": self.notes + (
                ["收集时跳过无访问权限的路径：" + "、".join(self.unreadable)] if self.unreadable else []
            ),
            "boundaries": [
                "本工具不发布、不推送、不 git commit。",
                "instance/（用户资料与 content-backup-*.zip 内容备份）绝不进交付包。",
                "dist/ 未写入 .gitignore；本工具不会改动 .gitignore。",
                "EXE 留档在 tools/exe-build/dist/（该目录已在 .gitignore 中）。",
            ],
        }

    def write_manifest(self, manifest: dict) -> Path:
        assert self.zip_path is not None
        target = self.zip_path.with_name(self.zip_path.name + ".manifest.json")
        target.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        self.step("写出交付清单", "done", target.name)
        return target

    def print_summary(self, manifest: dict, manifest_path: Path, manifest_written: bool) -> None:
        archive = manifest["archive"]
        emit("")
        emit("=" * 30 + " 交付包构建结果 " + "=" * 30)
        emit(f"应用名称      : {manifest['application']['name']}")
        emit(f"版本          : {manifest['application']['version']}")
        emit(f"包格式        : {manifest['application']['package_format']}")
        sources = manifest["config_center"]["sources"] or ["（配置中心不可用，使用内置默认值）"]
        emit(f"配置来源      : {'、'.join(sources)}")
        emit(f"ZIP 文件      : {archive['path']}")
        emit(f"ZIP 大小      : {archive.get('size_human')}")
        emit(f"ZIP SHA-256   : {archive.get('sha256')}")
        if manifest_written:
            emit(f"清单文件      : {manifest_path}")
        emit(f"包内文件      : {archive.get('members')} 个 / {archive.get('unpacked_human')}")
        emit(f"ZIP 顶层目录  : {archive.get('root_prefix')}")
        if self.exe_info:
            emit(f"主工作台 EXE  : {self.exe_info.get('name') or '（无）'}"
                 f"（状态：{self.exe_info.get('status')}）")
        else:
            emit("主工作台 EXE  : 未构建")
        if self.args.with_editor:
            emit(f"编辑器 EXE    : {(self.editor_info or {}).get('name') or '未构建'}"
                 f"（状态：{(self.editor_info or {}).get('status', 'skipped')}）")
        if self.smoke_results:
            emit("冒烟测试      : " + "；".join(
                f"{item['label']} 通过" for item in self.smoke_results))
        else:
            emit("冒烟测试      : 已跳过或未执行")
        emit(f"构建耗时      : {manifest['build_seconds']} 秒")
        if self.args.keep_staging:
            emit(f"临时目录      : {self.tmp_root}（--keep-staging 保留）")
        for note in manifest["notes"]:
            emit(f"提示          : {note}")
        emit("注意          : dist/ 没有写进 .gitignore；本工具不会改动它，请不要把 dist/ 提交进版本库。")
        emit("=" * 78)

    def write_failure_record(self, error: Exception, manifest_path: Path | None) -> None:
        """失败时留一份明确的失败记录（不是成功清单）。"""
        try:
            self.output_dir.mkdir(parents=True, exist_ok=True)
            target = self.output_dir / (self.zip_name + ".failed.json") if self.zip_name else \
                self.output_dir / "build-failed.json"
            record = {
                "format": self.values["package_format"],
                "result": "failed",
                "failed_at": datetime.now().astimezone().isoformat(timespec="seconds"),
                "tool": "tools/build_package.py",
                "reason": str(error),
                "steps": self.steps,
                "notes": self.notes,
                "manifest_not_written": str(manifest_path) if manifest_path else None,
            }
            target.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
            emit(f"失败记录：{target}")
        except OSError:
            pass

    # -- 总流程 -----------------------------------------------------------
    def run(self) -> int:
        section("配置中心")
        emit(f"  应用名称：{self.values['app_name']}")
        emit(f"  短名/版本：{self.values['slug']} / {self.values['version']}")
        for note in self.values["config_notes"]:
            emit("  · " + note)
        self.step("读取配置中心", "done",
                  "、".join(self.values["config_sources"]) or "配置中心不可用，使用内置默认值")

        self.prepare_output()
        try:
            self.gate_existing_zip()
            self.prepare_tmp()
            self.check_runtime()
            self.desktop_info()
            self.check_desktop_runtime()
            self.exe_info = self.build_workbench_exe()
            self.editor_info = self.build_editor_exe()
            self.collect()
            self.run_smoke_tests()
            self.make_zip()
            manifest = self.manifest()
            manifest_path = self.write_manifest(manifest)
            self.print_summary(manifest, manifest_path, True)
            return 0
        except BaseException as error:  # 失败：清理半成品，不写成功清单
            if isinstance(error, (KeyboardInterrupt, SystemExit)):
                raise
            try:
                partial = self.zip_path.with_name(self.zip_path.name + ".partial")
                if partial.exists():
                    partial.unlink()
            except (OSError, AttributeError):
                pass
            if isinstance(error, BuildError):
                self.step("中止", "failed", str(error).splitlines()[0])
                emit("")
                emit("[构建失败] " + str(error))
                self.write_failure_record(error, self.zip_path.with_name(self.zip_path.name + ".manifest.json")
                                          if self.zip_path else None)
                return 2
            emit("")
            emit("[构建失败] 未预期的错误：" + repr(error))
            import traceback

            traceback.print_exc()
            self.write_failure_record(error, None)
            return 1
        finally:
            self.cleanup()

    def check_desktop_runtime(self) -> None:
        """把 desktop/ 是否完整写进备注（收集阶段仍会照常收集）。"""
        if not (ROOT / "desktop").is_dir():
            self.note("项目里没有 desktop/ 目录，交付包不含桌面壳。")


def build_parser(config: dict) -> argparse.ArgumentParser:
    values = config["values"]
    parser = argparse.ArgumentParser(
        prog="build_package.py",
        description=(
            f"一键封装「{values['app_name']}」免安装交付包"
            f"（应用版本 {values['version']}，包格式 {values['package_format']}）。"
            "只读取配置中心，不硬编码应用名。"
        ),
        epilog=(
            "示例：\n"
            "  1) 默认打包（尝试 EXE，缺 PyInstaller 则跳过）\n"
            "     runtime\\python.exe -X utf8 tools\\build_package.py\n"
            "  2) 连同「内容编辑器」EXE 一起打包\n"
            "     runtime\\python.exe -X utf8 tools\\build_package.py --with-editor\n"
            "  3) 只打源码+运行时（跳过 EXE），输出到自定义目录\n"
            "     runtime\\python.exe -X utf8 tools\\build_package.py --skip-exe --output-dir D:\\交付\n"
            "  4) 允许联网安装 PyInstaller 并强制重建 EXE\n"
            "     runtime\\python.exe -X utf8 tools\\build_package.py --install-pyinstaller --rebuild\n"
            "\n"
            "边界：不发布、不推送、不 git commit，也不修改 .gitignore。\n"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--version", action="version",
                        version=f"%(prog)s 打包工具（应用：{values['app_name']}；"
                                f"应用版本：{values['version']}；包格式：{values['package_format']}）")
    parser.add_argument("--output-dir", metavar="DIR", default=None,
                        help="ZIP 与清单的输出目录（默认：项目根下的 dist/）")
    parser.add_argument("--skip-exe", action="store_true",
                        help="跳过主工作台单文件 EXE 的构建与复用")
    parser.add_argument("--with-editor", action="store_true",
                        help="额外构建「内容编辑器」子项目 EXE（复用其 build/*.spec 配方）")
    parser.add_argument("--rebuild", action="store_true",
                        help="覆盖已存在的 EXE / ZIP（默认检测到已有产物就询问或跳过）")
    parser.add_argument("--install-pyinstaller", action="store_true",
                        help="允许联网安装 PyInstaller 到便携运行环境（默认不联网）")
    parser.add_argument("--keep-staging", action="store_true",
                        help="保留项目根下的 .build-tmp-<pid>/ 临时目录以便排查")
    parser.add_argument("--skip-smoke", action="store_true",
                        help="跳过启动服务/EXE 的冒烟测试（仍会做 ZIP 结构校验）")
    advanced = parser.add_argument_group("进阶参数")
    advanced.add_argument("--app-version", metavar="VERSION", default=None,
                          help="覆盖配置中心里的版本号（用于 ZIP 文件名）")
    advanced.add_argument("--editor-dir", metavar="DIR", default=None,
                          help="指定「内容编辑器」子项目目录（默认取配置中心的 editor.directory）")
    advanced.add_argument("--exe-console", action="store_true",
                          help="把 EXE 构建成带控制台窗口的版本（默认无控制台，便于排查）")
    advanced.add_argument("--exe-embed-desktop-runtime", action="store_true",
                          help="把 desktop/runtime 整个 Electron 运行时打进 EXE（体积很大）")
    advanced.add_argument("--with-vendor-archives", action="store_true",
                          help="把 vendor/ 下的大型离线归档（*.zip）也收进交付包")
    advanced.add_argument("--smoke-timeout", type=float, default=120.0, metavar="SECONDS",
                          help="单次冒烟测试等待服务就绪的秒数（默认 120）")
    return parser


def main(argv=None) -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except (AttributeError, ValueError):
            pass

    config = read_config_center(ROOT)
    parser = build_parser(config)
    args = parser.parse_args(argv)

    if args.app_version:
        sanitized = sanitize_version(args.app_version)
        if not sanitized:
            parser.error("--app-version 只接受数字、字母、点、下划线与加号")
        config["values"]["version"] = sanitized
        config["notes"].append(f"版本号已被命令行覆盖为 {sanitized}。")
    if args.smoke_timeout <= 0:
        parser.error("--smoke-timeout 必须大于 0")

    output_dir = Path(args.output_dir).expanduser() if args.output_dir else (ROOT / "dist")
    if not output_dir.is_absolute():
        output_dir = (Path.cwd() / output_dir)
    output_dir = output_dir.resolve()

    emit(f"项目根目录：{ROOT}")
    emit(f"输出目录  ：{output_dir}")
    packager = Packager(args, config, output_dir)
    return packager.run()


if __name__ == "__main__":
    raise SystemExit(main())
