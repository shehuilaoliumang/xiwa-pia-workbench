# -*- coding: utf-8 -*-
"""真实查询字节已开通模型（AK/SK），确认视频模型是否可用。"""
import json
import sys
from pathlib import Path

sys.path.insert(0, r".")
from ai_generator.byte import ByteAdapter

ROOT = Path(r"C:\Users\Lu\Documents\ChatGPT\选本网页")
OUT = ROOT / "instance" / "ai_output"

db = __import__("sqlite3").connect(str(ROOT / "instance" / "ai_generator.sqlite3"))
row = db.execute("select data from ai_config where key='main'").fetchone()
c = json.loads(row[0])
b = c["platforms"]["byte"]

adapter = ByteAdapter(output_dir=OUT, api_key=b.get("api_key", ""))
result = adapter.list_activations(ak=b.get("ak", ""), sk=b.get("sk", ""))
if result is None:
    print("查询失败（AK/SK 无效或网络问题）")
else:
    print("已开通数量:", len(result))
    for item in result:
        print(" -", item if isinstance(item, str) else item.get("FoundationModelName"))
