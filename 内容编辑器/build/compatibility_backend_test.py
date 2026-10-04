"""Standalone fan-service compatibility checks; temporary workspaces only.

This intentionally imports only the fan project's copied modules. The main
workbench's real export -> fan -> import test is a separate integration check.
"""
from __future__ import annotations

import copy
import hashlib
import io
import json
import sys
import tempfile
import unittest
import wave
import zipfile
from pathlib import Path

FAN = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(FAN))
import fan_app
import import_parser
import script_package as package
import storage


def package_bytes(item, assets=None):
    assets = assets or {}
    content = storage.encode(item).encode("utf-8")
    files = {"script.json": {"size": len(content), "sha256": hashlib.sha256(content).hexdigest(), "mime": "application/json"}}
    mapping = {}
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("script.json", content)
        written = set()
        for ref, data in assets.items():
            extension = Path(ref).suffix.lower()
            member = "assets/" + hashlib.sha256(data).hexdigest() + extension
            mapping[ref] = member
            files[member] = {"size": len(data), "sha256": hashlib.sha256(data).hexdigest(), "mime": package.MIMES[extension]}
            if member not in written:
                archive.writestr(member, data)
                written.add(member)
        archive.writestr("manifest.json", storage.encode({"format": "content-package", "version": 1,
                            "category_name": "当前作者分组", "files": files, "resources": mapping}))
    return output.getvalue()


class CompatibilityTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="fan-compatibility-")
        self.data = Path(self.temporary.name)
        self.app = fan_app.create_app(self.data)
        self.app.config["TESTING"] = True
        self.client = self.app.test_client()
        self.token = self.app.extensions["csrf_token"]
        self.item = {"id": "script-current", "title": "当前作者配色条目", "category_id": "cat-main",
                     "author": "作者", "tags": ["双人"], "role_colors": {"甲": "#AB2255", "乙": "#2244AA"},
                     "source_category": "PPT 原分组", "source_pages": [5],
                     "blocks": [{"id": "original-block", "kind": "text", "text": "第一句。第二句。", "role": "甲", "color": "#343b37",
                                 "source_page": 5, "source_file": "证据.pptx", "original_text": "原始证据文字",
                                 "runs": [{"text": "第一句。", "color": "#aa2255", "bold": True},
                                          {"text": "第二句。", "color": "#2244aa", "bold": False}]},
                                {"id": "other-block", "kind": "text", "text": "另一句。", "role": "乙", "color": "#2244aa"}]}

    def tearDown(self):
        self.temporary.cleanup()

    def write(self, route, payload, expected=200, method="PUT"):
        response = self.client.open(route, method=method, json=payload, headers={"X-CSRF-Token": self.token})
        self.assertEqual(response.status_code, expected, response.get_data(as_text=True))
        return response.get_json()

    def open(self, item=None, assets=None, expected=200):
        response = self.client.post("/api/workspaces", data={"package": (io.BytesIO(package_bytes(item or self.item, assets)), "作者导出.zip")},
                                    headers={"X-CSRF-Token": self.token})
        self.assertEqual(response.status_code, expected, response.get_data(as_text=True))
        result = response.get_json()
        response.close(); response.request.close(); response.request.environ["wsgi.input"].close()
        return result.get("workspace", result)

    def get(self, wsid):
        return self.client.get("/api/workspaces/" + wsid).get_json()["script"]

    def exported(self, wsid):
        response = self.client.post("/api/workspaces/" + wsid + "/export", headers={"X-CSRF-Token": self.token})
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True) if response.status_code != 200 else "")
        try:
            with package._validated(io.BytesIO(response.data)) as validated:
                return copy.deepcopy(validated["script"])
        finally:
            response.close()

    def test_imports_are_project_local_and_new_schema_roundtrips(self):
        for module in (fan_app, package, storage, import_parser):
            self.assertEqual(Path(module.__file__).resolve().parent, FAN)
        self.assertIn("role_colors", package.SCRIPT_FIELDS)
        workspace = self.open(); script = self.get(workspace["id"])
        self.assertEqual(script["role_colors"], {"甲": "#ab2255", "乙": "#2244aa"})
        self.assertEqual(script["blocks"][0]["runs"], self.item["blocks"][0]["runs"])
        self.assertEqual(self.exported(workspace["id"]), script)

    def test_health_identifies_the_absolute_workspace_for_desktop_monitor(self):
        health = self.client.get("/api/health").get_json()
        self.assertTrue(health["ok"])
        self.assertEqual(health["app"], "content-editor")
        self.assertEqual(health["version"], "0.2.1")
        self.assertIsInstance(health["data_dir"], str)
        self.assertEqual(Path(health["data_dir"]), self.data.resolve())
        self.assertTrue(Path(health["data_dir"]).is_absolute())
        # Desktop requestHealth resolves the CLI directory before comparing it.
        equivalent = fan_app.create_app(self.data / ".")
        self.assertEqual(equivalent.test_client().get("/api/health").get_json()["data_dir"], health["data_dir"])

    def test_existing_palette_kept_without_payload_and_editable_when_explicit(self):
        wsid = self.open()["id"]
        self.write("/api/workspaces/" + wsid, {"author": "作者核对"})
        self.assertEqual(self.get(wsid)["role_colors"], {"甲": "#ab2255", "乙": "#2244aa"})
        self.write("/api/workspaces/" + wsid, {"role_colors": {"甲": "#112233"}})
        self.assertEqual(self.exported(wsid)["role_colors"], {"甲": "#112233"})

    def test_palette_validation_matches_anchor_and_old_packages_default_empty(self):
        wsid = self.open()["id"]
        original = self.get(wsid)
        for value in [None, [], {"甲": "red"}, {"": "#123456"}, {"甲": "123456"}, {str(i): "#112233" for i in range(201)}]:
            self.write("/api/workspaces/" + wsid, {"role_colors": value}, expected=400)
            self.assertEqual(self.get(wsid), original)
        legacy = copy.deepcopy(self.item); legacy.pop("role_colors")
        self.assertEqual(self.get(self.open(legacy)["id"])["role_colors"], {})

    def test_save_preserves_source_identity_and_unchanged_runs(self):
        wsid = self.open()["id"]; previous = self.get(wsid)
        blocks = copy.deepcopy(previous["blocks"])
        blocks[0].update(source_file="伪造来源", source_page=777, original_text="伪造原文")
        result = self.write("/api/workspaces/" + wsid, {"id": "changed", "category_id": "changed", "source_pages": [777], "blocks": blocks})["script"]
        self.assertEqual(result, previous)

    def test_editing_text_discards_stale_runs_and_color_change_is_visible(self):
        wsid = self.open()["id"]
        blocks = copy.deepcopy(self.get(wsid)["blocks"]); blocks[0]["color"] = "#CC8833"
        result = self.write("/api/workspaces/" + wsid, {"blocks": blocks})["script"]
        self.assertEqual(result["blocks"][0]["runs"], [{"text": "第一句。第二句。", "color": "#cc8833", "bold": False}])
        blocks = copy.deepcopy(result["blocks"]); blocks[0]["text"] = "作者新台词"
        result = self.write("/api/workspaces/" + wsid, {"blocks": blocks})["script"]
        self.assertNotIn("runs", result["blocks"][0])
        self.assertEqual(result["blocks"][0]["original_text"], "原始证据文字")
        self.assertEqual(self.exported(wsid)["blocks"][0]["text"], "作者新台词")

    def test_create_new_workspace_accepts_palette_and_blank_lines_are_not_paragraphs(self):
        parsed = self.write("/api/import-preview", {"text": "标题：作者新条目\n\n甲：第一句\n\n\n乙：第二句"}, method="POST")
        # The importer retains the source title line as authored content.
        self.assertEqual(len(parsed["candidate"]["blocks"]), 3)
        self.assertTrue(all(block["text"].strip() for block in parsed["candidate"]["blocks"]))
        candidate = parsed["candidate"]
        workspace = self.write("/api/workspaces/new", {"title": candidate["title"], "blocks": candidate["blocks"], "role_colors": {"甲": "#AA3355"}}, 201, "POST")["workspace"]
        self.assertEqual(self.exported(workspace["id"])["role_colors"], {"甲": "#aa3355"})

    def test_media_ids_cue_links_survive_and_referenced_block_deletion_is_rejected(self):
        audio = io.BytesIO()
        with wave.open(audio, "wb") as writer:
            writer.setnchannels(1); writer.setsampwidth(2); writer.setframerate(8000); writer.writeframes(b"\0\0" * 8000)
        raw = audio.getvalue(); digest = hashlib.sha256(raw).hexdigest(); path = "/media/" + digest + ".wav"
        item = copy.deepcopy(self.item)
        item["media"] = {"path": path, "kind": "audio", "name": "配本.wav", "size": len(raw), "sha256": digest, "duration": 1,
                         "cues": [{"id": "existing-cue", "at": 0.2, "label": "暂停", "block_ids": ["original-block"]}]}
        wsid = self.open(item, {path: raw})["id"]
        original = self.get(wsid)
        self.write("/api/workspaces/" + wsid, {"blocks": [original["blocks"][1]]}, expected=400)
        self.assertEqual(self.get(wsid), original)
        exported = self.exported(wsid)
        self.assertEqual(exported["media"], original["media"])
        self.assertEqual(exported["blocks"], original["blocks"])

    def test_invalid_package_palette_is_rejected_before_creating_workspace(self):
        invalid = copy.deepcopy(self.item); invalid["role_colors"] = {"甲": "bad"}
        self.open(invalid, expected=400)
        self.assertEqual(self.client.get("/api/workspaces").get_json()["workspaces"], [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
