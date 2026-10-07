# -*- coding: utf-8 -*-
"""端到端验证：真实字节视频生成（seedance-1-0-pro-fast，已开通）。
验证 content dict/list 解析修复与整条任务链路。"""
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, r".")
from ai_generator.tasks import TaskManager

ROOT = Path(r"C:\Users\Lu\Documents\ChatGPT\选本网页")
DB = ROOT / "instance" / "ai_generator.sqlite3"
MEDIA = ROOT / "instance" / "media"
OUT = ROOT / "instance" / "ai_output"

tm = TaskManager(database=DB, media_dir=MEDIA, output_dir=OUT)
tm.start()

task_id = tm.submit_video(
    prompt="夜晚的江南古镇，细雨绵绵，一名撑着油纸伞的女子缓缓走过青石板桥，桥下流水倒映暖黄灯笼光，静谧唯美。",
    platform="byte",
    model="doubao-seedance-1-0-pro-fast-251015",
    ratio="16:9",
    duration=5,
    script_id=None,
    block_id=None,
)
print("task_id:", task_id)
tid = task_id["task_id"] if isinstance(task_id, dict) else task_id

for i in range(90):
    time.sleep(3)
    task = tm.get_task(tid)
    status = task.get("status")
    progress = task.get("progress")
    error = task.get("error")
    print(f"[{i*3}s] status={status} progress={progress} error={error}")
    if status in ("succeeded", "failed", "canceled"):
        print("RESULT:", json.dumps({k: task.get(k) for k in ("status", "output", "error", "model")}, ensure_ascii=False, default=str)[:500])
        break
else:
    print("TIMEOUT")
