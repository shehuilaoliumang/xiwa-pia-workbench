import sqlite3
db = sqlite3.connect(r"C:\Users\Lu\Documents\ChatGPT\选本网页\instance\workbench.sqlite3")
cur = db.cursor()
cur.execute("select name from sqlite_master where type='table'")
print("TABLES:", [r[0] for r in cur.fetchall()])
cur.execute("PRAGMA table_info(scripts)")
print("scripts cols:", [r[1] for r in cur.fetchall()])
