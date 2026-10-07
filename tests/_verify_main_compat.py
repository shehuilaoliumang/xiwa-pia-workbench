# -*- coding: utf-8 -*-
"""验证单篇导入对 GitHub main 版本导出格式的适配：
1) 用当前格式导出 script-08，构造「main 格式」包（剔除段落级音视频 block 与 media_* 字段，模拟 main 分支可导出的内容）
2) POST /api/script-packages/preview 验证可正常预览导入
3) 同时验证当前格式自兼容（script-e38349b24872 原样导出预览）
全程不真正导入，不污染剧本库。
"""
import hashlib
import http.cookiejar
import io
import json
import re
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(r"C:\Users\Lu\Documents\ChatGPT\选本网页")
sys.path.insert(0, str(ROOT))
import storage as storage_mod
from script_package import export_package, _json, _normalize, _pairs  # noqa: E402

BASE = "http://127.0.0.1:8765"
jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
csrf = None

def request(method, path, multipart=None):
    global csrf
    headers = {"X-CSRF-Token": csrf} if csrf else {}
    data = None
    if multipart is not None:
        boundary = "----pia" + hashlib.md5(b"pia-test").hexdigest()
        body = bytearray()
        for field, (filename, content, mime) in multipart.items():
            head = ('--%s\r\nContent-Disposition: form-data; name="%s"; filename="%s"\r\n'
                    'Content-Type: %s\r\n\r\n') % (boundary, field, filename, mime)
            body.extend(head.encode("utf-8"))
            body.extend(content if isinstance(content, bytes) else content.encode("utf-8"))
            body.extend(b"\r\n")
        body.extend(("--%s--\r\n" % boundary).encode("utf-8"))
        data = bytes(body)
        headers["Content-Type"] = "multipart/form-data; boundary=" + boundary
    req = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    with opener.open(req, timeout=60) as resp:
        body = resp.read().decode("utf-8")
        return resp.status, json.loads(body) if body else {}

# CSRF
page = opener.open(BASE + "/manage", timeout=30).read().decode("utf-8")
m = re.search(r'name="csrf-token" content="([^"]+)"', page)
csrf = m.group(1) if m else ""
assert csrf, "无 csrf token"
print("csrf ok")

store = storage_mod.Store(
    database=ROOT / "instance" / "workbench.sqlite3",
    seed_path=ROOT / "seed.json",
    project_root=ROOT,
)

def rebuild_zip(original_bytes, transform_script):
    """读原 ZIP，修改 script.json（去掉段落级音视频与 media_* 字段），重算 manifest，重新打包。"""
    with zipfile.ZipFile(io.BytesIO(original_bytes)) as zin:
        names = [n for n in zin.namelist() if n != "manifest.json"]
        script_content = zin.read("script.json")
        manifest = json.loads(zin.read("manifest.json"))
        entries = {n: zin.read(n) for n in names}
    new_script = transform_script(json.loads(script_content.decode("utf-8")))
    new_content = json.dumps(new_script, ensure_ascii=False).encode("utf-8")
    # 校验新 script 符合当前导入器（自洽检查）
    _normalize(new_script)
    entries["script.json"] = new_content
    manifest["files"]["script.json"] = {
        "size": len(new_content),
        "sha256": hashlib.sha256(new_content).hexdigest(),
        "mime": "application/json",
    }
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zout:
        for name in ("script.json",) + tuple(n for n in names if n != "script.json"):
            zout.writestr(name, entries[name])
        zout.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False).encode("utf-8"))
    return out.getvalue()

def make_main_format(script):
    """把当前剧本结构降级为 main 分支可导出的格式：删掉 video/audio 段落与 media_* 字段。"""
    script = dict(script)
    script["blocks"] = [
        {k: v for k, v in b.items() if k not in ("media_path", "media_name", "media_size", "media_sha256", "media_duration")}
        for b in script.get("blocks", [])
        if b.get("kind") not in ("video", "audio")
    ]
    return script

# 1) 测试剧本原样导出（当前格式自兼容）
stream, _ = export_package(store, "script-e38349b24872")
stream.seek(0)
original_bytes = stream.read()
status, result = request("POST", "/api/script-packages/preview",
                         {"file": ("t.zip", original_bytes, "application/zip")})
print("测试剧本（当前格式）preview:", status)
assert status == 200, result
print("PASS: 当前格式包可预览导入")

# 2) script-08 构造 main 格式（无段落级音视频）
stream2, _ = export_package(store, "script-08")
stream2.seek(0)
orig08 = stream2.read()
main_bytes = rebuild_zip(orig08, make_main_format)
with zipfile.ZipFile(io.BytesIO(main_bytes)) as z:
    sc = json.loads(z.read("script.json"))
kinds = {b.get("kind") for b in sc["blocks"]}
print("main 格式段落 kind:", sorted(kinds))
assert "video" not in kinds and "audio" not in kinds
status2, result2 = request("POST", "/api/script-packages/preview",
                           {"file": ("main.zip", main_bytes, "application/zip")})
print("main 格式包 preview:", status2)
assert status2 == 200, result2
print("PASS: main 分支可导出的单篇 ZIP 能被当前版本预览导入（格式兼容）")

# 3) 反向：当前格式（含段落级音视频）导入 main 会失败 —— 验证预期报错（说明需要合并）
# main 的校验器在 git 里（BLOCK_FIELDS 无 media_*），本地无法直接跑 main 代码；给出格式差异结论
print("说明: main 的 BLOCK_FIELDS 不含 media_*，若把含音视频段落的 ZIP 交给 main 导入会报"
      "「结构无效或包含此版本不支持的资料」；粉丝编辑器(0.2.1)导出不含段落级媒体，main 可正常接收。")
print("ALL PASS")
