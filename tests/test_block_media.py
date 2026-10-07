"""Paragraph-level media blocks: upload, validation, resource collection."""
import hashlib
import io
import json
import tempfile
import unittest
from pathlib import Path

from app import create_app
from storage import DomainError


def mp4_bytes():
    def box(tag, payload):
        return (len(payload) + 8).to_bytes(4, "big") + tag + payload
    return box(b"ftyp", b"isom" + b"\0" * 4) + box(b"moov", b"") + box(b"mdat", b"sample-video-bytes")


def mp3_bytes():
    return b"ID3\x03\x00\x00\x00\x00\x00\x00" + b"\xff\xfb\x80\x00" + b"\x00" * 64


class BlockMediaTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="xiwa-block-media-")
        self.root = Path(self.temporary.name)
        (self.root / "static" / "media").mkdir(parents=True)
        (self.root / "static" / "media" / "source.png").write_bytes(b"\x89PNG\r\nsource-image")
        seed = {
            "categories": [{"id": "cat-a", "name": "甜本", "sort_order": 0, "visible": True}],
            "scripts": [
                {"id": "script-a", "title": "示例剧本", "category_id": "cat-a", "blocks": [
                    {"id": "para-1", "kind": "text", "text": "甲：第一句。", "role": "甲", "source_file": "来源.pptx"},
                ]},
            ],
        }
        seed_file = self.root / "seed.json"
        seed_file.write_text(json.dumps(seed, ensure_ascii=False), encoding="utf-8")
        self.config = {"TESTING": True, "DATABASE": str(self.root / "instance" / "workbench.sqlite3"),
                       "INSTANCE_PATH": str(self.root / "instance"), "SEED_PATH": str(seed_file), "PROJECT_ROOT": str(self.root)}
        self.app = create_app(self.config)
        self.client = self.app.test_client()
        self.token = self.client.get("/api/library").get_json()["csrf_token"]

    def tearDown(self):
        self.temporary.cleanup()

    def upload(self, payload, name, expected=201):
        response = self.client.post("/api/script-media",
                                    data={"file": (io.BytesIO(payload), name)},
                                    content_type="multipart/form-data",
                                    headers={"X-CSRF-Token": self.token})
        self.assertEqual(response.status_code, expected, response.get_data(as_text=True))
        return response.get_json() if expected < 400 else response.get_json()

    def save(self, script_id, data, expected=200):
        response = self.client.patch("/api/scripts/" + script_id, json=data,
                                     headers={"X-CSRF-Token": self.token})
        self.assertEqual(response.status_code, expected, response.get_data(as_text=True))
        return response.get_json()

    def test_upload_video_returns_asset_metadata(self):
        payload = mp4_bytes()
        asset = self.upload(payload, "demo.mp4")
        self.assertEqual(asset["kind"], "video")
        self.assertEqual(asset["name"], "demo.mp4")
        self.assertEqual(asset["size"], len(payload))
        self.assertTrue(asset["path"].startswith("/media/"))
        self.assertEqual(asset["sha256"], hashlib.sha256(payload).hexdigest())
        self.assertTrue((self.root / "instance" / "media" / (asset["sha256"] + ".mp4")).is_file())

    def test_upload_audio_returns_audio_kind(self):
        payload = mp3_bytes()
        asset = self.upload(payload, "demo.mp3")
        self.assertEqual(asset["kind"], "audio")

    def test_upload_rejects_invalid_media(self):
        self.upload(b"not a media file at all", "demo.mp4", expected=400)
        self.upload(mp4_bytes(), "demo.exe", expected=400)

    def test_save_script_with_video_block_and_resource_collection(self):
        asset = self.upload(mp4_bytes(), "demo.mp4")
        data = {"blocks": [
            {"id": "para-1", "kind": "text", "text": "甲：第一句。", "role": "甲", "source_file": "来源.pptx"},
            {"id": "vid-1", "kind": "video", "text": "", "media_path": asset["path"],
             "media_name": asset["name"], "media_size": asset["size"], "media_sha256": asset["sha256"]},
        ]}
        script = self.save("script-a", data)
        video = next(b for b in script["blocks"] if b["kind"] == "video")
        self.assertEqual(video["media_path"], asset["path"])
        self.assertEqual(video["media_sha256"], asset["sha256"])
        self.assertEqual(video["media_duration"], None)
        # resources() must collect paragraph media for packaging / backup
        from storage import resources
        collected = resources(script)
        self.assertIn(asset["path"], collected)

    def test_save_rejects_kind_media_mismatch(self):
        video = self.upload(mp4_bytes(), "demo.mp4")
        audio = self.upload(mp3_bytes(), "demo.mp3")
        data = {"blocks": [
            {"id": "para-1", "kind": "text", "text": "甲：第一句。", "role": "甲", "source_file": "来源.pptx"},
            {"id": "bad-1", "kind": "video", "text": "", "media_path": audio["path"],
             "media_name": audio["name"], "media_size": audio["size"], "media_sha256": audio["sha256"]},
        ]}
        self.save("script-a", data, expected=400)

    def test_save_rejects_missing_media_path(self):
        data = {"blocks": [
            {"id": "para-1", "kind": "text", "text": "甲：第一句。", "role": "甲", "source_file": "来源.pptx"},
            {"id": "bad-1", "kind": "video", "text": "", "media_path": ""},
        ]}
        self.save("script-a", data, expected=400)

    def test_export_import_roundtrip_preserves_media_block(self):
        asset = self.upload(mp4_bytes(), "demo.mp4")
        data = {"blocks": [
            {"id": "para-1", "kind": "text", "text": "甲：第一句。", "role": "甲", "source_file": "来源.pptx"},
            {"id": "vid-1", "kind": "video", "text": "", "media_path": asset["path"],
             "media_name": asset["name"], "media_size": asset["size"], "media_sha256": asset["sha256"]},
        ]}
        self.save("script-a", data)
        # 导出单篇 ZIP；改名后作为"外部收到的包"重新打包
        export = self.client.get("/api/scripts/script-a/export")
        self.assertEqual(export.status_code, 200, export.data[:200])
        import zipfile
        pkg = zipfile.ZipFile(io.BytesIO(export.data))
        script_json = json.loads(pkg.read("script.json").decode("utf-8"))
        script_json["title"] = "导入的剧本"
        new_script_bytes = json.dumps(script_json, ensure_ascii=False).encode("utf-8")
        manifest = json.loads(pkg.read("manifest.json").decode("utf-8"))
        manifest["files"]["script.json"] = {"size": len(new_script_bytes),
                                            "sha256": hashlib.sha256(new_script_bytes).hexdigest(),
                                            "mime": "application/json"}
        rebundled = io.BytesIO()
        with zipfile.ZipFile(rebundled, "w") as out:
            for member in pkg.namelist():
                if member == "script.json":
                    out.writestr(member, new_script_bytes)
                elif member == "manifest.json":
                    out.writestr(member, json.dumps(manifest, ensure_ascii=False).encode("utf-8"))
                else:
                    out.writestr(member, pkg.read(member))
        rebundled.seek(0)
        package_bytes = rebundled.getvalue()
        # 导入预览：应通过校验且保留 video block
        preview = self.client.post("/api/script-packages/preview",
                                   data={"file": (io.BytesIO(package_bytes), "pkg.zip")},
                                   content_type="multipart/form-data",
                                   headers={"X-CSRF-Token": self.token})
        self.assertEqual(preview.status_code, 200, preview.get_data(as_text=True))
        previewed = preview.get_json()
        media_blocks = [b for b in previewed["script"]["blocks"] if b["kind"] == "video"]
        self.assertEqual(len(media_blocks), 1)
        self.assertEqual(media_blocks[0]["media_path"], asset["path"])
        # 实际导入为剧本 script-b（带预览返回的包校验值）
        rebundled.seek(0)
        imported = self.client.post("/api/script-packages/import",
                                    data={"file": (io.BytesIO(package_bytes), "pkg.zip"),
                                          "action": "new", "category_id": "cat-a",
                                          "expected_sha256": previewed["package_sha256"]},
                                    content_type="multipart/form-data",
                                    headers={"X-CSRF-Token": self.token})
        self.assertEqual(imported.status_code, 201, imported.get_data(as_text=True))
        library = self.client.get("/api/library").get_json()
        new_script = next(item for item in library["scripts"] if item["id"] != "script-a")
        video_blocks = [b for b in new_script["blocks"] if b["kind"] == "video"]
        self.assertEqual(len(video_blocks), 1)
        self.assertTrue(video_blocks[0]["media_path"].startswith("/media/"))


if __name__ == "__main__":
    unittest.main()
