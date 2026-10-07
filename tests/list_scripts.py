import sqlite3, json
c = sqlite3.connect(r"C:\Users\Lu\Documents\ChatGPT\选本网页\演示数据16篇\workbench.sqlite3")
cats = {r[0]: r[1] for r in c.execute("SELECT id, data FROM categories").fetchall()}
rows = c.execute("SELECT id, category_id, data FROM scripts").fetchall()
for rid, cid, data in rows:
    p = json.loads(data)
    cat = json.loads(cats.get(cid, "{}")).get("name", "?") if cid in cats else "?"
    media = p.get("media")
    if media and media.get("path"):
        print(f"{rid} | {cat} | {p.get('title')} | media={media.get('path')} kind={media.get('kind')} name={media.get('name')} cues={len(media.get('cues') or [])}")
    else:
        print(f"{rid} | {cat} | {p.get('title')} | media=none")
