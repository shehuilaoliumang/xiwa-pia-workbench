"""Closed-loop test for the fan editor (desktop-capable service).

Simulates the full journey without touching any real data:
  1. Build a legal anchor-exported v1 ZIP (image + WAV media + cue points).
  2. Start the fan editor service on an isolated port/data dir.
  3. Import the ZIP -> edit (retitle, change text, delete a cued block, add
     new text block and illustration) -> export a new ZIP.
  4. Validate the exported ZIP with the fan's local package validator.

For actual CURRENT anchor API compatibility, additionally run the parent
project's tests/fan_exchange_compatibility.py (supports FAN_EXE too).

Also covers the media/cue endpoints (upload, save cues, remove) that mirror
the anchor workbench's media editor, and asserts the anchor-parity rule that
deleting a block referenced by a cue fails until the cue is adjusted.
"""
from __future__ import annotations

import hashlib
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
import wave
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # fan project root

import script_package as package
from storage import encode, resources

PORT = 9411


def make_png(color=(200, 80, 60)):
    from PIL import Image
    image = Image.new("RGB", (24, 16), color)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def make_wav(seconds=0.25):
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(16000)
        frames = b"\x00\x00" * int(16000 * seconds)
        wav.writeframes(frames)
    return buffer.getvalue()


def build_source_package():
    image = make_png()
    media = make_wav()
    img_sha = hashlib.sha256(image).hexdigest()
    media_sha = hashlib.sha256(media).hexdigest()

    item = {
        "id": "script-source",
        "title": "测试剧本",
        "author": "喜娃",
        "category_id": "category-test",
        "visible": True,
        "tags": ["测试"],
        "blocks": [
            {"id": "block-1", "kind": "text", "text": "第一段台词", "role": "旁白",
             "color": "#c0392b"},
            {"id": "block-2", "kind": "image", "text": "", "image_path": "/static/media/" + img_sha + ".png"},
            {"id": "block-3", "kind": "text", "text": "第二段台词（将被删除）", "role": "小明",
             "color": "#2980b9"},
        ],
        "media": {
            "path": "/media/" + media_sha + ".wav",
            "kind": "audio", "name": "配音.wav",
            "size": len(media), "sha256": media_sha, "duration": 0.25,
            "cues": [
                {"id": "cue-1", "at": 0.0, "label": "开场", "block_ids": ["block-1"]},
                {"id": "cue-2", "at": 0.1, "label": "第二段", "block_ids": ["block-3"]},
            ],
        },
    }
    item = package._normalize(item)
    refs = sorted(resources(item))
    content = encode(item).encode("utf-8")
    files = {"script.json": {"size": len(content), "sha256": hashlib.sha256(content).hexdigest(), "mime": "application/json"}}
    mapping, total = {}, len(content)
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        archive.writestr("script.json", content)
        for ref in refs:
            if ref.endswith(".wav"):
                data, extension, member = media, ".wav", "assets/" + media_sha + ".wav"
            else:
                data, extension, member = image, ".png", "assets/" + img_sha + ".png"
            mapping[ref] = member
            files[member] = {"size": len(data), "sha256": hashlib.sha256(data).hexdigest(), "mime": package.MIMES[extension]}
            archive.writestr(member, data)
        manifest = encode({"format": package.FORMAT, "version": package.VERSION, "created_at": "2026-09-29T00:00:00.000+00:00",
                           "category_name": "测试分类", "files": files, "resources": mapping}).encode("utf-8")
        archive.writestr("manifest.json", manifest)
    output.seek(0)
    return output.getvalue(), img_sha, media_sha


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
    boundary = b"----fan-test-" + os.urandom(6).hex().encode()
    parts = [b"--" + boundary + b"\r\nContent-Disposition: form-data; name=\"" + field.encode() +
             b"\"; filename=\"" + filename.encode() + b"\"\r\nContent-Type: " + content_type.encode() + b"\r\n\r\n",
             payload, b"\r\n--" + boundary + b"--\r\n"]
    return b"".join(parts), "multipart/form-data; boundary=" + boundary.decode()


def main():
    with socket.socket() as probe:
        probe.settimeout(.3)
        assert probe.connect_ex(('127.0.0.1', PORT)) != 0, 'Do not reuse an occupied QA service'
    base = Path(tempfile.mkdtemp(prefix="fan-test-"))
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
                time.sleep(0.5)
        else:
            raise RuntimeError("fan service did not start")

        status, page = fetch("GET", base_url + "/")
        assert status == 200 and "喜娃剧本粉丝编辑器" in page.decode("utf-8")
        csrf = csrf_from_page(page.decode("utf-8"))

        source_zip, img_sha, media_sha = build_source_package()
        # Step 1: import the anchor package
        body, content_type = multipart("package", "source.zip", "application/zip", source_zip)
        status, data = fetch("POST", base_url + "/api/workspaces", data=body,
                             headers={"Content-Type": content_type, "X-CSRF-Token": csrf})
        assert status == 200, data.decode()
        workspace = json.loads(data)["workspace"]
        wsid = workspace["id"]
        assert workspace["title"] == "测试剧本"
        assert workspace["text_blocks"] == 2 and workspace["image_blocks"] == 1
        assert workspace["has_media"] and workspace["cue_count"] == 2

        # Step 2: read the opened script
        status, data = fetch("GET", base_url + f"/api/workspaces/{wsid}")
        assert status == 200
        opened = json.loads(data)
        script = opened["script"]
        assert len(script["blocks"]) == 3
        assert script["media"]["cues"][0]["block_ids"] == ["block-1"]

        # Step 3: anchor-parity rule — deleting a cued block is rejected
        blocks = list(script["blocks"])
        blocks = [b for b in blocks if b["id"] != "block-3"]
        payload = json.dumps({"title": "测试剧本（粉丝修改版）", "author": "粉丝小剧场",
                              "blocks": blocks}).encode("utf-8")
        status, data = fetch("PUT", base_url + f"/api/workspaces/{wsid}", data=payload,
                             headers={"Content-Type": "application/json", "X-CSRF-Token": csrf})
        assert status == 400 and "invalid_cues" in json.loads(data).get("code", ""), \
            "deleting a cued block must fail like the anchor workbench: " + data.decode()

        # Step 4: adjust the cue first (remove cue-2), then save blocks
        status, data = fetch("PUT", base_url + f"/api/workspaces/{wsid}/media", data=json.dumps(
            {"duration": 0.25, "cues": [{"id": "cue-1", "at": 0.0, "label": "开场", "block_ids": ["block-1"]}]}
        ).encode("utf-8"), headers={"Content-Type": "application/json", "X-CSRF-Token": csrf})
        assert status == 200, data.decode()
        assert [cue["id"] for cue in json.loads(data)["media"]["cues"]] == ["cue-1"]

        for b in blocks:
            if b["id"] == "block-1":
                b["text"] = "第一段台词（已修改）"
                b.pop("runs", None)
                b["role"] = "主播"
        blocks.append({"id": "block-4", "kind": "text", "text": "新增一段", "role": "粉丝",
                       "color": "#27ae60"})
        payload = json.dumps({"title": "测试剧本（粉丝修改版）", "author": "粉丝小剧场",
                              "synopsis": "简介", "cast_note": "注意语气", "notes": "",
                              "tags": ["测试", "修改"], "visible": True, "blocks": blocks}).encode("utf-8")
        status, data = fetch("PUT", base_url + f"/api/workspaces/{wsid}", data=payload,
                             headers={"Content-Type": "application/json", "X-CSRF-Token": csrf})
        assert status == 200, data.decode()
        saved = json.loads(data)
        assert saved["script"]["title"] == "测试剧本（粉丝修改版）"
        assert [cue["id"] for cue in saved["script"]["media"]["cues"]] == ["cue-1"]

        # Step 5: upload a NEW illustration and add it as an image block
        new_image = make_png(color=(40, 120, 200))
        body, content_type = multipart("image", "new.png", "image/png", new_image)
        status, data = fetch("POST", base_url + f"/api/workspaces/{wsid}/images", data=body,
                             headers={"Content-Type": content_type, "X-CSRF-Token": csrf})
        assert status == 200, data.decode()
        new_ref = json.loads(data)["ref"]
        # sanitize re-encodes the image, so the stored hash differs from the raw upload
        new_img_sha = new_ref.split("/")[-1].split(".")[0]
        assert new_ref.startswith("/static/media/") and new_ref.endswith(".png")

        blocks = list(saved["script"]["blocks"])
        blocks.append({"id": "block-5", "kind": "image", "text": "", "image_path": new_ref})
        payload = json.dumps({"title": "测试剧本（粉丝修改版）", "author": "粉丝小剧场",
                              "blocks": blocks}).encode("utf-8")
        status, data = fetch("PUT", base_url + f"/api/workspaces/{wsid}", data=payload,
                             headers={"Content-Type": "application/json", "X-CSRF-Token": csrf})
        assert status == 200, data.decode()
        script = json.loads(data)["script"]
        assert len(script["blocks"]) == 4

        # Step 6: media editing — upload a fresh audio file (replaces old media)
        new_media = make_wav(seconds=0.5)
        new_media_sha = hashlib.sha256(new_media).hexdigest()
        body, content_type = multipart("file", "新版配音.wav", "audio/wav", new_media)
        status, data = fetch("POST", base_url + f"/api/workspaces/{wsid}/media", data=body,
                             headers={"Content-Type": content_type, "X-CSRF-Token": csrf})
        assert status == 200, data.decode()
        media = json.loads(data)["media"]
        assert media["path"] == "/media/" + new_media_sha + ".wav"
        assert media["kind"] == "audio" and media["name"] == "新版配音.wav"
        assert media["duration"] is None and media["cues"] == []
        # media asset is served with the right mime (players need range support)
        status, data = fetch("GET", base_url + f"/api/workspaces/{wsid}/assets/" + new_media_sha + ".wav",
                             headers={"Range": "bytes=0-31"})
        assert status == 206, "media asset must support HTTP range for playback"
        assert data[:4] == b"RIFF"

        # Step 7: save duration + cues on the new media
        status, data = fetch("PUT", base_url + f"/api/workspaces/{wsid}/media", data=json.dumps(
            {"duration": 0.5, "cues": [
                {"id": "cue-x", "at": 0.2, "label": "新版时间点", "block_ids": ["block-1", "block-4"]}]}
        ).encode("utf-8"), headers={"Content-Type": "application/json", "X-CSRF-Token": csrf})
        assert status == 200, data.decode()
        media = json.loads(data)["media"]
        assert media["duration"] == 0.5
        assert [cue["id"] for cue in media["cues"]] == ["cue-x"]
        assert media["cues"][0]["block_ids"] == ["block-1", "block-4"]
        # duplicate cue seconds are rejected
        status, data = fetch("PUT", base_url + f"/api/workspaces/{wsid}/media", data=json.dumps(
            {"duration": 0.5, "cues": [
                {"id": "cue-a", "at": 0.1, "label": "", "block_ids": ["block-1"]},
                {"id": "cue-b", "at": 0.1, "label": "", "block_ids": ["block-4"]}]}
        ).encode("utf-8"), headers={"Content-Type": "application/json", "X-CSRF-Token": csrf})
        assert status == 400 and "invalid_cues" in json.loads(data).get("code", "")

        # Step 8: remove the media attachment entirely
        status, data = fetch("DELETE", base_url + f"/api/workspaces/{wsid}/media",
                             headers={"X-CSRF-Token": csrf})
        assert status == 200, data.decode()
        script = json.loads(data)["script"]
        assert "media" not in script

        # Step 9: export and validate with the fan-local routine
        status, data = fetch("POST", base_url + f"/api/workspaces/{wsid}/export",
                             headers={"X-CSRF-Token": csrf})
        assert status == 200
        exported = io.BytesIO(data)
        with package._validated(exported) as pkg:
            item = pkg["script"]
            assert item["title"] == "测试剧本（粉丝修改版）"
            assert item["author"] == "粉丝小剧场"
            assert len(item["blocks"]) == 4
            assert {b["id"] for b in item["blocks"]} >= {"block-4", "block-5"}
            assert "media" not in item
            refs = sorted(resources(item))
            assert "/static/media/" + img_sha + ".png" in refs
            assert "/static/media/" + new_img_sha + ".png" in refs

        print("CLOSED-LOOP OK")
        print("  imported:", workspace["title"], "->", len(script["blocks"]), "blocks, media ok")
        print("  edited: retitled, text/role changed, cued-block deletion rejected until cue adjusted,")
        print("          new text + image block added, media uploaded/cued/removed")
        print("  exported: re-validated by fan-local _validated -> OK")
    finally:
        try:
            if csrf:
                fetch("POST", base_url + "/api/shutdown", headers={"X-CSRF-Token": csrf})
        except Exception:
            pass
        proc.wait(timeout=10)
        import shutil
        resolved = base.resolve()
        assert resolved.parent == Path(tempfile.gettempdir()).resolve() and resolved.name.startswith('fan-test-')
        shutil.rmtree(resolved, ignore_errors=True)


if __name__ == "__main__":
    main()
