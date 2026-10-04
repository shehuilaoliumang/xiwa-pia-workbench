"""AI 生成中心 —— Flask 蓝图路由。"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Optional

from flask import Blueprint, jsonify, request
from storage import DomainError

from . import base
from .base import AiError
from .tasks import TaskManager


def create_ai_blueprint(store, instance_path: Path, enabled_default: bool = True):
    instance_path = Path(instance_path)
    database = instance_path / base.DB_FILENAME
    output_dir = instance_path / base.OUTPUT_DIRNAME
    manager = TaskManager(database, store.media_dir, output_dir, store=store)
    blueprint = Blueprint("ai_generator", __name__)
    blueprint.ai_manager = manager  # 供宿主/测试在进程退出前关闭工作线程

    @blueprint.errorhandler(AiError)
    def ai_error(error: AiError):
        return jsonify(error=error.message, code=error.code), error.status

    @blueprint.errorhandler(DomainError)
    def domain_error(error: DomainError):
        return jsonify(error=str(error), code=error.code), error.status

    def body() -> dict:
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            raise AiError("请提交 JSON 对象。", 400, "invalid_json")
        return payload

    # ---------- 配置 ----------

    @blueprint.get("/api/ai/status")
    def ai_status():
        config = base.load_config(database)
        return jsonify(config=config, ratios=base.RATIOS, durations=list(base.DURATIONS))

    @blueprint.get("/api/ai/config")
    def get_ai_config():
        return jsonify(config=base.load_config(database))

    @blueprint.post("/api/ai/config")
    def post_ai_config():
        return jsonify(config=base.save_config(database, body()))

    # ---------- 角色库 ----------

    @blueprint.get("/api/ai/characters")
    def list_ai_characters():
        return jsonify(characters=base.list_characters(database))

    @blueprint.post("/api/ai/characters")
    def create_ai_character():
        return jsonify(base.save_character(database, body())), 201

    @blueprint.put("/api/ai/characters/<character_id>")
    def update_ai_character(character_id):
        return jsonify(base.save_character(database, body(), character_id))

    @blueprint.get("/api/ai/characters/<character_id>")
    def get_ai_character(character_id):
        return jsonify(base.get_character(database, character_id))

    @blueprint.delete("/api/ai/characters/<character_id>")
    def delete_ai_character(character_id):
        base.delete_character(database, character_id)
        return jsonify(ok=True)

    @blueprint.post("/api/ai/characters/<character_id>/image")
    def upload_ai_character_image(character_id):
        uploaded = request.files.get("file")
        if not uploaded or not uploaded.filename:
            raise AiError("请选择形象图片。", 400, "invalid_image")
        result = store.upload_script_image(uploaded.stream, uploaded.filename)
        character = base.set_character_image(database, character_id, result["path"], result["sha256"])
        return jsonify(character), 201

    @blueprint.post("/api/ai/characters/<character_id>/generate-image")
    def generate_ai_character_image(character_id):
        payload = body()
        character = base.get_character(database, character_id)
        prompt = str(payload.get("prompt") or character.get("description") or character["name"]).strip()
        platform = str(payload.get("platform") or "mock")
        model = str(payload.get("model") or "")
        ratio = str(payload.get("ratio") or "1:1")
        task = manager.submit_image(prompt, platform, model, ratio, role_name=character["name"],
                                    script_id=None)
        return jsonify(task), 201

    @blueprint.post("/api/ai/characters/<character_id>/uses")
    def add_ai_character_use(character_id):
        payload = body()
        script_id = str(payload.get("script_id") or "").strip()
        script_title = str(payload.get("script_title") or "").strip()
        alias = str(payload.get("alias") or "").strip()
        if not script_id:
            raise AiError("缺少剧本 ID。", 400, "invalid_use")
        character = base.add_character_use(database, character_id, script_id, script_title, alias)
        return jsonify(character)

    @blueprint.delete("/api/ai/characters/<character_id>/uses")
    def remove_ai_character_use(character_id):
        script_id = str(request.args.get("script_id") or "").strip()
        alias = str(request.args.get("alias") or "").strip()
        if not script_id:
            raise AiError("缺少剧本 ID。", 400, "invalid_use")
        character = base.remove_character_use(database, character_id, script_id, alias)
        return jsonify(character)

    # ---------- 生成任务 ----------

    @blueprint.post("/api/ai/video/generate")
    def generate_ai_video():
        payload = body()
        task = manager.submit_video(
            prompt=str(payload.get("prompt") or ""),
            platform=str(payload.get("platform") or "mock"),
            model=str(payload.get("model") or ""),
            ratio=str(payload.get("ratio") or "9:16"),
            duration=int(payload.get("duration") or 10),
            script_id=str(payload.get("script_id") or ""),
            block_id=str(payload.get("block_id") or ""),
            ref_image=(payload.get("ref_image") or None),
            role_name=str(payload.get("role_name") or ""),
        )
        return jsonify(task), 201

    @blueprint.get("/api/ai/tasks")
    def list_ai_tasks():
        try:
            limit = max(1, min(int(request.args.get("limit", 100)), 500))
        except ValueError:
            limit = 100
        return jsonify(tasks=manager.list_tasks(limit))

    @blueprint.get("/api/ai/tasks/<task_id>")
    def get_ai_task(task_id):
        return jsonify(manager.get_task(task_id))

    @blueprint.post("/api/ai/tasks/<task_id>/cancel")
    def cancel_ai_task(task_id):
        return jsonify(manager.cancel_task(task_id))

    @blueprint.post("/api/ai/tasks/<task_id>/retry")
    def retry_ai_task(task_id):
        return jsonify(manager.retry_task(task_id))

    return blueprint
