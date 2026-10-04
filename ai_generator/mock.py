"""Mock 平台 —— 无 API Key 阶段的联调适配器。

- 生图：用 PIL 生成一张带角色名的占位形象图。
- 生视频：从 instance/media 复制一段真实 mp4 作为“生成结果”，
  用于验证 提交 → 排队 → 轮询 → 自动挂载 的完整链路。
"""
from __future__ import annotations

import time
import uuid
from pathlib import Path
from typing import Optional

from PIL import Image, ImageDraw, ImageFont

from .base import AiError

# 常见的 Windows 中文字体，逐个尝试，找不到就退回无字体绘制
_FONT_CANDIDATES = [
    "C:/Windows/Fonts/msyh.ttc",
    "C:/Windows/Fonts/simhei.ttf",
    "C:/Windows/Fonts/simsun.ttc",
]


def _load_font(size: int):
    for candidate in _FONT_CANDIDATES:
        try:
            return ImageFont.truetype(candidate, size)
        except OSError:
            continue
    return None


class MockAdapter:
    name = "mock"
    display = "模拟平台（测试）"
    models = {"mock-v1": "模拟模型 v1"}

    def __init__(self, media_dir: Path, output_dir: Path, model: str = "mock-v1"):
        self.media_dir = media_dir
        self.output_dir = output_dir
        self.model = model or "mock-v1"
        self.output_dir.mkdir(parents=True, exist_ok=True)

    def _mock_delay(self, seconds: float = 2.0):
        # 模拟生成耗时；保持可中断（不设超长等待）
        time.sleep(seconds)

    def generate_image(self, prompt: str, ratio: str, role_name: str = "", progress=None) -> Path:
        self._mock_delay(1.2)
        width, height = {"9:16": (720, 1280), "16:9": (1280, 720), "1:1": (1024, 1024),
                         "3:4": (900, 1200), "4:3": (1200, 900)}.get(ratio, (720, 1280))
        image = Image.new("RGB", (width, height), (46, 58, 89))
        draw = ImageDraw.Draw(image)
        font = _load_font(max(40, min(width, height) // 12))
        label = role_name or "形象占位"
        text = f"Mock 形象 · {label}"
        if font is not None:
            draw.text((width // 2, height // 2), text, fill=(255, 255, 255), font=font, anchor="mm")
        else:
            # 无字体兜底：画一个大圆作为占位
            radius = min(width, height) // 4
            draw.ellipse((width // 2 - radius, height // 2 - radius, width // 2 + radius, height // 2 + radius),
                         fill=(255, 255, 255))
        file = self.output_dir / f"mock_image_{uuid.uuid4().hex}.png"
        image.save(file)
        return file

    def generate_video(self, prompt: str, ratio: str, duration: int,
                       ref_image: Optional[str] = None, role_name: str = "", progress=None) -> Path:
        self._mock_delay(2.5)
        templates = sorted(self.media_dir.glob("*.mp4"))
        if not templates:
            raise AiError(
                "模拟平台需要一个视频模板：请先手动为任意剧本关联一个 MP4 视频，再重试 AI 生成。",
                409, "mock_template_missing",
            )
        source = templates[0]
        target = self.output_dir / f"mock_video_{uuid.uuid4().hex}.mp4"
        with source.open("rb") as src, target.open("wb") as dst:
            while chunk := src.read(1024 * 1024):
                dst.write(chunk)
        return target
