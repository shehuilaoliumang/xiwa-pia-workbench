"""AI 多媒体生成中心（实验功能）。

- 平台适配层：mock（无 key 联调）/ byte（豆包 seedance）/ ali（通义万相）。
- 全局角色形象卡片库：跨剧本复用，记录“已在哪些剧本应用+对应别名”。
- 生成任务异步排队，视频生成成功后自动挂载到段落媒体位。

独立于主库运行（instance/ai_generator.sqlite3），回退时删除本包与独立库即可。
"""
from __future__ import annotations

from pathlib import Path

from .base import RATIOS, DURATIONS, DEFAULT_CONFIG, AiError  # noqa: F401
from .routes import create_ai_blueprint

__version__ = "0.1.0"

__all__ = ["create_ai_blueprint", "RATIOS", "DURATIONS", "DEFAULT_CONFIG", "AiError", "__version__"]
