# 单测：_remember_unavailable_model 落库 + status 返回
import sys, json
sys.path.insert(0, r"C:\Users\Lu\Documents\ChatGPT\选本网页")
from pathlib import Path
from ai_generator.tasks import TaskManager
from ai_generator import base

DB = Path(r"C:\Users\Lu\Documents\ChatGPT\选本网页\instance\ai_generator.sqlite3")
media = Path(r"C:\Users\Lu\Documents\ChatGPT\选本网页\instance\media")
outdir = Path(r"C:\Users\Lu\Documents\ChatGPT\选本网页\instance\ai_output")

m = TaskManager(DB, media, outdir, store=None)

# 用户账号实测 404 的模型（2026-10-06 实测：字节 7 个图像模型全未开通）
byte_image_unavailable = [
    "doubao-seedream-3-0-t2i-250415",
    "doubao-seedream-4-0-20260415",
    "doubao-seedream-4-0-250828",
    "doubao-seedream-4-5-251128",
    "doubao-seedream-5-0-260128",
    "doubao-seedream-5-0-flash-260915",
    "doubao-seedream-5-0-pro-260628",
]
byte_video_unavailable = ["doubao-seedance-2-0-260128"]  # 用户此前视频 404 报错

for mod in byte_image_unavailable:
    m._remember_unavailable_model("byte", mod)
for mod in byte_video_unavailable:
    m._remember_unavailable_model("byte", mod)

cfg = base.load_config(DB)
print("byte.unavailable_models =", json.dumps(cfg["platforms"]["byte"].get("unavailable_models"), ensure_ascii=False))
assert sorted(cfg["platforms"]["byte"]["unavailable_models"]) == sorted(byte_image_unavailable + byte_video_unavailable), "落库不一致"
print("OK: 落库验证通过")
