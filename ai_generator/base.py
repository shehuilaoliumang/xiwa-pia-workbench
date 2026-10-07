"""AI 多媒体生成中心 —— 基础层。

独立于主播工作台主库运行：
  - 角色库 / 生成任务 / 平台配置全部存放在 instance/ai_generator.sqlite3，
    不触碰主库 schema（workbench.sqlite3），回退时只需删除该独立库与本包。
  - 生成结果先落 instance/ai_output/，挂载时复用 Store.upload_script_media，
    与原“手动上传音视频”走完全相同的校验、去重与历史记录路径。
"""
from __future__ import annotations

import json
import re
import secrets
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator, Optional

DB_FILENAME = "ai_generator.sqlite3"
OUTPUT_DIRNAME = "ai_output"
SCHEMA_VERSION = "1"

# 生成结果真实格式识别：不依赖扩展名，按文件头判断（供应商可能 jpeg 内容配 png 后缀）
_IMAGE_MAGIC = (
    (b"\x89PNG\r\n\x1a\n", ".png"),
    (b"\xff\xd8\xff", ".jpg"),
    (b"RIFF", ".webp"),  # RIFF....WEBP
    (b"GIF87a", ".gif"),
    (b"GIF89a", ".gif"),
    (b"BM", ".bmp"),
)


def detect_image_ext(raw: bytes) -> str:
    """按真实文件头返回图片扩展名（.png/.jpg/.webp/.gif/.bmp）；无法识别返回 .png。"""
    for magic, ext in _IMAGE_MAGIC:
        if magic == b"RIFF":
            if raw[:4] == magic and raw[8:12] == b"WEBP":
                return ext
        elif raw.startswith(magic):
            return ext
    return ".png"

DEFAULT_CONFIG = {
    "enabled": False,
    "default_ratio": "9:16",
    "default_duration": 10,
    "platforms": {
        "mock": {"model": "mock-v1", "api_key": "", "endpoint": ""},
        "byte": {"model": "seedance-2.0-pro", "api_key": "", "endpoint": "https://ark.cn-beijing.volces.com/api/v3/",
                 "tts_api_key": ""},
        "ali": {"model": "wanx2.1-t2v-turbo", "api_key": "", "endpoint": "https://dashscope.aliyuncs.com/api/v1/",
                "workspace_id": ""},
    },
}

RATIOS = {"9:16": "竖屏 9:16", "16:9": "横屏 16:9", "1:1": "方形 1:1", "3:4": "竖屏 3:4", "4:3": "横屏 4:3"}
DURATIONS = (5, 10, 15, 20, 30)


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def new_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(8)}"


def _error_fields(text: str) -> tuple[str, str]:
    """从平台报错文本里尽力提取 code 与英文 message；取不到就返回空。"""
    match = re.search(r"\{.*\}", str(text or ""), re.S)
    if not match:
        return "", ""
    try:
        payload = json.loads(match.group(0))
    except (ValueError, RecursionError):
        return "", ""
    error = payload.get("error") if isinstance(payload.get("error"), dict) else payload
    code = str(error.get("code") or "")
    message = str(error.get("message") or "")
    return code, message


def friendly_error(message: str) -> str:
    """把平台英文/JSON 报错翻译成外行人友好的中文；无法识别时原样返回。"""
    text = str(message or "")
    if not text:
        return text
    code, raw_message = _error_fields(text)
    lower = " ".join((code, raw_message, text)).lower()
    model = re.search(r"已尝试模型[:：]\s*([^\s）)]+)", text)
    model_note = f"（模型：{model.group(1)}）" if model else ""
    head = text.split("：", 1)[0] if "：" in text else text.split(":", 1)[0]

    if "accountoverdue" in lower or "overdue balance" in lower:
        return (f"{head} · 账户欠费\n"
                "你的火山引擎账户有逾期未结清的账单，平台已暂停生成服务。\n"
                "请登录火山方舟控制台 → 费用中心，结清账单后再重试。"
                f"{model_note}")
    if "invalidendpointormodel" in lower or "modelnotopen" in lower or "not activated" in lower or "does not exist" in lower:
        return (f"{head} · 模型未开通\n"
                "这个模型在你的账号里还没有开通（或已下线）。\n"
                "请登录火山方舟控制台 → 「开通管理」，开通对应模型后重试；"
                "也可以回到「AI 生成设置」刷新模型列表，只保留已开通的模型。"
                f"{model_note}")
    if "setlimitexceeded" in lower or "usage limit" in lower:
        return (f"{head} · 用量已达上限\n"
                "该模型在你账号上的免费/安全体验额度已经用完，服务被暂停。\n"
                "请到火山方舟控制台 → 模型开通页，调整或关闭「安全体验模式」后重试。"
                f"{model_note}")
    if "signaturedoesnotmatch" in lower or "signature" in lower and "401" in text:
        return (f"{head} · 密钥校验失败\n"
                "AccessKey / SecretKey 签名对不上，请检查 AI 设置里的密钥是否正确、"
                "是否有遗漏或复制错字符。")
    if "missingparameter" in lower and "content" in lower:
        return (f"{head} · 缺少生成内容\n"
                "请求缺少画面描述内容，请填写剧情描述后再生成。"
                f"{model_note}")
    if "does not support content generation" in lower:
        return (f"{head} · 模型不支持此任务\n"
                "这个模型不支持当前类型的生成（例如用图像模型生成视频）。\n"
                "请在「AI 生成设置」中把视频/图像模型分别换成支持的模型。"
                f"{model_note}")
    if "url error" in lower or "please check url" in lower:
        return (f"{head} · 服务未开通或地址有误\n"
                "阿里百炼返回地址错误，通常是该模型尚未开通或服务地址变化。\n"
                "请到阿里百炼控制台确认已开通对应模型服务，并在设置里刷新模型。"
                f"{model_note}")
    if "invalidapikey" in lower or "unauthorized" in lower or "authentication" in lower:
        return (f"{head} · 密钥无效\n"
                "API 密钥校验失败，请检查 AI 设置里的密钥是否正确、是否已过期。")
    # 未识别：保留原始报错，但去掉过长的 Request id 以便阅读
    return text


class AiError(Exception):
    """领域错误，携带面向用户的中文消息。"""

    def __init__(self, message: str, status: int = 400, code: str = "ai_error"):
        super().__init__(message)
        self.message = message
        self.status = status
        self.code = code


def _connect(database: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(str(database), timeout=15)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA busy_timeout=15000")
    connection.execute("PRAGMA foreign_keys=ON")
    return connection


@contextmanager
def db_scope(database: Path) -> Iterator[sqlite3.Connection]:
    """自动提交并关闭的连接上下文（sqlite3 的 with 语句不会关闭连接）。"""
    connection = _connect(database)
    try:
        yield connection
        connection.commit()
    finally:
        connection.close()


def initialize_database(database: Path) -> None:
    database.parent.mkdir(parents=True, exist_ok=True)
    with db_scope(database) as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS ai_config(key TEXT PRIMARY KEY, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS ai_characters(
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                description TEXT NOT NULL DEFAULT '',
                image_file TEXT,
                image_sha256 TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS ai_character_uses(
                character_id TEXT NOT NULL REFERENCES ai_characters(id) ON DELETE CASCADE,
                script_id TEXT NOT NULL,
                script_title TEXT NOT NULL DEFAULT '',
                alias TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                PRIMARY KEY (character_id, script_id, alias)
            );
            CREATE TABLE IF NOT EXISTS ai_tasks(
                id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL UNIQUE,
                kind TEXT NOT NULL,
                platform TEXT NOT NULL,
                model TEXT NOT NULL DEFAULT '',
                prompt TEXT NOT NULL DEFAULT '',
                ref_image TEXT,
                ratio TEXT NOT NULL DEFAULT '9:16',
                duration INTEGER,
                status TEXT NOT NULL DEFAULT 'queued',
                progress INTEGER NOT NULL DEFAULT 0,
                result_file TEXT,
                error TEXT,
                script_id TEXT,
                block_id TEXT,
                role_name TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            """
        )
        connection.execute("INSERT OR REPLACE INTO meta VALUES('schema_version',?)", (SCHEMA_VERSION,))
        # 配音任务的音色字段（老库无此列时补充）
        try:
            connection.execute("ALTER TABLE ai_tasks ADD COLUMN voice_type TEXT NOT NULL DEFAULT ''")
        except sqlite3.OperationalError:
            pass  # 列已存在


def load_config(database: Path) -> dict:
    with db_scope(database) as connection:
        row = connection.execute("SELECT data FROM ai_config WHERE key='main'").fetchone()
        value = json.loads(row[0]) if row else {}
    merged = json.loads(json.dumps(DEFAULT_CONFIG))
    for section in ("platforms",):
        merged[section].update(value.get(section, {}))
    for key in ("enabled", "default_ratio", "default_duration"):
        if key in value:
            merged[key] = value[key]
    return merged


def save_config(database: Path, payload: dict) -> dict:
    current = load_config(database)
    if "enabled" in payload and isinstance(payload["enabled"], bool):
        current["enabled"] = payload["enabled"]
    if "default_ratio" in payload:
        if payload["default_ratio"] not in RATIOS:
            raise AiError("默认比例不支持。", 400, "invalid_ratio")
        current["default_ratio"] = payload["default_ratio"]
    if "default_duration" in payload:
        if payload["default_duration"] not in DURATIONS:
            raise AiError("默认时长不支持。", 400, "invalid_duration")
        current["default_duration"] = payload["default_duration"]
    platforms = payload.get("platforms")
    if isinstance(platforms, dict):
        for name, values in platforms.items():
            if name not in current["platforms"]:
                raise AiError(f"平台 {name} 不受支持。", 400, "unknown_platform")
            if not isinstance(values, dict):
                raise AiError("平台配置格式无效。", 400, "invalid_platform")
            current["platforms"][name].update({k: str(values[k]) for k in ("model", "image_model", "audio_model", "voice_model", "api_key", "endpoint", "ak", "sk", "tts_api_key", "workspace_id") if k in values})
            if isinstance(values.get("models"), dict) and values["models"]:
                current["platforms"][name]["models"] = values["models"]
            if isinstance(values.get("unavailable_models"), list):
                current["platforms"][name]["unavailable_models"] = [str(m) for m in values["unavailable_models"]]
    with db_scope(database) as connection:
        connection.execute(
            "INSERT INTO ai_config(key,data) VALUES('main',?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
            (json.dumps(current, ensure_ascii=False),),
        )
    return current


def list_characters(database: Path) -> list[dict]:
    with db_scope(database) as connection:
        rows = connection.execute(
            "SELECT * FROM ai_characters ORDER BY updated_at DESC"
        ).fetchall()
        uses = {
            row["character_id"]: [dict(u) for u in connection.execute(
                "SELECT script_id, script_title, alias, created_at FROM ai_character_uses ORDER BY created_at"
            ).fetchall()]
            for row in connection.execute("SELECT DISTINCT character_id FROM ai_character_uses").fetchall()
        }
    result = []
    for row in rows:
        item = dict(row)
        item["uses"] = uses.get(item["id"], [])
        result.append(item)
    return result


def get_character(database: Path, character_id: str) -> dict:
    with db_scope(database) as connection:
        row = connection.execute("SELECT * FROM ai_characters WHERE id=?", (character_id,)).fetchone()
        if not row:
            raise AiError("角色不存在。", 404, "character_not_found")
        item = dict(row)
        item["uses"] = [dict(u) for u in connection.execute(
            "SELECT script_id, script_title, alias, created_at FROM ai_character_uses WHERE character_id=? ORDER BY created_at",
            (character_id,),
        ).fetchall()]
        return item


def save_character(database: Path, payload: dict, character_id: Optional[str] = None) -> dict:
    name = str(payload.get("name", "")).strip()
    if not name or len(name) > 200:
        raise AiError("角色名不能为空且不超过 200 字。", 400, "invalid_character")
    description = str(payload.get("description", "")).strip()[:2000]
    now = utcnow()
    with db_scope(database) as connection:
        if character_id:
            row = connection.execute("SELECT * FROM ai_characters WHERE id=?", (character_id,)).fetchone()
            if not row:
                raise AiError("角色不存在。", 404, "character_not_found")
            existing = connection.execute("SELECT id FROM ai_characters WHERE name=? AND id<>?", (name, character_id)).fetchone()
            if existing:
                raise AiError("已有同名角色，请直接选择或换一个名字。", 409, "duplicate_character")
            connection.execute(
                "UPDATE ai_characters SET name=?, description=?, updated_at=? WHERE id=?",
                (name, description, now, character_id),
            )
        else:
            existing = connection.execute("SELECT id FROM ai_characters WHERE name=?", (name,)).fetchone()
            if existing:
                raise AiError("已有同名角色，请直接选择或换一个名字。", 409, "duplicate_character")
            character_id = new_id("char")
            connection.execute(
                "INSERT INTO ai_characters(id,name,description,created_at,updated_at) VALUES(?,?,?,?,?)",
                (character_id, name, description, now, now),
            )
    return get_character(database, character_id)


def delete_character(database: Path, character_id: str) -> None:
    with db_scope(database) as connection:
        connection.execute("DELETE FROM ai_characters WHERE id=?", (character_id,))


def set_character_image(database: Path, character_id: str, file_path: str, sha256: str) -> dict:
    with db_scope(database) as connection:
        row = connection.execute("SELECT id FROM ai_characters WHERE id=?", (character_id,)).fetchone()
        if not row:
            raise AiError("角色不存在。", 404, "character_not_found")
        connection.execute(
            "UPDATE ai_characters SET image_file=?, image_sha256=?, updated_at=? WHERE id=?",
            (file_path, sha256, utcnow(), character_id),
        )
    return get_character(database, character_id)


def add_character_use(database: Path, character_id: str, script_id: str, script_title: str, alias: str) -> dict:
    alias = str(alias or "").strip()[:200]
    with db_scope(database) as connection:
        row = connection.execute("SELECT id FROM ai_characters WHERE id=?", (character_id,)).fetchone()
        if not row:
            raise AiError("角色不存在。", 404, "character_not_found")
        connection.execute(
            "INSERT OR REPLACE INTO ai_character_uses(character_id,script_id,script_title,alias,created_at) VALUES(?,?,?,?,?)",
            (character_id, script_id, script_title, alias, utcnow()),
        )
    return get_character(database, character_id)


def remove_character_use(database: Path, character_id: str, script_id: str, alias: str) -> dict:
    with db_scope(database) as connection:
        connection.execute(
            "DELETE FROM ai_character_uses WHERE character_id=? AND script_id=? AND alias=?",
            (character_id, script_id, alias),
        )
    return get_character(database, character_id)


def find_character_for_role(database: Path, script_id: str, role_name: str) -> Optional[dict]:
    """段落角色名 → 全局角色库：先按剧本内别名精确匹配，再按角色名同名匹配。"""
    with db_scope(database) as connection:
        row = connection.execute(
            "SELECT c.* FROM ai_character_uses u JOIN ai_characters c ON c.id=u.character_id "
            "WHERE u.script_id=? AND (u.alias=? OR c.name=?) ORDER BY (u.alias=?) DESC LIMIT 1",
            (script_id, role_name, role_name, role_name),
        ).fetchone()
        return dict(row) if row else None
