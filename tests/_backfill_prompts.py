# -*- coding: utf-8 -*-
"""回填历史产物的提示词：用户确认 byte_90e614e5 / byte_957a53 / byte_176189435b
三个视频的提示词均为「夜晚的江南古镇…」。同时检查并报告其余产物的 meta 完整度。"""
import json
from pathlib import Path

OUT = Path(r"C:\Users\Lu\Documents\ChatGPT\选本网页\instance\ai_output")

JIANGNAN_PROMPT = (
    "夜晚的江南古镇，细雨绵绵。女主撑着一把油纸伞站在石桥上，青丝微湿，回眸望向桥下缓缓划过的乌篷船，"
    "眼神温柔带一丝忧伤。镜头缓慢推进，前景雨丝清晰可见，暖黄灯笼光晕映在青石板上。"
    "电影感画面，柔和光线，细节丰富，人物特写。"
)

BACKFILL = {
    "byte_90e614e5bd714c15b05e01b71ee22b35": JIANGNAN_PROMPT,
    "byte_957a53c031d94e079e103cfa7bb8607d": JIANGNAN_PROMPT,
    "byte_176189435bee4e9590f88f2b40830fb2": JIANGNAN_PROMPT,
}

done = 0
for kind in ("video", "image"):
    kind_dir = OUT / kind
    if not kind_dir.is_dir():
        continue
    for folder in sorted(kind_dir.iterdir()):
        if not folder.is_dir():
            continue
        meta_file = folder / "meta.json"
        if not meta_file.is_file():
            print(f"[缺失 meta] {kind}/{folder.name}")
            continue
        meta = json.loads(meta_file.read_text(encoding="utf-8"))
        prompt = (meta.get("prompt") or "").strip()
        if not prompt:
            print(f"[无提示词] {kind}/{folder.name} -> ", end="")
            if folder.name in BACKFILL:
                meta["prompt"] = BACKFILL[folder.name]
                meta_file.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
                done += 1
                print("已回填（用户确认提示词）")
            else:
                print("无来源，保持原样")

print(f"回填完成: {done} 个")
