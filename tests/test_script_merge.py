"""Import decisions, role palettes and draft previews use temporary libraries."""
import copy
import hashlib
import io
import json
import unittest
from pathlib import Path
from unittest.mock import patch

import test_script_packages as fixtures
from storage import DomainError, normalize_script


class ScriptMergeTests(unittest.TestCase):
    setUp = fixtures.ScriptPackageTests.setUp
    tearDown = fixtures.ScriptPackageTests.tearDown
    make_app = fixtures.ScriptPackageTests.make_app
    write = fixtures.ScriptPackageTests.write
    upload = fixtures.ScriptPackageTests.upload
    media = fixtures.ScriptPackageTests.media
    export = fixtures.ScriptPackageTests.export
    preview = fixtures.ScriptPackageTests.preview
    do_import = fixtures.ScriptPackageTests.do_import
    frozen = fixtures.ScriptPackageTests.frozen
    unpack = fixtures.ScriptPackageTests.unpack
    repack = fixtures.ScriptPackageTests.repack
    changed_script = fixtures.ScriptPackageTests.changed_script

    def merge_preview(self, content, app=None, expected=200):
        app = app or self.app
        return self.upload(app.test_client(), app.extensions["csrf_token"], "/api/library-merge/preview", content, expected=expected)

    def merge(self, content, decisions, app=None, expected=200, checksum=None):
        app = app or self.app
        return self.upload(app.test_client(), app.extensions["csrf_token"], "/api/library-merge/import", content,
                           {"expected_sha256": checksum or hashlib.sha256(content).hexdigest(), "decisions": json.dumps(decisions)}, expected)

    def test_duplicate_ignores_ids_source_metadata_asset_paths_and_category(self):
        self.media()
        content = self.export()
        def change(item):
            item["id"] = "different-script"
            item["category_id"] = "other-category"
            item["source_category"] = "新机器资料目录"
            item["source_pages"] = [999]
            ids = {block["id"]: "different-" + block["id"] for block in item["blocks"]}
            for block in item["blocks"]:
                block.update(id=ids[block["id"]], source_file="C:/another/copy.pptx", source_page=999, original_text="不同的证据原文")
            for cue in item["media"]["cues"]:
                cue["id"] = "different-" + cue["id"]
                cue["block_ids"] = [ids[old] for old in cue["block_ids"]]
        content = self.changed_script(content, change)
        before = self.frozen()
        preview = self.preview(content)
        self.assertEqual(preview["status"], "duplicate")
        self.assertTrue(preview["matches"][0]["identical"])
        result = self.do_import(content)
        self.assertEqual((result["action"], result["reason"]), ("skip", "duplicate"))
        self.assertEqual(self.frozen(), before)

    def test_default_skip_and_explicit_new_conflict_cannot_duplicate(self):
        content = self.changed_script(self.export(), lambda script: script.update(author="新作者"))
        before = self.frozen()
        self.assertEqual(self.preview(content)["status"], "conflict")
        self.assertTrue(self.do_import(content, action="skip")["skipped"])
        self.do_import(content, expected=409)
        self.assertEqual(self.frozen(), before)

    def test_overwrite_preserves_id_queue_frozen_live_and_history(self):
        self.media()
        self.write("/api/queue", {"script_ids": ["script-a"]}, "PUT")
        self.write("/api/apply", {"mode": "script", "script_id": "script-a", "layout": {"body_mode": "pages"}})
        before = self.frozen()
        content = self.changed_script(self.export(), lambda script: script.update(author="新作者", role_colors={"甲": "#AA2255"}))
        candidate = self.preview(content)["matches"][0]
        result = self.do_import(content, action="overwrite", target_id="script-a", expected_target_fingerprint=candidate["fingerprint"])
        self.assertEqual(result["script"]["id"], "script-a")
        self.assertTrue(result["overwritten"])
        self.assertEqual(result["script"]["role_colors"], {"甲": "#aa2255"})
        after = self.frozen()
        self.assertEqual(after["data"]["settings"], before["data"]["settings"])
        self.assertEqual(len(after["data"]["history"]), len(before["data"]["history"]) + 1)
        self.assertEqual(after["data"]["history"][-1]["script"], before["data"]["scripts"][0])
        old_id = after["data"]["history"][-1]["id"]
        recovered = self.write(f"/api/scripts/script-a/history/{old_id}/restore", {})
        self.assertEqual(recovered, before["data"]["scripts"][0])
        self.assertEqual(self.frozen()["data"]["settings"], before["data"]["settings"])

    def test_overwrite_stale_or_wrong_target_has_no_writes(self):
        content = self.changed_script(self.export(), lambda script: script.update(author="包作者"))
        fingerprint = self.preview(content)["matches"][0]["fingerprint"]
        self.write("/api/scripts/script-a", {"notes": "预览后他人修改"}, "PATCH")
        before = self.frozen()
        result = self.do_import(content, expected=409, action="overwrite", target_id="script-a", expected_target_fingerprint=fingerprint)
        self.assertEqual(result["code"], "import_target_changed")
        self.assertEqual(self.frozen(), before)

    def test_legacy_row_without_palette_has_consistent_preview_fingerprint(self):
        with self.store.transaction(write=True) as connection:
            old = self.store._get(connection, "scripts", "script-a")
            old.pop("role_colors", None)
            connection.execute("UPDATE scripts SET data=? WHERE id=?", (json.dumps(old), "script-a"))
        content = self.changed_script(self.export(), lambda script: script.update(author="包作者"))
        fingerprint = self.preview(content)["matches"][0]["fingerprint"]
        result = self.do_import(content, action="overwrite", target_id="script-a", expected_target_fingerprint=fingerprint)
        self.assertTrue(result["overwritten"])
        self.assertEqual(result["script"]["author"], "包作者")

    def test_preview_lists_every_same_name_candidate(self):
        original = self.store.library()["scripts"][0]
        duplicate = copy.deepcopy(original); duplicate["id"] = "second-same-name"; duplicate["author"] = "另一个作者"
        self.store.save_script(duplicate)
        content = self.changed_script(self.export(), lambda script: script.update(author="第三个作者"))
        preview = self.preview(content)
        self.assertEqual(preview["status"], "conflict")
        self.assertEqual({match["id"] for match in preview["matches"]}, {"script-a", "second-same-name"})
        self.assertTrue(all({"field": "author", "label": "作者"} in match["changes"] for match in preview["matches"]))

    def test_batch_new_duplicate_conflict_only_updates_selected_documents(self):
        self.media()
        self.store.save_script({"id": "new-one", "title": "全新剧本", "category_id": "cat-a", "blocks": []})
        content = self.store.backup()
        target = self.make_app(self.root / "merge target")
        target_store = target.extensions["store"]
        archive = self.export()
        original = self.do_import(archive, "cat-target", app=target)["script"]
        target_store.save_script({"author": "本地手改"}, original["id"])
        before = self.frozen(target_store)
        preview = self.merge_preview(content, target)
        self.assertEqual([item["status"] for item in preview["items"]], ["conflict", "new"])
        self.assertEqual(self.frozen(target_store), before)
        match = preview["items"][0]["matches"][0]
        decisions = [{"source_id": "script-a", "action": "overwrite", "category_id": "cat-target",
                      "target_id": original["id"], "expected_target_fingerprint": match["fingerprint"]},
                     {"source_id": "new-one", "action": "new", "category_id": "cat-target"}]
        result = self.merge(content, decisions, target)
        self.assertEqual((result["added"], result["overwritten"], result["skipped"]), (1, 1, 0))
        after = self.frozen(target_store)
        self.assertEqual(after["data"]["settings"], before["data"]["settings"])
        self.assertEqual(after["data"]["categories"], before["data"]["categories"])
        repeated = self.merge(content, decisions, target)
        self.assertEqual((repeated["added"], repeated["overwritten"], repeated["skipped"]), (0, 0, 2))
        self.assertEqual(self.frozen(target_store), after)

    def test_batch_late_error_rolls_back_database_and_created_assets(self):
        self.media()
        self.store.save_script({"id": "late-one", "title": "第二篇", "category_id": "cat-a", "blocks": []})
        content = self.store.backup()
        target = self.make_app(self.root / "rollback merge target")
        before = self.frozen(target.extensions["store"])
        self.merge(content, [{"source_id": "script-a", "action": "new", "category_id": "cat-target"},
                             {"source_id": "late-one", "action": "new", "category_id": "missing"}], target, 404)
        self.assertEqual(self.frozen(target.extensions["store"]), before)

    def test_incoming_same_names_default_later_skip_and_double_new_rolls_back(self):
        original = self.store.library()["scripts"][0]
        other = copy.deepcopy(original); other.update(id="same-name-in-backup", author="另一版")
        self.store.save_script(other)
        content = self.store.backup()
        target = self.make_app(self.root / "same name merge target")
        before = self.frozen(target.extensions["store"])
        preview = self.merge_preview(content, target)
        self.assertEqual([item["default_action"] for item in preview["items"]], ["new", "skip"])
        self.merge(content, [{"source_id": item["source_id"], "action": "new", "category_id": "cat-target"}
                             for item in preview["items"]], target, 409)
        self.assertEqual(self.frozen(target.extensions["store"]), before)

    def test_batch_decisions_and_zip_validation_are_required(self):
        content = self.store.backup(); before = self.frozen()
        for decisions in [None, [], [{"source_id": "wrong", "action": "skip"}], [{"source_id": "script-a", "action": "unknown"}]]:
            self.merge(content, decisions, expected=400)
        self.merge_preview(self.export(), expected=400)
        self.merge(content, [{"source_id": "script-a", "action": "skip"}], expected=409, checksum="0" * 64)
        self.assertEqual(self.frozen(), before)

    def test_role_colors_normalize_backup_and_packages_keep_palette(self):
        for invalid in [None, [], {"甲": "red"}, {"甲": None}, {"甲": "112233"}, {"": "#112233"}]:
            with self.subTest(invalid=invalid), self.assertRaises(DomainError):
                normalize_script({"title": "色卡", "role_colors": invalid})
        self.write("/api/scripts/script-a", {"role_colors": {"甲": "#ABCDEF"}}, "PATCH")
        self.assertEqual(self.preview(self.export())["script"]["role_colors"], {"甲": "#abcdef"})
        target = self.make_app(self.root / "palette restore")
        target.extensions["store"].restore(io.BytesIO(self.store.backup()))
        self.assertEqual(target.extensions["store"].library()["scripts"][0]["role_colors"], {"甲": "#abcdef"})

    def test_editor_preview_is_readonly_preserves_source_and_no_apply_token(self):
        before = self.frozen()
        draft = copy.deepcopy(self.store.library()["scripts"][0])
        draft["blocks"][0].update(text="本地尚未保存", source_file="伪造来源")
        draft["blocks"][1]["text"] = "图片说明"
        result = self.write("/api/editor-preview", {"script_id": "script-a", "draft": draft, "orientation": "landscape", "body_mode": "scroll"})
        snapshot = result["snapshot"]
        self.assertEqual(snapshot["scripts"][0]["blocks"][0]["text"], "本地尚未保存")
        self.assertEqual(snapshot["scripts"][0]["blocks"][0]["source_file"], "原稿.pptx")
        self.assertNotIn("runs", snapshot["scripts"][0]["blocks"][0])
        self.assertNotIn("content_token", snapshot)
        self.assertEqual(self.frozen(), before)
        empty = self.write("/api/editor-preview", {"draft": {"title": "", "category_id": "cat-a", "blocks": []}})
        self.assertEqual(empty["snapshot"]["scripts"][0]["title"], "未命名剧本")
        self.assertEqual(self.frozen(), before)
        for change in [{"script_id": []}, {"script_id": 0}, {"orientation": []}, {"body_mode": "media"}, {"draft": None}]:
            self.write("/api/editor-preview", {"draft": draft, **change}, expected=400)
        self.assertEqual(self.frozen(), before)

    def test_history_restore_missing_assets_rolls_back_and_deleted_category_falls_back(self):
        self.write("/api/scripts/script-a", {"author": "新版"}, "PATCH")
        history_id = self.store.history("script-a")[0]["id"]
        self.store.delete_category("cat-a", "cat-b")
        restored = self.write(f"/api/scripts/script-a/history/{history_id}/restore", {})
        self.assertEqual(restored["category_id"], "uncategorized")
        (self.root / "static/media/source.jpeg").unlink()
        before = self.frozen()
        self.write(f"/api/scripts/script-a/history/{history_id}/restore", {}, expected=400)
        self.assertEqual(self.frozen(), before)


if __name__ == "__main__":
    unittest.main()
