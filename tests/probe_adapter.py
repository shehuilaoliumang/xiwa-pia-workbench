# -*- coding: utf-8 -*-
"""验证 _adapter 模型解析（不实际调用平台 API）"""
import json
import os
import sys
import urllib.request

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, root)

# 1) 确认 config.model（HTTP 方式，含 refresh）
req = urllib.request.Request("http://127.0.0.1:8765/api/library")
with urllib.request.urlopen(req, timeout=5) as r:
    lib = json.loads(r.read().decode("utf-8"))
tok = lib["csrf_token"]
req2 = urllib.request.Request("http://127.0.0.1:8765/api/ai/models/refresh", method="POST")
req2.add_header("X-CSRF-Token", tok)
with urllib.request.urlopen(req2, timeout=15) as r:
    json.loads(r.read().decode("utf-8"))
req3 = urllib.request.Request("http://127.0.0.1:8765/api/ai/status")
with urllib.request.urlopen(req3, timeout=5) as r:
    st = json.loads(r.read().decode("utf-8"))
cfg = st["config"]["platforms"]
for p in ("byte", "ali"):
    m = cfg[p].get("model")
    ok = m in st["platforms"][p]["models"]
    im = (cfg[p].get("models") or {}).get("image") or {}
    print(p, "config.model =", m, "| 在视频列表:", ok, "| 动态图像模型数:", len(im), "| 首个图像:", next(iter(im), "-"))

# 2) 直接测 _adapter（模拟空 model 提交 → 应回退 config.model）
from ai_generator.tasks import TaskManager
from pathlib import Path

out_lines = []
instance = Path(root) / "instance"
manager = TaskManager(instance / "ai_generator.sqlite3", Path(root) / "instance" / "media",
                      Path(root) / "instance" / "ai_output", store=None)
for p in ("byte", "ali"):
    adapter = manager._adapter(p, "")  # 前端提交 model="" 的场景
    out_lines.append(f"{p} _adapter 空 model → {adapter.model} | image_model: {getattr(adapter, 'image_model', '')[:70] or '-'}")

with open(os.path.join(root, "tests", "_adapter_result.txt"), "w", encoding="utf-8") as f:
    f.write("\n".join(out_lines))
print("done")

