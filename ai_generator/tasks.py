"""任务管理器 —— 排队、执行、状态机与自动挂载。

- 单工作线程顺序执行队列（批量排队天然有序，避免并发写库竞争）。
- 视频任务成功且携带 script_id/block_id 时，自动复用 Store.upload_script_media
  落库，随后 save_media_cues 把 0s 时间点指向目标段落（“自动挂载”）。
"""
from __future__ import annotations

import copy
import queue
import threading
import time
import uuid
from pathlib import Path
from typing import Callable, Optional

from . import base
from .base import AiError, get_character, load_config, new_id, utcnow
from .mock import MockAdapter
from .byte import ByteAdapter
from .ali import AliAdapter


class TaskManager:
    def __init__(self, database: Path, media_dir: Path, output_dir: Path, store=None):
        self.database = Path(database)
        self.media_dir = Path(media_dir)
        self.output_dir = Path(output_dir)
        self.store = store
        self._queue: queue.Queue[Optional[str]] = queue.Queue()
        self._thread: Optional[threading.Thread] = None
        self._running = False
        base.initialize_database(self.database)
        self._purge_stale()

    # ---------- 生命周期 ----------

    def start(self):
        if self._thread and self._thread.is_alive():
            return
        self._running = True
        self._thread = threading.Thread(target=self._worker_loop, name="ai-task-worker", daemon=True)
        self._thread.start()

    def stop(self):
        self._running = False
        try:
            self._queue.put_nowait(None)
        except queue.Full:
            pass

    def shutdown(self):
        self.stop()
        if self._thread:
            self._thread.join(timeout=3)

    # ---------- 配置与适配器 ----------

    def _adapter(self, platform: str, model: str):
        config = load_config(self.database)
        platform_config = config["platforms"].get(platform)
        if not platform_config:
            raise AiError(f"平台 {platform} 不受支持。", 400, "unknown_platform")
        if platform == "mock":
            return MockAdapter(self.media_dir, self.output_dir, model)
        if platform == "byte":
            return ByteAdapter(self.output_dir, model, platform_config.get("api_key", ""), platform_config.get("endpoint", ""))
        if platform == "ali":
            return AliAdapter(self.output_dir, model, platform_config.get("api_key", ""), platform_config.get("endpoint", ""))
        raise AiError(f"平台 {platform} 尚未实现适配器。", 400, "unknown_platform")

    # ---------- 任务提交 ----------

    def submit_image(self, prompt: str, platform: str, model: str, ratio: str,
                     role_name: str = "", character_id: Optional[str] = None,
                     script_id: Optional[str] = None) -> dict:
        prompt = (prompt or "").strip()
        if not prompt or len(prompt) > 2000:
            raise AiError("生成描述不能为空且不超过 2000 字。", 400, "invalid_prompt")
        if ratio not in base.RATIOS:
            raise AiError("画面比例不支持。", 400, "invalid_ratio")
        config = load_config(self.database)
        if not config["enabled"]:
            raise AiError("AI 生成功能已关闭，请先在「AI 生成设置」中开启。", 409, "ai_disabled")
        task_id = new_id("task")
        now = utcnow()
        with base.db_scope(self.database) as connection:
            connection.execute(
                "INSERT INTO ai_tasks(id,task_id,kind,platform,model,prompt,ratio,status,progress,"
                "role_name,script_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (new_id("row"), task_id, "image", platform, model, prompt, ratio, "queued", 0,
                 role_name, script_id, now, now),
            )
        self._queue.put(task_id)
        self.start()
        return self.get_task(task_id)

    def submit_video(self, prompt: str, platform: str, model: str, ratio: str, duration: int,
                     script_id: str, block_id: str, ref_image: Optional[str] = None,
                     role_name: str = "") -> dict:
        prompt = (prompt or "").strip()
        if not prompt or len(prompt) > 2000:
            raise AiError("生成描述不能为空且不超过 2000 字。", 400, "invalid_prompt")
        if ratio not in base.RATIOS:
            raise AiError("画面比例不支持。", 400, "invalid_ratio")
        if duration not in base.DURATIONS:
            raise AiError("生成时长不支持。", 400, "invalid_duration")
        config = load_config(self.database)
        if not config["enabled"]:
            raise AiError("AI 生成功能已关闭，请先在「AI 生成设置」中开启。", 409, "ai_disabled")
        # 目标段落存在性交由挂载阶段的既有校验兜底（save_media_cues 会校验 block_ids）。
        task_id = new_id("task")
        now = utcnow()
        with base.db_scope(self.database) as connection:
            connection.execute(
                "INSERT INTO ai_tasks(id,task_id,kind,platform,model,prompt,ref_image,ratio,duration,status,progress,"
                "script_id,block_id,role_name,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (new_id("row"), task_id, "video", platform, model, prompt, ref_image, ratio, duration,
                 "queued", 0, script_id, block_id, role_name, now, now),
            )
        self._queue.put(task_id)
        self.start()
        return self.get_task(task_id)

    # ---------- 查询 / 取消 / 重试 ----------

    def list_tasks(self, limit: int = 100) -> list[dict]:
        with base.db_scope(self.database) as connection:
            rows = connection.execute(
                "SELECT * FROM ai_tasks ORDER BY created_at DESC LIMIT ?", (int(limit),)
            ).fetchall()
        return [dict(row) for row in rows]

    def get_task(self, task_id: str) -> dict:
        with base.db_scope(self.database) as connection:
            row = connection.execute("SELECT * FROM ai_tasks WHERE task_id=?", (task_id,)).fetchone()
        if not row:
            raise AiError("生成任务不存在。", 404, "task_not_found")
        return dict(row)

    def cancel_task(self, task_id: str) -> dict:
        with base.db_scope(self.database) as connection:
            row = connection.execute("SELECT * FROM ai_tasks WHERE task_id=?", (task_id,)).fetchone()
            if not row:
                raise AiError("生成任务不存在。", 404, "task_not_found")
            if row["status"] in ("succeeded", "failed", "cancelled"):
                raise AiError("该任务已结束，无法取消。", 409, "task_finished")
            connection.execute(
                "UPDATE ai_tasks SET status='cancelled', updated_at=? WHERE task_id=?",
                (utcnow(), task_id),
            )
        return self.get_task(task_id)

    def retry_task(self, task_id: str) -> dict:
        with base.db_scope(self.database) as connection:
            row = connection.execute("SELECT * FROM ai_tasks WHERE task_id=?", (task_id,)).fetchone()
            if not row:
                raise AiError("生成任务不存在。", 404, "task_not_found")
            if row["status"] not in ("failed", "cancelled"):
                raise AiError("只有失败或已取消的任务可以重试。", 409, "task_not_retryable")
            connection.execute(
                "UPDATE ai_tasks SET status='queued', progress=0, error=NULL, updated_at=? WHERE task_id=?",
                (utcnow(), task_id),
            )
        self._queue.put(task_id)
        self.start()
        return self.get_task(task_id)

    # ---------- 内部 ----------

    def _purge_stale(self):
        with base.db_scope(self.database) as connection:
            connection.execute(
                "UPDATE ai_tasks SET status='failed', error='程序重启导致任务中断，请重试。', updated_at=? "
                "WHERE status IN ('queued','running')",
                (utcnow(),),
            )

    def _worker_loop(self):
        while self._running:
            try:
                task_id = self._queue.get(timeout=1)
            except queue.Empty:
                continue
            if task_id is None:
                break
            try:
                self._run_task(task_id)
            except Exception as error:  # noqa: BLE001 - worker 不得退出
                self._mark_failed(task_id, f"生成任务内部错误：{error}")
            finally:
                self._queue.task_done()

    def _run_task(self, task_id: str):
        task = self.get_task(task_id)
        if task["status"] == "cancelled":
            return
        self._update(task_id, status="running", progress=5)
        try:
            adapter = self._adapter(task["platform"], task["model"])
            role_name = task.get("role_name") or ""
            if task["kind"] == "image":
                result = adapter.generate_image(task["prompt"], task["ratio"], role_name=role_name,
                                                progress=lambda value: self._update(task_id, progress=value))
                self._update(task_id, status="succeeded", progress=100, result_file=str(result))
                # 形象卡片生成成功后，自动写入角色库形象图
                if task.get("role_name"):
                    self._attach_character_image(task_id, task["role_name"], result)
            else:
                result = adapter.generate_video(task["prompt"], task["ratio"], task.get("duration") or 10,
                                                ref_image=task.get("ref_image"), role_name=role_name,
                                                progress=lambda value: self._update(task_id, progress=value))
                self._update(task_id, status="succeeded", progress=100, result_file=str(result))
                if task.get("script_id") and task.get("block_id"):
                    self._attach_video(task_id, result)
        except AiError as error:
            self._mark_failed(task_id, error.message)
        except OSError as error:
            self._mark_failed(task_id, f"本地文件操作失败：{error}")

    def _attach_character_image(self, task_id: str, role_name: str, image_file: Path):
        """生图任务成功且带 role_name：若库中已有同名角色则写入形象图。"""
        with base.db_scope(self.database) as connection:
            row = connection.execute("SELECT id FROM ai_characters WHERE name=?", (role_name,)).fetchone()
        if not row:
            return
        digest, size = self._file_sha256(image_file)
        media_file = self.media_dir / (digest + image_file.suffix.lower())
        if media_file.exists():
            media_file.unlink(missing_ok=True)
        import shutil
        shutil.copy2(image_file, media_file)
        base.set_character_image(self.database, row["id"], "/media/" + media_file.name, digest)
        self._update(task_id, error=f"已写入角色库「{role_name}」形象卡片。")

    def _attach_video(self, task_id: str, video_file: Path):
        if self.store is None:
            return
        task = self.get_task(task_id)
        try:
            with video_file.open("rb") as stream:
                script = self.store.upload_script_media(
                    task["script_id"], stream, f"AI生成_{task_id[:8]}.mp4"
                )
            # 自动把 0s 时间点指向目标段落
            self.store.save_media_cues(task["script_id"], {
                "duration": None,
                "cues": [{"id": new_id("cue"), "at": 0, "label": "AI 生成视频", "block_ids": [task["block_id"]]}],
            })
            self._update(task_id, error=None)
        except AiError as error:
            self._mark_failed(task_id, f"生成成功但自动挂载失败：{error.message}")
        except Exception as error:  # noqa: BLE001
            self._mark_failed(task_id, f"生成成功但自动挂载失败：{error}")

    @staticmethod
    def _file_sha256(path: Path) -> tuple[str, int]:
        import hashlib
        digest, size = hashlib.sha256(), 0
        with path.open("rb") as handle:
            while chunk := handle.read(1024 * 1024):
                size += len(chunk)
                digest.update(chunk)
        return digest.hexdigest(), size

    def _update(self, task_id: str, **fields):
        allowed = {"status", "progress", "result_file", "error"}
        updates = {key: value for key, value in fields.items() if key in allowed}
        if not updates:
            return
        columns = ", ".join(f"{key}=?" for key in updates)
        values = list(updates.values()) + [utcnow(), task_id]
        with base.db_scope(self.database) as connection:
            connection.execute(f"UPDATE ai_tasks SET {columns}, updated_at=? WHERE task_id=?", values)

    def _mark_failed(self, task_id: str, message: str):
        self._update(task_id, status="failed", error=str(message)[:2000])
