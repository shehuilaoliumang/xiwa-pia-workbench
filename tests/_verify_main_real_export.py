# -*- coding: utf-8 -*-
"""端到端验证：用 GitHub main 分支真实代码导出单篇 ZIP → 当前版本(8765)预览导入。
不真正导入，不污染剧本库。"""
import hashlib
import http.cookiejar
import json
import re
import sys
import urllib.request
from pathlib import Path

WT = Path(r"C:\Users\Lu\Documents\ChatGPT\选本网页\wt-main")
ROOT = Path(r"C:\Users\Lu\Documents\ChatGPT\选本网页")
sys.path.insert(0, str(WT))

import storage as main_storage  # noqa: E402
import script_package as main_pkg  # noqa: E402

store = main_storage.Store(
    database=ROOT / "instance" / "workbench.sqlite3",
    seed_path=WT / "seed.json",
    project_root=WT,
)

# 1) main 代码导出 script-08
stream, _ = main_pkg.export_package(store, "script-08")
stream.seek(0)
raw = stream.read()
print("main 导出的包大小:", len(raw))

# 2) 检查包内 script.json 段落 kind（应无 video/audio）
import io, zipfile
with zipfile.ZipFile(io.BytesIO(raw)) as z:
    sc = json.loads(z.read("script.json").decode("utf-8"))
kinds = sorted({b.get("kind") for b in sc["blocks"]})
print("段落 kind:", kinds)
print("BLOCK_FIELDS 是否有 media_*:", any(k.startswith("media_") for k in sc["blocks"][0]) if sc["blocks"] else "no blocks")

# 3) 用当前版本 8765 preview 导入
BASE = "http://127.0.0.1:8765"
jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
page = opener.open(BASE + "/manage", timeout=30).read().decode("utf-8")
m = re.search(r'name="csrf-token" content="([^"]+)"', page)
csrf = m.group(1) if m else ""
assert csrf, "no csrf"
boundary = "----pia" + hashlib.md5(b"main-verify").hexdigest()
head = ('--%s\r\nContent-Disposition: form-data; name="file"; filename="main.zip"\r\n'
        'Content-Type: application/zip\r\n\r\n') % boundary
body = head.encode("utf-8") + raw + ("\r\n--%s--\r\n" % boundary).encode("utf-8")
req = urllib.request.Request(BASE + "/api/script-packages/preview", data=bytes(body), method="POST",
                             headers={"Content-Type": "multipart/form-data; boundary=" + boundary,
                                      "X-CSRF-Token": csrf})
with opener.open(req, timeout=60) as resp:
    result = json.loads(resp.read().decode("utf-8"))
script_title = (result.get("script") or {}).get("title", "")
print("当前版本 preview:", resp.status)
print("preview 解析出剧本:", script_title)
print("ALL PASS" if resp.status == 200 and script_title else "FAIL")
