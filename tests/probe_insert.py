# -*- coding: utf-8 -*-
"""直调 storage.insert_block_media 定位 500 根因"""
import io
import os
import sys
import traceback

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from storage import Store

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
import storage as storage_mod
print("storage 模块:", storage_mod.__file__)
import inspect
print("签名:", inspect.signature(storage_mod.Store.insert_block_media))
s = Store(os.path.join(root, "instance", "workbench.sqlite3"), os.path.join(root, "data", "seed.json"), root)
sid = "script-06feadd7bb90"  # 上轮 API 创建的临时剧本
with open(r"C:\Users\Lu\Music\银临 - 不老梦_L.mp3", "rb") as f:
    data = f.read()
print("sid:", sid, "| size:", len(data))
try:
    asset = s.upload_block_media(io.BytesIO(data), "银临 - 不老梦_L.mp3")
    print("asset:", asset["kind"], asset["name"], asset["size"])
    r = s.insert_block_media(sid, None, asset, source="用户新增")
    print("OK blocks:", len(r.get("blocks", [])))
    for b in r["blocks"]:
        print("  -", b.get("kind"), (b.get("text") or b.get("media_name") or "")[:20])
except Exception:
    traceback.print_exc()
