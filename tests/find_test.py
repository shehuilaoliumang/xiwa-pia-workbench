import sqlite3, json
for db in [r"C:\Users\Lu\Documents\ChatGPT\选本网页\演示数据16篇\workbench.sqlite3", r"C:\Users\Lu\Documents\ChatGPT\选本网页\instance\workbench.sqlite3"]:
    print("== " + db)
    c = sqlite3.connect(db)
    n = c.execute("SELECT COUNT(*) FROM scripts").fetchone()[0]
    print(f"  scripts={n}")
    for rid, data in c.execute("SELECT id, data FROM scripts").fetchall():
        p = json.loads(data)
        if p.get("title") == "测试" or "8aa496" in rid:
            print("  FOUND 测试:", rid)
            media_blocks = [b for b in p.get("blocks", []) if b.get("media_path")]
            for b in media_blocks:
                print("    block media:", b.get("kind"), b.get("media_path"), b.get("media_name"))
