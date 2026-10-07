# -*- coding: utf-8 -*-
import sqlite3, json
db = sqlite3.connect(r"instance\ai_generator.sqlite3")
row = db.execute("select data from ai_config where key='main'").fetchone()
c = json.loads(row[0])
b = c["platforms"]["byte"]
print("api_key:", repr(b.get("api_key", ""))[:24])
print("ak:", repr(b.get("ak", ""))[:70])
print("sk set:", bool(b.get("sk")))
print("image_model:", repr(b.get("image_model", "")))
