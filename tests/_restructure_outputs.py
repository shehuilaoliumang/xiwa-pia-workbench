# -*- coding: utf-8 -*-
"""重构 ai_output 结构：每个产物单独一个文件夹（video/<stem>/ 或 image/<stem>/），
产物与 meta.json 打包在一起；清理孤儿/命名错乱的旧 json，并截断超长 ref_image。"""
import json
import shutil
import sqlite3
from pathlib import Path

ROOT = Path(r"C:\Users\Lu\Documents\ChatGPT\选本网页")
OUT = ROOT / "instance" / "ai_output"
DB = ROOT / "instance" / "ai_generator.sqlite3"

EXT_KIND = {
    ".mp4": "video", ".mov": "video", ".webm": "video", ".m4v": "video", ".avi": "video",
    ".mp3": "audio", ".wav": "audio", ".m4a": "audio", ".ogg": "audio", ".flac": "audio",
    ".png": "image", ".jpg": "image", ".jpeg": "image", ".webp": "image", ".gif": "image",
}

def short_ref(ref):
    ref = ref or ""
    if isinstance(ref, str) and len(ref) > 120:
        return f"（内嵌参考图 data URI，共 {len(ref)} 字符，已省略）"
    return ref

conn = sqlite3.connect(str(DB))
conn.row_factory = sqlite3.Row

def find_legacy_json(stem):
    """全局找该产物对应的旧伴随 json（如 xxx.mp4.json / xxx.png.json），排除新结构 meta.json。"""
    for file in OUT.rglob(stem + "*.json"):
        if file.name == "meta.json":
            continue
        if file.parent.parent == OUT:  # 只认旧平铺结构 video/xxx.json 或 image/xxx.json
            return file
    return None

def update_task(new_result: Path, old_names):
    for old in old_names:
        rows = conn.execute("SELECT task_id FROM ai_tasks WHERE result_file=?", (old,)).fetchall()
        for row in rows:
            conn.execute("UPDATE ai_tasks SET result_file=? WHERE task_id=?", (str(new_result), row["task_id"]))

moved = []
orphan_jsons = []
for kind_dir in [OUT / "video", OUT / "image", OUT / "audio"]:
    if not kind_dir.is_dir():
        continue
    for file in list(kind_dir.iterdir()):
        if file.is_dir():
            continue
        if file.suffix.lower() in EXT_KIND:
            # 产物：建独立文件夹
            folder = kind_dir / file.stem
            folder.mkdir(parents=True, exist_ok=True)
            target = folder / file.name
            if file != target:
                if target.exists():
                    target.unlink()
                shutil.move(str(file), str(target))
            moved.append(target)
            # 伴随元数据：优先旧 json，其次最小信息
            legacy = find_legacy_json(file.stem)
            meta = None
            if legacy:
                try:
                    meta = json.loads(legacy.read_text(encoding="utf-8"))
                except Exception:
                    meta = None
                legacy.unlink(missing_ok=True)
            if not isinstance(meta, dict):
                meta = {}
            meta.setdefault("kind", EXT_KIND[target.suffix.lower()])
            meta.setdefault("status", "succeeded")
            meta["ref_image"] = short_ref(meta.get("ref_image"))
            meta["result_file"] = str(target)
            (folder / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
            update_task(target, [str(file), file.name, file.stem])
        elif file.suffix.lower() == ".json" and file.name != "meta.json":
            orphan_jsons.append(file)

# 清理孤儿 json（无对应产物）
removed = 0
for json_file in orphan_jsons:
    stem = json_file.stem
    # 检查是否已有同 stem 的产物文件夹（可能已并入，直接删旧文件）
    if any((OUT / kind / stem).is_dir() for kind in ("video", "image", "audio")):
        json_file.unlink(missing_ok=True)
        removed += 1

conn.commit()
conn.close()
print(f"重构产物: {len(moved)} 个 | 清理孤儿 json: {removed} 个")
for sub in sorted(p for p in OUT.iterdir() if p.is_dir()):
    folders = [p for p in sub.iterdir() if p.is_dir()]
    loose = [p.name for p in sub.iterdir() if p.is_file() and p.suffix.lower() in EXT_KIND]
    print(f"  {sub.name}/: {len(folders)} 个产物文件夹" + (f"（遗留散文件: {loose}）" if loose else ""))
