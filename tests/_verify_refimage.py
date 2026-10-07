# -*- coding: utf-8 -*-
import sys
from pathlib import Path
sys.path.insert(0, r".")
from ai_generator.tasks import TaskManager

db = Path(r"instance\ai_generator.sqlite3")
media = Path(r"instance\media")
out = Path(r"instance\ai_output")
tm = TaskManager(db, media, out)

for ref in ("/media/84f718b7685ecb3e6ab802f785cbb59a0b03f05145302ff5227d80fda41ac1f3.png",
            "https://example.com/a.png", "", "data:image/png;base64,AAA"):
    uri = tm._ref_image_to_data_uri(ref)
    print(repr(ref)[:50], "->", len(uri), uri[:45], flush=True)
