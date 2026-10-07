import sqlite3, json
c = sqlite3.connect(r"C:\Users\Lu\Documents\ChatGPT\选本网页\instance\workbench.sqlite3")
cols = [r[1] for r in c.execute("PRAGMA table_info(scripts)").fetchall()]
print("cols:", cols)
idcol = cols[0]
datacol = "data" if "data" in cols else cols[-1]
rows = c.execute(f"SELECT {idcol}, {datacol} FROM scripts").fetchall()
count = 0
for rid, data in rows:
    payload = json.loads(data)
    title = payload.get("title", rid)
    media = payload.get("media")
    if media and media.get("path"):
        count += 1
        print(f"{title}: media={media.get('path')} kind={media.get('kind')} cues={len(media.get('cues') or [])}")
print(f"total scripts={len(rows)}, with media={count}")
