"""Media integration coverage. Every database and resource lives in a temp folder."""
import copy
import hashlib
import io
import json
import sqlite3
import tempfile
import unittest
import wave
import zipfile
from pathlib import Path
from unittest.mock import patch

from jinja2 import DictLoader
from app import create_app
from storage import DomainError, MEDIA_MAX_BYTES, validate_media_stream


def wav_bytes(samples=80000, sample=b"\x00\x00"):
    stream = io.BytesIO()
    with wave.open(stream, "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(8000)
        output.writeframes(sample * samples)
    return stream.getvalue()


class MediaTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="xiwa-media-")
        self.root = Path(self.temporary.name)
        (self.root / "static" / "media").mkdir(parents=True)
        (self.root / "static" / "media" / "source.png").write_bytes(b"source-image")
        self.seed = {"categories": [{"id": "cat-a", "name": "分类"}], "scripts": [
            {"id": "script-a", "title": "媒体测试", "category_id": "cat-a", "source_pages": [7],
             "blocks": [{"id": "block-a", "kind": "text", "text": "甲：原文。", "source_page": 7},
                        {"id": "block-b", "kind": "text", "text": "乙：第二段。"},
                        {"id": "block-image", "kind": "image", "text": "", "image_path": "/static/media/source.png"}]},
            {"id": "script-b", "title": "无媒体", "category_id": "cat-a", "blocks": []}]}
        self.seed_path = self.root / "seed.json"
        self.seed_path.write_text(json.dumps(self.seed), encoding="utf-8")
        self.config = {"TESTING": True, "DATABASE": str(self.root / "instance" / "workbench.sqlite3"),
                       "INSTANCE_PATH": str(self.root / "instance"), "SEED_PATH": str(self.seed_path), "PROJECT_ROOT": str(self.root)}
        self.app = create_app(self.config)
        self.client = self.app.test_client()
        self.store = self.app.extensions["store"]
        self.token = self.library()["csrf_token"]
        self.payload = {"mode": "script", "script_id": "script-a", "orientation": "portrait", "layout": {"body_mode": "media"}}
        self.cues = [{"id": "cue-0", "at": 0, "label": "开始", "block_ids": ["block-a", "block-image"]},
                     {"id": "cue-1", "at": 5, "label": "第二句", "block_ids": ["block-b"]}]

    def tearDown(self):
        self.temporary.cleanup()

    def library(self):
        return self.client.get("/api/library").get_json()

    def script(self):
        return next(item for item in self.library()["scripts"] if item["id"] == "script-a")

    def write(self, path, payload=None, method="POST", expected=200):
        response = self.client.open(path, method=method, json={} if payload is None else payload,
                                    headers={"X-CSRF-Token": self.token})
        self.assertEqual(response.status_code, expected, response.get_data(as_text=True))
        return response.get_json()

    def upload(self, content=None, filename="示例.wav", expected=201, script="script-a"):
        response = self.client.post(f"/api/scripts/{script}/media",
                                    data={"file": (io.BytesIO(wav_bytes() if content is None else content), filename),
                                          "kind": "video", "path": "../../arbitrary", "duration": "999"},
                                    headers={"X-CSRF-Token": self.token})
        try:
            self.assertEqual(response.status_code, expected, response.get_data(as_text=True))
            return response.get_json()
        finally:
            response.close()
            response.request.close()
            response.request.environ["wsgi.input"].close()

    def configure(self):
        self.upload()
        return self.write("/api/scripts/script-a/media/cues", {"duration": 10, "cues": self.cues}, "PUT")

    def apply(self, **kwargs):
        payload = {**self.payload, **kwargs}
        preview = self.write("/api/preview", payload)
        return self.write("/api/apply", {**payload, "preview_token": preview["content_token"]})

    def restore(self, content, client=None, token=None, expected=200):
        response = (client or self.client).post("/api/restore", data={"file": (io.BytesIO(content), "backup.zip")},
                                               headers={"X-CSRF-Token": token or self.token})
        try:
            self.assertEqual(response.status_code, expected, response.get_data(as_text=True))
            return response.get_json()
        finally:
            response.close()
            response.request.close()
            response.request.environ["wsgi.input"].close()

    def altered_backup(self, original, mutate):
        with zipfile.ZipFile(io.BytesIO(original)) as archive:
            files = {name: archive.read(name) for name in archive.namelist()}
        manifest = json.loads(files.pop("manifest.json"))
        database = self.root / "altered.sqlite3"
        database.write_bytes(files["database.sqlite3"])
        connection = sqlite3.connect(database)
        try:
            mutate(connection, files, manifest)
            connection.commit()
        finally:
            connection.close()
        files["database.sqlite3"] = database.read_bytes()
        manifest["files"] = {name: {"size": len(value), "sha256": hashlib.sha256(value).hexdigest()} for name, value in files.items()}
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("manifest.json", json.dumps(manifest))
            for name, value in files.items():
                archive.writestr(name, value)
        return output.getvalue()

    def test_upload_uses_server_metadata_and_supports_byte_ranges(self):
        content = wav_bytes()
        original = self.script()
        item = self.upload(content, filename="../../用户文件.wav")
        media = item["media"]
        self.assertEqual(media["kind"], "audio")
        self.assertEqual(media["name"], "用户文件.wav")
        self.assertEqual(media["size"], len(content))
        self.assertEqual(media["sha256"], hashlib.sha256(content).hexdigest())
        self.assertIsNone(media["duration"])
        self.assertEqual(media["cues"], [])
        self.assertEqual(item["blocks"], original["blocks"])
        response = self.client.get(media["path"], headers={"Range": "bytes=0-11"})
        try:
            self.assertEqual(response.status_code, 206)
            self.assertEqual(response.mimetype, "audio/wav")
            self.assertEqual(response.data, content[:12])
        finally:
            response.close()
        self.assertEqual(self.client.get("/media/invalid.wav").status_code, 400)

    def test_signatures_reject_disguised_or_truncated_files_without_resources(self):
        original = self.script()
        for content, name in [(b"<svg>evil</svg>", "fake.mp4"), (wav_bytes(), "fake.mp3"),
                              (wav_bytes()[:-1], "short.wav"), (b"", "empty.wav"), (wav_bytes(), "image.svg")]:
            with self.subTest(name=name):
                self.upload(content, name, expected=400)
                self.assertEqual(self.script(), original)
                self.assertEqual(list(self.store.media_dir.iterdir()), [])
        self.upload(script="missing", expected=404)
        self.assertEqual(list(self.store.media_dir.iterdir()), [])

    def test_allowed_container_signatures(self):
        def box(kind, content):
            return (8 + len(content)).to_bytes(4, "big") + kind + content
        mp4 = box(b"ftyp", b"isom\x00\x00\x00\x00isom") + box(b"moov", b"") + box(b"mdat", b"sample")
        fixtures = {".wav": wav_bytes(), ".mp4": mp4, ".m4a": mp4,
                    ".mp3": b"\xff\xfb\x90\x64" + bytes(100),
                    ".webm": b"\x1aE\xdf\xa3\x87\x42\x82\x84webm\x18\x53\x80\x67\x80",
                    ".ogg": b"OggS\x00\x02" + bytes(20) + b"\x01\x08OpusHead"}
        for extension, content in fixtures.items():
            with self.subTest(extension=extension):
                self.assertIn(validate_media_stream(io.BytesIO(content), extension, len(content)), {"audio", "video"})
        with self.assertRaises(DomainError):
            validate_media_stream(io.BytesIO(b"ID3\x04\x00\x00\x80\x00\x00\x00"), ".mp3", 10)

    def test_upload_limit_and_stream_failure_remove_partial_files(self):
        with patch("storage.MEDIA_MAX_BYTES", 100):
            self.upload(expected=413)
        self.assertEqual(list(self.store.media_dir.iterdir()), [])
        class FailingStream:
            calls = 0
            def read(self, size):
                self.calls += 1
                if self.calls == 1:
                    return b"RIFFpartial"
                raise OSError("simulated read failure")
        with self.assertRaises(DomainError) as error:
            self.store.upload_script_media("script-a", FailingStream(), "broken.wav")
        self.assertEqual(error.exception.code, "resource_write_failed")
        self.assertEqual(list(self.store.media_dir.iterdir()), [])
        self.assertNotIn("media", self.script())

    def test_database_failure_removes_new_file_but_preserves_existing_hash(self):
        original = self.upload()
        files = set(self.store.media_dir.iterdir())
        for content in [wav_bytes(sample=b"\x01\x00"), wav_bytes()]:
            with patch.object(self.store, "_script", side_effect=sqlite3.OperationalError("simulated commit failure")):
                with self.assertLogs(self.app.logger, level="ERROR"):
                    self.upload(content, expected=503)
            self.assertEqual(self.script(), original)
            self.assertEqual(set(self.store.media_dir.iterdir()), files)
            self.assertEqual(self.store.resource_file(original["media"]["path"]).read_bytes(), wav_bytes())

    def test_replacement_and_removal_keep_frozen_snapshot_and_history_files(self):
        original = self.configure()
        live = self.apply()
        replacement = self.upload(wav_bytes(sample=b"\x01\x00"))
        self.assertNotEqual(original["media"]["path"], replacement["media"]["path"])
        self.assertIsNone(replacement["media"]["duration"])
        self.assertEqual(replacement["media"]["cues"], [])
        self.assertEqual(self.store.state(), live)
        removed = self.write("/api/scripts/script-a/media", method="DELETE")
        self.assertNotIn("media", removed)
        self.assertEqual(self.store.state()["snapshot"]["scripts"][0]["media"], original["media"])
        for item in [original, replacement]:
            self.assertTrue(self.store.resource_file(item["media"]["path"]).exists())
        history = self.store.history("script-a")
        self.assertTrue(any(entry["script"].get("media") == original["media"] for entry in history))
        with zipfile.ZipFile(io.BytesIO(self.store.backup())) as archive:
            resources = json.loads(archive.read("manifest.json"))["resources"]
            self.assertIn(original["media"]["path"], resources)
            self.assertIn(replacement["media"]["path"], resources)

    def test_duplicate_upload_resets_cues_but_reuses_file(self):
        original = self.configure()
        files = set(self.store.media_dir.iterdir())
        current = self.upload()
        self.assertEqual(current["media"]["path"], original["media"]["path"])
        self.assertEqual(current["media"]["cues"], [])
        self.assertIsNone(current["media"]["duration"])
        self.assertEqual(set(self.store.media_dir.iterdir()), files)

    def test_cue_sorting_multi_block_and_validation_are_atomic(self):
        self.upload()
        item = self.write("/api/scripts/script-a/media/cues", {"duration": 10, "cues": self.cues[::-1]}, "PUT")
        self.assertEqual(item["media"]["cues"], self.cues)
        invalid = [self.cues + [{**self.cues[0], "id": "same-time"}], [{**self.cues[0], "at": -1}],
                   [{**self.cues[0], "at": 11}], [{**self.cues[0], "at": float("nan")}],
                   [{**self.cues[0], "block_ids": []}], [{**self.cues[0], "block_ids": ["missing"]}],
                   [{**self.cues[0], "block_ids": ["block-a", "block-a"]}],
                   self.cues + [{**self.cues[0], "at": 8}]]
        for cues in invalid:
            with self.subTest(cues=cues):
                self.write("/api/scripts/script-a/media/cues", {"cues": cues}, "PUT", expected=400)
                self.assertEqual(self.script(), item)
        for duration in [0, -1, float("inf"), True, "10"]:
            self.write("/api/scripts/script-a/media/cues", {"cues": [], "duration": duration}, "PUT", expected=400)
        cleared = self.write("/api/scripts/script-a/media/cues", {"cues": [], "duration": None}, "PUT")
        self.assertEqual(cleared["media"]["cues"], [])
        self.assertIsNone(cleared["media"]["duration"])

    def test_normal_script_edit_cannot_inject_media_or_remove_referenced_block(self):
        original = self.configure()
        updated = self.write("/api/scripts/script-a", {"title": "新标题", "media": {"path": "/etc/passwd"}}, "PATCH")
        self.assertEqual(updated["media"], original["media"])
        self.write("/api/scripts/script-a", {"blocks": updated["blocks"][1:]}, "PATCH", expected=400)
        self.assertEqual(self.script(), updated)
        changed = copy.deepcopy(updated["blocks"])
        changed[0]["text"] = "保留 ID 的新台词"
        saved = self.write("/api/scripts/script-a", {"blocks": changed}, "PATCH")
        self.assertEqual(saved["media"], original["media"])
        self.assertEqual(saved["blocks"][0]["original_text"], original["blocks"][0]["original_text"])

    def test_preview_is_read_only_and_media_requires_attachment(self):
        before = self.store.state()
        self.write("/api/preview", self.payload, expected=409)
        directory = self.write("/api/preview", {"mode": "list", "directory_level": "categories", "layout": {"body_mode": "media"}})
        self.assertEqual(directory["mode"], "list")
        self.configure()
        preview = self.write("/api/preview", self.payload)
        self.assertEqual(preview["scripts"][0]["media"], self.script()["media"])
        self.assertEqual(self.store.state(), before)
        for layout in [{"media_side": "top"}, {"media_caption_mode": "guess"}]:
            self.write("/api/preview", {**self.payload, "layout": {"body_mode": "media", **layout}}, expected=400)

    def test_verified_apply_confirmation_pauses_and_realtime_reuses_snapshot(self):
        self.configure()
        media_state = {"position": 5, "caption_index": 1, "cue_id": "cue-1"}
        self.write("/api/apply", {**self.payload, "preview_media_state": media_state}, expected=400)
        confirmed = self.apply(preview_media_state=media_state, preview_playing=True)
        self.assertFalse(confirmed["playing"])
        self.assertEqual(confirmed["media_state"], {**media_state, "caption_page_index": 0})
        realtime = self.apply(realtime=True, preview_media_state={"position": 0, "caption_index": 0, "cue_id": None}, preview_playing=True)
        self.assertTrue(realtime["playing"])
        self.assertEqual(realtime["snapshot"]["id"], confirmed["snapshot"]["id"])
        retained = self.apply()
        self.assertEqual(retained["media_state"], realtime["media_state"])
        self.assertFalse(retained["playing"])
        preview = self.write("/api/preview", self.payload)
        self.write("/api/scripts/script-a/media/cues", {"cues": []}, "PUT")
        self.write("/api/apply", {**self.payload, "preview_token": preview["content_token"]}, expected=409)
        self.assertEqual(self.store.state(), retained)

    def test_invalid_media_apply_rolls_back_layout_and_live(self):
        self.configure()
        live = self.apply()
        layouts = self.library()["layouts"]
        for media_state in [{"position": -1, "caption_index": 0, "cue_id": None},
                            {"position": 11, "caption_index": 0, "cue_id": None},
                            {"position": 1, "caption_index": 2, "cue_id": None},
                            {"position": 1, "caption_index": True, "cue_id": None},
                            {"position": 1, "caption_index": 0, "cue_id": "missing"}, {}]:
            payload = {**self.payload, "layout": {"body_mode": "media", "font_size": 70}}
            preview = self.write("/api/preview", payload)
            response = self.client.post("/api/apply", json={**payload, "preview_token": preview["content_token"], "preview_media_state": media_state},
                                        headers={"X-CSRF-Token": self.token})
            self.assertIn(response.status_code, {400, 409})
            self.assertEqual(self.store.state(), live)
            self.assertEqual(self.library()["layouts"], layouts)

    def test_media_command_checkpoint_and_stale_revision(self):
        self.configure()
        live = self.apply()
        request = {"action": "media", "snapshot_id": live["snapshot"]["id"], "revision": live["revision"],
                   "playing": True, "media_state": {"position": 3, "caption_index": 0, "cue_id": None}}
        playing = self.write("/api/command", request)
        self.assertTrue(playing["playing"])
        self.assertEqual(playing["seek_version"], live["seek_version"] + 1)
        self.write("/api/command", request, expected=409)
        self.write("/api/command", {**request, "revision": playing["revision"], "snapshot_id": "wrong"}, expected=409)
        self.write("/api/command", {**request, "revision": playing["revision"], "playing": 1}, expected=400)
        position = {"position": 4, "caption_index": 0, "cue_id": None}
        checkpoint = self.write("/api/checkpoint", {"revision": playing["revision"], "media_state": position})
        self.assertEqual(checkpoint["revision"], playing["revision"])
        self.assertEqual(checkpoint["seek_version"], playing["seek_version"])
        self.assertEqual(checkpoint["media_state"], {**position, "caption_page_index": 0})
        paused = self.write("/api/command", {**request, "revision": checkpoint["revision"], "playing": False,
                                             "media_state": {"position": 5, "caption_index": 1, "cue_id": "cue-1"}})
        self.write("/api/checkpoint", {"revision": playing["revision"], "media_state": position}, expected=409)
        self.assertEqual(self.store.state(), paused)

    def test_refresh_and_restart_pause_but_keep_media_position(self):
        self.configure()
        position = {"position": 5, "caption_index": 1, "caption_page_index": 3, "cue_id": "cue-1"}
        self.apply(realtime=True, preview_playing=True, preview_media_state=position)
        connected = self.write("/api/display/connect")
        self.assertFalse(connected["playing"])
        self.assertEqual(connected["media_state"], position)
        restarted = create_app(self.config).extensions["store"].state()
        self.assertFalse(restarted["playing"])
        self.assertEqual(restarted["media_state"], position)
        self.assertEqual(restarted["snapshot"], connected["snapshot"])

    def test_without_cues_caption_index_uses_blocks_and_empty_script_can_play(self):
        self.upload()
        live = self.apply(preview_media_state={"position": 1, "caption_index": 2, "cue_id": None})
        self.assertEqual(live["media_state"]["caption_index"], 2)
        self.upload(script="script-b")
        payload = {**self.payload, "script_id": "script-b", "realtime": True, "preview_playing": True}
        preview = self.write("/api/preview", payload)
        state = self.write("/api/apply", {**payload, "preview_token": preview["content_token"]})
        self.assertTrue(state["playing"])
        self.assertEqual(state["media_state"], {"position": 0, "caption_index": 0, "caption_page_index": 0, "cue_id": None})

    def test_backup_roundtrip_keeps_media_history_cues_and_position(self):
        item = self.configure()
        position = {"position": 5, "caption_index": 1, "caption_page_index": 3, "cue_id": "cue-1"}
        self.apply(realtime=True, preview_playing=True, preview_media_state=position,
                   layout={"body_mode": "media", "media_caption_layout": "scroll"})
        self.write("/api/scripts/script-a/media", method="DELETE")
        backup = self.store.backup()
        target_config = {**self.config, "DATABASE": str(self.root / "destination" / "workbench.sqlite3"),
                         "INSTANCE_PATH": str(self.root / "destination")}
        target = create_app(target_config)
        client = target.test_client()
        token = client.get("/api/library").get_json()["csrf_token"]
        result = self.restore(backup, client, token)
        self.assertFalse(result["state"]["playing"])
        self.assertEqual(result["state"]["media_state"], position)
        self.assertEqual(result["state"]["snapshot"]["layout"]["media_caption_layout"], "scroll")
        self.assertEqual(result["state"]["snapshot"]["scripts"][0]["media"], item["media"])
        store = target.extensions["store"]
        self.assertEqual(store.resource_file(item["media"]["path"]).read_bytes(), wav_bytes())
        self.assertTrue(any(entry["script"].get("media") == item["media"] for entry in store.history("script-a")))

    def test_restore_rejects_self_consistent_bad_media_signature_and_paths(self):
        self.upload()
        backup = self.store.backup()
        before = self.store.library()
        def bad_signature(connection, files, manifest):
            row = connection.execute("SELECT data FROM scripts WHERE id='script-a'").fetchone()
            item = json.loads(row[0]); media = item["media"]
            old_path = media["path"]; old_archive = manifest["resources"].pop(old_path)
            content = b"EVIL" + files.pop(old_archive)[4:]
            digest = hashlib.sha256(content).hexdigest()
            media.update(path="/media/" + digest + ".wav", sha256=digest)
            archive_name = "assets/media/" + digest + ".wav"
            files[archive_name] = content
            manifest["resources"][media["path"]] = archive_name
            connection.execute("UPDATE scripts SET data=? WHERE id='script-a'", (json.dumps(item),))
        self.restore(self.altered_backup(backup, bad_signature), expected=400)
        self.assertEqual(self.store.library(), before)
        def bad_path(connection, files, manifest):
            item = json.loads(connection.execute("SELECT data FROM scripts WHERE id='script-a'").fetchone()[0])
            item["media"]["path"] = "/media/../escape.wav"
            connection.execute("UPDATE scripts SET data=? WHERE id='script-a'", (json.dumps(item),))
        self.restore(self.altered_backup(backup, bad_path), expected=400)
        self.assertEqual(self.store.library(), before)

    def test_media_over_old_image_limit_can_backup_restore(self):
        # A real 42 MiB PCM WAV verifies that the old 40 MiB image limit does not
        # silently prevent backing up a valid media file. Zero samples zip well.
        content = wav_bytes(samples=21 * 1024 * 1024)
        self.assertGreater(len(content), 40 * 1024 * 1024)
        self.assertLess(len(content), MEDIA_MAX_BYTES)
        item = self.upload(content)
        result = self.restore(self.store.backup())
        self.assertTrue(result["restored"])
        self.assertEqual(self.store.resource_file(item["media"]["path"]).stat().st_size, len(content))

    def test_legacy_backup_defaults_and_media_editor_context(self):
        backup = self.store.backup()
        def remove_fields(connection, files, manifest):
            layouts = json.loads(connection.execute("SELECT data FROM settings WHERE key='layouts'").fetchone()[0])
            for layout in layouts.values():
                layout.pop("media_caption_mode", None); layout.pop("media_side", None); layout.pop("media_caption_layout", None)
            connection.execute("UPDATE settings SET data=? WHERE key='layouts'", (json.dumps(layouts),))
            state = json.loads(connection.execute("SELECT data FROM settings WHERE key='state'").fetchone()[0])
            state.pop("media_state", None)
            connection.execute("UPDATE settings SET data=? WHERE key='state'", (json.dumps(state),))
        self.restore(self.altered_backup(backup, remove_fields))
        library = self.library()
        self.assertEqual(library["layouts"]["portrait"]["media_caption_mode"], "auto")
        self.assertEqual(library["layouts"]["landscape"]["media_side"], "left")
        self.assertTrue(all(layout["media_caption_layout"] == "pages" for layout in library["layouts"].values()))
        self.assertEqual(library["state"]["media_state"], {"position": 0, "caption_index": 0, "caption_page_index": 0, "cue_id": None})
        self.app.jinja_loader = DictLoader({"media_editor.html": "{{page}}|{{script_id}}|{{script.title}}|{{bootstrap.csrf_token}}"})
        response = self.client.get("/script/script-a/media")
        self.assertEqual(response.status_code, 200)
        self.assertIn("media-editor|script-a|媒体测试|", response.get_data(as_text=True))
        self.assertEqual(self.client.get("/script/missing/media").status_code, 404)


    def test_caption_layout_defaults_presets_and_backup_are_independent(self):
        before = self.library()
        for orientation in ("portrait", "landscape"):
            self.assertEqual(before["default_layouts"][orientation]["media_caption_layout"], "pages")
            self.assertEqual(before["layouts"][orientation]["media_caption_layout"], "pages")
            self.assertEqual(before["layouts"][orientation]["body_mode"], "pages")
        default_preset = self.write("/api/layout-presets", {"name": "默认媒体排版", "layouts": {
            "portrait": {}, "landscape": {}}}, expected=201)
        self.assertTrue(all(layout["media_caption_layout"] == "pages" for layout in default_preset["layouts"].values()))
        custom = self.write("/api/layout-presets", {"name": "各画幅独立", "layouts": {
            "portrait": {"body_mode": "media", "media_caption_layout": "scroll"},
            "landscape": {"body_mode": "scroll", "media_caption_layout": "pages"}}}, expected=201)
        self.assertEqual(self.library()["layouts"], before["layouts"])
        self.assertEqual(self.store.state(), before["state"])
        saved = self.write("/api/layouts", {"orientation": "landscape", "layout": {"media_caption_layout": "scroll"}})
        self.assertEqual(saved["portrait"]["media_caption_layout"], "pages")
        self.assertEqual(saved["landscape"]["media_caption_layout"], "scroll")
        self.assertEqual(saved["landscape"]["body_mode"], "pages")
        backup = self.store.backup()
        self.write("/api/layout-presets/" + custom["id"], method="DELETE")
        self.restore(backup)
        restored = self.library()
        self.assertEqual(restored["layouts"], saved)
        self.assertEqual(restored["layout_presets"], [default_preset, custom])
        for invalid in ("continuous", None, True, 0, []):
            with self.subTest(layout=invalid):
                self.write("/api/layouts", {"orientation": "portrait", "layout": {"media_caption_layout": invalid}}, expected=400)
                self.write("/api/layout-presets", {"name": "无效台词布局", "layouts": {
                    "portrait": {"media_caption_layout": invalid}, "landscape": {}}}, expected=400)
        self.assertEqual(self.library()["layouts"], saved)
        self.assertEqual(self.library()["layout_presets"], [default_preset, custom])

    def test_caption_page_apply_command_checkpoint_and_token_boundary(self):
        self.configure()
        original = self.store.state()
        preview = self.write("/api/preview", self.payload)
        self.assertEqual(preview["layout"]["media_caption_layout"], "pages")
        self.assertEqual(self.store.state(), original)
        position = {"position": 5, "caption_index": 1, "caption_page_index": 2, "cue_id": "cue-1"}
        live = self.write("/api/apply", {**self.payload, "preview_token": preview["content_token"],
                                        "preview_media_state": position, "preview_playing": True})
        self.assertFalse(live["playing"])
        self.assertEqual(live["media_state"], position)
        synced = self.apply(realtime=True, preview_playing=True, preview_media_state={**position, "caption_page_index": 3})
        self.assertEqual(synced["snapshot"]["id"], live["snapshot"]["id"])
        self.assertEqual(synced["snapshot"]["content_token"], live["snapshot"]["content_token"])
        self.assertEqual(synced["media_state"]["caption_page_index"], 3)
        self.assertTrue(synced["playing"])
        command = self.write("/api/command", {"action": "media", "snapshot_id": synced["snapshot"]["id"],
                             "revision": synced["revision"], "playing": False,
                             "media_state": {**position, "caption_page_index": 4}})
        self.assertEqual(command["media_state"]["caption_page_index"], 4)
        self.assertGreater(command["seek_version"], synced["seek_version"])
        checkpoint = self.write("/api/checkpoint", {"revision": command["revision"],
                                "snapshot_id": command["snapshot"]["id"],
                                "media_state": {**position, "caption_page_index": 100000}})
        self.assertEqual(checkpoint["media_state"]["caption_page_index"], 100000)
        self.assertEqual(checkpoint["revision"], command["revision"])
        self.assertEqual(checkpoint["seek_version"], command["seek_version"])
        self.write("/api/checkpoint", {"revision": synced["revision"], "media_state": position}, expected=409)
        changed = {**self.payload, "layout": {"body_mode": "media", "media_caption_layout": "scroll"}}
        scroll_preview = self.write("/api/preview", changed)
        self.assertNotEqual(scroll_preview["content_token"], preview["content_token"])
        self.write("/api/apply", {**changed, "preview_token": preview["content_token"],
                                 "preview_media_state": position}, expected=409)
        self.assertEqual(self.store.state(), checkpoint)
        switched = self.write("/api/apply", {**changed, "realtime": True, "preview_token": scroll_preview["content_token"],
                                            "preview_media_state": {**position, "caption_page_index": 0}})
        self.assertNotEqual(switched["snapshot"]["id"], live["snapshot"]["id"])
        self.assertEqual(switched["snapshot"]["layout"]["media_caption_layout"], "scroll")
        # Ordinary body mode keeps its established non-media normalization.
        ordinary = self.write("/api/apply", {"mode": "script", "script_id": "script-a", "layout": {"body_mode": "pages"}})
        self.assertEqual(ordinary["media_state"], {"position": 0, "caption_index": 0, "caption_page_index": 0, "cue_id": None})
        self.write("/api/checkpoint", {"revision": ordinary["revision"], "media_state": position}, expected=400)
        self.assertEqual(self.store.state(), ordinary)

    def test_invalid_caption_page_rolls_back_apply_command_checkpoint_and_restore(self):
        self.configure()
        position = {"position": 5, "caption_index": 1, "caption_page_index": 2, "cue_id": "cue-1"}
        live = self.apply(preview_media_state=position)
        before = self.library()
        backup = self.store.backup()
        payload = {**self.payload, "layout": {"body_mode": "media", "font_size": 62}}
        preview = self.write("/api/preview", payload)
        for invalid in (-1, 100001, True, 1.0, "2", None, []):
            with self.subTest(page=invalid):
                media_state = {**position, "caption_page_index": invalid}
                self.write("/api/apply", {**payload, "preview_token": preview["content_token"],
                                         "preview_media_state": media_state}, expected=400)
                self.write("/api/command", {"action": "media", "snapshot_id": live["snapshot"]["id"],
                           "revision": live["revision"], "playing": True, "media_state": media_state}, expected=400)
                self.write("/api/checkpoint", {"revision": live["revision"], "media_state": media_state}, expected=400)
                def corrupt(connection, files, manifest):
                    state = json.loads(connection.execute("SELECT data FROM settings WHERE key='state'").fetchone()[0])
                    state["media_state"]["caption_page_index"] = invalid
                    connection.execute("UPDATE settings SET data=? WHERE key='state'", (json.dumps(state),))
                self.restore(self.altered_backup(backup, corrupt), expected=400)
                self.assertEqual(self.library(), before)
        def bad_layout(connection, files, manifest):
            state = json.loads(connection.execute("SELECT data FROM settings WHERE key='state'").fetchone()[0])
            state["snapshot"]["layout"]["media_caption_layout"] = "bad"
            connection.execute("UPDATE settings SET data=? WHERE key='state'", (json.dumps(state),))
        self.restore(self.altered_backup(backup, bad_layout), expected=400)
        self.assertEqual(self.library(), before)

    def test_old_caption_fields_load_without_rewriting_snapshot_or_source(self):
        self.configure()
        live = self.apply(realtime=True, preview_playing=True,
                          preview_media_state={"position": 5, "caption_index": 1, "cue_id": "cue-1"})
        self.write("/api/layout-presets", {"name": "旧媒体方案", "layouts": {
            "portrait": {"body_mode": "media"}, "landscape": {"body_mode": "scroll"}}}, expected=201)
        # Model a pre-pagination database, including its saved preview token and ID.
        with self.store.transaction(write=True) as connection:
            for key in ("layouts", "layout_presets", "state"):
                value = json.loads(connection.execute("SELECT data FROM settings WHERE key=?", (key,)).fetchone()[0])
                layouts = (value.values() if key == "layouts" else
                           value[0]["layouts"].values() if key == "layout_presets" else [value["snapshot"]["layout"]])
                for layout in layouts:
                    layout.pop("media_caption_layout")
                if key == "state":
                    value["media_state"].pop("caption_page_index")
                self.store._save_setting(connection, key, value)
        with self.store.transaction() as connection:
            raw = self.store._export(connection)
        loaded = self.library()
        self.assertEqual(loaded["state"]["media_state"]["caption_page_index"], 0)
        self.assertEqual(loaded["state"]["snapshot"]["layout"]["media_caption_layout"], "pages")
        self.assertTrue(loaded["state"]["playing"])
        for key in ("id", "content_token", "created_at", "scripts", "categories", "selection"):
            self.assertEqual(loaded["state"]["snapshot"][key], live["snapshot"][key])
        self.assertEqual(loaded["state"]["revision"], live["revision"])
        self.assertEqual(loaded["state"]["seek_version"], live["seek_version"])
        self.assertTrue(all(layout["media_caption_layout"] == "pages" for layout in loaded["layout_presets"][0]["layouts"].values()))
        with self.store.transaction() as connection:
            self.assertEqual(self.store._export(connection), raw, "reading old data must not rewrite it")
        backup = self.store.backup()
        restored = self.restore(backup)["state"]
        self.assertFalse(restored["playing"])
        self.assertEqual(restored["media_state"], loaded["state"]["media_state"])
        # Restore already strips derived category counts and maps packaged images
        # to hash-addressed local resources; all source text and frozen IDs survive.
        expected_snapshot = copy.deepcopy(loaded["state"]["snapshot"])
        expected_scripts = copy.deepcopy(loaded["scripts"])
        for category in expected_snapshot["categories"]:
            category.pop("script_count", None)
            category.pop("visible_count", None)
        image_path = "/media/" + hashlib.sha256(b"source-image").hexdigest() + ".png"
        for script in expected_snapshot["scripts"] + expected_scripts:
            for block in script["blocks"]:
                if block.get("image_path") == "/static/media/source.png":
                    block["image_path"] = image_path
        self.assertEqual(self.store.resource_file(image_path).read_bytes(), b"source-image")
        self.assertEqual(restored["snapshot"], expected_snapshot)
        self.assertEqual(self.library()["scripts"], expected_scripts)
        restarted = create_app(self.config).extensions["store"].state()
        self.assertFalse(restarted["playing"])
        self.assertEqual(restarted["media_state"], restored["media_state"])
        self.assertEqual(restarted["snapshot"], restored["snapshot"])



if __name__ == "__main__":
    unittest.main()
