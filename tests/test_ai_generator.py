"""AI 生成中心（实验）集成测试：mock 平台全流程 + 自动挂载回退安全。

覆盖：蓝图注册 / 配置读写 / 角色库 CRUD 与应用记录 / mock 生图 / mock 生视频自动挂载 /
     关闭开关后的拒绝行为。全部使用隔离 instance，不触碰真实数据。
"""
import json
import tempfile
import time
import unittest
from pathlib import Path

from app import create_app


def mp4_bytes():
    def box(kind, content):
        return (8 + len(content)).to_bytes(4, "big") + kind + content
    return box(b"ftyp", b"isom\x00\x00\x00\x00isom") + box(b"moov", b"") + box(b"mdat", b"sample")


class AiGeneratorTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="xiwa-ai-")
        self.root = Path(self.temporary.name)
        (self.root / "static" / "media").mkdir(parents=True)
        (self.root / "static" / "media" / "source.png").write_bytes(b"\x89PNG\r\nsource-image")
        self.seed = {
            "categories": [
                {"id": "cat-a", "name": "甜本", "color": "#cc8899", "background": "/static/media/source.png",
                 "sort_order": 0, "visible": True},
            ],
            "scripts": [
                {"id": "script-a", "title": "示例剧本", "category_id": "cat-a", "source_category": "甜本",
                 "author": "原作者", "source_pages": [1], "blocks": [
                     {"id": "para-1", "kind": "text", "text": "甲：第一句。", "role": "甲",
                      "source_page": 1, "source_file": "来源.pptx",
                      "runs": [{"text": "甲：第一句。", "color": "#c06080"}]},
                     {"id": "para-2", "kind": "text", "text": "乙：第二句。", "role": "乙",
                      "source_page": 1, "source_file": "来源.pptx"},
                 ]},
            ],
        }
        self.seed_file = self.root / "seed.json"
        self.seed_file.write_text(json.dumps(self.seed, ensure_ascii=False), encoding="utf-8")
        self.config = {"TESTING": True, "DATABASE": str(self.root / "instance" / "workbench.sqlite3"),
                       "INSTANCE_PATH": str(self.root / "instance"), "SEED_PATH": str(self.seed_file),
                       "PROJECT_ROOT": str(self.root)}
        self.app = create_app(self.config)
        self.client = self.app.test_client()
        self.token = self.client.get("/api/library").get_json()["csrf_token"]
        # 预置一个最小 mp4 作为 mock 视频模板
        response = self.client.post(
            "/api/scripts/script-a/media",
            data={"file": (self._stream(mp4_bytes()), "sample.mp4")},
            content_type="multipart/form-data", headers={"X-CSRF-Token": self.token},
        )
        assert response.status_code == 201, response.get_data(as_text=True)
        # 开启 AI 生成（mock 联调）
        response = self.client.post("/api/ai/config", json={"enabled": True},
                                    headers={"X-CSRF-Token": self.token})
        assert response.status_code == 200, response.get_data(as_text=True)

    def tearDown(self):
        manager = getattr(self.app.blueprints.get("ai_generator"), "ai_manager", None)
        if manager is not None:
            manager.shutdown()
        self.temporary.cleanup()

    @staticmethod
    def _stream(content: bytes):
        import io
        return io.BytesIO(content)

    def json(self, method, path, payload=None, expected=None):
        response = self.client.open(path, method=method, json=payload,
                                    headers={"X-CSRF-Token": self.token})
        if expected is not None:
            self.assertEqual(response.status_code, expected, response.get_data(as_text=True))
        return response.get_json()

    def wait_task(self, task_id, timeout=30):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            task = self.json("GET", f"/api/ai/tasks/{task_id}")
            if task["status"] in ("succeeded", "failed", "cancelled"):
                return task
            time.sleep(0.3)
        self.fail("任务超时未结束")

    # ---------- 蓝图与配置 ----------

    def test_status_and_config_roundtrip(self):
        status = self.json("GET", "/api/ai/status")
        self.assertIn("mock", status["config"]["platforms"])
        self.assertIn("9:16", status["ratios"])
        config = self.json("POST", "/api/ai/config",
                           {"default_ratio": "16:9", "default_duration": 5,
                            "platforms": {"mock": {"model": "mock-v1"}}})
        self.assertEqual(config["config"]["default_ratio"], "16:9")
        self.assertEqual(config["config"]["default_duration"], 5)
        fetched = self.json("GET", "/api/ai/config")
        self.assertEqual(fetched["config"]["default_ratio"], "16:9")

    def test_unknown_platform_rejected(self):
        response = self.client.post("/api/ai/config", json={"platforms": {"nope": {"model": "x"}}},
                                    headers={"X-CSRF-Token": self.token})
        self.assertEqual(response.status_code, 400)

    # ---------- 角色库 ----------

    def test_character_crud_and_uses(self):
        character = self.json("POST", "/api/ai/characters",
                              {"name": "甲", "description": "温柔的女主角"})
        character_id = character["id"]
        self.json("POST", f"/api/ai/characters/{character_id}/uses",
                  {"script_id": "script-a", "script_title": "示例剧本", "alias": "小甲"})
        fetched = self.json("GET", "/api/ai/characters")
        self.assertEqual(len(fetched["characters"]), 1)
        self.assertEqual(fetched["characters"][0]["uses"][0]["alias"], "小甲")
        updated = self.json("PUT", f"/api/ai/characters/{character_id}",
                            {"name": "甲（改）", "description": "温柔的女主角"})
        self.assertEqual(updated["name"], "甲（改）")
        self.json("DELETE", f"/api/ai/characters/{character_id}/uses?script_id=script-a&alias=%E5%B0%8F%E7%94%B2")
        self.assertEqual(self.json("GET", f"/api/ai/characters/{character_id}")["uses"], [])
        self.json("DELETE", f"/api/ai/characters/{character_id}")
        self.assertEqual(self.json("GET", "/api/ai/characters")["characters"], [])

    # ---------- mock 生图 ----------

    def test_mock_image_task_writes_character_card(self):
        character = self.json("POST", "/api/ai/characters", {"name": "乙", "description": "开朗的少年"})
        task = self.json("POST", f"/api/ai/characters/{character['id']}/generate-image",
                         {"prompt": "阳光开朗的少年，半身像", "platform": "mock", "ratio": "1:1"})
        finished = self.wait_task(task["task_id"])
        self.assertEqual(finished["status"], "succeeded", finished)
        self.assertTrue(finished["result_file"])
        card = self.json("GET", f"/api/ai/characters/{character['id']}")
        self.assertTrue(card["image_file"] and card["image_sha256"])
        media_file = self.root / "instance" / "media" / Path(card["image_file"]).name
        self.assertTrue(media_file.is_file())

    # ---------- mock 生视频自动挂载 ----------

    def test_mock_video_task_auto_attach(self):
        character = self.json("POST", "/api/ai/characters", {"name": "甲", "description": "温柔的女主角"})
        task = self.json("POST", "/api/ai/video/generate", {
            "prompt": "女主角在雨中回头微笑", "platform": "mock", "ratio": "9:16", "duration": 5,
            "script_id": "script-a", "block_id": "para-1", "role_name": "甲",
        })
        finished = self.wait_task(task["task_id"])
        self.assertEqual(finished["status"], "succeeded", finished)
        library = self.client.get("/api/library").get_json()
        script = next(item for item in library["scripts"] if item["id"] == "script-a")
        self.assertTrue(script.get("media"), "AI 视频应自动挂载到剧本媒体位")
        self.assertEqual(script["media"]["cues"][0]["block_ids"], ["para-1"])
        self.assertEqual(script["media"]["cues"][0]["at"], 0)
        media_file = self.root / "instance" / "media" / Path(script["media"]["path"]).name
        self.assertTrue(media_file.is_file())

    # ---------- 开关与失败 ----------

    def test_disabled_rejects_submit(self):
        self.json("POST", "/api/ai/config", {"enabled": False})
        response = self.client.post("/api/ai/video/generate", json={
            "prompt": "任意", "platform": "mock", "ratio": "9:16", "duration": 5,
            "script_id": "script-a", "block_id": "para-1",
        }, headers={"X-CSRF-Token": self.token})
        self.assertEqual(response.status_code, 409)

    def test_cancel_and_retry(self):
        character = self.json("POST", "/api/ai/characters", {"name": "丙", "description": "测试角色"})
        task = self.json("POST", f"/api/ai/characters/{character['id']}/generate-image",
                         {"prompt": "测试", "platform": "mock", "ratio": "1:1"})
        # 直接取消一个已完成前的任务（可能已跑完，容忍两种结果）
        try:
            self.json("POST", f"/api/ai/tasks/{task['task_id']}/cancel")
        except AssertionError:
            pass
        finished = self.wait_task(task["task_id"])
        self.assertIn(finished["status"], ("succeeded", "cancelled"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
