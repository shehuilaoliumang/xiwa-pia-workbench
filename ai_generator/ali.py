"""阿里（通义万相 / DashScope / 百炼）平台适配器。

真实联调骨架：封装 HTTP 提交与轮询；未配置 api_key 时明确报错。
- 视频/图片：DashScope 旧端点（dashscope.aliyuncs.com/api/v1），同一 api_key。
- 音乐（fun-music）/ 配音（qwen-tts）：百炼新版 maas 端点
  https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/services/...，
  需要「业务空间 ID（workspace_id）」拼接域名。
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Optional

from .base import AiError, detect_image_ext


class AliAdapter:
    name = "ali"
    display = "阿里 · 通义万相"
    models = {
        "wanx2.1-t2v-turbo": "万相 2.1 文生视频",
        "wanx2.1-i2v-turbo": "万相 2.1 图生视频",
        "wan2.2-t2v-plus": "万相 2.2 Plus 文生视频",
    }
    image_models = {
        "wanx2.1-imageplus": "通义万相 2.1 图像 Plus（角色卡，同一 Key）",
        "wanx-v1": "通义万相文生图（角色卡）",
    }
    audio_models = {
        "fun-music-v1": "Fun-Music 音乐生成（纯音乐/歌曲）",
    }
    voice_models = {
        "qwen-audio-3.1-tts-next": "Qwen-Audio TTS 语音合成（配音）",
        "qwen-audio-3.0-tts-plus": "Qwen-Audio 3.0 TTS Plus（配音）",
    }

    def __init__(self, output_dir: Path, model: str = "wanx2.1-t2v-turbo",
                 api_key: str = "", endpoint: str = "https://dashscope.aliyuncs.com/api/v1/",
                 image_model: str = "", audio_model: str = "fun-music-v1",
                 voice_model: str = "qwen-audio-3.1-tts-next", workspace_id: str = ""):
        self.output_dir = output_dir
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.model = model or "wanx2.1-t2v-turbo"
        self.api_key = (api_key or "").strip()
        self.endpoint = (endpoint or "https://dashscope.aliyuncs.com/api/v1/").rstrip("/") + "/"
        self.image_model = (image_model or "").strip()
        self.audio_model = (audio_model or "fun-music-v1").strip()
        self.voice_model = (voice_model or "qwen-audio-3.1-tts-next").strip()
        self.workspace_id = (workspace_id or "").strip()

    def _require_key(self):
        if not self.api_key:
            raise AiError(
                "阿里平台未配置 API Key：请到「AI 生成设置」填写百炼/DashScope 的 api_key 后再试。",
                409, "api_key_missing",
            )

    def _request(self, path: str, payload: dict, timeout: int = 30) -> dict:
        body = json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(
            self.endpoint + path, data=body, method="POST",
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {self.api_key}"},
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")[:500]
            raise AiError(f"阿里平台请求失败（{error.code}）：{detail}", 502, "provider_error") from error
        except (urllib.error.URLError, TimeoutError) as error:
            raise AiError(f"阿里平台无法连接：{error}", 502, "provider_unreachable") from error

    def _poll_task(self, task_id: str) -> dict:
        request = urllib.request.Request(
            self.endpoint + f"async-tasks/{task_id}",
            headers={"Authorization": f"Bearer {self.api_key}"},
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")[:500]
            raise AiError(f"阿里平台轮询失败（{error.code}）：{detail}", 502, "provider_error") from error
        except (urllib.error.URLError, TimeoutError) as error:
            raise AiError(f"阿里平台无法连接：{error}", 502, "provider_unreachable") from error

    def _download(self, url: str, suffix: str, fix_image: bool = True) -> Path:
        target = self.output_dir / f"ali_{uuid.uuid4().hex}{suffix}"
        request = urllib.request.Request(url)
        try:
            with urllib.request.urlopen(request, timeout=120) as response, target.open("wb") as output:
                while chunk := response.read(1024 * 1024):
                    output.write(chunk)
        except (urllib.error.URLError, TimeoutError) as error:
            raise AiError(f"下载生成结果失败：{error}", 502, "provider_error") from error
        # 仅图片做「真实文件头修正扩展名」；视频扩展名由调用方确定，禁止走图片识别
        # （否则 mp4 文件头不匹配图片 magic 会被回退成 .png，导致产物被误分类为图片）。
        if not fix_image:
            return target
        try:
            real = detect_image_ext(target.read_bytes()[:16])
            if target.suffix.lower() != real:
                fixed = target.with_suffix(real)
                target.rename(fixed)
                return fixed
        except OSError:
            pass
        return target

    def test_connection(self) -> dict:
        """轻量验证：调用 OpenAI 兼容模型列表接口，不产生任何生成费用。"""
        if not self.api_key:
            return {"ok": False, "message": "尚未填写 API Key，请先到「AI 生成设置」获取并填写百炼/DashScope api_key。"}
        # DashScope OpenAI 兼容端点：/compatible-mode/v1/models
        compatible = self.endpoint.replace("/api/v1/", "/compatible-mode/v1/")
        request = urllib.request.Request(
            compatible + "models",
            headers={"Authorization": f"Bearer {self.api_key}"},
        )
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                payload = json.loads(response.read().decode("utf-8"))
            models = payload.get("data") or []
            return {"ok": True, "message": f"连接成功：阿里百炼可用（模型列表 {len(models)} 项）。",
                    "detail": f"HTTP {response.status}"}
        except urllib.error.HTTPError as error:
            body = error.read().decode("utf-8", errors="replace")[:300]
            if error.code == 401:
                return {"ok": False, "message": "API Key 无效或已过期，请检查是否复制完整、前后无空格。",
                        "detail": f"HTTP {error.code} {body}"}
            if error.code == 403:
                return {"ok": False, "message": "账号权限不足：请确认已在阿里云百炼开通通义万相/大模型服务。",
                        "detail": f"HTTP {error.code} {body}"}
            return {"ok": False, "message": f"请求失败（HTTP {error.code}），请检查网络与密钥。",
                    "detail": f"{body}"}
        except (urllib.error.URLError, TimeoutError) as error:
            return {"ok": False, "message": "无法连接阿里百炼，请检查网络（或代理）后重试。",
                    "detail": str(error)}

    def list_models(self, api_key: str = "") -> Optional[dict]:
        """查询百炼账号当前可用模型，返回 {video:{id:label}, image:{id:label}}；失败返回 None（调用方降级内置列表）。"""
        key = (api_key or self.api_key or "").strip()
        if not key:
            return None
        compatible = self.endpoint.replace("/api/v1/", "/compatible-mode/v1/")
        request = urllib.request.Request(
            compatible + "models",
            headers={"Authorization": f"Bearer {key}"},
        )
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except Exception:
            return None
        video, image = {}, {}
        for item in payload.get("data") or []:
            name = str(item.get("id") or item.get("model_name") or "").strip()
            if not name:
                continue
            lower = name.lower()
            if "t2v" in lower or "i2v" in lower:
                video[name] = name
            elif "image" in lower or "wanx-v" in lower or "flux" in lower or "cogvideox" in lower:
                image[name] = name
        if not video and not image:
            return None
        return {"video": video or None, "image": image or None}

    def generate_image(self, prompt: str, ratio: str, role_name: str = "", progress=None) -> Path:
        self._require_key()
        # 角色形象卡：优先使用密钥查询到的真实可用图像模型（与视频共用同一 api_key）
        image_model = self.image_model or (self.model if self.model in self.image_models else "") \
            or next(iter(self.image_models), "wanx2.1-imageplus")
        payload = {"model": image_model, "input": {"prompt": prompt}, "parameters": {"size": ratio}}
        result = self._request("services/aigc/text2image/image-synthesis", payload)
        task_id = (result.get("output", {}).get("task_id") or "").strip()
        if not task_id:
            raise AiError("阿里平台未返回任务 ID。", 502, "provider_error")
        deadline = time.monotonic() + 600
        while time.monotonic() < deadline:
            poll = self._poll_task(task_id)
            output = poll.get("output", {})
            status = (output.get("task_status") or "").lower()
            if status in ("succeeded", "success"):
                results = output.get("results") or []
                if results and results[0].get("url"):
                    return self._download(results[0]["url"], ".png")
                raise AiError("阿里平台未返回图片地址。", 502, "provider_error")
            if status in ("failed", "error", "canceled"):
                raise AiError(f"阿里平台生成失败：{output.get('message') or '未知原因'}", 502, "provider_error")
            if progress is not None:
                progress(60)
            time.sleep(3)
        raise AiError("阿里平台生成超时。", 504, "provider_timeout")

    def generate_video(self, prompt: str, ratio: str, duration: int,
                       ref_image: Optional[str] = None, role_name: str = "", progress=None) -> Path:
        self._require_key()
        input_payload = {"prompt": prompt}
        if ref_image:
            input_payload["img_url"] = ref_image
        payload = {
            "model": self.model,
            "input": input_payload,
            "parameters": {"size": ratio, "duration": duration},
        }
        result = self._request("services/aigc/video-generation/video-synthesis", payload)
        task_id = (result.get("output", {}).get("task_id") or "").strip()
        if not task_id:
            raise AiError("阿里平台未返回任务 ID。", 502, "provider_error")
        deadline = time.monotonic() + 1800
        while time.monotonic() < deadline:
            poll = self._poll_task(task_id)
            output = poll.get("output", {})
            status = (output.get("task_status") or "").lower()
            if status in ("succeeded", "success"):
                results = output.get("video_url") or (output.get("results") or [{}])[0].get("url", "")
                if results:
                    return self._download(results, ".mp4", fix_image=False)
                raise AiError("阿里平台未返回视频地址。", 502, "provider_error")
            if status in ("failed", "error", "canceled"):
                raise AiError(f"阿里平台生成失败：{output.get('message') or '未知原因'}", 502, "provider_error")
            if progress is not None:
                progress(95)
            time.sleep(5)
        raise AiError("阿里平台生成超时。", 504, "provider_timeout")

    # ---------- 音乐生成（Fun-Music，纯音乐/背景音效） ----------

    def _maas_endpoint(self, service_path: str) -> str:
        """百炼新版业务空间专属端点：https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/services/..."""
        if not self.workspace_id:
            raise AiError(
                "阿里平台未配置「业务空间 ID（WorkspaceId）」：\n"
                "音乐/配音生成走百炼新版专属端点，请登录阿里云百炼控制台 → 工作空间 "
                "找到业务空间 ID，在「AI 生成设置」→ 阿里平台的「业务空间 ID」中填写。",
                409, "workspace_id_missing",
            )
        return f"https://{self.workspace_id}.cn-beijing.maas.aliyuncs.com/api/v1/services/{service_path}"

    def _maas_request(self, service_path: str, payload: dict, timeout: int = 300) -> dict:
        body = json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(
            self._maas_endpoint(service_path), data=body, method="POST",
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {self.api_key}"},
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")[:500]
            raise AiError(f"阿里平台请求失败（{error.code}）：{detail}", 502, "provider_error") from error
        except (urllib.error.URLError, TimeoutError) as error:
            raise AiError(f"阿里平台无法连接：{error}", 502, "provider_unreachable") from error

    def _download_audio(self, url: str) -> Path:
        """下载音频产物：扩展名从 URL 推断（.wav/.mp3/.m4a/.ogg），推断不到默认 .wav。"""
        target = self.output_dir / f"ali_{uuid.uuid4().hex}"
        request = urllib.request.Request(url)
        try:
            with urllib.request.urlopen(request, timeout=180) as response, target.open("wb") as output:
                while chunk := response.read(1024 * 1024):
                    output.write(chunk)
        except (urllib.error.URLError, TimeoutError) as error:
            raise AiError(f"下载生成结果失败：{error}", 502, "provider_error") from error
        path = Path(urllib.parse.urlparse(url).path)
        ext = path.suffix.lower() if path.suffix.lower() in (".wav", ".mp3", ".m4a", ".ogg", ".flac") else ".wav"
        final = target.with_suffix(ext)
        if final != target:
            target.rename(final)
        return final

    def generate_audio(self, prompt: str, ratio: str = "", role_name: str = "", progress=None) -> Path:
        """文生音乐/背景音效：fun-music-v1（纯音乐），同步等待返回音频地址并下载。"""
        self._require_key()
        payload = {"model": self.audio_model, "input": {"prompt": prompt}}
        result = self._maas_request("audio/music/generation", payload)
        url = ((result.get("output") or {}).get("audio") or {}).get("url") or ""
        if not url:
            raise AiError("阿里平台未返回音乐地址。", 502, "provider_error")
        if progress is not None:
            progress(80)
        return self._download_audio(url)

    def generate_voice(self, text: str, voice_type: str = "", ratio: str = "", role_name: str = "", progress=None) -> Path:
        """文本转语音配音：qwen-audio-3.1-tts-next，同步返回音频地址并下载。"""
        self._require_key()
        payload = {
            "model": self.voice_model,
            "input": {"text_prompt": text, "format": "wav", "sample_rate": 48000},
        }
        if voice_type:
            payload["input"]["voice"] = voice_type
        result = self._maas_request("audio/tts/SpeechSynthesizer", payload)
        url = ((result.get("output") or {}).get("audio") or {}).get("url") or ""
        if not url:
            raise AiError("阿里平台未返回配音地址。", 502, "provider_error")
        if progress is not None:
            progress(80)
        return self._download_audio(url)
