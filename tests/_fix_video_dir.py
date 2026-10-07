# -*- coding: utf-8 -*-
"""修复 video/ 目录下的假 .png 真 mp4（生成时被 _fix_image_suffix 误改名）：
改回 .mp4，更新伴随元数据（kind/result_file，ref_image 超长时省略），同步任务表。"""
import json
import shutil
import sqlite3
from pathlib import Path

ROOT = Path(r"C:\Users\Lu\Documents\ChatGPT\选本网页")
OUT = ROOT / "instance" / "ai_output"
DB = ROOT / "instance" / "ai_generator.sqlite3"

def is_mp4(path: Path) -> bool:
    try:
        with path.open("rb") as f:
            return len(f.read(12)) >= 8 and f.seek(4) or False
    except OSError:
        return False

def read_mp4(path: Path) -> bool:
    try:
        with path.open("rb") as f:
            head = f.read(12)
        return len(head) >= 8 and head[4:8] == b"ftyp"
    except OSError:
        return False

def short_ref(ref: str) -> str:
    ref = ref or ""
    if len(ref) > 120:
        return "（内嵌参考图 data URI，共 " + str(len(ref)) + " 字符，已省略）"
    return ref

conn = sqlite3.connect(str(DB))
conn.row_factory = sqlite3.Row
fixed = 0
for folder in [OUT / "video", OUT / "image", OUT]:
    if not folder.is_dir():
        continue
    for file in folder.iterdir():
        if not file.is_file() or file.suffix.lower() not in (".png", ".jpg", ".jpeg", ".webp", ".gif"):
            continue
        if not read_mp4(file):
            continue
        target = file.with_suffix(".mp4")
        if target.exists():
            target.unlink()
        shutil.move(str(file), str(target))
        meta_file = target.with_suffix(".mp4.json")
        if meta_file.is_file():
            meta = json.loads(meta_file.read_text(encoding="utf-8"))
            meta["kind"] = "video"
            meta["ref_image"] = short_ref(meta.get("ref_image"))
            meta["result_file"] = str(target)
            meta_file.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
        for old in (str(file), file.name, file.stem):
            rows = conn.execute("SELECT task_id FROM ai_tasks WHERE result_file=? OR task_id=?", (old, old)).fetchall()
            for row in rows:
                conn.execute("UPDATE ai_tasks SET result_file=? WHERE task_id=?", (str(target), row["task_id"]))
        print("修复:", file.name, "->", target.name)
        fixed += 1
conn.commit()
conn.close()
print("共修复", fixed, "个")
