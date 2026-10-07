"""AI 生成中心 —— Flask 蓝图路由。"""
from __future__ import annotations

import json
import time
from pathlib import Path, PurePosixPath
from typing import Optional

from flask import Blueprint, jsonify, request, send_from_directory
from storage import DomainError

from . import base
from .base import AiError
from .tasks import TaskManager

# ListModelActivations 结果缓存（避免每次 status 都发起签名请求；TTL 5 分钟）
_activation_cache: dict = {}
_ACTIVATION_TTL = 300


def _byte_activated(pcfg: dict, force: bool = False):
    """查询字节火山方舟「已开通」基础模型名单。返回 (names | None, configured)。
    configured=False 表示未配置 AK/SK；names=None 表示查询失败（调用方保持现状）。"""
    ak = str(pcfg.get("ak") or "").strip()
    sk = str(pcfg.get("sk") or "").strip()
    if not ak or not sk:
        return None, False
    key = (ak, sk)
    now = time.time()
    hit = _activation_cache.get(key)
    if not force and hit and now - hit[1] < _ACTIVATION_TTL:
        return hit[0], True
    from . import byte
    try:
        names = byte.ByteAdapter().list_activations(ak, sk)
    except Exception:
        names = None
    _activation_cache[key] = (names, now)
    return names, True


def _filter_models_by_activation(info: dict, pcfg: dict, force: bool = False):
    """配置了 AK/SK 时，用「已开通」名单过滤 models/image_models（治本：权威过滤）。"""
    names, configured = _byte_activated(pcfg, force)
    if not configured or names is None:
        return
    from . import byte
    fam = {byte.ByteAdapter._model_family(n) for n in names}
    for bucket in ("models", "image_models"):
        listed = info.get(bucket)
        if isinstance(listed, dict) and listed:
            info[bucket] = {k: v for k, v in listed.items()
                            if byte.ByteAdapter._model_family(k) in fam} or None
        else:
            info[bucket] = None


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

    def _refresh_platform_models(config: dict) -> dict:
        """对已配置密钥的平台查询可用模型，成功后写回 config（失败保留内置/原列表）。"""
        from . import ali, byte
        adapters = {"byte": byte.ByteAdapter, "ali": ali.AliAdapter}
        changed = False
        for name, adapter in adapters.items():
            pcfg = config.get("platforms", {}).get(name) or {}
            api_key = str(pcfg.get("api_key") or "").strip()
            if not api_key:
                continue
            try:
                listed = adapter(Path(".")).list_models(api_key)
            except Exception:
                listed = None
            if not listed:
                continue
            # 字节：配置 AK/SK 时按「已开通」名单权威过滤，只保留已开通模型写回
            if name == "byte":
                names, configured = _byte_activated(pcfg, force=True)
                if configured and names is not None:
                    fam = {byte.ByteAdapter._model_family(n) for n in names}
                    filtered_video = {k: v for k, v in (listed.get("video") or {}).items()
                                      if byte.ByteAdapter._model_family(k) in fam}
                    filtered_image = {k: v for k, v in (listed.get("image") or {}).items()
                                      if byte.ByteAdapter._model_family(k) in fam}
                    if filtered_video or filtered_image:
                        listed = {"video": filtered_video or None, "image": filtered_image or None}
                    else:
                        listed = {}
            if not listed:
                continue
            config.setdefault("platforms", {}).setdefault(name, {})
            if listed.get("video") or listed.get("image"):
                config["platforms"][name]["models"] = listed
                changed = True
        if changed:
            base.save_config(database, config)
        return config

    # ---------- 配置 ----------

    @blueprint.get("/api/ai/status")
    def ai_status():
        config = base.load_config(database)
        from . import ali, byte, mock
        platforms = {
            "byte": {"display": byte.ByteAdapter.display,
                     "models": byte.ByteAdapter.models,
                     "image_models": byte.ByteAdapter.image_models,
                     "audio_models": None,
                     "voice_models": byte.ByteAdapter.voice_models},
            "ali": {"display": ali.AliAdapter.display,
                    "models": ali.AliAdapter.models,
                    "image_models": ali.AliAdapter.image_models,
                    "audio_models": ali.AliAdapter.audio_models,
                    "voice_models": ali.AliAdapter.voice_models},
            "mock": {"display": mock.MockAdapter.display,
                     "models": mock.MockAdapter.models,
                     "image_models": mock.MockAdapter.image_models,
                     "audio_models": mock.MockAdapter.audio_models,
                     "voice_models": mock.MockAdapter.voice_models},
        }
        # 动态模型列表（来自密钥查询）覆盖内置默认
        for name, info in platforms.items():
            saved = (config.get("platforms", {}).get(name) or {}).get("models")
            if isinstance(saved, dict) and saved:
                if saved.get("video"):
                    info["models"] = saved["video"]
                if saved.get("image"):
                    info["image_models"] = saved["image"]
                if saved.get("audio"):
                    info["audio_models"] = saved["audio"]
                if saved.get("voice"):
                    info["voice_models"] = saved["voice"]
            pcfg = config.get("platforms", {}).get(name) or {}
            info["image_model"] = pcfg.get("image_model") or ""
            info["audio_model"] = pcfg.get("audio_model") or ""
            info["voice_model"] = pcfg.get("voice_model") or ""
            info["unavailable_models"] = list(pcfg.get("unavailable_models") or [])
            info["has_ak"] = bool(str(pcfg.get("ak") or "").strip())
            info["has_sk"] = bool(str(pcfg.get("sk") or "").strip())
            info["has_workspace_id"] = bool(str(pcfg.get("workspace_id") or "").strip())
            info["has_tts_api_key"] = bool(str(pcfg.get("tts_api_key") or "").strip())
            # 字节配置 AK/SK 后：只显示「已开通」模型（权威过滤，替代实测隐藏）
            if name == "byte":
                _filter_models_by_activation(info, pcfg, force=False)
        # SecretKey 属高敏感凭证，接口不回显明文
        for name in ("byte",):
            platform_cfg = config.get("platforms", {}).get(name)
            if platform_cfg and platform_cfg.get("sk"):
                platform_cfg["sk"] = "***"
        return jsonify(config=config, ratios=base.RATIOS, durations=list(base.DURATIONS),
                       platforms=platforms)

    @blueprint.get("/api/ai/config")
    def get_ai_config():
        return jsonify(config=base.load_config(database))

    @blueprint.post("/api/ai/config")
    def post_ai_config():
        payload = body()
        saved = base.save_config(database, payload)
        # 保存密钥后自动刷新该平台可用模型列表
        saved = _refresh_platform_models(saved)
        return jsonify(config=saved)

    @blueprint.post("/api/ai/models/refresh")
    def refresh_ai_models():
        config = _refresh_platform_models(base.load_config(database))
        from . import ali, byte, mock
        platforms = {
            "byte": {"display": byte.ByteAdapter.display, "models": byte.ByteAdapter.models,
                     "image_models": byte.ByteAdapter.image_models},
            "ali": {"display": ali.AliAdapter.display, "models": ali.AliAdapter.models,
                    "image_models": ali.AliAdapter.image_models},
            "mock": {"display": mock.MockAdapter.display, "models": mock.MockAdapter.models,
                     "image_models": mock.MockAdapter.image_models},
        }
        for name, info in platforms.items():
            saved = (config.get("platforms", {}).get(name) or {}).get("models")
            if isinstance(saved, dict) and saved:
                if saved.get("video"):
                    info["models"] = saved["video"]
                if saved.get("image"):
                    info["image_models"] = saved["image"]
            pcfg = config.get("platforms", {}).get(name) or {}
            info["has_ak"] = bool(str(pcfg.get("ak") or "").strip())
            info["has_sk"] = bool(str(pcfg.get("sk") or "").strip())
            if name == "byte":
                _filter_models_by_activation(info, pcfg, force=True)
        return jsonify(platforms=platforms, refreshed=True)

    @blueprint.post("/api/ai/test")
    def test_ai_connection():
        payload = body()
        platform = str(payload.get("platform") or "").strip()
        return jsonify(manager.test_platform(platform))

    @blueprint.post("/api/ai/byte/activations")
    def byte_activations():
        """一键测试字节「开通状态」：用 AK/SK 签名查询已开通模型（不产生任何费用）。"""
        payload = body()
        ak = str(payload.get("ak") or "").strip()
        sk = str(payload.get("sk") or "").strip()
        if not ak or not sk:
            # 输入框留空时回退到已保存的凭证（SecretKey 不回显，测试无需重填）
            saved_pcfg = (base.load_config(database).get("platforms", {}).get("byte") or {})
            ak = ak or str(saved_pcfg.get("ak") or "").strip()
            sk = sk or str(saved_pcfg.get("sk") or "").strip()
        if not ak or not sk:
            raise AiError("请先填写 AccessKey 与 SecretKey。", 400, "invalid_credentials")
        from . import byte
        try:
            names = byte.ByteAdapter().list_activations(ak, sk)
        except AiError as error:
            # 透传具体错误（HTTP 码 + 平台返回体），先翻译为通俗中文便于外行人定位问题
            return jsonify(ok=False, error="查询失败：" + base.friendly_error(error.message))
        except Exception as error:  # noqa: BLE001
            return jsonify(ok=False, error="查询失败：" + base.friendly_error(str(error)))
        if not names:
            return jsonify(ok=True, activated=[], count=0,
                           message="查询成功：当前账号未开通任何基础模型，请到「开通管理」开通。")
        return jsonify(ok=True, activated=names, count=len(names),
                       message=f"查询成功：已开通 {len(names)} 个基础模型。")

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

    @blueprint.post("/api/ai/image/generate")
    def generate_ai_image():
        """生成图片（通用文生图，也可带角色名用于写入角色库形象卡）。"""
        payload = body()
        task = manager.submit_image(
            prompt=str(payload.get("prompt") or ""),
            platform=str(payload.get("platform") or "mock"),
            model=str(payload.get("model") or ""),
            ratio=str(payload.get("ratio") or "1:1"),
            role_name=str(payload.get("role_name") or ""),
            script_id=str(payload.get("script_id") or ""),
        )
        return jsonify(task), 201

    @blueprint.get("/api/ai/tasks")
    def list_ai_tasks():
        try:
            limit = max(1, min(int(request.args.get("limit", 100)), 500))
        except ValueError:
            limit = 100
        return jsonify(tasks=manager.list_tasks(limit))

    @blueprint.post("/api/ai/audio/generate")
    def generate_ai_audio():
        """生成背景音乐/音效（fun-music 等音乐模型）。"""
        payload = body()
        task = manager.submit_audio(
            prompt=str(payload.get("prompt") or ""),
            platform=str(payload.get("platform") or "mock"),
            model=str(payload.get("model") or ""),
            script_id=str(payload.get("script_id") or ""),
            block_id=str(payload.get("block_id") or ""),
            role_name=str(payload.get("role_name") or ""),
        )
        return jsonify(task), 201

    @blueprint.post("/api/ai/voice/generate")
    def generate_ai_voice():
        """生成配音（文本转语音：豆包语音 / Qwen-TTS）。"""
        payload = body()
        task = manager.submit_voice(
            text=str(payload.get("text") or ""),
            platform=str(payload.get("platform") or "mock"),
            model=str(payload.get("model") or ""),
            voice_type=str(payload.get("voice_type") or ""),
            script_id=str(payload.get("script_id") or ""),
            block_id=str(payload.get("block_id") or ""),
            role_name=str(payload.get("role_name") or ""),
        )
        return jsonify(task), 201

    @blueprint.get("/api/ai/tasks/<task_id>")
    def get_ai_task(task_id):
        return jsonify(manager.get_task(task_id))

    @blueprint.post("/api/ai/tasks/<task_id>/cancel")
    def cancel_ai_task(task_id):
        return jsonify(manager.cancel_task(task_id))

    @blueprint.post("/api/ai/tasks/<task_id>/retry")
    def retry_ai_task(task_id):
        return jsonify(manager.retry_task(task_id))

    @blueprint.delete("/api/ai/tasks/finished")
    def clear_finished_ai_tasks():
        """清除所有已结束（已完成/失败/已取消）的生成任务记录；排队与生成中的任务保留。"""
        return jsonify(manager.clear_finished_tasks())

    # ---------- 已生成产物：浏览与手动插入正文 ----------

    _OUTPUT_EXT_KIND = {
        ".mp4": "video", ".mov": "video", ".webm": "video", ".m4v": "video", ".avi": "video",
        ".mp3": "audio", ".wav": "audio", ".m4a": "audio", ".ogg": "audio", ".flac": "audio",
        ".png": "image", ".jpg": "image", ".jpeg": "image", ".webp": "image", ".gif": "image",
    }
    _OUTPUT_DIR_KIND = {"video": "video", "audio": "audio", "voice": "voice", "image": "image"}

    @blueprint.get("/api/ai/outputs")
    def list_ai_outputs():
        """列出 ai_output 中已生成的产物（按分类子目录递归，时间倒序），
        分类以所在文件夹为准（video/audio/voice/image——配音与背景音乐分开），
        附带每个产物文件夹里的 meta.json（提示词/平台/模型/比例/时长/角色/目标段落等）。"""
        items = []
        output_dir = Path(manager.output_dir)
        if output_dir.is_dir():
            for file in output_dir.rglob("*"):
                if not file.is_file():
                    continue
                rel = file.relative_to(output_dir)
                if file.suffix.lower() == ".json":
                    continue  # 伴随元数据 meta.json 不作为产物列出
                kind = _OUTPUT_DIR_KIND.get(rel.parts[0]) if len(rel.parts) > 1 else None
                if not kind:
                    kind = _OUTPUT_EXT_KIND.get(file.suffix.lower())
                if not kind:
                    continue
                stat = file.stat()
                meta = None
                meta_file = file.parent / "meta.json"
                if meta_file.is_file():
                    try:
                        meta = json.loads(meta_file.read_text(encoding="utf-8"))
                    except Exception:  # noqa: BLE001
                        meta = None
                folder = str(rel.parent) if rel.parent != Path(".") else ""
                items.append({
                    "filename": file.name,
                    "folder": folder,
                    "kind": kind,
                    "size": stat.st_size,
                    "created_at": int(stat.st_mtime * 1000),
                    "url": "/ai-output/" + str(rel).replace("\\", "/"),
                    "meta": meta,
                })
        items.sort(key=lambda item: item["created_at"], reverse=True)
        return jsonify(outputs=items)

    @blueprint.get("/ai-output/<path:filename>")
    def ai_output_file(filename):
        """预览已生成的 AI 产物（音视频/图片）。"""
        # 防路径穿越：只允许 output_dir 内的文件
        safe = PurePosixPath(filename)
        if safe.name in ("", ".", "..") or ".." in safe.parts:
            raise AiError("非法文件路径。", 400, "invalid_path")
        return send_from_directory(manager.output_dir, filename)

    @blueprint.post("/api/ai/outputs/<path:filename>/insert")
    def insert_ai_output(filename):
        """把已生成的 AI 产物插入剧本指定正文段落后方。"""
        payload = body()
        script_id = str(payload.get("script_id") or "").strip()
        block_id = str(payload.get("block_id") or "").strip()
        if not script_id or not block_id:
            raise AiError("请选择目标剧本与正文段落。", 400, "missing_target")
        # 防路径穿越：只允许 output_dir 内的文件（支持分类子目录，如 video/xxx.mp4）
        rel = PurePosixPath(filename)
        if rel.name in ("", ".", "..") or ".." in rel.parts:
            raise AiError("非法文件路径。", 400, "invalid_path")
        source = Path(manager.output_dir) / rel
        if not source.is_file():
            raise AiError("产物文件不存在或已移动。", 404, "output_missing")
        kind = _OUTPUT_EXT_KIND.get(source.suffix.lower())
        if not kind or kind == "image":
            raise AiError("仅支持音视频产物插入正文。", 400, "invalid_output")
        try:
            with source.open("rb") as stream:
                asset = store.upload_block_media(stream, f"AI产物_{name}")
            updated = store.insert_block_media(script_id, block_id, asset, source="AI 产物")
        except DomainError as error:
            raise AiError(f"插入失败：{error}", error.status, error.code) from error
        inserted = next(
            (b for b in updated.get("blocks", []) if b.get("media_path") == asset["path"]), None)
        return jsonify({"ok": True, "block": inserted, "script": updated}), 201

    return blueprint
