# -*- coding: utf-8 -*-
"""API 级验证：媒体剧本 preview -> apply(realtime, media_state) -> liveState 更新。
覆盖「预览媒体交互实时指挥展示」的后端链路（前端 app.js 改动已 node --check + 走查）。
"""
import json
import re
import sys
import urllib.request
import http.cookiejar

BASE = "http://127.0.0.1:8765"
SCRIPT_ID = "script-08"  # 爱情公寓（视频配本）

_cj = http.cookiejar.CookieJar()
_opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(_cj))


def http(path, payload=None, token=None):
    data = None
    headers = {"Content-Type": "application/json"}
    if token:
        headers["X-CSRF-Token"] = token
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(BASE + path, data=data, headers=headers)
    try:
        with _opener.open(req, timeout=15) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        print(f"HTTP {e.code} on {path}: {body[:300]}")
        raise


def main():
    # 1) 取 CSRF token + session cookie
    with _opener.open(BASE + "/control", timeout=15) as resp:
        html = resp.read().decode("utf-8")
    m = re.search(r'name="csrf-token" content="([^"]+)"', html)
    token = m.group(1) if m else ""
    print("csrf token:", token[:12] + "...")

    # 2) 预览媒体剧本（音视频配本布局）
    preview_payload = {
        "mode": "script",
        "script_id": SCRIPT_ID,
        "orientation": "portrait",
        "layout": {"body_mode": "media"},
    }
    snap = http("/api/preview", preview_payload, token)
    if "content_token" not in snap:
        print("FAIL preview:", json.dumps(snap, ensure_ascii=False)[:200])
        return
    print("preview ok: mode=", snap.get("mode"), "layout=", snap.get("layout", {}).get("body_mode"))

    # 3) realtime apply（模拟预览内媒体播放 -> 实时指挥展示）
    apply_payload = {
        **preview_payload,
        "preview_token": snap["content_token"],
        "preview_anchor": None,
        "preview_playing": True,
        "preview_media_state": {"position": 0.0, "playing": True, "caption_index": 0, "cue_id": None},
        "realtime": True,
    }
    state = http("/api/apply", apply_payload, token)
    print("apply ok: revision=", state.get("revision"), "snapshot_id=", str(state.get("snapshot", {}).get("id"))[:16], "...")
    media = state.get("snapshot", {}).get("scripts", [{}])[0].get("media", {}) if state.get("snapshot", {}).get("scripts") else {}
    print("live media:", media.get("kind"), media.get("name"))
    if state.get("media_state"):
        print("live media_state:", json.dumps(state["media_state"], ensure_ascii=False)[:120])

    # 4) 读回 liveState
    live = http("/api/state", None, token)
    live_media = live.get("snapshot", {}).get("scripts", [{}])[0].get("media", {}) if live.get("snapshot", {}).get("scripts") else {}
    print("state media:", live_media.get("kind"), "| playing:", live.get("playing"))
    print("RESULT:", "PASS" if state.get("revision") and live_media.get("kind") == "video" else "CHECK")


if __name__ == "__main__":
    main()
