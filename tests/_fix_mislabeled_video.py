# -*- coding: utf-8 -*-
"""修复历史产物：扫描 ai_output 下扩展名为 .png/.jpg/.webp 但真实文件头是 mp4 的
「假图片真视频」，改回 .mp4、移入 video/ 子目录，并同步伴随元数据与任务表。"""
import json
import shutil
import sqlite3
import sys
from pathlib import Path

ROOT = Path(r"C:\Users\Lu\Documents\ChatGPT\选本网页")
OUT = ROOT / "instance" / "ai_output"
DB = ROOT / "instance" / "ai_generator.sqlite3"

MP4_MAGIC = b"ftyp"  # mp4 文件头第 4-8 字节

def is_mp4(path: Path) -> bool:
    try:
        with path.open("rb") as f:
            head = f.read(12)
        return len(head) >= 8 and head[4:8] == MP4_MAGIC
    except OSError:
        return False

fixed = []
for folder in [OUT, OUT / "image"]:
    if not folder.is_dir():
        continue
    for file in folder.iterdir():
        if not file.is_file() or file.suffix.lower() not in (".png", ".jpg", ".jpeg", ".webp", ".gif"):
            continue
        if is_mp4(file):
            fixed.append(file)

print(f"发现假图片真视频: {len(fixed)} 个")

conn = sqlite3.connect(str(DB))
conn.row_factory = sqlite3.Row

for file in fixed:
    # 1) 改回 .mp4 并移入 video/
    target = OUT / "video" / (file.stem + ".mp4")
    if target.exists():
        target.unlink()
    shutil.move(str(file), str(target))
    # 2) 更新伴随元数据
    meta_file = target.with_suffix(".mp4.json")
    if meta_file.is_file():
        meta = json.loads(meta_file.read_text(encoding="utf-8"))
        meta["kind"] = "video"
        meta["result_file"] = str(target)
        meta_file.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    # 3) 更新任务表（按旧 result_file 或文件 stem 匹配）
    old_names = [str(file), file.name, file.stem]
    for old in old_names:
        rows = conn.execute("SELECT task_id FROM ai_tasks WHERE result_file=? OR task_id=?", (old, old)).fetchall()
        for row in rows:
            conn.execute("UPDATE ai_tasks SET result_file=? WHERE task_id=?", (str(target), row["task_id"]))
    print("  修复:", file.name, "->", target.name)

conn.commit()
conn.close()
print("完成")
