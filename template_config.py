"""集中配置读取器（通用核心）。

全项目的应用名、短名、端口、页面/窗口标题、通用术语、包格式名、备份前缀
都只从这里读取，避免硬编码。配置来源是 ``config/template.json``。

换领域时优先改 ``config/template.json``；也可以用 ``tools/customize.py``
交互式完成。配置文件缺失或字段残缺时，本模块回退到下面的内置默认值，
保证应用始终能启动。
"""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CONFIG_PATH = ROOT / "config" / "template.json"

#: 配置中心缺失时的内置默认值（与 config/template.json 保持一致）。
DEFAULTS: dict = {
    "schema_version": 1,
    "app": {
        "name": "内容管理工作台",
        "short_name": "工作台",
        "slug": "content-workbench",
        "app_id": "content-workbench",
        "version": "0.1.0",
        "port": 8765,
        "window_title": "内容管理工作台 · 桌面版",
        "display_window_title": "内容管理 · 展示窗口",
        "brand_mark": "内",
        "tagline": "本地内容管理 · 展示与播控",
    },
    "backup": {"format": "content-workbench-backup", "filename_prefix": "content-backup-"},
    "package": {
        "format": "content-package",
        "temp_prefix": "content-package-",
        "export_filename_prefix": "条目-",
    },
    "runtime": {"desktop_marker": "desktop-runtime.json", "python_version": "3.14.7"},
    "desktop": {
        "package_name": "content-workbench-desktop",
        "single_instance_key": "content-workbench.desktop.started",
        "user_agent_brand": "ContentWorkbench",
        "startup_grace_seconds": 6,
        "sandbox_retry_args": ["--no-sandbox"],
    },
    "editor": {
        "directory": "内容编辑器",
        "name": "内容编辑器",
        "app_id": "content-editor",
        "package_name": "content-editor-desktop",
        "version": "0.2.1",
        "single_instance_key": "content-editor.desktop.started",
    },
    "terms": {
        "item": "条目",
        "group": "分组",
        "manage": "内容管理",
        "catalog": "内容管理",
        "control": "展示控制",
        "display": "展示窗口",
        "note": "备注",
        "item_color": "条目配色",
        "library": "内容库",
        "uncategorized": "未分组",
        "collaborator": "协作者",
    },
    "defaults": {
        "groups": [
            "示例分组一",
            "示例分组二",
            "示例分组三",
            "示例分组四",
            "示例分组五",
            "示例分组六",
        ]
    },
    "modules": {
        "display_sync": True,
        "media": True,
        "content_packages": True,
        "editor_subproject": True,
    },
}


def _merge(base: dict, override: dict) -> dict:
    """递归合并配置，缺字段时保留默认值。"""
    result = dict(base)
    for key, value in (override or {}).items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = _merge(result[key], value)
        else:
            result[key] = value
    return result


def load_config(path: Path | str | None = None) -> dict:
    """读取配置中心；文件缺失或损坏时回退到内置默认值。"""
    target = Path(path) if path else CONFIG_PATH
    try:
        loaded = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return json.loads(json.dumps(DEFAULTS))
    if not isinstance(loaded, dict):
        return json.loads(json.dumps(DEFAULTS))
    return _merge(DEFAULTS, loaded)


CONFIG = load_config()


def value(path: str, default=None):
    """按 ``"app.name"`` 形式读取配置项。"""
    node = CONFIG
    for part in path.split("."):
        if not isinstance(node, dict) or part not in node:
            return default
        node = node[part]
    return node


# --- 常用配置的扁平常量（代码里直接 import 这些，避免各处重复取路径） ---
APP_NAME: str = value("app.name")
APP_SHORT_NAME: str = value("app.short_name")
APP_SLUG: str = value("app.slug")
APP_ID: str = value("app.app_id")
APP_VERSION: str = value("app.version")
APP_PORT: int = int(value("app.port"))
WINDOW_TITLE: str = value("app.window_title")
DISPLAY_WINDOW_TITLE: str = value("app.display_window_title")
BRAND_MARK: str = value("app.brand_mark")
TAGLINE: str = value("app.tagline")

BACKUP_FORMAT: str = value("backup.format")
BACKUP_PREFIX: str = value("backup.filename_prefix")

PACKAGE_FORMAT: str = value("package.format")
PACKAGE_TEMP_PREFIX: str = value("package.temp_prefix")
PACKAGE_EXPORT_PREFIX: str = value("package.export_filename_prefix")

DESKTOP_MARKER: str = value("runtime.desktop_marker")
DESKTOP_PACKAGE_NAME: str = value("desktop.package_name")
DESKTOP_SINGLE_INSTANCE_KEY: str = value("desktop.single_instance_key")
DESKTOP_UA_BRAND: str = value("desktop.user_agent_brand")
#: 桌面宿主启动宽限期：超过这个时间仍存活才算真正起来。
DESKTOP_STARTUP_GRACE_SECONDS: float = float(value("desktop.startup_grace_seconds", 6))
#: 桌面宿主首次启动失败后，用这些兼容参数重试一次（部分机器无法初始化 Chromium 沙箱）。
DESKTOP_SANDBOX_RETRY_ARGS: list = list(value("desktop.sandbox_retry_args", []) or [])

EDITOR_DIRECTORY: str = value("editor.directory")
EDITOR_NAME: str = value("editor.name")
EDITOR_APP_ID: str = value("editor.app_id")
EDITOR_PACKAGE_NAME: str = value("editor.package_name")
EDITOR_VERSION: str = value("editor.version")
EDITOR_SINGLE_INSTANCE_KEY: str = value("editor.single_instance_key")

TERMS: dict = value("terms")
DEFAULT_GROUPS: list = value("defaults.groups")
MODULES: dict = value("modules")


def template_globals() -> dict:
    """模板层使用的配置视图（注入 Jinja 全局）。"""
    return {
        "app_name": APP_NAME,
        "app_short_name": APP_SHORT_NAME,
        "app_id": APP_ID,
        "app_version": APP_VERSION,
        "window_title": WINDOW_TITLE,
        "display_window_title": DISPLAY_WINDOW_TITLE,
        "brand_mark": BRAND_MARK,
        "tagline": TAGLINE,
        "terms": TERMS,
        "modules": MODULES,
    }


if __name__ == "__main__":  # 便于排查：打印当前生效配置
    print(json.dumps(CONFIG, ensure_ascii=False, indent=2))
