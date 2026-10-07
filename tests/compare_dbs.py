import sqlite3, json
for db in [r"C:\Users\Lu\Documents\ChatGPT\选本网页\instance\workbench.sqlite3", r"C:\Users\Lu\Documents\ChatGPT\选本网页\演示数据16篇\workbench.sqlite3"]:
    print("== " + db)
    c = sqlite3.connect(db)
    rows = c.execute("SELECT id, data FROM scripts").fetchall()
    for rid, data in rows:
        p = json.loads(data)
        media = p.get("media")
        m = ""
        if media and media.get("path"):
            m = f" media={media.get('path')} kind={media.get('kind')} name={media.get('name')}"
        print(f"  {rid} | {p.get('title')}{m}")
