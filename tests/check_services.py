import urllib.request, json, socket
def check(port):
    try:
        r = urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=3)
        return r.read().decode()[:300]
    except Exception as e:
        return f"ERR {type(e).__name__}: {str(e)[:120]}"
print("8765:", check(8765))
print("8878:", check(8878))
# server.json pid check
import os
for base in [r"C:\Users\Lu\Documents\ChatGPT\选本网页\instance", r"C:\Users\Lu\Documents\ChatGPT\选本网页\演示数据16篇"]:
    p = os.path.join(base, "server.json")
    if os.path.exists(p):
        print(p, "->", open(p).read())
