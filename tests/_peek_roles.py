# -*- coding: utf-8 -*-
import sqlite3
c = sqlite3.connect(r"instance\ai_generator.sqlite3")
rows = c.execute("select id,name,image_file from ai_characters limit 10").fetchall()
print("total rows:", len(rows), flush=True)
for r in rows:
    print("role:", r[1], "| image_file:", repr(r[2])[:100], flush=True)
