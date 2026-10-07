import sqlite3, json
db = sqlite3.connect(r"C:\Users\Lu\Documents\ChatGPT\选本网页\instance\workbench.sqlite3")
cur = db.cursor()
cur.execute("select id, category_id, data from scripts")
for rid, cid, data in cur.fetchall():
    d = json.loads(data) if data else {}
    title = d.get("title", "")
    media = d.get("media") or None
    blocks = d.get("blocks") or []
    med = [b for b in blocks if b.get("kind") in ("audio", "video")]
    print(rid[:12], "|", title, "| media:", (json.dumps(media, ensure_ascii=False)[:70] if media else "-"))
    for b in med:
        print("   block:", b.get("kind"), "|", (b.get("media_name") or ""), "|", (b.get("media_path") or "")[:40])
