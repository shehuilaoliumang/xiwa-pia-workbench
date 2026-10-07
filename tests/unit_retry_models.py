# -*- coding: utf-8 -*-
"""单元测试：模型不可用时自动切换下一个模型并记住可用模型（不调真实 API）"""
import json
import os
import sys
import tempfile
import threading
from pathlib import Path

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, root)

from ai_generator import base
from ai_generator.base import AiError
from ai_generator.tasks import TaskManager

results = []

# 构造临时数据目录
tmp = Path(tempfile.mkdtemp(prefix="ai_retry_"))
db = tmp / "ai_generator.sqlite3"
media = tmp / "media"
media.mkdir(parents=True, exist_ok=True)
out = tmp / "ai_output"
out.mkdir(parents=True, exist_ok=True)

base.initialize_database(db)
# 写入测试配置：平台 byte，video 模型列表 3 个，保存的默认模型 = 不可用的 bad-model
config = {
    "enabled": True,
    "platforms": {
        "byte": {
            "api_key": "test-key",
            "endpoint": "https://ark.cn-beijing.volces.com/api/v3/",
            "model": "bad-model",
            "models": {
                "video": {"bad-model": "坏模型", "good-model": "好模型", "another-model": "另一个模型"},
                "image": {"img-bad": "图坏", "img-good": "图好"},
            },
        }
    }
}
base.save_config(db, config)

manager = TaskManager(db, media, out, store=None)

# 假适配器：bad-model 抛 ModelNotOpen；good-model 成功；another-model 抛 InvalidEndpointOrModel
class FakeAdapter:
    def __init__(self, model=""):
        self.model = model

    def generate_video(self, *a, **kw):
        if self.model == "bad-model":
            raise AiError("ModelNotOpen: account has not activated the model bad-model. Please activate in the Ark Console.")
        if self.model == "another-model":
            raise AiError("InvalidEndpointOrModel.NotFound: the model another-model does not exist")
        out_file = out / (self.model + ".mp4")
        out_file.write_bytes(b"fake-video")
        return out_file

manager._adapter = lambda platform, model: FakeAdapter(model)  # type: ignore[method-assign]

# 提交一个视频任务（model 空 → 走模型尝试序列）
task = manager.submit_video("测试提示词", "byte", "", "9:16", 5, None, None, None)
results.append("提交: " + task["task_id"] + " status=" + task["status"])

# 同步驱动 worker
manager.start()
for _ in range(50):
    t = manager.get_task(task["task_id"])
    if t["status"] in ("succeeded", "failed", "cancelled"):
        break
    threading.Event().wait(0.1)
manager.stop()

final = manager.get_task(task["task_id"])
results.append("最终状态: " + final["status"] + " | 错误: " + str(final.get("error") or "无"))
results.append("result_file: " + str(final.get("result_file") or "").split("/")[-1])

# 验证 config.model 已被记住为可用模型
saved = base.load_config(db)["platforms"]["byte"]
results.append("记住的默认模型: " + saved.get("model", ""))

# 再测：全不可用 → 报错列出尝试的模型
manager2 = TaskManager(db, media, out, store=None)
class FakeAdapter2:
    def __init__(self, model=""):
        self.model = model

    def generate_video(self, *a, **kw):
        raise AiError("InvalidEndpointOrModel: " + self.model + " does not exist")

manager2._adapter = lambda platform, model: FakeAdapter2(model)  # type: ignore[method-assign]
task2 = manager2.submit_video("测试2", "byte", "", "9:16", 5, None, None, None)
manager2.start()
for _ in range(50):
    t = manager2.get_task(task2["task_id"])
    if t["status"] in ("succeeded", "failed", "cancelled"):
        break
    threading.Event().wait(0.1)
manager2.stop()
final2 = manager2.get_task(task2["task_id"])
results.append("全失败状态: " + final2["status"])
results.append("全失败错误(含尝试模型): " + str(final2.get("error") or "")[-90:])

with open(os.path.join(root, "tests", "_adapter_result.txt"), "w", encoding="utf-8") as f:
    f.write("\n".join(results))
print("done")
