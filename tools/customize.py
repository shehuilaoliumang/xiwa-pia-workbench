#!/usr/bin/env python3
"""自动化定制向导：把通用模板改造成一个新领域的工作台。

用法::

    runtime\\python.exe -X utf8 tools/customize.py                # 交互式向导
    runtime\\python.exe -X utf8 tools/customize.py --show          # 查看当前配置
    runtime\\python.exe -X utf8 tools/customize.py --dry-run ...   # 只预览不写入
    runtime\\python.exe -X utf8 tools/customize.py --non-interactive \\
        --name 播客工作台 --slug podcast-workbench --port 8801 \\
        --item 单集 --group 专辑 --groups "访谈,故事,杂谈"

安全约束（刻意保守）：
* 改动前自动把每个被改文件备份到 ``.backup/customize-<时间戳>/``，并写出变更清单。
* 只对**白名单**文本文件做替换（见 ``tools/templating.py`` 的扩展名/目录规则）；
  ``instance/``、``runtime/``、``vendor/``、``evidence/``、``.backup/``、
  ``.local-archive/``、``desktop/runtime/`` 一律不动。
* 不做全库盲目正则替换：只应用由「旧配置值 → 新配置值」推导出的有序映射。
* 无法自动处理的项目（截图、图标、文档内嵌图片中的旧文字）写入「需人工处理」清单。
* 不删除任何功能：``--drop-display-module`` 只把模块标记为关闭并列出可裁剪文件。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tools"))

import templating  # noqa: E402  (同目录脚本)

CONFIG_PATH = ROOT / "config" / "template.json"

#: 可裁剪模块 → 相关文件（用于换领域时人工删改，绝不自动删除）。
MODULE_FILES: dict[str, list[str]] = {
    "display_sync": [
        "templates/control.html", "templates/display.html",
        "static/display.js", "static/display-directory.css", "static/preview.css",
        "static/media-pagination.js", "tests/desktop_display.cjs",
        "docs/展示控制.md", "docs/独立展示器.md",
    ],
    "media": [
        "static/media-player.js", "static/media-player.css", "static/media-editor.js",
        "templates/media_editor.html", "tests/browser_media_player.cjs",
        "docs/音视频配本.md",
    ],
    "content_packages": [
        "script_package.py", "static/script-package.js", "static/library-merge.js",
        "templates/library_merge.html", "tests/test_script_packages.py",
    ],
    "editor_subproject": ["内容编辑器/"],
}

#: 需要人工确认的资产（自动替换覆盖不到）。
MANUAL_ASSET_HINTS = [
    ("docs/guide-assets/", "文档截图：图片内可能仍有旧应用名/旧文字，需重新截图或修图"),
    ("static/media/", "演示素材图片：可能包含旧文字或旧标识"),
    ("static/*.png", "图标/占位图：可能包含旧字形，需替换为通用图标"),
    ("docs/*.docx", "Word 文档：正文已由脚本改写，但内嵌截图里的文字需人工核对"),
    ("evidence/", "证据目录：原始资料，模板交付时应整体移出（见 docs/定制指南.md）"),
    ("desktop/runtime/", "Electron 运行时：二进制，不参与替换（无需品牌化）"),
]


# --------------------------------------------------------------------------
# 配置读写
# --------------------------------------------------------------------------
def load_raw_config() -> dict:
    try:
        return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def current_values() -> dict:
    """把当前生效配置摊平成「可替换的旧值」视图。"""
    import template_config as tc
    return {
        "app_name": tc.APP_NAME,
        "short_name": tc.APP_SHORT_NAME,
        "slug": tc.APP_SLUG,
        "app_id": tc.APP_ID,
        "port": tc.APP_PORT,
        "window_title": tc.WINDOW_TITLE,
        "display_window_title": tc.DISPLAY_WINDOW_TITLE,
        "tagline": tc.TAGLINE,
        "brand_mark": tc.BRAND_MARK,
        "backup_format": tc.BACKUP_FORMAT,
        "backup_prefix": tc.BACKUP_PREFIX,
        "package_format": tc.PACKAGE_FORMAT,
        "package_temp_prefix": tc.PACKAGE_TEMP_PREFIX,
        "package_export_prefix": tc.PACKAGE_EXPORT_PREFIX,
        "terms": dict(tc.TERMS),
        "default_groups": list(tc.DEFAULT_GROUPS),
        "desktop_package_name": tc.DESKTOP_PACKAGE_NAME,
        "desktop_instance_key": tc.DESKTOP_SINGLE_INSTANCE_KEY,
        "editor_directory": tc.EDITOR_DIRECTORY,
    }


def apply_new_config(raw: dict, answers: dict) -> dict:
    """把向导答案写进配置字典（保持其它字段不变）。"""
    cfg = json.loads(json.dumps(raw))
    cfg.setdefault("app", {})
    cfg.setdefault("backup", {})
    cfg.setdefault("package", {})
    cfg.setdefault("terms", {})
    cfg.setdefault("defaults", {})
    cfg.setdefault("desktop", {})
    cfg.setdefault("modules", {})

    cfg["app"]["name"] = answers["app_name"]
    cfg["app"]["short_name"] = answers["short_name"]
    cfg["app"]["slug"] = answers["slug"]
    cfg["app"]["app_id"] = answers["slug"]
    cfg["app"]["port"] = answers["port"]
    cfg["app"]["window_title"] = answers["window_title"]
    cfg["app"]["display_window_title"] = answers["display_window_title"]
    cfg["app"]["tagline"] = answers["tagline"]
    cfg["app"]["brand_mark"] = answers["brand_mark"]

    cfg["backup"]["format"] = answers["backup_format"]
    cfg["backup"]["filename_prefix"] = answers["backup_prefix"]

    cfg["package"]["format"] = answers["package_format"]
    cfg["package"]["temp_prefix"] = answers["package_temp_prefix"]
    cfg["package"]["export_filename_prefix"] = answers["package_export_prefix"]

    for key in ("item", "group", "manage", "catalog", "control", "display", "note", "item_color", "collaborator"):
        if key in answers["terms"]:
            cfg["terms"][key] = answers["terms"][key]
    if answers["terms"].get("uncategorized"):
        cfg["terms"]["uncategorized"] = answers["terms"]["uncategorized"]

    if answers["groups"]:
        cfg["defaults"]["groups"] = list(answers["groups"])
    cfg["modules"]["display_sync"] = bool(answers["keep_display"])
    return cfg


# --------------------------------------------------------------------------
# 派生替换映射
# --------------------------------------------------------------------------
def build_mapping(old: dict, new: dict) -> list[tuple[str, str]]:
    pairs: list[tuple[str, str]] = []

    def add(a, b):
        if a and b and a != b and str(a) != str(b):
            pairs.append((str(a), str(b)))

    # 身份串：长的先（引擎会再按长度排序，这里只是可读性）
    add(old["window_title"], new["window_title"])
    add(old["display_window_title"], new["display_window_title"])
    add(old["app_name"], new["app_name"])
    add(old["desktop_package_name"], new["desktop_package_name"])
    add(old["desktop_instance_key"], new["desktop_instance_key"])
    add(old["slug"], new["slug"])
    add(old["app_id"], new["app_id"])

    # 格式与文件名
    add(old["backup_format"], new["backup_format"])
    add(old["backup_prefix"], new["backup_prefix"])
    add(old["package_format"], new["package_format"])
    add(old["package_temp_prefix"], new["package_temp_prefix"])
    add(old["package_export_prefix"], new["package_export_prefix"])

    # 术语
    for key, value in old["terms"].items():
        add(value, new["terms"].get(key, value))

    # 口号与标记
    add(old["tagline"], new["tagline"])
    add(old["brand_mark"], new["brand_mark"])

    # 去重，避免同一对出现两次
    seen = set()
    unique = []
    for pair in pairs:
        if pair not in seen:
            seen.add(pair)
            unique.append(pair)
    return unique


# --------------------------------------------------------------------------
# 种子数据：按位置重命名分组（保留 id 与条目归属）
# --------------------------------------------------------------------------
def regenerate_seed(new: dict, dry_run: bool) -> dict:
    path = ROOT / "data" / "seed.json"
    if not path.exists():
        return {"changed": False, "reason": "data/seed.json 不存在"}
    try:
        seed = json.loads(path.read_text(encoding="utf-8"))
    except ValueError as error:
        return {"changed": False, "reason": f"seed 解析失败：{error}"}
    categories = seed.get("categories")
    if not isinstance(categories, list) or not categories:
        return {"changed": False, "reason": "seed 没有 categories"}
    names = list(new["groups"])
    renames = []
    for index, category in enumerate(sorted(categories, key=lambda c: c.get("sort_order", 0))):
        if category.get("system"):
            continue
        if index < len(names):
            old_name = category.get("name")
            if old_name != names[index]:
                category["name"] = names[index]
                renames.append({"id": category.get("id"), "from": old_name, "to": names[index]})
    if renames and not dry_run:
        path.write_text(json.dumps(seed, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return {"changed": bool(renames), "renames": renames}


# --------------------------------------------------------------------------
# 需人工处理清单
# --------------------------------------------------------------------------
def manual_review(old: dict) -> list[dict]:
    items = []
    for pattern, reason in MANUAL_ASSET_HINTS:
        for path in sorted(ROOT.glob(pattern)):
            items.append({"path": path.relative_to(ROOT).as_posix(), "reason": reason})
    # 文档标题：正文由替换处理，这里只提示需要通读
    for path in sorted((ROOT / "docs").glob("*.md")):
        text = path.read_text(encoding="utf-8", errors="replace")
        if old["app_name"] in text or old["slug"] in text:
            items.append({"path": path.relative_to(ROOT).as_posix(),
                          "reason": "正文含旧应用名/旧标识，请通读确认语气与新领域一致"})
    return items


def module_report(new: dict) -> list[dict]:
    report = []
    for module, files in MODULE_FILES.items():
        enabled = bool(new["modules"].get(module, True))
        report.append({"module": module, "enabled": enabled, "files": files})
    return report


# --------------------------------------------------------------------------
# 验证
# --------------------------------------------------------------------------
def smoke_test() -> dict:
    """在当前解释器里用测试客户端跑一遍关键页面（不起网络端口）。"""
    result = {"ok": False, "detail": []}
    try:
        import importlib
        import os
        os.chdir(ROOT)
        if str(ROOT) not in sys.path:
            sys.path.insert(0, str(ROOT))
        # 配置已改：强制重新导入，避免拿到旧值
        for module in ("template_config", "storage", "script_package", "app"):
            if module in sys.modules:
                del sys.modules[module]
        app_module = importlib.import_module("app")
        workdir = ROOT / ".qa-smoke"
        workdir.mkdir(exist_ok=True)
        application = app_module.create_app({
            "TESTING": True,
            "DATABASE": str(workdir / "smoke.sqlite3"),
            "INSTANCE_PATH": str(workdir),
            "CSRF_ENABLED": False,
        })
        client = application.test_client()
        health = client.get("/api/health")
        payload = health.get_json() or {}
        result["detail"].append(f"GET /api/health -> {health.status_code} app={payload.get('app')}")
        for path in ("/", "/control", "/manage"):
            response = client.get(path)
            result["detail"].append(f"GET {path} -> {response.status_code}")
            if response.status_code != 200:
                return result
        result["ok"] = health.status_code == 200 and bool(payload.get("ok"))
    except Exception as error:  # noqa: BLE001 - 向导要把失败原因原样报给使用者
        result["detail"].append(f"冒烟失败：{type(error).__name__}: {error}")
    return result


def residual_scan(old: dict, new: dict) -> list[dict]:
    patterns = [old["app_name"], old["slug"], old["app_id"], old["backup_format"],
                old["package_format"], old["desktop_instance_key"]]
    patterns += [value for value in old["terms"].values() if value and value != new["terms"].get("item")]
    patterns = [p for p in dict.fromkeys(patterns) if p]
    return templating.scan(root=ROOT, patterns=patterns)


# --------------------------------------------------------------------------
# 交互式输入
# --------------------------------------------------------------------------
def ask(prompt: str, default: str) -> str:
    suffix = f"（默认：{default}）" if default else ""
    try:
        answer = input(f"{prompt}{suffix}: ").strip()
    except EOFError:
        answer = ""
    return answer or default


def collect_answers(old: dict, args) -> dict:
    terms = dict(old["terms"])
    if args.non_interactive:
        app_name = args.name or old["app_name"]
        slug = args.slug or old["slug"]
        port = args.port or old["port"]
        groups = [g.strip() for g in (args.groups.split(",") if args.groups else old["default_groups"]) if g.strip()]
        terms["item"] = args.item or terms["item"]
        terms["group"] = args.group or terms["group"]
        short_name = args.short_name or old["short_name"]
        tagline = args.tagline or old["tagline"]
        brand_mark = args.brand_mark or app_name[:1]
        keep_display = not args.drop_display_module
    else:
        print("\n=== 定制向导：请输入新领域信息（直接回车保留默认值）===\n")
        app_name = ask("新应用名", old["app_name"])
        short_name = ask("应用短名", old["short_name"])
        slug = ask("英文标识（小写+连字符，用于 app_id/包名）", old["slug"])
        port = int(ask("默认端口", str(old["port"])) or old["port"])
        terms["item"] = ask(f"「条目」在本领域的叫法（当前：{terms['item']}）", terms["item"])
        terms["group"] = ask(f"「分组」在本领域的叫法（当前：{terms['group']}）", terms["group"])
        default_groups = "，".join(old["default_groups"])
        groups = [g.strip() for g in
                  re.split(r"[,，\s]+", ask("默认分组名（逗号分隔）", default_groups)) if g.strip()]
        tagline = ask("副标题/口号", old["tagline"])
        brand_mark = ask("角标字符（一个汉字）", app_name[:1])
        keep_display = ask("是否保留展示/播控模块？(y/n)", "y").lower().startswith("y")

    return {
        "app_name": app_name,
        "short_name": short_name,
        "slug": slug,
        "port": port,
        "window_title": f"{app_name} · 桌面版",
        "display_window_title": f"{terms['display']} · {app_name}",
        "tagline": tagline,
        "brand_mark": brand_mark,
        "backup_format": f"{slug}-backup",
        "backup_prefix": f"{slug.split('-')[0]}-backup-",
        "package_format": f"{slug}-package",
        "package_temp_prefix": f"{slug}-package-",
        "package_export_prefix": f"{terms['item']}-",
        "terms": terms,
        "groups": groups,
        "keep_display": keep_display,
        "desktop_package_name": f"{slug}-desktop",
        "desktop_instance_key": f"{slug}.desktop.started",
        "editor_directory": terms.get("editor_directory", old.get("editor_directory", "内容编辑器")),
    }


# --------------------------------------------------------------------------
# 主流程
# --------------------------------------------------------------------------
def main() -> int:
    parser = argparse.ArgumentParser(description="自动化定制向导：把通用模板改成新领域的工作台")
    parser.add_argument("--show", action="store_true", help="打印当前配置后退出")
    parser.add_argument("--dry-run", action="store_true", help="只预览改动，不写入文件")
    parser.add_argument("--non-interactive", action="store_true", help="从命令行参数读取答案，不提问")
    parser.add_argument("--name"), parser.add_argument("--short-name"), parser.add_argument("--slug")
    parser.add_argument("--port", type=int), parser.add_argument("--item"), parser.add_argument("--group")
    parser.add_argument("--groups"), parser.add_argument("--tagline"), parser.add_argument("--brand-mark")
    parser.add_argument("--drop-display-module", action="store_true", help="把展示/播控模块标记为关闭（不删除代码）")
    parser.add_argument("--skip-seed", action="store_true", help="不重命名种子数据里的分组")
    parser.add_argument("--skip-smoke", action="store_true", help="跳过定制后的冒烟测试")
    parser.add_argument("--yes", action="store_true", help="跳过最终确认")
    args = parser.parse_args()

    old = current_values()
    if args.show:
        print(json.dumps(old, ensure_ascii=False, indent=2))
        return 0

    answers = collect_answers(old, args)
    new_cfg = apply_new_config(load_raw_config(), answers)
    import template_config as tc_module
    new = dict(old)
    new.update({
        "app_name": answers["app_name"], "short_name": answers["short_name"],
        "slug": answers["slug"], "app_id": answers["slug"], "port": answers["port"],
        "window_title": answers["window_title"],
        "display_window_title": answers["display_window_title"],
        "tagline": answers["tagline"], "brand_mark": answers["brand_mark"],
        "backup_format": answers["backup_format"], "backup_prefix": answers["backup_prefix"],
        "package_format": answers["package_format"],
        "package_temp_prefix": answers["package_temp_prefix"],
        "package_export_prefix": answers["package_export_prefix"],
        "terms": answers["terms"], "default_groups": answers["groups"],
        "desktop_package_name": answers["desktop_package_name"],
        "desktop_instance_key": answers["desktop_instance_key"],
        "modules": {"display_sync": answers["keep_display"]},
    })

    mapping = build_mapping(old, new)
    print(f"\n=== 变更计划 ===\n应用名：{old['app_name']} → {new['app_name']}")
    print(f"英文标识：{old['slug']} → {new['slug']}    端口：{old['port']} → {new['port']}")
    print(f"术语：{old['terms']} → {new['terms']}")
    print(f"替换规则 {len(mapping)} 条，示例：{mapping[:5]}")

    if not args.yes and not args.non_interactive:
        confirm = ask("确认执行？(y/N)", "n")
        if not confirm.lower().startswith("y"):
            print("已取消，未做任何改动。")
            return 0

    # 1) 写配置中心
    if not args.dry_run:
        CONFIG_PATH.write_text(json.dumps(new_cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"\n[1/5] 已写入配置中心 {CONFIG_PATH.relative_to(ROOT)}")
    else:
        print(f"\n[1/5] （dry-run）将写入 {CONFIG_PATH.relative_to(ROOT)}")

    # 2) 全局文案替换（白名单）
    outcome = templating.apply_mapping(root=ROOT, mapping=mapping, dry_run=args.dry_run,
                                       log_stem="customize")
    print(f"[2/5] 文案替换：{outcome['changed']} 个文件 / {outcome['total_replacements']} 处"
          f"{'（dry-run）' if args.dry_run else ''}")
    for item in outcome["files"]:
        print(f"       {item['replacements']:5}  {item['path']}")
    print(f"       备份目录：{outcome['backup_dir'] or '（dry-run 无备份）'}")

    # 3) 种子数据
    if args.skip_seed:
        print("[3/5] 已跳过种子分组重命名")
        seed_result = {"changed": False, "reason": "skipped"}
    else:
        seed_result = regenerate_seed(new, args.dry_run)
        print(f"[3/5] 种子分组：{json.dumps(seed_result, ensure_ascii=False)}")

    # 4) 模块与人工清单
    print("[4/5] 可裁剪模块：")
    for item in module_report(new):
        state = "保留" if item["enabled"] else "可裁剪（仅标记关闭，代码未删除）"
        print(f"       {item['module']}: {state}  相关文件 {len(item['files'])} 个")
    reviews = manual_review(old)
    print(f"[4/5] 需人工处理 {len(reviews)} 项：")
    for item in reviews[:30]:
        print(f"       {item['path']} —— {item['reason']}")

    # 5) 验证
    if args.dry_run or args.skip_smoke:
        print("[5/5] 已跳过冒烟测试")
        smoke = {"ok": None, "detail": ["skipped"]}
        residuals = []
    else:
        smoke = smoke_test()
        print(f"[5/5] 冒烟测试：{'通过' if smoke['ok'] else '未通过'}")
        for line in smoke["detail"]:
            print("       " + line)
        residual_patterns = [old["app_name"], old["slug"], old["app_id"]]
        residuals = templating.scan(root=ROOT, patterns=residual_patterns)
        print(f"[5/5] 旧值残留：{len(residuals)} 处")
        for item in residuals[:30]:
            print(f"       {item['path']}:{item['line']} [{item['pattern']}] {item['text'][:80]}")

    # 变更清单落盘
    report_dir = ROOT / ".backup" / f"customize-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
    if not args.dry_run:
        report_dir.mkdir(parents=True, exist_ok=True)
        (report_dir / "customize-report.json").write_text(json.dumps({
            "old": old, "new": new, "mapping": mapping, "outcome": outcome,
            "seed": seed_result, "manual_review": reviews,
            "modules": module_report(new), "smoke": smoke, "residuals": residuals,
        }, ensure_ascii=False, indent=2), encoding="utf-8")
        (report_dir / "customize-report.md").write_text(render_report(old, new, outcome, seed_result,
                                                                     reviews, smoke, residuals),
                                                        encoding="utf-8")
        print(f"\n变更清单：{report_dir.relative_to(ROOT)}/customize-report.md")

    return 0 if (smoke["ok"] is not False) else 1


def render_report(old, new, outcome, seed_result, reviews, smoke, residuals) -> str:
    lines = [
        "# 定制变更清单", "",
        f"- 应用名：`{old['app_name']}` → `{new['app_name']}`",
        f"- 英文标识：`{old['slug']}` → `{new['slug']}`",
        f"- 端口：`{old['port']}` → `{new['port']}`",
        f"- 术语：`{json.dumps(old['terms'], ensure_ascii=False)}` → "
        f"`{json.dumps(new['terms'], ensure_ascii=False)}`",
        f"- 改动文件：**{outcome['changed']}**，替换 **{outcome['total_replacements']}** 处",
        f"- 备份目录：`{outcome['backup_dir']}`", "",
        "## 逐文件改动", "", "| 文件 | 替换次数 | 规则 |", "| --- | --- | --- |",
    ]
    for item in outcome["files"]:
        detail = "；".join(f"`{k}`×{v}" for k, v in sorted(item["detail"].items(), key=lambda kv: -kv[1]))
        lines.append(f"| `{item['path']}` | {item['replacements']} | {detail} |")
    lines += ["", "## 种子数据", "", f"```json\n{json.dumps(seed_result, ensure_ascii=False, indent=2)}\n```", "",
              "## 需人工处理", "", "| 路径 | 原因 |", "| --- | --- |"]
    for item in reviews:
        lines.append(f"| `{item['path']}` | {item['reason']} |")
    lines += ["", "## 验证", "", f"- 冒烟测试：{'通过' if smoke.get('ok') else smoke.get('ok')}"]
    for line in smoke.get("detail", []):
        lines.append(f"  - {line}")
    lines += ["", f"- 旧值残留：{len(residuals)} 处"]
    for item in residuals[:60]:
        lines.append(f"  - `{item['path']}:{item['line']}` [{item['pattern']}] {item['text'][:120]}")
    return "\n".join(lines) + "\n"


if __name__ == "__main__":
    raise SystemExit(main())
