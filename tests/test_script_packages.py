"""Single-script exchange is isolated from all existing library and live data."""
import copy
import hashlib
import io
import json
from pathlib import Path
import sqlite3
import stat
import tempfile
import unittest
from unittest.mock import patch
import wave
import zipfile

from PIL import Image
from app import create_app
from storage import DomainError
import script_package as packages


def picture(fmt="JPEG"):
    out = io.BytesIO()
    Image.new("RGB", (17, 29), (30, 100, 160)).save(out, format=fmt)
    return out.getvalue()


def sound():
    out = io.BytesIO()
    with wave.open(out, "wb") as writer:
        writer.setnchannels(1); writer.setsampwidth(2); writer.setframerate(8000)
        writer.writeframes(b"\0\0" * 16000)
    return out.getvalue()


class ScriptPackageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="xiwa-packages-")
        self.root = Path(self.temporary.name)
        source = self.root / "static/media"
        source.mkdir(parents=True)
        (source / "source.jpeg").write_bytes(picture())
        seed = {"categories": [{"id": "cat-a", "name": "原分类"}, {"id": "cat-b", "name": "接收分类"}],
                "scripts": [{"id": "script-a", "title": "原稿 / 分享", "author": "原作者", "category_id": "cat-a",
                    "source_category": "PPT 原始分类", "source_pages": [7], "notes": "保留原备注", "tags": ["双人"],
                    "blocks": [
                        {"id": "text-a", "kind": "text", "role": "甲", "text": "保留  空格\n和换行", "color": "#224466",
                         "runs": [{"text": "保留  空格\n", "color": "#aa2233", "bold": True}, {"text": "和换行", "color": "#3344aa", "bold": False}],
                         "source_page": 7, "source_file": "原稿.pptx", "original_text": "来源原文"},
                        {"id": "image-a", "kind": "image", "text": "插图说明", "image_path": "/static/media/source.jpeg", "source_page": 7, "source_file": "原稿.pptx"},
                        {"id": "text-b", "kind": "text", "role": "乙", "text": "第二段"}]}]}
        self.app = self.make_app(self.root, seed)
        self.client = self.app.test_client()
        self.store = self.app.extensions["store"]
        self.token = self.client.get("/api/library").get_json()["csrf_token"]

    def make_app(self, root, seed=None):
        root.mkdir(parents=True, exist_ok=True)
        seed_path = root / "seed.json"
        seed_path.write_text(json.dumps(seed or {"categories": [{"id": "cat-target", "name": "目标分类"}], "scripts": []}, ensure_ascii=False), encoding="utf-8")
        return create_app({"TESTING": True, "DATABASE": str(root / "instance/workbench.sqlite3"),
                           "INSTANCE_PATH": str(root / "instance"), "SEED_PATH": str(seed_path), "PROJECT_ROOT": str(root)})

    def tearDown(self):
        self.temporary.cleanup()

    def write(self, url, value, method="POST", expected=200):
        response = self.client.open(url, method=method, json=value, headers={"X-CSRF-Token": self.token})
        self.assertEqual(response.status_code, expected, response.get_data(as_text=True))
        return response.get_json()

    def upload(self, client, token, path, content, fields=None, expected=200, filename="剧本包.zip"):
        response = client.post(path, data={"file": (io.BytesIO(content), filename), **(fields or {})},
                               headers={"X-CSRF-Token": token})
        try:
            self.assertEqual(response.status_code, expected, response.get_data(as_text=True))
            return response.get_json()
        finally:
            response.close(); response.request.close(); response.request.environ["wsgi.input"].close()

    def media(self):
        self.upload(self.client, self.token, "/api/scripts/script-a/media", sound(), expected=201, filename="配音.wav")
        return self.write("/api/scripts/script-a/media/cues", {"duration": 2, "cues": [
            {"id": "cue-first", "at": 0, "label": "文字和图", "block_ids": ["text-a", "image-a"]},
            {"id": "cue-next", "at": 1, "label": "下一句", "block_ids": ["text-b"]}]}, "PUT")

    def export(self, script_id="script-a", client=None):
        response = (client or self.client).get(f"/api/scripts/{script_id}/export")
        try:
            self.assertEqual(response.status_code, 200, response.get_data(as_text=True) if response.status_code != 200 else "")
            self.assertEqual(response.mimetype, "application/zip")
            self.assertIn("attachment", response.headers["Content-Disposition"])
            return response.data
        finally:
            response.close()

    def preview(self, content, expected=200):
        return self.upload(self.client, self.token, "/api/script-packages/preview", content, expected=expected)

    def do_import(self, content, category="cat-b", expected=201, sha=None, app=None):
        app = app or self.app
        client = app.test_client()
        token = app.extensions["csrf_token"]
        return self.upload(client, token, "/api/script-packages/import", content,
                           {"category_id": category, "expected_sha256": sha if sha is not None else hashlib.sha256(content).hexdigest()}, expected)

    def frozen(self, store=None):
        store = store or self.store
        with store.transaction() as connection:
            data = store._export(connection)
        return {"db": hashlib.sha256(store.database.read_bytes()).hexdigest(), "data": data,
                "media": {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in store.media_dir.iterdir()}}

    def unpack(self, content):
        with zipfile.ZipFile(io.BytesIO(content)) as archive:
            result = {name: archive.read(name) for name in archive.namelist()}
        return json.loads(result.pop("manifest.json")), result

    def repack(self, manifest, files, recalc=True, extra=None):
        manifest = copy.deepcopy(manifest)
        if recalc:
            for name, data in files.items():
                old = manifest["files"].get(name, {})
                manifest["files"][name] = {**old, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False))
            for name, data in files.items(): archive.writestr(name, data)
            for name, data in extra or []: archive.writestr(name, data)
        return output.getvalue()

    def changed_script(self, original, mutate):
        manifest, files = self.unpack(original)
        script = json.loads(files["script.json"])
        mutate(script)
        files["script.json"] = json.dumps(script, ensure_ascii=False).encode("utf-8")
        return self.repack(manifest, files)

    def test_export_is_one_document_only_and_readonly(self):
        self.media()
        self.write("/api/queue", {"script_ids": ["script-a"]}, "PUT")
        self.write("/api/apply", {"mode": "script", "script_id": "script-a", "orientation": "portrait", "layout": {"body_mode": "pages"}})
        before = self.frozen()
        archive = self.export()
        manifest, files = self.unpack(archive)
        self.assertEqual(manifest["format"], "xiwa-script-package")
        self.assertEqual(manifest["category_name"], "原分类")
        self.assertEqual(set(files), {"script.json", *manifest["resources"].values()})
        self.assertEqual(len(manifest["resources"]), 2)
        self.assertFalse(any("sqlite" in name or "pptx" in name or "history" in name for name in files))
        script = json.loads(files["script.json"])
        self.assertEqual(script["media"]["cues"][0]["block_ids"], ["text-a", "image-a"])
        self.assertEqual(script["blocks"][0]["runs"][0]["bold"], True)
        self.assertEqual(self.frozen(), before)

    def test_preview_reports_contents_duplicates_hidden_and_no_writes(self):
        self.media()
        self.write("/api/scripts/script-a", {"visible": False}, "PATCH")
        archive = self.export()
        before = self.frozen()
        result = self.preview(archive)
        self.assertEqual((result["text_blocks"], result["image_blocks"], result["cue_count"]), (2, 1, 2))
        self.assertEqual(result["package_sha256"], hashlib.sha256(archive).hexdigest())
        self.assertEqual(result["duplicate_title_count"], 1)
        self.assertFalse(result["visible"])
        self.assertTrue(result["has_media"])
        self.assertEqual(len(result["warnings"]), 2)
        self.assertEqual(self.frozen(), before)

    def test_import_remaps_ids_cues_preserves_sources_and_existing_state(self):
        original = self.media()
        self.write("/api/queue", {"script_ids": ["script-a"]}, "PUT")
        self.write("/api/apply", {"mode": "script", "script_id": "script-a", "orientation": "portrait", "layout": {"body_mode": "pages"}})
        archive = self.export()
        before = self.frozen()
        item = self.do_import(archive)["script"]
        after = self.frozen()
        self.assertNotEqual(item["id"], original["id"])
        self.assertEqual(item["category_id"], "cat-b")
        self.assertEqual(item["source_category"], original["source_category"])
        self.assertEqual(item["source_pages"], [7])
        ids = dict(zip([b["id"] for b in original["blocks"]], [b["id"] for b in item["blocks"]]))
        self.assertTrue(set(ids).isdisjoint(ids.values()))
        for old, new in zip(original["blocks"], item["blocks"]):
            for key in old.keys() - {"id", "image_path"}: self.assertEqual(new[key], old[key], key)
        for old, new in zip(original["media"]["cues"], item["media"]["cues"]):
            self.assertNotEqual(old["id"], new["id"])
            self.assertEqual(new["block_ids"], [ids[x] for x in old["block_ids"]])
            self.assertEqual((new["at"], new["label"]), (old["at"], old["label"]))
        for key in ("categories", "settings", "history"): self.assertEqual(after["data"][key], before["data"][key])
        self.assertEqual(after["data"]["scripts"][:-1], before["data"]["scripts"])
        self.assertEqual(after["data"]["scripts"][-1], item)
        self.assertEqual(item["media"]["path"], original["media"]["path"])
        self.assertEqual(len(after["media"]), len(before["media"]) + 1)

    def test_import_export_import_roundtrip_and_resource_dedup(self):
        self.media()
        self.write("/api/scripts/script-a", {"visible": False}, "PATCH")
        archive = self.export()
        target = self.make_app(self.root / "different machine 中文")
        one = self.do_import(archive, "cat-target", app=target)["script"]
        self.assertFalse(one["visible"])
        again = self.export(one["id"], target.test_client())
        two = self.do_import(again, "cat-target", app=target)["script"]
        self.assertNotEqual(one["id"], two["id"])
        self.assertEqual([b["text"] for b in one["blocks"]], [b["text"] for b in two["blocks"]])
        self.assertEqual([c["at"] for c in two["media"]["cues"]], [0, 1])
        self.assertEqual(two["media"]["cues"][0]["block_ids"], [two["blocks"][0]["id"], two["blocks"][1]["id"]])
        self.assertEqual(len(list(target.extensions["store"].media_dir.iterdir())), 2)
        for item in (one, two):
            for url in [item["media"]["path"], item["blocks"][1]["image_path"]]:
                response = target.test_client().get(url)
                try: self.assertEqual(response.status_code, 200)
                finally: response.close()

    def test_plain_text_empty_media_and_empty_script_supported(self):
        self.write("/api/scripts/script-a", {"blocks": []}, "PATCH")
        archive = self.export()
        result = self.preview(archive)
        self.assertFalse(result["has_media"])
        self.assertEqual(result["text_blocks"], 0)
        self.assertEqual(result["image_blocks"], 0)
        self.assertEqual(self.do_import(archive)["script"]["blocks"], [])

    def test_stale_sha_missing_sha_or_missing_category_never_writes(self):
        archive = self.export(); before = self.frozen()
        for sha in ["0" * 64, "", "garbage"]:
            self.do_import(archive, expected=409, sha=sha)
            self.assertEqual(self.frozen(), before)
        self.do_import(archive, category="missing", expected=404)
        self.assertEqual(self.frozen(), before)

    def test_malformed_path_duplicate_and_symlink_zip(self):
        archive = self.export(); manifest, files = self.unpack(archive); before = self.frozen()
        variants = [b"", b"not zip", archive[:-30]]
        for name in ["../outside.txt", "assets/../../bad.png", "/absolute.png", "C:/evil", "assets\\evil.png", "database.sqlite3", "script2.json"]:
            variants.append(self.repack(manifest, files, extra=[(name, b"bad")]))
        variants.append(self.repack(manifest, files, extra=[("SCRIPT.JSON", b"{}")]))
        link = zipfile.ZipInfo("assets/" + "f" * 64 + ".png"); link.create_system = 3; link.external_attr = (stat.S_IFLNK | 0o777) << 16
        variants.append(self.repack(manifest, files, extra=[(link, b"target")]))
        for content in variants:
            with self.subTest(size=len(content)):
                self.preview(content, expected=400)
                self.do_import(content, expected=400)
                self.assertEqual(self.frozen(), before)

    def test_damaged_deflate_encrypted_and_unsupported_compression_are_400(self):
        archive = self.export(); before = self.frozen()
        damaged = bytearray(archive)
        with zipfile.ZipFile(io.BytesIO(archive)) as z:
            offset = z.getinfo("script.json").header_offset
        start = offset + 30 + int.from_bytes(damaged[offset+26:offset+28], "little") + int.from_bytes(damaged[offset+28:offset+30], "little")
        damaged[start] |= 7  # Reserved DEFLATE block type, raises zlib.error.
        encrypted = bytearray(archive)
        central = encrypted.index(b"PK\x01\x02")
        encrypted[central+8] |= 1
        unsupported = io.BytesIO()
        manifest, files = self.unpack(archive)
        with zipfile.ZipFile(unsupported, "w", zipfile.ZIP_BZIP2) as z:
            z.writestr("manifest.json", json.dumps(manifest))
            for name, content in files.items(): z.writestr(name, content)
        for content in [bytes(damaged), bytes(encrypted), unsupported.getvalue()]:
            self.preview(content, expected=400)
            self.do_import(content, expected=400)
            self.assertEqual(self.frozen(), before)

    def test_escaped_lone_surrogate_is_rejected_before_preview_response_or_save(self):
        archive = self.export(); manifest, files = self.unpack(archive); before = self.frozen()
        script = json.loads(files["script.json"]); script["title"] = "\ud800"
        files["script.json"] = json.dumps(script, ensure_ascii=True).encode("ascii")
        content = self.repack(manifest, files)
        self.preview(content, expected=400)
        self.do_import(content, expected=400)
        self.assertEqual(self.frozen(), before)

    def test_wrong_version_full_backup_and_duplicate_json_fields_rejected(self):
        archive = self.export(); manifest, files = self.unpack(archive); before = self.frozen()
        for field, value in [("version", True), ("version", 2), ("format", "xiwa-workbench-backup"), ("scripts", [])]:
            altered = {**manifest, field: value}
            self.preview(self.repack(altered, files), expected=400)
        bad_files = dict(files); bad_files["script.json"] = b'{"id":"a","id":"b"}'
        self.preview(self.repack(manifest, bad_files), expected=400)
        self.preview(self.store.backup(), expected=400)
        self.assertEqual(self.frozen(), before)

    def test_hash_missing_extra_assets_and_mime_mismatch_rejected(self):
        archive = self.export(); manifest, files = self.unpack(archive); before = self.frozen()
        member = next(name for name in files if name.startswith("assets/"))
        changed = copy.deepcopy(manifest); changed["files"][member]["sha256"] = "0" * 64
        self.preview(self.repack(changed, files, recalc=False), expected=400)
        changed = copy.deepcopy(manifest); changed["files"][member]["mime"] = "image/png"
        self.preview(self.repack(changed, files), expected=400)
        changed = copy.deepcopy(manifest); changed["resources"] = {}
        self.preview(self.repack(changed, files), expected=400)
        missing = {k: v for k, v in files.items() if k != member}
        self.preview(self.repack(manifest, missing), expected=400)
        self.assertEqual(self.frozen(), before)

    def test_actual_image_encoding_must_match_extension_even_with_valid_hash(self):
        manifest, files = self.unpack(self.export()); before = self.frozen()
        old = next(name for name in files if name.startswith("assets/"))
        for forged in [b"<svg>not a picture</svg>", picture("PNG")]:
            changed = copy.deepcopy(manifest); changed_files = dict(files)
            new = "assets/" + hashlib.sha256(forged).hexdigest() + ".jpeg"
            changed_files.pop(old); changed_files[new] = forged
            changed["files"][new] = changed["files"].pop(old)
            changed["resources"] = {k: new for k in changed["resources"]}
            self.preview(self.repack(changed, changed_files), expected=400)
        self.assertEqual(self.frozen(), before)

    def test_cue_reference_and_runs_validation_rejects_without_change(self):
        self.media(); archive = self.export(); before = self.frozen()
        changes = [lambda s:s["media"]["cues"][0].update(block_ids=["missing"]),
                   lambda s:s["media"]["cues"][0].update(at=float("nan")),
                   lambda s:s["media"]["cues"][1].update(at=0),
                   lambda s:s["blocks"][1].update(id=s["blocks"][0]["id"]),
                   lambda s:s["blocks"][0]["runs"][0].update(text="wrong")]
        for mutate in changes:
            changed = self.changed_script(archive, mutate)
            self.preview(changed, expected=400)
            self.do_import(changed, expected=400)
            self.assertEqual(self.frozen(), before)

    def test_media_bytes_must_pass_container_and_metadata_validation(self):
        self.media(); manifest, files = self.unpack(self.export()); before = self.frozen()
        old = next(name for name in files if name.endswith(".wav"))
        forged = b"RIFFbroken WAV content"
        checksum = hashlib.sha256(forged).hexdigest(); new = "assets/" + checksum + ".wav"
        script = json.loads(files["script.json"]); old_path = script["media"]["path"]; new_path = "/media/" + checksum + ".wav"
        script["media"].update(path=new_path, size=len(forged), sha256=checksum)
        files["script.json"] = json.dumps(script).encode(); files.pop(old); files[new] = forged
        manifest["files"][new] = manifest["files"].pop(old)
        manifest["resources"].pop(old_path); manifest["resources"][new_path] = new
        self.preview(self.repack(manifest, files), expected=400)
        self.assertEqual(self.frozen(), before)

    def test_decompressed_size_count_and_upload_size_limits(self):
        archive = self.export(); before = self.frozen()
        for constant, limit in [("PACKAGE_MAX_BYTES", len(archive)-1), ("SCRIPT_MAX_BYTES", 20), ("MAX_ASSETS", 0)]:
            with self.subTest(constant=constant), patch.object(packages, constant, limit):
                self.preview(archive, expected=400 if constant == "MAX_ASSETS" else 413)
        self.assertEqual(self.frozen(), before)

    def test_partial_resource_write_rolls_back_new_assets_and_database(self):
        self.media(); archive = self.export()
        target = self.make_app(self.root / "failed target")
        store = target.extensions["store"]; before = self.frozen(store)
        original = store._write_new_resource
        count = 0
        def fail_second(destination, content):
            nonlocal count
            count += 1
            if count == 2: raise DomainError("模拟资源写入失败", 503, "resource_write_failed")
            return original(destination, content)
        with patch.object(store, "_write_new_resource", side_effect=fail_second):
            self.do_import(archive, "cat-target", expected=503, app=target)
        self.assertEqual(count, 2)
        self.assertEqual(self.frozen(store), before)
        self.do_import(archive, "cat-target", app=target)

    def test_commit_failure_rolls_back_script_and_new_assets(self):
        archive = self.export()
        target = self.make_app(self.root / "commit failure")
        store = target.extensions["store"]; before = self.frozen(store)
        original = store._connection
        class Connection:
            def __init__(self): self.actual = original()
            def __getattr__(self, name): return getattr(self.actual, name)
            def commit(self): raise sqlite3.OperationalError("simulated commit failure")
        with patch.object(store, "_connection", side_effect=Connection), self.assertLogs(target.logger, level="ERROR"):
            self.do_import(archive, "cat-target", expected=503, app=target)
        self.assertEqual(self.frozen(store), before)

    def test_existing_damaged_hash_file_is_not_overwritten_or_deleted(self):
        archive = self.export(); manifest, files = self.unpack(archive)
        member = next(name for name in files if name.startswith("assets/"))
        target = self.store.media_dir / Path(member).name
        target.write_bytes(b"existing damage")
        before = self.frozen()
        result = self.do_import(archive, expected=409)
        self.assertEqual(result["code"], "resource_conflict")
        self.assertEqual(self.frozen(), before)

    def test_missing_export_resource_and_invalid_upload_do_not_write(self):
        before = self.frozen()
        self.assertEqual(self.client.get("/api/scripts/missing/export").status_code, 404)
        response = self.client.post("/api/script-packages/preview", headers={"X-CSRF-Token": self.token})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.client.post("/api/script-packages/import").status_code, 403)
        (self.root / "static/media/source.jpeg").unlink()
        self.assertEqual(self.client.get("/api/scripts/script-a/export").status_code, 409)
        self.assertEqual(self.frozen(), before)


if __name__ == "__main__":
    unittest.main()
