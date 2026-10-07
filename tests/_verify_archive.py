# -*- coding: utf-8 -*-
"""验证新归档链路：mock 任务生成成功 -> 产物自动归档 ai_output/video/ -> 伴随 json 含提示词。
不带 script_id/block_id（不插入正文，不污染剧本库）。"""
import http.cookiejar
import json
import re
import time
import urllib.request
from pathlib import Path

BASE = "http://127.0.0.1:8765"
jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
csrf = ""

def request(method, path, payload=None):
    headers = {"X-CSRF-Token": csrf} if csrf else {}
    data = None
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    with opener.open(req, timeout=30) as resp:
        body = resp.read().decode("utf-8")
        return resp.status, json.loads(body) if body else {}

page = opener.open(BASE + "/manage", timeout=30).read().decode("utf-8")
m = re.search(r'name="csrf-token" content="([^"]+)"', page)
csrf = m.group(1) if m else ""
assert csrf

PROMPT = "归档链路自动验证：一杯咖啡的特写镜头，清晨阳光，暖色调。"
_, task = request("POST", "/api/ai/video/generate", {
    "prompt": PROMPT, "platform": "mock", "model": "mock-v1",
    "ratio": "9:16", "duration": 10, "script_id": "", "block_id": "",
})
tid = task["task_id"]
print("task:", tid)

for _ in range(60):
    time.sleep(2)
    _, t = request("GET", "/api/ai/tasks/" + tid)
    if t["status"] in ("succeeded", "failed", "cancelled"):
        break
print("status:", t["status"], "| result_file:", t.get("result_file"))
assert t["status"] == "succeeded", t.get("error")

rf = Path(t["result_file"])
assert rf.parent.name == "video", "未归档到 video/ 子目录：" + str(rf)
meta_file = rf.with_suffix(rf.suffix + ".json")
assert meta_file.is_file(), "缺少伴随元数据 json"
meta = json.loads(meta_file.read_text(encoding="utf-8"))
assert meta.get("prompt") == PROMPT, "伴随 json 提示词缺失"
print("PASS: 产物归档 ->", rf.parent.name + "/" + rf.name)
print("PASS: 伴随 json 含提示词/平台/模型/比例/时长/任务ID")
print("meta:", json.dumps({k: meta[k] for k in ("kind", "platform", "model", "ratio", "duration", "task_id")}, ensure_ascii=False))
