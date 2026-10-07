# -*- coding: utf-8 -*-
"""验证 _ref_image_to_data_uri 在最新代码下不抛 name 'base' is not defined。"""
import json
import sys
from pathlib import Path

sys.path.insert(0, r".")
from ai_generator.tasks import TaskManager

ROOT = Path(r"C:\Users\Lu\Documents\ChatGPT\选本网页")
DB = ROOT / "instance" / "ai_generator.sqlite3"
MEDIA = ROOT / "instance" / "media"
OUT = ROOT / "instance" / "ai_output"

tm = TaskManager(database=DB, media_dir=MEDIA, output_dir=OUT)

# 现有角色图（实际文件名）
ref = "/media/84f718b7685ecb3e6ab802f785cbb59a0b03f05145302ff5227d80fda41ac1f3.png"
uri = tm._ref_image_to_data_uri(ref)
print("ref ->", uri[:80], "len=", len(uri))
assert uri.startswith("data:image/"), "应返回 data URI"

# 无参考图
assert tm._ref_image_to_data_uri("") == ""
assert tm._ref_image_to_data_uri(None) == ""
print("PASS: _ref_image_to_data_uri 正常（base 引用 OK）")
