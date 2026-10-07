import socket, urllib.request
# check 8765 and 19648
try:
    with urllib.request.urlopen("http://127.0.0.1:8765/api/health", timeout=2) as r:
        print("8765 UP:", r.read().decode()[:200])
except Exception as e:
    print("8765 ERR:", e)
import psutil
