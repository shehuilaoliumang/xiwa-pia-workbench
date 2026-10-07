# -*- coding: utf-8 -*-
"""Mock 全流程测试：音乐(audio) + 配音(voice) 生成 → 归档 ai_output/audio|voice/<stem>/ 产物+meta.json
用法：固定 python tests\_verify_audio_voice.py  （需要 instance/media 有音频模板）"""
import os
import shutil
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from ai_generator.tasks import TaskManager

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "instance", "ai_output")


def run_submit(kind, prompt, voice_type=""):
    mgr = TaskManager(os.path.join(ROOT, "instance", "ai_generator.sqlite3"),
                      os.path.join(ROOT, "instance", "media"),
                      os.path.join(ROOT, "instance", "ai_output"))
    if kind == "audio":
        task = mgr.submit_audio(prompt=prompt, platform="mock", model="", script_id="", block_id="", role_name="")
    else:
        task = mgr.submit_voice(text=prompt, platform="mock", model="", voice_type=voice_type,
                                script_id="", block_id="", role_name="")
    tid = task["task_id"]
    for _ in range(40):
        state = mgr.get_task(tid)
        if state["status"] in ("succeeded", "failed", "cancelled"):
            return state
        time.sleep(1)
    return mgr.get_task(tid)


def check(kind):
    d = os.path.join(OUT, kind)
    if not os.path.isdir(d):
        return False, "no dir " + d
    for name in sorted(os.listdir(d)):
        p = os.path.join(d, name)
        if not os.path.isdir(p):
            continue
        files = os.listdir(p)
        media = [f for f in files if not f.endswith(".json")]
        meta = os.path.join(p, "meta.json")
        if media and os.path.isfile(meta):
            return True, os.path.join(kind, name, media[0])
    return False, "no archived item in " + d


def main():
    print("== audio (music) ==")
    audio_state = run_submit("audio", "雨夜忧伤的钢琴背景音乐 节奏舒缓 带雨声氛围")
    print("status:", audio_state["status"], "| kind:", audio_state.get("kind"))
    ok, info = check("audio")
    print("archive:", ok, "->", info)
    print("== voice (tts) ==")
    voice_state = run_submit("voice", "夜色渐深，古镇的石桥上只剩下她一个人。", voice_type="zh_female_wanqu")
    print("status:", voice_state["status"], "| kind:", voice_state.get("kind"), "| voice_type:", voice_state.get("voice_type"))
    ok2, info2 = check("voice")
    print("archive:", ok2, "->", info2)
    # meta 内容抽查
    import json
    for kind in ("audio", "voice"):
        d = os.path.join(OUT, kind)
        if not os.path.isdir(d):
            continue
        for name in sorted(os.listdir(d)):
            p = os.path.join(d, name)
            if os.path.isdir(p) and os.path.isfile(os.path.join(p, "meta.json")):
                with open(os.path.join(p, "meta.json"), encoding="utf-8") as f:
                    meta = json.load(f)
                print(kind, "meta keys:", sorted(meta.keys()))
                break
    print("PASS" if (ok and ok2) else "FAIL")


if __name__ == "__main__":
    main()
