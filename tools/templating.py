"""通用模板替换引擎（被去品牌迁移与 tools/customize.py 共用）。

设计原则：
* **白名单驱动**：只处理明确允许的文本扩展名，二进制（.pptx/.png/.docx/.zip…）
  永不参与替换。
* **不做全库盲目正则替换**：只应用调用方给出的有序映射表，逐条统计命中次数。
* **改前必备份**：每个被改动的文件在 ``.backup/customize-<时间戳>/`` 下保留原样，
  并写出可读的变更清单。
* **保留原始换行符**：读写成 ``newline=""``，避免 CRLF/LF 被整体重写。

本模块**不包含任何具体品牌词**：映射表与扫描模式都由调用方传入
（``tools/customize.py`` 从配置中心的旧值推导，历史迁移由一次性脚本传入）。
"""

from __future__ import annotations

import json
import shutil
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:  # 允许直接以脚本方式运行
    sys.path.insert(0, str(ROOT))

#: 允许参与文本替换的扩展名。
TEXT_SUFFIXES = {
    ".py", ".js", ".cjs", ".mjs", ".html", ".htm", ".css", ".md", ".txt",
    ".cmd", ".bat", ".json", ".yml", ".yaml", ".toml", ".cfg", ".ini", ".csv",
}

#: 永不参与替换的二进制扩展名（显式列出，双保险）。
BINARY_SUFFIXES = {
    ".pptx", ".ppt", ".docx", ".doc", ".xlsx", ".xls", ".png", ".jpg", ".jpeg",
    ".gif", ".webp", ".ico", ".zip", ".exe", ".dll", ".pyd", ".pdf", ".woff",
    ".woff2", ".ttf", ".otf", ".mp3", ".mp4", ".wav", ".bin", ".asar",
}

#: 这些目录（或其下任意层级）永不参与替换。
EXCLUDED_DIR_NAMES = {
    ".git", ".backup", ".local-archive", ".qa", "instance", "runtime", "vendor",
    "node_modules", "__pycache__", "dist", ".venv", "venv", ".idea", ".vscode",
    "evidence",
}

#: 这些相对路径前缀永不参与替换（可在 EXCLUDED_DIR_NAMES 之外补充）。
EXCLUDED_PATH_PREFIXES = ("desktop/runtime",)

#: 允许放行的点文件。
ALLOWED_DOTFILES = {".gitignore", ".gitattributes", ".editorconfig"}


# --------------------------------------------------------------------------
# 目标枚举
# --------------------------------------------------------------------------
def is_target(rel: Path) -> bool:
    """判断相对路径是否属于允许替换的文本文件。"""
    parts = rel.parts
    if any(part in EXCLUDED_DIR_NAMES for part in parts[:-1]):
        return False
    name = rel.name
    # 隐藏的临时/脚本文件（例如 .seed_tokens.txt）不参与替换。
    if name.startswith(".") and name not in ALLOWED_DOTFILES:
        return False
    posix = rel.as_posix()
    if any(posix == prefix or posix.startswith(prefix + "/") for prefix in EXCLUDED_PATH_PREFIXES):
        return False
    suffix = rel.suffix.lower()
    if suffix in BINARY_SUFFIXES:
        return False
    return suffix in TEXT_SUFFIXES


def iter_targets(root: Path | None = None, subdirs=None, extra_exclude=(),
                 extra_include=()) -> list[Path]:
    """列出允许替换的文件（相对于 root 的 Path 列表）。

    ``subdirs`` 限定只扫描这些子目录；``extra_exclude`` / ``extra_include``
    是相对路径前缀，用于调用方临时收窄或放宽范围。
    """
    base = Path(root) if root else ROOT
    found: list[Path] = []
    walk_roots = [base / sub for sub in subdirs] if subdirs else [base]
    for walk_root in walk_roots:
        if not walk_root.exists():
            continue
        candidates = [walk_root] if walk_root.is_file() else sorted(walk_root.rglob("*"))
        for path in candidates:
            if not path.is_file():
                continue
            rel = path.relative_to(base)
            posix = rel.as_posix()
            if any(posix == e or posix.startswith(e.rstrip("/") + "/") for e in extra_exclude):
                continue
            if extra_include and not any(
                posix == i or posix.startswith(i.rstrip("/") + "/") for i in extra_include
            ):
                continue
            if is_target(rel):
                found.append(rel)
    return sorted(set(found))


# --------------------------------------------------------------------------
# 有序映射
# --------------------------------------------------------------------------
def order_mapping(mapping) -> list[tuple[str, str]]:
    """按「长串优先」稳定排序，避免短串先替换掉长串的一部分。"""
    indexed = [(i, str(s), str(t)) for i, (s, t) in enumerate(mapping)]
    indexed.sort(key=lambda item: (-len(item[1]), item[0]))
    return [(s, t) for _, s, t in indexed]


def load_mapping(path: Path | str) -> list[tuple[str, str]]:
    """从 JSON 读取映射表：``[["旧串", "新串"], ...]`` 或 ``{"map": [...]}``。"""
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    if isinstance(payload, dict):
        payload = payload.get("map", [])
    return [(str(pair[0]), str(pair[1])) for pair in payload]


def read_text(path: Path) -> str | None:
    try:
        with path.open("r", encoding="utf-8", newline="") as handle:
            return handle.read()
    except (OSError, UnicodeDecodeError):
        return None


def write_text(path: Path, text: str) -> None:
    with path.open("w", encoding="utf-8", newline="") as handle:
        handle.write(text)


# --------------------------------------------------------------------------
# 应用替换
# --------------------------------------------------------------------------
def apply_mapping(root: Path | None = None, mapping=(), targets=None,
                  backup: bool = True, dry_run: bool = False,
                  log_stem: str = "customize") -> dict:
    """把有序映射应用到目标文件。

    返回：``{changed, total_replacements, files: [...], backup_dir, dry_run}``
    """
    base = Path(root) if root else ROOT
    ordered = order_mapping(mapping)
    files = list(targets) if targets is not None else iter_targets(base)

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_dir = base / ".backup" / f"{log_stem}-{stamp}"
    result = {
        "started_at": datetime.now().astimezone().isoformat(),
        "root": str(base),
        "dry_run": bool(dry_run),
        "backup_dir": str(backup_dir) if backup and not dry_run else "",
        "changed": 0,
        "total_replacements": 0,
        "files": [],
        "skipped": [],
    }

    for rel in files:
        path = base / rel
        original = read_text(path)
        if original is None:
            result["skipped"].append({"path": rel.as_posix(), "reason": "not_utf8_text"})
            continue
        updated = original
        per_source: dict[str, int] = {}
        for source, replacement in ordered:
            if source and source in updated:
                count = updated.count(source)
                updated = updated.replace(source, replacement)
                per_source[source] = count
        if not per_source:
            continue
        if backup and not dry_run:
            destination = backup_dir / rel
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, destination)
        if not dry_run:
            write_text(path, updated)
        total = sum(per_source.values())
        result["changed"] += 1
        result["total_replacements"] += total
        result["files"].append({
            "path": rel.as_posix(),
            "replacements": total,
            "detail": per_source,
        })

    if not dry_run:
        backup_dir.mkdir(parents=True, exist_ok=True)
        (backup_dir / f"{log_stem}-changelog.json").write_text(
            json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        (backup_dir / f"{log_stem}-changelog.md").write_text(
            render_changelog(result), encoding="utf-8")
    result["finished_at"] = datetime.now().astimezone().isoformat()
    return result


def render_changelog(result: dict) -> str:
    lines = [
        f"# 变更清单（{result.get('started_at', '')}）",
        "",
        f"- 项目根：`{result.get('root', '')}`",
        f"- 改动文件数：**{result.get('changed', 0)}**",
        f"- 替换总次数：**{result.get('total_replacements', 0)}**",
        f"- 备份目录：`{result.get('backup_dir', '')}`",
        "",
        "| 文件 | 替换次数 | 命中规则 |",
        "| --- | --- | --- |",
    ]
    for item in result.get("files", []):
        detail = "；".join(f"`{k}`×{v}" for k, v in sorted(item["detail"].items(), key=lambda kv: -kv[1]))
        lines.append(f"| `{item['path']}` | {item['replacements']} | {detail} |")
    if result.get("skipped"):
        lines += ["", "## 跳过", ""]
        lines += [f"- `{s['path']}`：{s['reason']}" for s in result["skipped"]]
    return "\n".join(lines) + "\n"


# --------------------------------------------------------------------------
# 残留扫描
# --------------------------------------------------------------------------
def scan(root: Path | None = None, patterns=(), targets=None,
         include_binary_names: bool = True, skip=(".git", ".backup", ".local-archive")) -> list[dict]:
    """扫描残留：返回 ``[{path, line, text, pattern}]``。

    ``patterns`` 由调用方提供（例如刚被替换掉的旧配置值），本模块不含品牌词。
    """
    base = Path(root) if root else ROOT
    patterns = tuple(p for p in patterns if p)
    files = list(targets) if targets is not None else iter_targets(base)
    findings: list[dict] = []
    for rel in files:
        text = read_text(base / rel)
        if text is None:
            continue
        for number, line in enumerate(text.splitlines(), start=1):
            for pattern in patterns:
                if pattern in line:
                    findings.append({
                        "path": rel.as_posix(),
                        "line": number,
                        "pattern": pattern,
                        "text": line.strip()[:240],
                    })
    if include_binary_names:
        # 文件名里带旧值的二进制/其他文件也要报出来（不扫内容）。
        for path in sorted(base.rglob("*")):
            if not path.is_file():
                continue
            rel = path.relative_to(base)
            posix = rel.as_posix()
            if any(posix == s or posix.startswith(s.rstrip("/") + "/") for s in skip):
                continue
            for pattern in patterns:
                if pattern in path.name:
                    findings.append({
                        "path": posix, "line": 0, "pattern": pattern,
                        "text": "（文件名命中）",
                    })
    return findings


if __name__ == "__main__":  # 便于手工排查
    import argparse

    parser = argparse.ArgumentParser(description="通用模板替换引擎（需外部提供映射表/扫描词）")
    parser.add_argument("--mapping", help="映射表 JSON 路径：[['旧','新'], ...]")
    parser.add_argument("--patterns", nargs="*", default=[], help="残留扫描词")
    parser.add_argument("--dry-run", action="store_true", help="只统计不写入")
    parser.add_argument("--exclude", action="append", default=[], help="排除的相对路径前缀，可重复")
    parser.add_argument("--list", action="store_true", help="只列出会被处理的文件")
    args = parser.parse_args()

    targets = iter_targets(extra_exclude=args.exclude)
    if args.list:
        print(f"目标文件 {len(targets)} 个")
        for rel in targets:
            print(f"  {rel.as_posix()}")
    elif args.patterns and not args.mapping:
        found = scan(patterns=args.patterns, targets=targets)
        print(f"残留 {len(found)} 处")
        for item in found[:200]:
            print(f"  {item['path']}:{item['line']} [{item['pattern']}] {item['text']}")
    elif args.mapping:
        outcome = apply_mapping(mapping=load_mapping(args.mapping), targets=targets,
                                dry_run=args.dry_run, log_stem="customize")
        print(f"改动文件 {outcome['changed']} 个 / 替换 {outcome['total_replacements']} 次"
              f"{'（dry-run，未写入）' if args.dry_run else ''}")
        for item in outcome["files"]:
            print(f"  {item['replacements']:5}  {item['path']}")
    else:
        parser.error("请提供 --mapping 或 --patterns")
