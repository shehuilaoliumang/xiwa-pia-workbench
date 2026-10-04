"""阿里（通义万相 / DashScope）平台适配器。

真实联调骨架：封装 HTTP 提交与轮询；未配置 api_key 时明确报错。
接入时按 DashScope 异步任务接口补齐鉴权与结果解析。
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Optional

from .base import AiError


class AliAdapter:
    name = "ali"
    display = "阿里 · 通义万相"
    models = {"wanx2.1-t2v-turbo": "万相 2.1 文生视频", "wanx2.1-i2v-turbo": "万相 2.1 图生视频"}

    def __init__(self, output_dir: Path, model: str = "wanx2.1-t2v-turbo",
                 api_key: str = "", endpoint: str = "https://dashscope.aliyuncs.com/api/v1/"):
        self.output_dir = output_dir
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.model = model or "wanx2.1-t2v-turbo"
        self.api_key = (api_key or "").strip()
        self.endpoint = (endpoint or "https://dashscope.aliyuncs.com/api/v1/").rstrip("/") + "/"

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

    def _download(self, url: str, suffix: str) -> Path:
        target = self.output_dir / f"ali_{uuid.uuid4().hex}{suffix}"
        request = urllib.request.Request(url)
        try:
            with urllib.request.urlopen(request, timeout=120) as response, target.open("wb") as output:
                while chunk := response.read(1024 * 1024):
                    output.write(chunk)
        except (urllib.error.URLError, TimeoutError) as error:
            raise AiError(f"下载生成结果失败：{error}", 502, "provider_error") from error
        return target

    def generate_image(self, prompt: str, ratio: str, role_name: str = "", progress=None) -> Path:
        self._require_key()
        # 通义万相文生图（model 需为图像生成模型，接入时按所选模型调整）
        payload = {"model": self.model, "input": {"prompt": prompt}, "parameters": {"size": ratio}}
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
                    return self._download(results, ".mp4")
                raise AiError("阿里平台未返回视频地址。", 502, "provider_error")
            if status in ("failed", "error", "canceled"):
                raise AiError(f"阿里平台生成失败：{output.get('message') or '未知原因'}", 502, "provider_error")
            if progress is not None:
                progress(95)
            time.sleep(5)
        raise AiError("阿里平台生成超时。", 504, "provider_timeout")
