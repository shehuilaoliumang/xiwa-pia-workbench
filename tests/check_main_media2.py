import sqlite3, json
c = sqlite3.connect(r"C:\Users\Lu\Documents\ChatGPT\选本网页\instance\workbench.sqlite3")
for rid, data in c.execute("SELECT id, data FROM scripts").fetchall():
    p = json.loads(data)
    media = p.get("media")
    if media and media.get("path"):
        print(f"{rid} | {p.get('title')} | media={media.get('path')} kind={media.get('kind')} cues={len(media.get('cues') or [])}")
