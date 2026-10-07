# -*- coding: utf-8 -*-
"""验证 AI 生成视频 -> upload_block_media -> insert_block_media 插入正确位置（目标段落后方）。
插入后立即删除回滚，不污染剧本数据。"""
import sys
from pathlib import Path

sys.path.insert(0, r".")
import storage as storage_mod

ROOT = Path(r"C:\Users\Lu\Documents\ChatGPT\选本网页")
store = storage_mod.Store(
    database=ROOT / "instance" / "workbench.sqlite3",
    seed_path=ROOT / "seed.json",
    project_root=ROOT,
)

# 剧本 script-08（爱情公寓，有媒体配本）
lib = store.library()
script = next(s for s in lib["scripts"] if s["id"] == "script-08")
blocks = script.get("blocks", [])
text_blocks = [b for b in blocks if b["kind"] == "text"]
print("script-08 blocks:", len(blocks), "文字段落:", len(text_blocks))
if not text_blocks:
    print("FAIL: 无文字段落")
    sys.exit(1)
target = text_blocks[0]
target_index = blocks.index(target)
print("目标段落:", target["id"], "位于 index", target_index, "text:", (target.get("text") or "")[:20])

# 用刚才真实生成的视频
video = ROOT / "instance" / "ai_output" / "byte_90e614e5bd714c15b05e01b71ee22b35.mp4"
assert video.is_file(), "视频文件不存在"
with video.open("rb") as stream:
    asset = store.upload_block_media(stream, "AI验证_插入测试.mp4")
print("asset:", asset.get("kind"), asset.get("size"))

# 插入到目标段落之后
updated = store.insert_block_media("script-08", target["id"], asset, source="AI 验证")
new_blocks = updated.get("blocks", [])
new_index = next((i for i, b in enumerate(new_blocks) if b.get("media_path") == asset["path"]), None)
print("插入后新视频段落 index:", new_index, "（期望", target_index + 1, "）")
assert new_index == target_index + 1, "插入位置不对！"
assert new_blocks[new_index]["kind"] == "video"
print("PASS: 视频段落已插入目标段落后方（index", new_index, "），kind =", new_blocks[new_index]["kind"])

# 回滚：删除插入的段落
store.delete_block_media("script-08", new_blocks[new_index]["id"])
after = store.library()
script_after = next(s for s in after["scripts"] if s["id"] == "script-08")
assert len(script_after.get("blocks", [])) == len(blocks), "回滚失败，blocks 数量变化"
print("PASS: 已回滚，剧本恢复原状（blocks =", len(script_after.get("blocks", [])), "）")
