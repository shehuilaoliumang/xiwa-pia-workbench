"""Create-from-scratch flow test for the fan editor.

Covers the "0 to 1" path that mirrors the anchor workbench's text editor:
  1. /api/import-preview parses pasted text (JSON) and an uploaded TXT (multipart).
  2. /api/workspaces/new creates a workspace from the parsed candidate.
  3. The new workspace can be saved (edit a block, add a block) and exported.
  4. A blank workspace (no blocks) can be created, filled in and exported.
  5. Every exported ZIP passes the fan-local validation routine.
Run in dev mode (python) or against the frozen exe (FAN_EXE env).
Actual current anchor API compatibility is covered separately by the parent
project's tests/fan_exchange_compatibility.py, which also supports FAN_EXE.
"""
from __future__ import annotations

import io
import json
import os
import re
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # fan project root

import script_package as package

PORT = 9416


def fetch(method, url, data=None, headers=None):
    request = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()


def csrf_from_page(html):
    match = re.search(r'<meta name="csrf" content="([0-9a-f]+)">', html)
    assert match, "page does not expose CSRF token"
    return match.group(1)


def multipart(field, filename, content_type, payload):
    boundary = b"----fan-create-" + os.urandom(6).hex().encode()
    parts = [b"--" + boundary + b"\r\nContent-Disposition: form-data; name=\"" + field.encode() +
             b"\"; filename=\"" + filename.encode() + b"\"\r\nContent-Type: " + content_type.encode() + b"\r\n\r\n",
             payload, b"\r\n--" + boundary + b"--\r\n"]
    return b"".join(parts), "multipart/form-data; boundary=" + boundary.decode()


def validate_exported_zip(blob):
    """Run the fan-local import validation on the exported ZIP."""
    stream = io.BytesIO(blob)
    with package._validated(stream) as pkg:
        return pkg["script"], pkg["category_name"]


def main():
    with socket.socket() as probe:
        probe.settimeout(.3)
        assert probe.connect_ex(('127.0.0.1', PORT)) != 0, 'Do not reuse an occupied QA service'
    base = Path(tempfile.mkdtemp(prefix="fan-create-"))
    data_dir = base / "fan-data"
    fan_exe = os.environ.get("FAN_EXE")
    if fan_exe:
        command = [fan_exe, "--port", str(PORT), "--no-browser", "--data-dir", str(data_dir)]
    else:
        command = [sys.executable, str(Path(__file__).resolve().parents[1] / "fan_entry.py"),
                   "--port", str(PORT), "--no-browser", "--data-dir", str(data_dir)]
    proc = subprocess.Popen(command, cwd=str(Path(__file__).resolve().parents[1]),
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    csrf = ""
    try:
        base_url = f"http://127.0.0.1:{PORT}"
        for _ in range(60):
            try:
                status, body = fetch("GET", base_url + "/api/health")
                if status == 200 and Path(json.loads(body)['data_dir']).resolve() == data_dir.resolve():
                    break
            except Exception:
                pass
            time.sleep(0.5)
        else:
            raise RuntimeError("service did not start")
        status, page = fetch("GET", base_url + "/")
        assert status == 200
        csrf = csrf_from_page(page.decode("utf-8"))
        headers = {"X-CSRF-Token": csrf}

        # 1) parse pasted text
        text = ("剧名：星夜小剧场\n作者：小喜\n旁白：夜色降临。\n小明：我们去探险吧！\n小喜：好呀。\n"
                "（舞台提示：灯光亮起）\n旁白：故事开始了。")
        status, body = fetch("POST", base_url + "/api/import-preview",
                             data=json.dumps({"text": text, "filename": "粘贴文本"}).encode("utf-8"),
                             headers={**headers, "Content-Type": "application/json"})
        assert status == 200, body
        parsed = json.loads(body)
        candidate = parsed["candidate"]
        assert candidate["title"] == "星夜小剧场" and candidate["author"] == "小喜", parsed
        # 标题/作者行保留在正文中（与主播端一致），其余 5 行为台词段
        assert len(candidate["blocks"]) == 7, parsed
        assert parsed["roles"] == ["旁白", "小明", "小喜"], parsed
        assert candidate["blocks"][0]["role"] == "" and candidate["blocks"][0]["text"].startswith("剧名："), parsed
        # 舞台提示段无角色
        hint = next(b for b in candidate["blocks"] if b["text"].startswith("（"))
        assert hint["role"] == "", parsed
        assert parsed["warnings"], parsed

        # 2) parse an uploaded TXT (GB18030 content to exercise decode fallback)
        txt_bytes = "标题：黄昏来电\n作者：阿青\n女声：喂？\n男声：是我。".encode("gb18030")
        body_bytes, content_type = multipart("file", "剧本.txt", "text/plain", txt_bytes)
        status, body = fetch("POST", base_url + "/api/import-preview", data=body_bytes,
                             headers={**headers, "Content-Type": content_type})
        assert status == 200, body
        parsed_txt = json.loads(body)
        assert parsed_txt["candidate"]["title"] == "黄昏来电" and parsed_txt["roles"] == ["女声", "男声"], parsed_txt

        # 3) create a workspace from the first parsed candidate
        payload = {"title": candidate["title"], "author": candidate["author"],
                   "category_name": "粉丝自制", "blocks": candidate["blocks"]}
        status, body = fetch("POST", base_url + "/api/workspaces/new",
                             data=json.dumps(payload).encode("utf-8"),
                             headers={**headers, "Content-Type": "application/json"})
        assert status == 201, body
        workspace = json.loads(body)["workspace"]
        wsid = workspace["id"]
        assert workspace["text_blocks"] == 7 and workspace["category_name"] == "粉丝自制", workspace

        # 4) edit and save the created script (change a block, add a block)
        status, body = fetch("GET", base_url + f"/api/workspaces/{wsid}")
        assert status == 200, body
        script = json.loads(body)["script"]
        assert script["title"] == "星夜小剧场" and len(script["blocks"]) == 7
        script["blocks"][0]["text"] = "夜色降临，微风轻拂。"
        script["blocks"].append({"id": "block-new", "kind": "text", "text": "谢幕：再见！", "role": "小喜", "color": "#27ae60"})
        status, body = fetch("PUT", base_url + f"/api/workspaces/{wsid}",
                             data=json.dumps({"title": script["title"], "author": script["author"],
                                              "synopsis": "", "cast_note": "", "notes": "",
                                              "tags": ["自制"], "visible": True, "blocks": script["blocks"]}).encode("utf-8"),
                             headers={**headers, "Content-Type": "application/json"})
        assert status == 200, body
        saved = json.loads(body)["script"]
        assert saved["blocks"][0]["text"] == "夜色降临，微风轻拂。" and len(saved["blocks"]) == 8, saved

        # 5) export and validate with the fan-local routine
        status, body = fetch("POST", base_url + f"/api/workspaces/{wsid}/export", data=b"", headers=headers)
        assert status == 200 and body[:2] == b"PK", "export did not produce a zip"
        exported, category_name = validate_exported_zip(body)
        assert exported["title"] == "星夜小剧场" and len(exported["blocks"]) == 8, exported
        assert category_name == "粉丝自制", category_name

        # 6) blank workspace -> fill in -> export
        status, body = fetch("POST", base_url + "/api/workspaces/new",
                             data=json.dumps({"title": "", "author": ""}).encode("utf-8"),
                             headers={**headers, "Content-Type": "application/json"})
        assert status == 201, body
        blank = json.loads(body)["workspace"]
        assert blank["title"] == "未命名剧本" and blank["text_blocks"] == 0, blank
        blank_blocks = [{"id": "b1", "kind": "text", "text": "开场白", "role": "旁白", "color": "#343b37"},
                        {"id": "b2", "kind": "text", "text": "第一句", "role": "小明", "color": "#2980b9"}]
        status, body = fetch("PUT", base_url + f"/api/workspaces/{blank['id']}",
                             data=json.dumps({"title": "空白起步", "author": "粉丝", "synopsis": "", "cast_note": "",
                                              "notes": "", "tags": [], "visible": True, "blocks": blank_blocks}).encode("utf-8"),
                             headers={**headers, "Content-Type": "application/json"})
        assert status == 200, body
        status, body = fetch("POST", base_url + f"/api/workspaces/{blank['id']}/export", data=b"", headers=headers)
        assert status == 200 and body[:2] == b"PK"
        exported_blank, _category = validate_exported_zip(body)
        assert exported_blank["title"] == "空白起步" and len(exported_blank["blocks"]) == 2, exported_blank

        # 7) list reflects both workspaces
        status, body = fetch("GET", base_url + "/api/workspaces")
        assert status == 200
        names = {ws["title"] for ws in json.loads(body)["workspaces"]}
        assert {"星夜小剧场", "空白起步"} <= names, names

        print("CREATE FLOW OK")
        print("  pasted-text parsed (title/author/roles/5 blocks), TXT (GB18030) parsed,")
        print("  workspace created from candidate -> edited -> exported -> fan-local _validated OK,")
        print("  blank workspace created -> filled -> exported -> fan-local _validated OK")
    finally:
        try:
            if csrf:
                fetch("POST", base_url + "/api/shutdown", data=b"", headers={"X-CSRF-Token": csrf})
        except Exception:
            pass
        if proc.poll() is None:
            proc.terminate()
        proc.wait(timeout=10)
        import shutil
        resolved = base.resolve()
        assert resolved.parent == Path(tempfile.gettempdir()).resolve() and resolved.name.startswith('fan-create-')
        shutil.rmtree(resolved, ignore_errors=True)


if __name__ == "__main__":
    main()
