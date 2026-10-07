import sqlite3, json, os
root = r"C:\Users\Lu\Documents\ChatGPT\选本网页"
db = sqlite3.connect(os.path.join(root, "instance", "workbench.sqlite3"))
cur = db.cursor()
print("== media 目录 ==")
for f in sorted(os.listdir(os.path.join(root, "instance", "media"))):
    p = os.path.join(root, "instance", "media", f)
    print(" ", f, os.path.getsize(p) // 1024, "KB")
print("== settings state/queue ==")
for row in cur.execute("select key, data from settings"):
    d = json.loads(row[1]) if row[1] else {}
    if row[0] in ("state", "queue"):
        print(" ", row[0], "->", json.dumps(d, ensure_ascii=False)[:300])
print("== history 引用 88mp3 / 0880f1a6 ==")
for row in cur.execute("select script_id, data from history"):
    data = json.loads(row[1])
    txt = json.dumps(data, ensure_ascii=False)
    hits = [k for k in ("89d66f958f5c0b6c4022c0b8fcd85f7e9", "0880f1a624369891671b84595b3291f01") if k in txt]
    if hits:
        print("  history script", row[0][:12], "hits:", hits)
