# -*- coding: utf-8 -*-
"""验证新结构预览 URL 可访问 + 路径穿越防护。"""
import urllib.request

BASE = "http://127.0.0.1:8765"

def check(path, expect_ok=True):
    url = BASE + path
    try:
        req = urllib.request.Request(url, method="GET", headers={"Range": "bytes=0-1023"})
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = resp.read(1024)
            ctype = resp.headers.get("Content-Type", "?")
            print(f"{path}\n  -> HTTP {resp.status} | {ctype} | 读到 {len(data)} 字节")
            return True
    except urllib.error.HTTPError as e:
        print(f"{path}\n  -> HTTP {e.code}（期望失败时正常）")
        return e.code in (403, 404)

ok1 = check("/ai-output/video/byte_957a53c031d94e079e103cfa7bb8607d/byte_957a53c031d94e079e103cfa7bb8607d.mp4")
ok2 = check("/ai-output/video/byte_23dbefc89c0b4f12a5ec009a0760a170/byte_23dbefc89c0b4f12a5ec009a0760a170.mp4")
ok3 = check("/ai-output/image/byte_10e8fe95da3849ad8ef48406f824ebaf/byte_10e8fe95da3849ad8ef48406f824ebaf.png")
bad = check("/ai-output/../ai_output/../../Windows/win.ini", expect_ok=False)
print("结果:", "PASS" if (ok1 and ok2 and ok3 and bad) else "FAIL")
