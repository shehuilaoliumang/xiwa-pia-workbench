"""Draft image upload and document-resource integration; all data is temporary."""
import copy
import hashlib
import io
import json
from pathlib import Path
import struct
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import wave
import zipfile
import zlib

from PIL import Image, PngImagePlugin

from app import create_app


class ScriptImageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="xiwa-script-images-")
        self.root = Path(self.temporary.name)
        (self.root / "static/media").mkdir(parents=True)
        (self.root / "static/media/source.png").write_bytes(self.picture(shade=(1, 2, 3)))
        seed = {"categories": [{"id": "cat-a", "name": "分类"}], "scripts": [
            {"id": "script-a", "title": "原稿", "category_id": "cat-a", "source_pages": [7], "blocks": [
                {"id": "text-a", "kind": "text", "text": "甲：原文。", "source_page": 7, "source_file": "原稿.pptx"},
                {"id": "image-a", "kind": "image", "text": "原插图", "image_path": "/static/media/source.png",
                 "source_page": 7, "source_file": "原稿.pptx"}]}]}
        self.seed_path = self.root / "seed.json"
        self.seed_path.write_text(json.dumps(seed, ensure_ascii=False), encoding="utf-8")
        self.config = {"TESTING": True, "DATABASE": str(self.root / "instance/workbench.sqlite3"),
                       "INSTANCE_PATH": str(self.root / "instance"), "SEED_PATH": str(self.seed_path),
                       "PROJECT_ROOT": str(self.root)}
        self.app = create_app(self.config)
        self.client = self.app.test_client()
        self.store = self.app.extensions["store"]
        self.token = self.library()["csrf_token"]

    def tearDown(self):
        self.temporary.cleanup()

    @staticmethod
    def picture(fmt="PNG", shade=(30, 80, 120)):
        output = io.BytesIO()
        image = Image.new("RGB", (16, 24), shade)
        options = {}
        if fmt == "PNG":
            metadata = PngImagePlugin.PngInfo()
            metadata.add_text("private-note", "source metadata should not be retained")
            options["pnginfo"] = metadata
        image.save(output, format=fmt, **options)
        return output.getvalue()

    def library(self):
        return self.client.get("/api/library").get_json()

    def script(self):
        return next(item for item in self.library()["scripts"] if item["id"] == "script-a")

    def write(self, url, payload, method="POST", expected=200):
        response = self.client.open(url, method=method, json=payload, headers={"X-CSRF-Token": self.token})
        try:
            self.assertEqual(response.status_code, expected, response.get_data(as_text=True))
            return response.get_json()
        finally:
            response.close()

    def upload(self, content=None, filename="正文.png", expected=201, token=True, endpoint="/api/script-images"):
        response = self.client.post(endpoint,
            data={"file": (io.BytesIO(self.picture() if content is None else content), filename),
                  "path": "../../outside.png", "mime": "image/svg+xml", "width": "99999", "name": "不得加入背景"},
            headers={"X-CSRF-Token": self.token} if token else {})
        try:
            self.assertEqual(response.status_code, expected, response.get_data(as_text=True))
            return response.get_json()
        finally:
            response.close()
            response.request.close()
            response.request.environ["wsgi.input"].close()

    def apply(self, **kwargs):
        payload = {"mode": "script", "script_id": "script-a", "orientation": "portrait", **kwargs}
        preview = self.write("/api/preview", payload)
        return self.write("/api/apply", {**payload, "preview_token": preview["content_token"]})

    def test_formats_metadata_deduplication_and_cancel_leave_database_unchanged(self):
        live = self.apply()
        before = self.library()
        database = self.store.database.read_bytes()
        for fmt, suffix, mime in [("PNG", ".png", "image/png"), ("JPEG", ".jpeg", "image/jpeg"),
                                  ("WEBP", ".webp", "image/webp")]:
            with self.subTest(format=fmt):
                source = self.picture(fmt)
                uploaded = self.upload(source, "../../中文 图片" + suffix)
                same = self.upload(source, "另一名称" + suffix)
                self.assertEqual(same, uploaded)
                self.assertEqual((uploaded["width"], uploaded["height"], uploaded["mime"]), (16, 24, mime))
                file = self.store.resource_file(uploaded["path"])
                saved = file.read_bytes()
                self.assertEqual(uploaded["sha256"], hashlib.sha256(saved).hexdigest())
                self.assertEqual(uploaded["size"], len(saved))
                self.assertEqual(file.parent, self.store.media_dir)
                with Image.open(io.BytesIO(saved)) as image:
                    image.load()
                    self.assertNotIn("private-note", image.info)
                response = self.client.get(uploaded["path"])
                try:
                    self.assertEqual(response.status_code, 200)
                    self.assertEqual(response.mimetype, mime)
                    self.assertEqual(response.data, saved)
                finally:
                    response.close()
        self.assertEqual(self.library(), before)
        self.assertEqual(self.store.database.read_bytes(), database)
        self.assertEqual(self.store.state(), live)
        self.assertEqual(self.client.get("/api/scripts/script-a/history").get_json()["history"], [])
        with zipfile.ZipFile(io.BytesIO(self.client.get("/api/backup").data)) as archive:
            manifest = json.loads(archive.read("manifest.json"))
            self.assertFalse(any(url.startswith("/media/") for url in manifest["resources"]))

    def test_camera_orientation_is_applied_before_metadata_is_removed(self):
        source = io.BytesIO()
        image = Image.new("RGB", (16, 24), "red")
        image.paste("blue", (0, 12, 16, 24))
        exif = Image.Exif()
        exif[274] = 6  # A portrait JPEG that must be displayed rotated clockwise.
        exif[315] = "private camera owner"
        image.save(source, format="JPEG", quality=100, exif=exif)
        uploaded = self.upload(source.getvalue(), "手机照片.jpg")
        self.assertEqual((uploaded["width"], uploaded["height"]), (24, 16))
        with Image.open(self.store.resource_file(uploaded["path"])) as saved:
            saved.load()
            self.assertEqual(saved.size, (24, 16))
            self.assertFalse(saved.getexif())
            left = saved.getpixel((2, 8))
            right = saved.getpixel((21, 8))
            self.assertGreater(left[2], left[0])
            self.assertGreater(right[0], right[2])

    def test_invalid_images_and_request_guards_never_publish_files(self):
        before = self.library()
        bad_dimensions = bytearray(self.picture())
        bad_dimensions[16:20] = struct.pack(">I", 13001)
        bad_dimensions[29:33] = struct.pack(">I", zlib.crc32(bad_dimensions[12:29]))
        bad_pixels = bytearray(self.picture())
        bad_pixels[16:24] = struct.pack(">II", 5001, 5000)
        bad_pixels[29:33] = struct.pack(">I", zlib.crc32(bad_pixels[12:29]))
        animated = io.BytesIO()
        Image.new("RGB", (8, 8), "red").save(animated, format="PNG", save_all=True,
            append_images=[Image.new("RGB", (8, 8), "blue")], duration=100, loop=0)
        cases = [(b"<svg/>", "image.svg", 400), (b"<html>fake</html>", "image.png", 400),
                 (self.picture(), "wrong.jpg", 400), (self.picture("GIF"), "image.gif", 400),
                 (self.picture()[:40], "broken.png", 400), (bytes(bad_dimensions), "wide.png", 400),
                 (bytes(bad_pixels), "many-pixels.png", 400), (animated.getvalue(), "animated.png", 400),
                 (b"x" * (12 * 1024 * 1024 + 1), "large.png", 400),
                 (b"x" * (13 * 1024 * 1024 + 1), "too-large.png", 413)]
        for content, filename, status in cases:
            with self.subTest(filename=filename):
                error = self.upload(content, filename, expected=status)
                self.assertEqual(error["code"], "invalid_image")
                self.assertNotIn("背景", error["error"])
        response = self.client.post("/api/script-images", headers={"X-CSRF-Token": self.token})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.get_json()["code"], "invalid_image")
        self.assertEqual(self.upload(token=False, expected=403)["code"], "csrf_failed")
        self.assertEqual(self.library(), before)
        self.assertEqual(list(self.store.media_dir.iterdir()), [])

    def test_new_script_saves_uploaded_block_only_when_user_saves(self):
        before = self.library()
        uploaded = self.upload()
        self.assertEqual(self.library(), before)
        created = self.write("/api/scripts", {"id": "script-new", "title": "手动图文", "category_id": "cat-a",
            "blocks": [{"id": "new-caption", "kind": "text", "text": "开始"},
                       {"id": "new-image", "kind": "image", "image_path": uploaded["path"], "text": "插图说明"}]},
            expected=201)
        self.assertEqual([item["id"] for item in created["blocks"]], ["new-caption", "new-image"])
        self.assertEqual(created["blocks"][1]["image_path"], uploaded["path"])
        self.assertEqual(created["blocks"][1]["source_file"], "用户新增")
        self.assertIsNone(created["blocks"][1]["source_page"])
        self.assertEqual(self.library()["state"], before["state"])
        self.assertEqual(self.library()["backgrounds"], before["backgrounds"])
        self.write("/api/scripts", {"title": "不存在的图", "category_id": "cat-a",
            "blocks": [{"id": "missing", "kind": "image", "image_path": "/media/missing.png"}]}, expected=400)
        self.assertEqual(len(self.library()["scripts"]), 2)

    def test_replacing_picture_keeps_source_block_cues_history_and_live_snapshot(self):
        audio = io.BytesIO()
        with wave.open(audio, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(8000)
            wav.writeframes(b"\x00\x00" * 8000)
        self.upload(audio.getvalue(), "sample.wav", endpoint="/api/scripts/script-a/media")
        cues = [{"id": "cue-original", "at": 0, "label": "图片与文字", "block_ids": ["image-a", "text-a"]}]
        self.write("/api/scripts/script-a/media/cues", {"duration": 1, "cues": cues}, method="PUT")
        live = self.apply(layout={"body_mode": "media"})
        original = self.script()
        first = self.upload()
        second = self.upload(self.picture(shade=(80, 10, 40)))
        blocks = copy.deepcopy(original["blocks"])
        blocks[1]["image_path"] = first["path"]
        blocks.insert(1, {"id": "manual-image", "kind": "image", "image_path": second["path"], "text": "新图"})
        saved = self.write("/api/scripts/script-a", {"blocks": blocks}, method="PATCH")
        replacement = next(block for block in saved["blocks"] if block["id"] == "image-a")
        self.assertEqual(replacement["source_page"], 7)
        self.assertEqual(replacement["source_file"], "原稿.pptx")
        self.assertEqual(saved["media"], original["media"])
        self.assertEqual(saved["media"]["cues"], cues)
        self.assertEqual(self.store.state(), live)
        history = self.client.get("/api/scripts/script-a/history").get_json()["history"]
        self.assertTrue(any(entry["script"] == original for entry in history))
        before = self.script()
        self.write("/api/scripts/script-a", {"blocks": [block for block in saved["blocks"] if block["id"] != "image-a"]},
                   method="PATCH", expected=400)
        self.assertEqual(self.script(), before)
        self.assertEqual(self.store.state(), live)

    def test_backup_restore_keeps_current_history_and_snapshot_images_but_not_abandoned_drafts(self):
        first = self.upload()
        blocks = copy.deepcopy(self.script()["blocks"])
        blocks[1]["image_path"] = first["path"]
        self.write("/api/scripts/script-a", {"blocks": blocks}, method="PATCH")
        live = self.apply()
        second = self.upload(self.picture(shade=(200, 100, 20)))
        blocks[1]["image_path"] = second["path"]
        self.write("/api/scripts/script-a", {"blocks": blocks}, method="PATCH")
        abandoned = self.upload(self.picture(shade=(10, 200, 30)))
        backup = self.client.get("/api/backup").data
        with zipfile.ZipFile(io.BytesIO(backup)) as archive:
            manifest = json.loads(archive.read("manifest.json"))
            self.assertIn(first["path"], manifest["resources"])
            self.assertIn(second["path"], manifest["resources"])
            self.assertNotIn(abandoned["path"], manifest["resources"])
        other_root = self.root / "restored"
        other = create_app({**self.config, "DATABASE": str(other_root / "workbench.sqlite3"), "INSTANCE_PATH": str(other_root)})
        other_store = other.extensions["store"]
        other_store.restore(io.BytesIO(backup))
        restored = other_store.library()
        self.assertEqual(restored["scripts"][0]["blocks"][1]["image_path"], second["path"])
        self.assertEqual(restored["state"]["snapshot"]["scripts"][0]["blocks"][1]["image_path"], first["path"])
        self.assertEqual(restored["state"]["snapshot"]["id"], live["snapshot"]["id"])
        self.assertEqual(restored["scripts"][0]["blocks"][1]["id"], "image-a")
        self.assertTrue(any(entry["script"]["blocks"][1]["image_path"] == first["path"] for entry in other_store.history("script-a")))
        for image in (first, second):
            self.assertEqual(other_store.resource_file(image["path"]).read_bytes(), self.store.resource_file(image["path"]).read_bytes())
        self.assertFalse(other_store.resource_file(abandoned["path"]).exists())
        self.assertEqual(restored["backgrounds"], [])

    def test_same_background_resource_is_protected_after_script_save_and_history(self):
        background = self.upload(endpoint="/api/backgrounds")
        uploaded = self.upload()
        self.assertEqual(uploaded["path"], background["path"])
        self.assertEqual(len(self.library()["backgrounds"]), 1)
        original = self.script()["blocks"]
        blocks = copy.deepcopy(original)
        blocks.append({"id": "shared-image", "kind": "image", "image_path": uploaded["path"]})
        self.write("/api/scripts/script-a", {"blocks": blocks}, method="PATCH")
        error = self.write("/api/backgrounds/" + background["id"], {}, method="DELETE", expected=409)
        self.assertEqual(error["code"], "background_in_use")
        self.write("/api/scripts/script-a", {"blocks": original}, method="PATCH")
        error = self.write("/api/backgrounds/" + background["id"], {}, method="DELETE", expected=409)
        self.assertIn("历史", error["error"])
        self.assertTrue(self.store.resource_file(uploaded["path"]).is_file())

    def test_partial_write_close_and_rename_failures_leave_no_file_and_allow_retry(self):
        original_open = Path.open
        original_rename = Path.rename
        for index, failure in enumerate(("write", "close", "rename")):
            with self.subTest(failure=failure):
                before = self.library()
                before_files = set(self.store.media_dir.iterdir())
                content = self.picture(shade=(90 + index, 20, 180))
                class FailingWriter:
                    def __init__(self, handle):
                        self.handle = handle
                    def __enter__(self):
                        return self
                    def write(self, data):
                        if failure == "write":
                            self.handle.write(data[:len(data) // 2])
                            self.handle.flush()
                            raise OSError("simulated partial write")
                        return self.handle.write(data)
                    def __exit__(self, kind, error, traceback):
                        self.handle.close()
                        if failure == "close":
                            raise OSError("simulated close failure")
                def opened(path, mode="r", *args, **kwargs):
                    handle = original_open(path, mode, *args, **kwargs)
                    return FailingWriter(handle) if path.name.startswith(".image-upload-") and mode == "xb" else handle
                def renamed(path, target):
                    if path.name.startswith(".image-upload-") and failure == "rename":
                        self.assertFalse(Path(target).exists())
                        with Image.open(path) as image:
                            image.load()
                        raise OSError("simulated atomic publication failure")
                    return original_rename(path, target)
                with patch.object(Path, "open", opened), patch.object(Path, "rename", renamed):
                    error = self.upload(content, expected=503)
                    self.assertEqual(error["code"], "resource_write_failed")
                self.assertEqual(set(self.store.media_dir.iterdir()), before_files)
                self.assertEqual(self.library(), before)
                uploaded = self.upload(content)
                self.assertTrue(self.store.resource_file(uploaded["path"]).is_file())
                self.assertFalse(any(file.name.startswith(".image-upload-") for file in self.store.media_dir.iterdir()))

    def test_unsaved_shared_background_deletion_rejects_save_until_image_is_reuploaded(self):
        background = self.upload(endpoint="/api/backgrounds")
        image = self.upload()
        self.write("/api/backgrounds/" + background["id"], {}, method="DELETE")
        before = self.library()
        draft = {"title": "未保存的草稿", "category_id": "cat-a",
                 "blocks": [{"id": "draft-image", "kind": "image", "image_path": image["path"]}]}
        error = self.write("/api/scripts", draft, expected=400)
        self.assertIn("本地资源不存在", error["error"])
        self.assertEqual(self.library(), before)
        self.assertEqual(self.upload()["path"], image["path"])
        saved = self.write("/api/scripts", draft, expected=201)
        self.assertEqual(saved["blocks"][0]["id"], "draft-image")

    def test_temporary_name_collision_never_removes_an_existing_file(self):
        temporary = self.store.media_dir / ".image-upload-collision"
        temporary.write_bytes(b"belongs to an earlier operation")
        before = self.library()
        with patch("storage.uuid.uuid4", return_value=SimpleNamespace(hex="collision")):
            error = self.upload(expected=503)
        self.assertEqual(error["code"], "resource_write_failed")
        self.assertEqual(temporary.read_bytes(), b"belongs to an earlier operation")
        self.assertEqual(self.library(), before)
        self.assertEqual(list(self.store.media_dir.iterdir()), [temporary])
        self.assertTrue(self.store.resource_file(self.upload()["path"]).is_file())
        self.assertEqual(temporary.read_bytes(), b"belongs to an earlier operation")

    def test_hash_conflict_does_not_overwrite_existing_resource(self):
        image = self.upload()
        target = self.store.resource_file(image["path"])
        target.write_bytes(b"existing damaged resource")
        before = self.library()
        error = self.upload(expected=409)
        self.assertEqual(error["code"], "resource_conflict")
        self.assertEqual(target.read_bytes(), b"existing damaged resource")
        self.assertEqual(self.library(), before)
        self.assertEqual(list(self.store.media_dir.iterdir()), [target])


if __name__ == "__main__":
    unittest.main()
