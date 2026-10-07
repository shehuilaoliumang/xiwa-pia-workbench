# -*- coding: utf-8 -*-
"""验证 POST /api/ai/outputs/<filename>/insert 插入链路（HTTP 级），完成后回滚。"""
import http.cookiejar
import json
import re
import sys
import urllib.request

BASE = "http://127.0.0.1:8765"
jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

def request(method, path, payload=None):
    data = None
    headers = {"X-CSRF-Token": csrf} if csrf else {}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    with opener.open(req, timeout=30) as resp:
        body = resp.read().decode("utf-8")
        return resp.status, json.loads(body) if body else {}

# 1) 拿 CSRF token（页面 meta）
page = opener.open(BASE + "/manage", timeout=30).read().decode("utf-8")
m = re.search(r'name="csrf-token" content="([^"]+)"', page)
csrf = m.group(1) if m else ""
print("csrf token:", "yes" if csrf else "MISSING")
assert csrf, "无 csrf token"

# 2) 目标剧本：script-08 的文字段落
_, lib = request("GET", "/api/library")
script = next(s for s in lib["scripts"] if s["id"] == "script-08")
blocks = script.get("blocks", [])
target = next(b for b in blocks if b["kind"] == "text")
before = len(blocks)
print("script-08 blocks:", before, "目标段落:", target["id"])

# 3) 取一个已生成视频产物
_, outputs = request("GET", "/api/ai/outputs")
video = next(o for o in outputs["outputs"] if o["kind"] == "video")
print("选择产物:", video["filename"])

# 4) 插入
status, result = request("POST", "/api/ai/outputs/" + video["filename"] + "/insert",
                         {"script_id": "script-08", "block_id": target["id"]})
print("insert status:", status)
assert status == 201 and result.get("ok"), ("插入失败", result)
inserted = result["block"]
new_blocks = result["script"]["blocks"]
new_index = next(i for i, b in enumerate(new_blocks) if b["id"] == inserted["id"])
print("插入 index:", new_index, "（目标 index:", blocks.index(target), "）kind:", inserted["kind"])
assert new_index == blocks.index(target) + 1, "位置不对！"
assert len(new_blocks) == before + 1
print("PASS: 已生成视频产物成功插入目标段落后方")

# 5) 回滚
_, after = request("DELETE", "/api/ai/tasks/finished")  # 顺带验证清理接口可用
# 直接删插入的 block：走现有删除接口（若存在）——无公开 block 删除路由时用 storage 直删
sys.path.insert(0, r"C:\Users\Lu\Documents\ChatGPT\选本网页")
from pathlib import Path
import storage as storage_mod
store = storage_mod.Store(
    database=Path(r"C:\Users\Lu\Documents\ChatGPT\选本网页\instance\workbench.sqlite3"),
    seed_path=Path(r"C:\Users\Lu\Documents\ChatGPT\选本网页\seed.json"),
    project_root=Path(r"C:\Users\Lu\Documents\ChatGPT\选本网页"),
)
store.delete_block_media("script-08", inserted["id"])
lib2 = store.library()
s2 = next(s for s in lib2["scripts"] if s["id"] == "script-08")
assert len(s2.get("blocks", [])) == before, "回滚失败"
print("PASS: 已回滚，剧本恢复原状（blocks =", before, "）")
