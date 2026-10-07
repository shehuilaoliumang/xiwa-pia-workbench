"""字节（豆包 seedance / 火山方舟）平台适配器。

真实联调骨架：封装 HTTP 提交与轮询；未配置 api_key 时明确报错。
当前无 key，仅保证接口契约与错误提示正确，接入方补全后可切换。
"""
from __future__ import annotations

import datetime
import hashlib
import hmac
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Optional

from .base import AiError, detect_image_ext

VOLC_OPENAPI_HOST = "ark.cn-beijing.volcengineapi.com"
VOLC_OPENAPI_REGION = "cn-beijing"
VOLC_OPENAPI_SERVICE = "ark"


def _volc_v4_sign(ak: str, sk: str, params: dict, payload: str = "",
                  content_type: str = "application/json") -> tuple[str, str, str]:
    """火山引擎 OpenAPI V4 签名（HMAC-SHA256）。返回 (x-date, Authorization, payload_hash)。

    火山规范要点（与 AWS SigV4 的差异）：
    - canonical headers 必须包含 x-content-sha256（请求体 SHA256），并参与签名；
    - SignedHeaders = host;x-date;x-content-sha256;content-type（官方示例顺序）。
    """
    now = datetime.datetime.utcnow()
    xdate = now.strftime("%Y%m%dT%H%M%SZ")
    short_date = xdate[:8]
    sorted_params = sorted(params.items())
    canonical_query = "&".join(
        f"{urllib.parse.quote(str(k), safe='')}={urllib.parse.quote(str(v), safe='')}"
        for k, v in sorted_params
    )
    payload_hash = hashlib.sha256(payload.encode("utf-8")).hexdigest()
    # 对齐官方签名示例的 canonical headers 顺序（host;x-date;x-content-sha256;content-type）
    canonical_headers = (
        f"host:{VOLC_OPENAPI_HOST}\n"
        f"x-date:{xdate}\n"
        f"x-content-sha256:{payload_hash}\n"
        f"content-type:{content_type}\n"
    )
    signed_headers = "host;x-date;x-content-sha256;content-type"
    canonical_request = (
        f"POST\n/\n{canonical_query}\n{canonical_headers}\n{signed_headers}\n{payload_hash}"
    )
    scope = f"{short_date}/{VOLC_OPENAPI_REGION}/{VOLC_OPENAPI_SERVICE}/request"
    string_to_sign = (
        f"HMAC-SHA256\n{xdate}\n{scope}\n"
        + hashlib.sha256(canonical_request.encode("utf-8")).hexdigest()
    )
    k_date = hmac.new(sk.encode("utf-8"), short_date.encode("utf-8"), hashlib.sha256).digest()
    k_region = hmac.new(k_date, VOLC_OPENAPI_REGION.encode("utf-8"), hashlib.sha256).digest()
    k_service = hmac.new(k_region, VOLC_OPENAPI_SERVICE.encode("utf-8"), hashlib.sha256).digest()
    k_signing = hmac.new(k_service, b"request", hashlib.sha256).digest()
    signature = hmac.new(k_signing, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()
    authorization = (
        f"HMAC-SHA256 Credential={ak}/{scope}, "
        f"SignedHeaders={signed_headers}, Signature={signature}"
    )
    return xdate, authorization, payload_hash


class ByteAdapter:
    name = "byte"
    display = "字节 · 豆包 Seedance（即梦同源）"
    models = {
        "seedance-2.0-pro": "豆包 Seedance 2.0 Pro（即梦同源）",
        "seedance-2.0-lite": "豆包 Seedance 2.0 Lite",
        "seedance-1.0-pro": "Seedance 1.0 Pro",
        "seedance-1.0-lite": "Seedance 1.0 Lite",
    }
    image_models = {
        "seedream-4.0": "豆包 Seedream 4.0（角色卡，同一 Key）",
        "seedream-3.0": "Seedream 3.0（角色卡）",
    }

    voice_models = {
        "seed-audio-1.0": "豆包语音 · 音频生成（配音/音效，需豆包语音 API Key）",
    }

    def __init__(self, output_dir: Optional[Path] = None, model: str = "seedance-2.0-pro",
                 api_key: str = "", endpoint: str = "https://ark.cn-beijing.volces.com/api/v3/",
                 image_model: str = "", tts_api_key: str = "", voice_model: str = "seed-audio-1.0"):
        self.output_dir = Path(output_dir or ".")
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.model = model or "seedance-2.0-pro"
        self.api_key = (api_key or "").strip()
        self.endpoint = (endpoint or "https://ark.cn-beijing.volces.com/api/v3/").rstrip("/") + "/"
        self.image_model = (image_model or "").strip()
        self.tts_api_key = (tts_api_key or "").strip()
        self.voice_model = (voice_model or "seed-audio-1.0").strip()

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
            # 429 SetLimitExceeded：免费体验模型「安全体验模式」用量达上限，服务暂停 → 给可操作指引
            if error.code == 429 and "SetLimitExceeded" in detail:
                raise AiError(
                    "字节平台用量已达上限：该模型受「安全体验模式」配额保护，服务已被暂停。"
                    "请到火山方舟控制台（console.volcengine.com/ark）→「开通管理」→ 找到该模型，"
                    "调整或关闭「安全体验模式」（或开通付费用量）后重试。", 429, "provider_quota",
                ) from error
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

    def _download(self, url: str, suffix: str, fix_image: bool = True) -> Path:
        target = self.output_dir / f"byte_{uuid.uuid4().hex}{suffix}"
        request = urllib.request.Request(url)
        try:
            with urllib.request.urlopen(request, timeout=120) as response, target.open("wb") as output:
                while chunk := response.read(1024 * 1024):
                    output.write(chunk)
        except (urllib.error.URLError, TimeoutError) as error:
            raise AiError(f"下载生成结果失败：{error}", 502, "provider_error") from error
        # 仅图片做「真实文件头修正扩展名」（供应商可能 jpeg 内容配 png 后缀）；
        # 视频扩展名由调用方按媒体类型确定，禁止走图片识别（否则 mp4 会被误判回退成 .png）。
        return self._fix_image_suffix(target) if fix_image else target

    def _fix_image_suffix(self, target: Path) -> Path:
        try:
            raw = target.read_bytes()[:16]
            real = detect_image_ext(raw)
            if target.suffix.lower() != real:
                fixed = target.with_suffix(real)
                target.rename(fixed)
                return fixed
        except OSError:
            pass
        return target

    def test_connection(self) -> dict:
        """轻量验证：调用模型列表接口，不产生任何生成费用。"""
        if not self.api_key:
            return {"ok": False, "message": "尚未填写 API Key，请先到「AI 生成设置」获取并填写火山方舟 api_key。"}
        request = urllib.request.Request(
            self.endpoint + "models",
            headers={"Authorization": f"Bearer {self.api_key}"},
        )
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                payload = json.loads(response.read().decode("utf-8"))
            models = payload.get("data") or []
            return {"ok": True, "message": f"连接成功：火山方舟可用（模型列表 {len(models)} 项）。",
                    "detail": f"HTTP {response.status}"}
        except urllib.error.HTTPError as error:
            body = error.read().decode("utf-8", errors="replace")[:300]
            if error.code == 401:
                return {"ok": False, "message": "API Key 无效或已过期，请检查是否复制完整、前后无空格。",
                        "detail": f"HTTP {error.code} {body}"}
            if error.code == 403:
                return {"ok": False, "message": "账号权限不足：请确认已在火山方舟开通豆包大模型服务（开通管理）。",
                        "detail": f"HTTP {error.code} {body}"}
            return {"ok": False, "message": f"请求失败（HTTP {error.code}），请检查网络与密钥。",
                    "detail": f"{body}"}
        except (urllib.error.URLError, TimeoutError) as error:
            return {"ok": False, "message": "无法连接火山方舟，请检查网络（或代理）后重试。",
                    "detail": str(error)}

    def list_models(self, api_key: str = "") -> Optional[dict]:
        """查询火山方舟账号当前可用模型，返回 {video:{id:label}, image:{id:label}}；失败返回 None（调用方降级内置列表）。"""
        key = (api_key or self.api_key or "").strip()
        if not key:
            return None
        request = urllib.request.Request(
            self.endpoint + "models",
            headers={"Authorization": f"Bearer {key}"},
        )
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except Exception:
            return None
        video, image = {}, {}
        for item in payload.get("data") or []:
            model_id = str(item.get("id") or "").strip()
            if not model_id:
                continue
            lower = model_id.lower()
            if "seedance" in lower:
                video[model_id] = model_id
            elif "seedream" in lower:
                image[model_id] = model_id
        if not video and not image:
            return None
        return {"video": video or None, "image": image or None}

    @staticmethod
    def _model_family(model_id: str) -> str:
        """模型 ID 的“家族名”：去掉尾部日期版本号（如 -260628），用于与基础模型开通名单比对。"""
        return re.sub(r"-\d{6}$", "", (model_id or "").strip()).lower()

    def list_activations(self, ak: str = "", sk: str = "") -> Optional[list]:
        """查询火山方舟「已开通」的基础模型（ListModelActivations，需 AK/SK V4 签名）。

        返回 FoundationModelName 列表（仅 State=Available）；
        AK/SK 未配置返回 None；请求失败返回 None；查询成功但无开通返回 []。
        """
        ak = (ak or "").strip()
        sk = (sk or "").strip()
        if not ak or not sk:
            return None
        params = {"Action": "ListModelActivations", "Version": "2024-01-01"}
        # 对齐官方请求格式：JSON body + Filter.States 过滤已开通（Available）
        payload = json.dumps({
            "PageNumber": 1,
            "PageSize": 100,
            "SortBy": "VendorName",
            "SortOrder": "Asc",
            "Filter": {"States": ["Available"], "IncludeDeprecatedModels": False},
        }, ensure_ascii=False)
        content_type = "application/json"
        xdate, authorization, payload_hash = _volc_v4_sign(ak, sk, params, payload, content_type)
        request = urllib.request.Request(
            f"https://{VOLC_OPENAPI_HOST}/?{urllib.parse.urlencode(params)}",
            data=payload.encode("utf-8"), method="POST",
            headers={"Content-Type": content_type,
                     "X-Date": xdate,
                     "X-Content-Sha256": payload_hash,
                     "Authorization": authorization},
        )
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                data = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            body = error.read().decode("utf-8", errors="replace")[:300]
            raise AiError(f"开通状态查询失败（HTTP {error.code}）：{body}", 502, "activation_query_failed") from error
        except (urllib.error.URLError, TimeoutError) as error:
            raise AiError(f"无法连接火山引擎 OpenAPI：{error}", 502, "provider_unreachable") from error
        # 官方响应结构：数据在 Result.Items（兼容旧版顶层 Items 兜底）
        result = data.get("Result") or {}
        items = result.get("Items") or data.get("Items") or []
        names = []
        for item in items:
            name = str(item.get("FoundationModelName") or "").strip()
            if name and str(item.get("State") or "").strip() == "Available":
                names.append(name)
        return names or None

    # Seedream 图像接口尺寸映射（方式2：宽x高像素值；flash/pro 总像素下限 921600）
    _IMAGE_SIZE_PX = {
        "1:1": "1024x1024", "4:3": "1152x864", "3:4": "864x1152",
        "16:9": "1424x800", "9:16": "800x1424",
        "3:2": "1248x832", "2:3": "832x1248", "21:9": "1568x672",
    }

    def generate_image(self, prompt: str, ratio: str, role_name: str = "", progress=None) -> Path:
        self._require_key()
        # 角色形象卡：优先使用密钥查询到的真实可用 Seedream 模型（与视频共用同一 api_key）
        image_model = self.image_model or (self.model if self.model in self.image_models else "") \
            or next(iter(self.image_models), "seedream-4.0")
        # 图像走独立接口 images/generations（API Key 鉴权，同步返回）；
        # Seedream 5.0 不支持 contents/generations 的 content 格式（会报 InvalidParameter）。
        payload = {
            "model": image_model,
            "prompt": prompt,
            "size": self._IMAGE_SIZE_PX.get(str(ratio or "").strip(), "1024x1024"),
            "response_format": "url",
            # 统一输出 PNG：角色图后续可能要做透明/抠图等处理，PNG 通用性最好
            "output_format": "png",
        }
        result = self._request("images/generations", payload)
        if progress is not None:
            progress(90)
        data = result.get("data") or result.get("images") or []
        url = ""
        if data:
            url = data[0].get("url") or data[0].get("image_url") or data[0].get("b64_json") or ""
        if not url:
            raise AiError("字节平台未返回图片地址。", 502, "provider_error")
        if url.startswith("data:"):
            import base64 as _b64
            raw = _b64.b64decode(url.split(",", 1)[1])
            # 自适应：按 data URI 声明的 mime 或真实文件头决定扩展名
            mime = url.split(",", 1)[0].split(";", 1)[0].split(":", 1)[-1].strip().lower()
            ext = ("." + mime) if mime in ("png", "jpeg", "webp", "gif") else detect_image_ext(raw)
            target = self.output_dir / f"byte_{uuid.uuid4().hex}{ext}"
            target.write_bytes(raw)
            return self._fix_image_suffix(target)
        return self._download(url, ".png")

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
                # Seedance 任务接口 content 是 dict（{"video_url": ...}）；旧版/部分模型可能返回 list
                content = result.get("content")
                if isinstance(content, list):
                    content = content[0] if content else {}
                elif not isinstance(content, dict):
                    content = {}
                url = content.get("url") or content.get("video_url") or ""
                if url:
                    return self._download(url, ".mp4", fix_image=False)
                raise AiError("字节平台未返回视频地址。", 502, "provider_error")
            if status in ("failed", "error", "canceled"):
                raise AiError(f"字节平台生成失败：{result.get('error') or '未知原因'}", 502, "provider_error")
            if progress is not None:
                progress(95)
            time.sleep(5)
        raise AiError("字节平台生成超时。", 504, "provider_timeout")

    # ---------- 配音生成（豆包语音 openspeech，独立 API Key） ----------

    def _require_tts_key(self):
        if not self.tts_api_key:
            raise AiError(
                "字节配音未配置「豆包语音 API Key」：\n"
                "配音走豆包语音独立服务（openspeech.bytedance.com），需单独的 API Key"
                "（与火山方舟 Key 不同）。请到豆包语音控制台 →「API Key 管理」创建，"
                "在「AI 生成设置」→ 字节平台的「豆包语音 API Key」中填写。",
                409, "tts_api_key_missing",
            )

    def generate_voice(self, text: str, voice_type: str = "", ratio: str = "",
                       role_name: str = "", progress=None) -> Path:
        """文本转语音配音：豆包语音音频生成 HTTP 接口（非流式，同步返回 base64 音频）。"""
        self._require_tts_key()
        payload = {
            "model": self.voice_model,
            "text_prompt": text,
            "audio_config": {"format": "mp3", "sample_rate": 48000},
        }
        if voice_type:
            payload["speaker"] = voice_type
        body = json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(
            "https://openspeech.bytedance.com/api/v3/tts/create", data=body, method="POST",
            headers={"Content-Type": "application/json", "X-Api-Key": self.tts_api_key},
        )
        try:
            with urllib.request.urlopen(request, timeout=300) as response:
                result = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")[:500]
            raise AiError(f"字节配音请求失败（{error.code}）：{detail}", 502, "provider_error") from error
        except (urllib.error.URLError, TimeoutError) as error:
            raise AiError(f"字节配音服务无法连接：{error}", 502, "provider_unreachable") from error
        code = result.get("code")
        if code not in (None, 0, 200, 3000):
            raise AiError(f"字节配音生成失败：{result.get('message') or '未知原因'}", 502, "provider_error")
        audio_b64 = result.get("audio") or ""
        url = result.get("url") or ""
        if audio_b64:
            import base64 as _b64
            raw = _b64.b64decode(audio_b64)
            target = self.output_dir / f"byte_{uuid.uuid4().hex}.mp3"
            target.write_bytes(raw)
            return target
        if url:
            return self._download(url, ".mp3", fix_image=False)
        raise AiError("字节配音未返回音频。", 502, "provider_error")
