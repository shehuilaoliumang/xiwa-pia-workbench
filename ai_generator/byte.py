"""字节（豆包 seedance / 火山方舟）平台适配器。

真实联调骨架：封装 HTTP 提交与轮询；未配置 api_key 时明确报错。
当前无 key，仅保证接口契约与错误提示正确，接入方补全后可切换。
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


class ByteAdapter:
    name = "byte"
    display = "字节 · 豆包 seedance"
    models = {"seedance-1.0-pro": "Seedance 1.0 Pro", "seedance-1.0-lite": "Seedance 1.0 Lite"}

    def __init__(self, output_dir: Path, model: str = "seedance-1.0-pro",
                 api_key: str = "", endpoint: str = "https://ark.cn-beijing.volces.com/api/v3/"):
        self.output_dir = output_dir
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.model = model or "seedance-1.0-pro"
        self.api_key = (api_key or "").strip()
        self.endpoint = (endpoint or "https://ark.cn-beijing.volces.com/api/v3/").rstrip("/") + "/"

    def _require_key(self):
        if not self.api_key:
            raise AiError(
                "字节平台未配置 API Key：请到「AI 生成设置」填写火山方舟的 api_key 后再试。",
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
            raise AiError(f"字节平台请求失败（{error.code}）：{detail}", 502, "provider_error") from error
        except (urllib.error.URLError, TimeoutError) as error:
            raise AiError(f"字节平台无法连接：{error}", 502, "provider_unreachable") from error

    def _submit(self, payload: dict) -> str:
        # 火山方舟任务式接口：提交后返回 task id，随后轮询结果
        result = self._request("contents/generations/tasks", payload)
        task_id = (result.get("id") or result.get("task_id") or "").strip()
        if not task_id:
            raise AiError("字节平台未返回任务 ID。", 502, "provider_error")
        return task_id

    def _poll(self, task_id: str) -> dict:
        query = urllib.request.Request(
            self.endpoint + f"contents/generations/tasks/{task_id}",
            headers={"Authorization": f"Bearer {self.api_key}"},
        )
        try:
            with urllib.request.urlopen(query, timeout=30) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")[:500]
            raise AiError(f"字节平台轮询失败（{error.code}）：{detail}", 502, "provider_error") from error
        except (urllib.error.URLError, TimeoutError) as error:
            raise AiError(f"字节平台无法连接：{error}", 502, "provider_unreachable") from error

    def _download(self, url: str, suffix: str) -> Path:
        target = self.output_dir / f"byte_{uuid.uuid4().hex}{suffix}"
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
        # 文生图：seedream / 通用图像生成任务（不同模型端点可能不同，接入时按模型调整）
        payload = {
            "model": self.model,
            "prompt": prompt,
            "size": ratio,
            "response_format": "url",
        }
        task_id = self._submit(payload)
        deadline = time.monotonic() + 600
        while time.monotonic() < deadline:
            result = self._poll(task_id)
            status = (result.get("status") or "").lower()
            if status in ("succeeded", "success", "done"):
                content = (result.get("content") or [{}])[0]
                url = content.get("url") or content.get("image_url") or ""
                if url:
                    return self._download(url, ".png")
                raise AiError("字节平台未返回图片地址。", 502, "provider_error")
            if status in ("failed", "error", "canceled"):
                raise AiError(f"字节平台生成失败：{result.get('error') or '未知原因'}", 502, "provider_error")
            if progress is not None:
                progress(60)
            time.sleep(3)
        raise AiError("字节平台生成超时。", 504, "provider_timeout")

    def generate_video(self, prompt: str, ratio: str, duration: int,
                       ref_image: Optional[str] = None, role_name: str = "", progress=None) -> Path:
        self._require_key()
        payload = {
            "model": self.model,
            "content": [{"type": "text", "text": prompt}],
            "duration": duration,
            "size": ratio,
        }
        if ref_image:
            payload["content"].insert(0, {"type": "image_url", "image_url": {"url": ref_image}})
        task_id = self._submit(payload)
        deadline = time.monotonic() + 1800
        while time.monotonic() < deadline:
            result = self._poll(task_id)
            status = (result.get("status") or "").lower()
            if status in ("succeeded", "success", "done"):
                content = (result.get("content") or [{}])[0]
                url = content.get("url") or content.get("video_url") or ""
                if url:
                    return self._download(url, ".mp4")
                raise AiError("字节平台未返回视频地址。", 502, "provider_error")
            if status in ("failed", "error", "canceled"):
                raise AiError(f"字节平台生成失败：{result.get('error') or '未知原因'}", 502, "provider_error")
            if progress is not None:
                progress(95)
            time.sleep(5)
        raise AiError("字节平台生成超时。", 504, "provider_timeout")
