"""任务管理器 —— 排队、执行、状态机与自动插入。

- 单工作线程顺序执行队列（批量排队天然有序，避免并发写库竞争）。
- 视频任务成功且携带 script_id/block_id 时，自动复用 Store.upload_block_media
  落库，随后 insert_block_media 在目标正文段落后方插入一个视频段落（“自动插入”）。
"""
from __future__ import annotations

import copy
import json
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
        # 提交未指定模型时，回退到设置中保存的（已按真实可用列表修正的）模型，避免使用失效的内置默认名
        resolved = (model or "").strip() or str(platform_config.get("model") or "").strip()
        # 动态模型列表（来自密钥查询），供角色形象卡/音乐/配音生成使用
        saved_models = platform_config.get("models") or {}
        image_models = saved_models.get("image") or {}
        audio_models = saved_models.get("audio") or {}
        voice_models = saved_models.get("voice") or {}
        image_model = next(iter(image_models), "")
        audio_model = next(iter(audio_models), "") or str(platform_config.get("audio_model") or "").strip()
        voice_model = next(iter(voice_models), "") or str(platform_config.get("voice_model") or "").strip()
        if platform == "mock":
            return MockAdapter(self.media_dir, self.output_dir, resolved)
        if platform == "byte":
            return ByteAdapter(self.output_dir, resolved, platform_config.get("api_key", ""),
                               platform_config.get("endpoint", ""), image_model=image_model,
                               tts_api_key=platform_config.get("tts_api_key", ""),
                               voice_model=voice_model)
        if platform == "ali":
            return AliAdapter(self.output_dir, resolved, platform_config.get("api_key", ""),
                              platform_config.get("endpoint", ""), image_model=image_model,
                              audio_model=audio_model, voice_model=voice_model,
                              workspace_id=platform_config.get("workspace_id", ""))
        raise AiError(f"平台 {platform} 尚未实现适配器。", 400, "unknown_platform")

    def test_platform(self, platform: str) -> dict:
        """一键测试连接：不产生生成费用，返回结构化结果供前端展示。"""
        config = load_config(self.database)
        platform_config = config["platforms"].get(platform)
        if not platform_config:
            raise AiError(f"平台 {platform} 不受支持。", 400, "unknown_platform")
        try:
            adapter = self._adapter(platform, platform_config.get("model") or "")
            result = adapter.test_connection()
            result["platform"] = platform
            return result
        except AiError as error:
            return {"ok": False, "platform": platform, "message": base.friendly_error(error.message)}

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

    def submit_audio(self, prompt: str, platform: str, model: str,
                     script_id: Optional[str] = None, block_id: Optional[str] = None,
                     role_name: str = "") -> dict:
        """提交背景音乐/音效生成任务（fun-music 等音乐模型）。"""
        prompt = (prompt or "").strip()
        if not prompt or len(prompt) > 2000:
            raise AiError("音乐描述不能为空且不超过 2000 字。", 400, "invalid_prompt")
        config = load_config(self.database)
        if not config["enabled"]:
            raise AiError("AI 生成功能已关闭，请先在「AI 生成设置」中开启。", 409, "ai_disabled")
        task_id = new_id("task")
        now = utcnow()
        with base.db_scope(self.database) as connection:
            connection.execute(
                "INSERT INTO ai_tasks(id,task_id,kind,platform,model,prompt,status,progress,"
                "script_id,block_id,role_name,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (new_id("row"), task_id, "audio", platform, model, prompt, "queued", 0,
                 script_id, block_id, role_name, now, now),
            )
        self._queue.put(task_id)
        self.start()
        return self.get_task(task_id)

    def submit_voice(self, text: str, platform: str, model: str, voice_type: str = "",
                     script_id: Optional[str] = None, block_id: Optional[str] = None,
                     role_name: str = "") -> dict:
        """提交文本转语音配音任务（豆包语音 / Qwen-TTS）。"""
        text = (text or "").strip()
        if not text or len(text) > 3000:
            raise AiError("配音文本不能为空且不超过 3000 字。", 400, "invalid_prompt")
        config = load_config(self.database)
        if not config["enabled"]:
            raise AiError("AI 生成功能已关闭，请先在「AI 生成设置」中开启。", 409, "ai_disabled")
        task_id = new_id("task")
        now = utcnow()
        with base.db_scope(self.database) as connection:
            connection.execute(
                "INSERT INTO ai_tasks(id,task_id,kind,platform,model,prompt,status,progress,"
                "script_id,block_id,role_name,voice_type,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (new_id("row"), task_id, "voice", platform, model, text, "queued", 0,
                 script_id, block_id, role_name, (voice_type or "").strip(), now, now),
            )
        self._queue.put(task_id)
        self.start()
        return self.get_task(task_id)

    def _ref_image_to_data_uri(self, ref_image: Optional[str]) -> str:
        """参考图 URL 规范化：本地 /media/xxx 路径转 base64 data URI（字节 image_url 支持 data URI；
        公网 URL / data URI 原样返回；读不到则返回空串，避免无效 URL 导致 400 InvalidParameter。"""
        ref_image = (ref_image or "").strip()
        if not ref_image:
            return ""
        if ref_image.startswith("data:") or ref_image.startswith("http://") or ref_image.startswith("https://"):
            return ref_image
        name = ref_image.lstrip("/")
        if name.startswith("media/"):
            name = name[len("media/"):]
        candidate = self.media_dir / name
        if candidate.is_file():
            try:
                import base64 as _b64
                raw_bytes = candidate.read_bytes()
                # 按真实文件头识别格式（后缀可能不准确：图像接口默认输出 jpeg 却按 png 命名）
                ext = base.detect_image_ext(raw_bytes)
                mime = ext.lstrip(".")
                if mime == "jpg":
                    mime = "jpeg"
                raw = _b64.b64encode(raw_bytes).decode("ascii")
                return f"data:image/{mime};base64,{raw}"
            except OSError:
                return ""
        return ""

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
        ref_image = self._ref_image_to_data_uri(ref_image)
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

    def clear_finished_tasks(self) -> dict:
        """删除所有已结束（已完成/失败/已取消）的任务记录；排队与生成中的任务保留。"""
        with base.db_scope(self.database) as connection:
            cursor = connection.execute(
                "DELETE FROM ai_tasks WHERE status IN ('succeeded', 'failed', 'cancelled')"
            )
            return {"deleted": cursor.rowcount}

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
        # 模型尝试序列：优先用户保存的模型，随后按平台真实模型列表逐个尝试，找到可用的
        attempts = self._model_attempts(task)
        last_error: AiError | None = None
        tried: list[str] = []
        for model in attempts:
            if self.get_task(task_id).get("status") == "cancelled":
                return
            try:
                adapter = self._adapter(task["platform"], model)
                role_name = task.get("role_name") or ""
                kind = task["kind"]
                if kind == "image":
                    result = adapter.generate_image(task["prompt"], task["ratio"], role_name=role_name,
                                                    progress=lambda value: self._update(task_id, progress=value))
                elif kind == "audio":
                    result = adapter.generate_audio(task["prompt"], task.get("ratio") or "", role_name=role_name,
                                                    progress=lambda value: self._update(task_id, progress=value))
                elif kind == "voice":
                    result = adapter.generate_voice(task["prompt"], voice_type=task.get("voice_type") or "",
                                                    role_name=role_name,
                                                    progress=lambda value: self._update(task_id, progress=value))
                else:
                    result = adapter.generate_video(task["prompt"], task["ratio"], task.get("duration") or 10,
                                                    ref_image=self._ref_image_to_data_uri(task.get("ref_image")),
                                                    role_name=role_name,
                                                    progress=lambda value: self._update(task_id, progress=value))
                self._update(task_id, status="succeeded", progress=100, result_file=str(result))
                # 归档产物到 ai_output/<kind>/ 并写伴随元数据
                self._organize_output(task_id)
                if kind == "image":
                    # 形象卡片生成成功后，自动写入角色库形象图
                    if task.get("role_name"):
                        self._attach_character_image(task_id, task["role_name"])
                if task.get("script_id") and task.get("block_id"):
                    self._attach_video(task_id)
                # 生成成功：记录该模型确实可用，作为平台默认（基于实测而非猜测）
                if model:
                    self._remember_working_model(task["platform"], task["kind"], model)
                return
            except AiError as error:
                last_error = error
                tried.append(model or "（未指定）")
                unavailable = self._is_model_unavailable(error.message)
                # 实测确认为“未开通/不存在”的模型立即记录，前端下拉将自动隐藏，避免反复踩 404
                if unavailable and model:
                    self._remember_unavailable_model(task["platform"], model)
                if not unavailable:
                    break  # 非“模型不可用”类错误（鉴权/配额/网络等），不切换模型
                self._update(task_id, progress=min(95, 5 + len(tried) * 15))
        suffix = f"（已尝试模型：{'、'.join(tried)}）" if tried else ""
        full = f"{last_error.message}{suffix}" if last_error else "生成任务失败。"
        self._mark_failed(task_id, base.friendly_error(full))

    @staticmethod
    def _is_model_unavailable(message: str) -> bool:
        """判断平台报错是否属于“模型未开通/不存在”类，这类错误应切换其他模型重试。"""
        text = str(message or "").lower()
        markers = ("modelnotopen", "invalidendpointormodel", "not activated",
                   "does not exist", "model not found", "not found", "not open",
                   "url error", "please check url")
        return any(marker in text for marker in markers)

    def _model_attempts(self, task: dict) -> list[str]:
        """构造本次生成要尝试的模型序列。"""
        platform = task.get("platform") or ""
        requested = str(task.get("model") or "").strip()
        if platform == "mock" or platform not in ("byte", "ali"):
            return [requested]
        config = load_config(self.database)
        platform_config = config["platforms"].get(platform) or {}
        listed = platform_config.get("models") or {}
        kind = task.get("kind") or ""
        bucket_key = kind if kind in ("image", "audio", "voice") else "video"
        bucket = listed.get(bucket_key) or {}
        candidates = list(bucket)
        # 用户保存的模型优先尝试（若指定且存在于列表则放最前；不在列表也先试一次）
        if requested and requested not in candidates:
            candidates.insert(0, requested)
        ordered: list[str] = []
        for name in ([requested] if requested else []) + candidates:
            if name and name not in ordered:
                ordered.append(name)
        return ordered or [requested]

    def _remember_working_model(self, platform: str, kind: str, model: str):
        """生成成功后，把该模型记为平台默认（实测可用，非列表猜测）。
        视频/图像/音乐/配音分别记录 model/image_model/audio_model/voice_model。"""
        if platform not in ("byte", "ali") or not model:
            return
        try:
            config = load_config(self.database)
        except Exception:  # noqa: BLE001
            return
        config.setdefault("platforms", {}).setdefault(platform, {})
        field = {"image": "image_model", "audio": "audio_model", "voice": "voice_model"}.get(kind, "model")
        config["platforms"][platform][field] = model
        # 该模型实测可用：从“未开通”名单移除（若之前误记）
        blocked = list(config["platforms"][platform].get("unavailable_models") or [])
        if model in blocked:
            blocked.remove(model)
            config["platforms"][platform]["unavailable_models"] = blocked
        base.save_config(self.database, config)

    def _remember_unavailable_model(self, platform: str, model: str):
        """实测确认为“模型未开通/不存在”的模型记录在案，前端据此隐藏该模型。"""
        if platform not in ("byte", "ali") or not model:
            return
        try:
            config = load_config(self.database)
        except Exception:  # noqa: BLE001
            return
        config.setdefault("platforms", {}).setdefault(platform, {})
        blocked = list(config["platforms"][platform].get("unavailable_models") or [])
        if model not in blocked:
            blocked.append(model)
            config["platforms"][platform]["unavailable_models"] = blocked
            base.save_config(self.database, config)

    def _organize_output(self, task_id: str):
        """生成成功后归档：每个产物单独打包为一个文件夹 ai_output/<kind>/<stem>/，
        产物与 meta.json（提示词/平台/模型/比例/时长/角色/目标段落等）放在一起，读取信息完整、不会混淆。"""
        try:
            task = self.get_task(task_id)
            result = Path(task.get("result_file") or "")
            if not result.is_file():
                return
            kind = task.get("kind") if task.get("kind") in ("video", "audio", "voice", "image") else "image"
            folder = Path(self.output_dir) / kind / result.stem
            folder.mkdir(parents=True, exist_ok=True)
            target = folder / result.name
            if result != target:
                if target.exists():
                    target.unlink()
                result.replace(target)
            ref_image = str(task.get("ref_image") or "")
            if len(ref_image) > 120:
                ref_image = f"（内嵌参考图 data URI，共 {len(ref_image)} 字符，已省略）"
            meta = {
                "task_id": task.get("task_id"),
                "kind": task.get("kind"),
                "status": task.get("status"),
                "platform": task.get("platform"),
                "model": task.get("model"),
                "prompt": task.get("prompt"),
                "ratio": task.get("ratio"),
                "duration": task.get("duration"),
                "role_name": task.get("role_name") or "",
                "ref_image": ref_image,
                "script_id": task.get("script_id") or "",
                "block_id": task.get("block_id") or "",
                "created_at": task.get("created_at"),
                "updated_at": task.get("updated_at"),
                "result_file": str(target),
            }
            meta_file = folder / "meta.json"
            meta_file.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
            self._update(task_id, result_file=str(target))
        except Exception:  # noqa: BLE001 归档失败不致命：任务已成功
            try:
                self._update(task_id, error=None)
            except Exception:  # noqa: BLE001
                pass

    def _attach_character_image(self, task_id: str, role_name: str):
        """生图任务成功且带 role_name：若库中已有同名角色则写入形象图。"""
        task = self.get_task(task_id)
        image_file = Path(task.get("result_file") or "")
        if not image_file.is_file():
            return
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

    def _attach_video(self, task_id: str):
        """生成成功后在目标正文段落后方插入一个媒体段落（视频/音乐/配音均可，扩展名决定类型）。"""
        if self.store is None:
            return
        task = self.get_task(task_id)
        media_file = Path(task.get("result_file") or "")
        if not media_file.is_file():
            return
        try:
            extension = media_file.suffix.lower() or ".mp4"
            with media_file.open("rb") as stream:
                asset = self.store.upload_block_media(stream, f"AI生成_{task_id[:8]}{extension}")
            self.store.insert_block_media(task["script_id"], task["block_id"], asset)
            self._update(task_id, error=None)
        except AiError as error:
            self._mark_failed(task_id, f"生成成功但自动插入正文失败：{error.message}")
        except Exception as error:  # noqa: BLE001
            self._mark_failed(task_id, f"生成成功但自动插入正文失败：{error}")

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
