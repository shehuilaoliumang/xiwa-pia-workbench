# -*- coding: utf-8 -*-
"""一次性迁移：把 ai_output 平铺产物按类别移入 video/image 子目录，
从 ai_tasks 表回填伴随元数据 json，同步更新任务 result_file；删除空目录 ai-output。"""
import json
import shutil
import sqlite3
import sys
from pathlib import Path

ROOT = Path(r"C:\Users\Lu\Documents\ChatGPT\选本网页")
OUT = ROOT / "instance" / "ai_output"
DB = ROOT / "instance" / "ai_generator.sqlite3"
STALE = ROOT / "instance" / "ai-output"

EXT_KIND = {
    ".mp4": "video", ".mov": "video", ".webm": "video", ".m4v": "video", ".avi": "video",
    ".mp3": "audio", ".wav": "audio", ".m4a": "audio", ".ogg": "audio", ".flac": "audio",
    ".png": "image", ".jpg": "image", ".jpeg": "image", ".webp": "image", ".gif": "image",
}

# 读取任务表
conn = sqlite3.connect(str(DB))
conn.row_factory = sqlite3.Row
rows = conn.execute(
    "SELECT task_id,kind,platform,model,prompt,ref_image,ratio,duration,role_name,"
    "script_id,block_id,status,progress,result_file,error,created_at,updated_at "
    "FROM ai_tasks ORDER BY created_at").fetchall()
tasks_by_file = {}
for row in rows:
    rf = row["result_file"] or ""
    if rf:
        tasks_by_file[Path(rf).name] = dict(row)

moved = 0
meta_written = 0
updated = 0
for file in OUT.iterdir():
    if not file.is_file() or file.suffix.lower() not in EXT_KIND:
        continue
    kind = EXT_KIND[file.suffix.lower()]
    sub = OUT / kind
    sub.mkdir(parents=True, exist_ok=True)
    target = sub / file.name
    if file != target:
        if target.exists():
            target.unlink()
        shutil.move(str(file), str(target))
        moved += 1
    # 伴随元数据：优先取任务表信息；无任务时写最小信息
    task = tasks_by_file.get(file.name)
    meta = {
        "task_id": (task or {}).get("task_id"),
        "kind": (task or {}).get("kind") or kind,
        "status": (task or {}).get("status") or "succeeded",
        "platform": (task or {}).get("platform"),
        "model": (task or {}).get("model"),
        "prompt": (task or {}).get("prompt"),
        "ratio": (task or {}).get("ratio"),
        "duration": (task or {}).get("duration"),
        "role_name": (task or {}).get("role_name") or "",
        "ref_image": (task or {}).get("ref_image") or "",
        "script_id": (task or {}).get("script_id") or "",
        "block_id": (task or {}).get("block_id") or "",
        "created_at": (task or {}).get("created_at"),
        "updated_at": (task or {}).get("updated_at"),
        "result_file": str(target),
    }
    meta_file = target.with_suffix(target.suffix + ".json")
    meta_file.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    meta_written += 1
    if task:
        conn.execute("UPDATE ai_tasks SET result_file=? WHERE task_id=?",
                     (str(target), task["task_id"]))
        updated += 1

conn.commit()
conn.close()

# 删除空目录 ai-output（旧命名遗留）
removed_stale = False
if STALE.is_dir() and not any(STALE.iterdir()):
    STALE.rmdir()
    removed_stale = True

print(f"移动产物: {moved} 个 | 写入伴随元数据: {meta_written} | 更新任务 result_file: {updated} | 删除空目录 ai-output: {removed_stale}")
for sub in sorted(p for p in OUT.iterdir() if p.is_dir()):
    count = len([f for f in sub.iterdir() if f.is_file() and f.suffix.lower() in EXT_KIND])
    print(f"  {sub.name}/: {count} 个产物")
