"""SQLite persistence and the workbench's preview/live-state boundary.

The database stores source-preserving documents as JSON inside a small relational
schema. All writes are transactions. A live snapshot is a detached copy, never a
foreign-key view of the editable library.
"""

from __future__ import annotations

import copy
import hashlib
import io
import json
import math
import re
import sqlite3
import stat
import tempfile
import threading
import uuid

from template_config import BACKUP_FORMAT, TERMS
import warnings
import zipfile
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath


SCHEMA_VERSION = 1
UNCATEGORIZED = "uncategorized"
#: 系统「未分组」的显示名，统一由配置中心提供。
UNCATEGORIZED_NAME = TERMS.get("uncategorized", "未分组")
BACKGROUND_MAX_BYTES = 12 * 1024 * 1024
BACKGROUND_MAX_PIXELS = 25_000_000
MEDIA_MAX_BYTES = 200 * 1024 * 1024
MEDIA_MAX_SECONDS = 7 * 24 * 60 * 60
MEDIA_FORMATS = {".mp4": ("video", "video/mp4"), ".webm": ("video", "video/webm"),
                 ".mp3": ("audio", "audio/mpeg"), ".wav": ("audio", "audio/wav"),
                 ".m4a": ("audio", "audio/mp4"), ".ogg": ("audio", "audio/ogg")}
SNAPSHOT_CONTENT_KEYS = ("categories", "scripts", "layout", "selection", "mode", "orientation",
                         "directory_level", "focus_category_id")
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff", ".emf", ".wmf"}
DEFAULT_LAYOUTS = {
    "portrait": {"font_size": 34, "line_height": 1.7, "padding": 56, "background_opacity": 0.18, "speed": 28,
                 "category_columns": 0, "category_background_opacity": 0.8, "body_mode": "pages",
                 "media_caption_mode": "auto", "media_side": "left", "media_caption_layout": "pages"},
    "landscape": {"font_size": 32, "line_height": 1.7, "padding": 64, "background_opacity": 0.18, "speed": 32,
                  "category_columns": 0, "category_background_opacity": 0.8, "body_mode": "pages",
                 "media_caption_mode": "auto", "media_side": "left", "media_caption_layout": "pages"},
}


class DomainError(Exception):
    def __init__(self, message, status=400, code="validation_error"):
        super().__init__(message)
        self.status = status
        self.code = code


def now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def text(value, name, maximum=10000, required=False, trim=False):
    if value is None:
        value = ""
    if not isinstance(value, str):
        raise DomainError(f"{name}必须是文字。")
    if trim:
        value = value.strip()
    if len(value) > maximum or "\x00" in value:
        raise DomainError(f"{name}过长或包含无效字符。")
    if required and not value.strip():
        raise DomainError(f"请填写{name}。")
    return value


def identifier(value, name="ID"):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}", value):
        raise DomainError(f"{name}无效。")
    return value


def boolean(value, name):
    if type(value) is int and value in (0, 1):
        return bool(value)
    if not isinstance(value, bool):
        raise DomainError(f"{name}必须为 true 或 false。")
    return value


def number(value, name, low, high, integer=False):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise DomainError(f"{name}必须是有效数字。")
    if not low <= value <= high or (integer and int(value) != value):
        raise DomainError(f"{name}须在 {low}–{high} 范围内。")
    return int(value) if integer else value


def color(value, fallback="#6e9a8b"):
    if value in (None, ""):
        return fallback
    if not isinstance(value, str) or not re.fullmatch(r"#?[0-9a-fA-F]{6}", value):
        raise DomainError("颜色须为六位十六进制色值。")
    return "#" + value.lstrip("#").lower()


def asset_path(value):
    if value in (None, ""):
        return ""
    value = text(value, "图片路径", 500, trim=True)
    if not value.startswith("/"):
        value = "/" + value
    path = PurePosixPath(value)
    if ("\\" in value or "%" in value or "?" in value or "#" in value
            or ".." in path.parts or "." in path.parts
            or not (value.startswith("/static/media/") or value.startswith("/media/"))
            or path.suffix.lower() not in IMAGE_EXTENSIONS):
        raise DomainError("图片必须引用项目内的本地图片资源。")
    if "//" in value:
        raise DomainError("图片路径无效。")
    return str(path)



def media_path(value):
    value = text(value, "音视频路径", 500, True)
    allowed = "|".join(re.escape(suffix) for suffix in MEDIA_FORMATS)
    if not re.fullmatch(r"/media/[0-9a-f]{64}(?:" + allowed + r")", value):
        raise DomainError("音视频必须引用工作台保存的本地媒体资源。", 400, "invalid_media")
    return value


def resource_path(value):
    if isinstance(value, str) and PurePosixPath(value).suffix.lower() in MEDIA_FORMATS:
        return media_path(value)
    return asset_path(value)


def media_duration(value):
    if value is None:
        return None
    result = number(value, "媒体时长", 0, MEDIA_MAX_SECONDS)
    if result == 0:
        raise DomainError("媒体时长须大于 0 秒。", 400, "invalid_media")
    return result


def normalize_cues(values, blocks, duration):
    if not isinstance(values, list) or len(values) > 5000:
        raise DomainError("时间点须为不超过 5000 项的列表。", 400, "invalid_cues")
    valid_blocks = {block["id"] for block in blocks}
    cues, ids, times = [], set(), set()
    for value in values:
        if not isinstance(value, dict):
            raise DomainError("时间点格式无效。", 400, "invalid_cues")
        cue_id = identifier(value.get("id"), "时间点 ID")
        at = number(value.get("at"), "时间点秒数", 0, duration if duration is not None else MEDIA_MAX_SECONDS)
        if cue_id in ids:
            raise DomainError("时间点 ID 不能重复。", 400, "invalid_cues")
        if at in times:
            raise DomainError("同一时间点请多选台词，不要创建重复秒数的时间点。", 400, "invalid_cues")
        block_ids = id_list(value.get("block_ids"), "时间点台词", 20000)
        if not block_ids or any(block_id not in valid_blocks for block_id in block_ids):
            raise DomainError("每个时间点须选择存在的正文段落；删除正文前请先调整相关时间点。", 400, "invalid_cues")
        cues.append({"id": cue_id, "at": at, "label": text(value.get("label", ""), "时间点名称", 200),
                     "block_ids": block_ids})
        ids.add(cue_id)
        times.add(at)
    return sorted(cues, key=lambda cue: cue["at"])


def normalize_media(value, blocks):
    if not isinstance(value, dict):
        raise DomainError("音视频资料格式无效。", 400, "invalid_media")
    path = media_path(value.get("path"))
    kind = MEDIA_FORMATS[PurePosixPath(path).suffix][0]
    if value.get("kind") != kind or value.get("sha256") != PurePosixPath(path).stem:
        raise DomainError("音视频类型或内容校验值无效。", 400, "invalid_media")
    duration = media_duration(value.get("duration"))
    return {"path": path, "kind": kind, "name": text(value.get("name"), "媒体名称", 255, True),
            "size": number(value.get("size"), "媒体大小", 1, MEDIA_MAX_BYTES, True),
            "sha256": value["sha256"], "duration": duration,
            "cues": normalize_cues(value.get("cues", []), blocks, duration)}


def validate_media_stream(stream, extension, size):
    """Check container signatures/structure, not codec support or full decoding."""
    if extension not in MEDIA_FORMATS or not 0 < size <= MEDIA_MAX_BYTES:
        raise DomainError("请选择不超过 200 MB 的 MP4、WebM、MP3、WAV、M4A 或 OGG 文件。", 400, "invalid_media")
    stream.seek(0)
    header = stream.read(min(size, 65536))
    valid = False
    if extension in {".mp4", ".m4a"}:
        position, boxes, brands = 0, set(), set()
        for _ in range(10000):
            if position == size:
                valid = bool({b"ftyp", b"moov", b"mdat"} <= boxes)
                break
            if size - position < 8:
                break
            stream.seek(position)
            box = stream.read(16)
            length, kind = int.from_bytes(box[:4], "big"), box[4:8]
            header_length = 8
            if length == 1:
                length, header_length = int.from_bytes(box[8:16], "big"), 16
            elif length == 0:
                length = size - position
            if length < header_length or position + length > size:
                break
            if kind == b"ftyp":
                if position != 0 or length < header_length + 8 or length > 4096:
                    break
                stream.seek(position + header_length)
                payload = stream.read(length - header_length)
                brands = {payload[:4], *(payload[i:i + 4] for i in range(8, len(payload), 4))}
                allowed = {b"isom", b"iso2", b"iso5", b"iso6", b"mp41", b"mp42", b"avc1", b"M4V ", b"M4A "}
                if not brands & allowed:
                    break
            boxes.add(kind)
            position += length
    elif extension == ".webm":
        valid = (header.startswith(b"\x1aE\xdf\xa3") and b"\x42\x82\x84webm" in header[:4096]
                 and b"\x18\x53\x80\x67" in header)
    elif extension == ".wav":
        valid = header.startswith(b"RIFF") and header[8:12] == b"WAVE" and int.from_bytes(header[4:8], "little") + 8 == size
        position, seen, chunk_count = 12, set(), 0
        while valid and position + 8 <= size and chunk_count < 10000:
            chunk_count += 1
            stream.seek(position)
            chunk = stream.read(8)
            length = int.from_bytes(chunk[4:], "little")
            if position + 8 + length > size:
                valid = False
                break
            if chunk[:4] == b"fmt " and length < 16:
                valid = False
                break
            seen.add(chunk[:4])
            position += 8 + length + (length % 2)
        valid = valid and position == size and {b"fmt ", b"data"} <= seen
    elif extension == ".mp3":
        offset = 0
        if header.startswith(b"ID3") and len(header) >= 10:
            if header[3] not in {2, 3, 4} or any(value & 128 for value in header[6:10]):
                raise DomainError("MP3 标记头无效。", 400, "invalid_media")
            offset = 10 + sum(value << (7 * (3 - index)) for index, value in enumerate(header[6:10]))
            if header[3] == 4 and header[5] & 16:
                offset += 10
        stream.seek(offset)
        frame = stream.read(4)
        valid = (len(frame) == 4 and frame[0] == 255 and frame[1] & 224 == 224
                 and (frame[1] >> 3) & 3 != 1 and (frame[1] >> 1) & 3 != 0
                 and (frame[2] >> 4) not in {0, 15} and (frame[2] >> 2) & 3 != 3
                 and size - offset > 4)
    elif extension == ".ogg":
        if len(header) >= 27 and header[:4] == b"OggS" and header[4] == 0 and header[5] & 2:
            segments = header[26]
            start = 27 + segments
            packet = header[start:]
            valid = (segments > 0 and len(header) >= start and start + sum(header[27:start]) <= size
                     and (packet.startswith(b"OpusHead") or packet.startswith(b"\x01vorbis")))
    if not valid:
        raise DomainError("文件内容与所选音视频格式不符，或媒体容器已损坏。", 400, "invalid_media")
    stream.seek(0)
    return MEDIA_FORMATS[extension][0]


def media_items(value):
    if isinstance(value, dict):
        for key, child in value.items():
            if key == "media" and isinstance(child, dict):
                yield child
            else:
                yield from media_items(child)
    elif isinstance(value, list):
        for child in value:
            yield from media_items(child)


def id_list(value, name, maximum=5000):
    if not isinstance(value, list) or len(value) > maximum:
        raise DomainError(f"{name}必须是长度合理的列表。")
    result = [identifier(item, name) for item in value]
    if len(result) != len(set(result)):
        raise DomainError(f"{name}不能包含重复项目。")
    return result


def normalize_layout(value, orientation, base=None):
    if not isinstance(orientation, str) or orientation not in DEFAULT_LAYOUTS:
        raise DomainError("请选择竖屏或横屏。")
    if not isinstance(value, dict):
        raise DomainError("排版配置格式无效。")
    result = copy.deepcopy(DEFAULT_LAYOUTS[orientation])
    if base is not None:
        result.update(copy.deepcopy(base))
    bounds = {"font_size": (16, 96), "line_height": (1.1, 3.0), "padding": (12, 200),
              "background_opacity": (0, 1), "speed": (5, 180), "category_background_opacity": (0, 1)}
    for key, limits in bounds.items():
        if key in value:
            result[key] = number(value[key], key, *limits)
    if "category_columns" in value:
        columns = value["category_columns"]
        if type(columns) is not int or not 0 <= columns <= 4:
            raise DomainError("分组列数须为 0（自动）或 1–4 的整数。")
        result["category_columns"] = columns
    if "body_mode" in value:
        mode = value["body_mode"]
        if not isinstance(mode, str) or mode not in {"scroll", "pages", "media"}:
            raise DomainError("正文模式须为 scroll、pages 或 media。")
        result["body_mode"] = mode
    for field, choices in (("media_caption_mode", {"auto", "manual"}), ("media_side", {"left", "right"}),
                           ("media_caption_layout", {"pages", "scroll"})):
        if field in value:
            if not isinstance(value[field], str) or value[field] not in choices:
                raise DomainError("媒体字幕模式、左右布局或台词阅读方式无效。")
            result[field] = value[field]
    return result



def normalize_snapshot_layout(value, orientation):
    # Before body_mode existed, live snapshots always meant continuous scroll.
    # Changing the defaults for new drafts must not reinterpret frozen content.
    if isinstance(value, dict) and "body_mode" not in value:
        value = {**value, "body_mode": "scroll"}
    return normalize_layout(value, orientation)


def normalize_layout_presets(values):
    if not isinstance(values, list) or len(values) > 10:
        raise DomainError("自定义排版预设最多保存 10 套。")
    result, ids, names = [], set(), set()
    for value in values:
        if not isinstance(value, dict):
            raise DomainError("排版预设格式无效。")
        item_id = identifier(value.get("id"), "预设 ID")
        name = text(value.get("name"), "预设名称", 80, True, True)
        layouts = value.get("layouts")
        if not isinstance(layouts, dict) or set(layouts) != set(DEFAULT_LAYOUTS):
            raise DomainError("排版预设须同时包含 portrait 和 landscape 两种画幅。")
        if item_id in ids or name.casefold() in names:
            raise DomainError("排版预设 ID 或名称不能重复。", 409, "duplicate_preset")
        ids.add(item_id)
        names.add(name.casefold())
        result.append({"id": item_id, "name": name,
                       "layouts": {orientation: normalize_layout(layouts[orientation], orientation)
                                   for orientation in DEFAULT_LAYOUTS}})
    return result


def is_paged(snapshot):
    return bool(snapshot and snapshot.get("mode") == "script" and snapshot.get("layout", {}).get("body_mode", "scroll") == "pages")



def is_media(snapshot):
    return bool(snapshot and snapshot.get("mode") == "script" and snapshot.get("layout", {}).get("body_mode") == "media")


def default_media_state():
    return {"position": 0, "caption_index": 0, "caption_page_index": 0, "cue_id": None}


def normalize_media_state(value, snapshot):
    if not is_media(snapshot) or len(snapshot.get("scripts", [])) != 1 or not snapshot["scripts"][0].get("media"):
        raise DomainError("当前展示不是已配音视频的条目。", 400, "invalid_media_state")
    if not isinstance(value, dict) or not {"position", "caption_index", "cue_id"} <= set(value):
        raise DomainError("媒体状态须包含播放位置、字幕序号和时间点。", 400, "invalid_media_state")
    script = snapshot["scripts"][0]
    media = script["media"]
    position = number(value["position"], "媒体位置", 0, media.get("duration") or MEDIA_MAX_SECONDS)
    cues = media.get("cues", [])
    count = len(cues) if cues else len(script["blocks"])
    index = value["caption_index"]
    if type(index) is not int or not 0 <= index <= max(0, count - 1):
        raise DomainError("字幕序号不属于当前上屏内容。", 409, "invalid_media_state")
    cue = value["cue_id"]
    if cue is not None and (not isinstance(cue, str) or cue not in {item["id"] for item in cues}):
        raise DomainError("时间点不属于当前上屏媒体。", 409, "invalid_media_state")
    # Older clients and backups did not carry a page within the current caption
    # group. The browser owns actual pagination; only validate a bounded index.
    page_index = value.get("caption_page_index", 0)
    if type(page_index) is not int or not 0 <= page_index <= 100000:
        raise DomainError("台词页位置须为 0–100000 的整数。", 400, "invalid_media_state")
    return {"position": position, "caption_index": index, "caption_page_index": page_index, "cue_id": cue}


def normalize_saved_media_state(state):
    snapshot = state.get("snapshot")
    state["media_state"] = (normalize_media_state(state.get("media_state", default_media_state()), snapshot)
                            if is_media(snapshot) else default_media_state())
    return state


def page_number(value):
    if type(value) is not int or not 0 <= value <= 100000:
        raise DomainError("页位置须为 0–100000 的整数。", 400, "invalid_page")
    return value


def normalize_page_state(state):
    position = state.get("page_index")
    if position is not None:
        page_number(position)
        if not is_paged(state.get("snapshot")):
            raise DomainError("只有分页正文可以保存页位置。", 400, "invalid_page")
    state["page_index"] = position
    if is_paged(state.get("snapshot")):
        state["playing"] = False
    return state


def normalize_category(data, existing=None):
    if not isinstance(data, dict):
        raise DomainError("分组资料格式无效。")
    previous = existing or {}
    result = {
        "id": identifier(previous.get("id") or data.get("id") or "cat-" + uuid.uuid4().hex[:12]),
        "name": text(data.get("name", previous.get("name")), "分组名称", 80, True, True),
        "description": text(data.get("description", previous.get("description", "")), "分组说明", 5000),
        "color": color(data.get("color", previous.get("color"))),
        "background": asset_path(data.get("background", previous.get("background", ""))),
        "sort_order": number(data.get("sort_order", previous.get("sort_order", 0)), "分组顺序", 0, 1000000, True),
        "visible": boolean(data.get("visible", previous.get("visible", True)), "分组显示状态"),
        "system": (previous.get("id") or data.get("id")) == UNCATEGORIZED,
    }
    if result["id"] == UNCATEGORIZED:
        result.update(name=UNCATEGORIZED_NAME, visible=True, system=True)
    return result


def normalize_script(data, existing=None, source_import=False):
    if not isinstance(data, dict):
        raise DomainError("条目资料格式无效。")
    previous = existing or {}
    result = copy.deepcopy(previous)
    result["id"] = identifier(previous.get("id") or data.get("id") or "script-" + uuid.uuid4().hex[:12])
    for field, title, limit in [("title", "剧名", 200), ("author", "作者", 500),
                                ("synopsis", "简介", 20000), ("cast_note", "配音配置", 5000),
                                ("notes", "核对备注", 40000)]:
        result[field] = text(data.get(field, previous.get(field, "")), title, limit, field == "title", field == "title")
    result["category_id"] = identifier(data.get("category_id", previous.get("category_id", UNCATEGORIZED)))
    visible = data.get("visible", data.get("enabled", previous.get("visible", True)))
    result["visible"] = boolean(visible, "条目显示状态")
    tags = data.get("tags", previous.get("tags", []))
    if not isinstance(tags, list) or len(tags) > 100:
        raise DomainError("标签须为不超过 100 项的列表。")
    result["tags"] = list(dict.fromkeys(text(tag, "标签", 80, True, True) for tag in tags))
    role_colors = data.get("role_colors", previous.get("role_colors", {}))
    if not isinstance(role_colors, dict) or len(role_colors) > 200:
        raise DomainError("角色默认配色须为不超过 200 项的对象。")
    result["role_colors"] = {}
    for role, value in role_colors.items():
        role = text(role, "角色名称", 200, True, True)
        if role in result["role_colors"]:
            raise DomainError("角色默认配色包含重复角色名。")
        if not isinstance(value, str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", value):
            raise DomainError("角色默认配色须为 #RRGGBB 色值。")
        result["role_colors"][role] = color(value)
    # Source fields are write-protected after import. Edits retain a full history.
    source = data if source_import else previous
    result["source_category"] = text(source.get("source_category", "用户新增"), "原分组", 200)
    pages = source.get("source_pages", [])
    if not isinstance(pages, list) or len(pages) > 5000:
        raise DomainError("来源页码格式无效。")
    result["source_pages"] = [number(page, "来源页码", 1, 100000, True) for page in pages]
    blocks = data.get("blocks", previous.get("blocks", []))
    if not isinstance(blocks, list) or len(blocks) > 20000:
        raise DomainError("正文段落数量无效。")
    old_blocks = {block["id"]: block for block in previous.get("blocks", [])}
    normalized, seen = [], set()
    for block in blocks:
        if not isinstance(block, dict):
            raise DomainError("正文段落格式无效。")
        block_id = identifier(block.get("id") or "block-" + uuid.uuid4().hex)
        if block_id in seen:
            raise DomainError("段落 ID 不能重复。")
        seen.add(block_id)
        old = old_blocks.get(block_id, {})
        kind = block.get("kind", "text")
        if not isinstance(kind, str) or kind not in {"text", "image"}:
            raise DomainError("正文只支持文字和图片段落。")
        source_block = block if source_import else old
        page = source_block.get("source_page")
        item = {"id": block_id, "kind": kind,
                "text": text(block.get("text", ""), "段落文字", 200000),
                "role": text(block.get("role", ""), "角色", 200),
                "color": color(block.get("color"), "#343b37"),
                "source_page": number(page, "来源页码", 1, 100000, True) if page is not None else None,
                "source_file": text(source_block.get("source_file", "用户新增"), "来源文件", 500)}
        if kind == "image":
            item["image_path"] = asset_path(block.get("image_path", ""))
            if not item["image_path"]:
                raise DomainError("图片段落缺少本地图片路径。")
        if "original_text" in source_block:
            item["original_text"] = text(source_block["original_text"], "来源原文", 200000)
        elif source_import:
            item["original_text"] = item["text"]
        # Keep PPT run-level colors on import and unchanged paragraphs. When text
        # changes, discard stale runs rather than displaying the previous wording.
        runs = block.get("runs", old.get("runs"))
        if runs is not None and (source_import or item["text"] == old.get("text")):
            if not isinstance(runs, list) or len(runs) > 10000:
                raise DomainError("正文颜色片段格式无效。")
            item["runs"] = []
            for run in runs:
                if not isinstance(run, dict):
                    raise DomainError("正文颜色片段格式无效。")
                item["runs"].append({"text": text(run.get("text", ""), "片段文字", 200000),
                                     "color": color(run.get("color"), item["color"]),
                                     "bold": bool(run.get("bold", False))})
        if "runs" in item and "".join(run["text"] for run in item["runs"]) != item["text"]:
            raise DomainError("颜色片段与段落正文不一致，请修正后保存。")
        normalized.append(item)
    result["blocks"] = normalized
    # Only the dedicated upload/cues endpoints can change media metadata.
    media = data.get("media") if source_import else previous.get("media")
    if media is not None:
        result["media"] = normalize_media(media, normalized)
    elif "media" in result:
        result.pop("media")
    if len(encode(result)) > 8 * 1024 * 1024:
        raise DomainError("单篇条目数据过大。")
    return result


def empty_state():
    return {"revision": 0, "seek_version": 0, "mode": "list", "orientation": "portrait",
            "playing": False, "speed": DEFAULT_LAYOUTS["portrait"]["speed"], "anchor": None,
            "snapshot": None, "page_index": None, "media_state": default_media_state(), "notice": "请选择内容并应用到展示。", "updated_at": now()}


def anchors(snapshot):
    if not snapshot:
        return []
    if snapshot["mode"] == "script":
        return [block["id"] for script in snapshot["scripts"] for block in script["blocks"]]
    level = snapshot.get("directory_level", snapshot.get("selection", {}).get("directory_level", "scripts"))
    if level == "categories":
        return ["category:" + category["id"] for category in snapshot["categories"]]
    return ["script:" + script["id"] for script in snapshot["scripts"]]


def resources(value):
    found = set()
    if isinstance(value, dict):
        for key, child in value.items():
            if key in {"background", "image_path", "path"} and child:
                found.add(resource_path(child) if key == "path" else asset_path(child))
            else:
                found.update(resources(child))
    elif isinstance(value, list):
        for child in value:
            found.update(resources(child))
    return found


def replace_resources(value, mapping):
    if isinstance(value, dict):
        return {key: mapping.get(child, child) if key in {"background", "image_path", "path"} and isinstance(child, str)
                else replace_resources(child, mapping) for key, child in value.items()}
    if isinstance(value, list):
        return [replace_resources(child, mapping) for child in value]
    return value


def normalize_background(item):
    if not isinstance(item, dict):
        raise DomainError("背景素材资料格式无效。")
    builtin = boolean(item.get("builtin", False), "内置素材标记")
    path = asset_path(item.get("path"))
    if not path or (not builtin and (not path.startswith("/media/") or PurePosixPath(path).suffix.lower() not in {".png", ".jpg", ".jpeg", ".webp"})):
        raise DomainError("背景素材图片路径无效。")
    result = {"id": identifier(item.get("id")), "name": text(item.get("name"), "素材名称", 80, True, True),
              "path": path, "builtin": builtin, "mime": text(item.get("mime", ""), "图片格式", 80),
              "size": number(item.get("size", 0), "图片大小", 0, 40 * 1024 * 1024, True),
              "created_at": text(item.get("created_at", ""), "上传时间", 100)}
    for key in ("width", "height"):
        value = item.get(key)
        result[key] = number(value, "图片尺寸", 1, 100000, True) if value is not None else None
    return result


def legacy_backgrounds(categories):
    result, seen = [], set()
    for category in categories:
        path = category.get("background", "")
        if not path or path in seen:
            continue
        seen.add(path)
        result.append(normalize_background({"id": "bg-builtin-" + hashlib.sha256(path.encode()).hexdigest()[:20],
                                            "name": category["name"] + " · 原始背景", "path": path, "builtin": True}))
    return result


def decode_background(content, filename=None, sanitize=False, label="背景图片"):
    """Decode the complete raster before persistence; ignore client MIME claims."""
    from PIL import Image, ImageOps, UnidentifiedImageError
    if not content or len(content) > BACKGROUND_MAX_BYTES:
        raise DomainError(f"{label}须为不超过 12 MB 的 PNG、JPEG 或 WebP。", 400, "invalid_image")
    formats = {"PNG": (".png", "image/png"), "JPEG": (".jpg", "image/jpeg"), "WEBP": (".webp", "image/webp")}
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(content)) as probe:
                image_format = probe.format
                if image_format not in formats:
                    raise DomainError(f"只支持 PNG、JPEG 或 WebP {label}。", 400, "invalid_image")
                width, height = probe.size
                if width > 12000 or height > 12000 or width * height > BACKGROUND_MAX_PIXELS:
                    raise DomainError(f"{label}单边不能超过 12000 像素，总像素不能超过 2500 万。", 400, "invalid_image")
                if getattr(probe, "n_frames", 1) != 1:
                    raise DomainError(f"{label}请使用静态图片。", 400, "invalid_image")
                if filename is not None:
                    suffix = Path(filename).suffix.lower()
                    allowed = {".jpg", ".jpeg"} if image_format == "JPEG" else {formats[image_format][0]}
                    if suffix not in allowed:
                        raise DomainError("文件扩展名与实际图片格式不符。", 400, "invalid_image")
                probe.verify()
            with Image.open(io.BytesIO(content)) as decoded:
                decoded.load()
                if sanitize:
                    # Re-encoding strips unrelated trailing content and source metadata.
                    output = io.BytesIO()
                    # Honor phone/camera orientation before removing metadata.
                    oriented = ImageOps.exif_transpose(decoded)
                    image = oriented.convert("RGB" if image_format == "JPEG" else "RGBA")
                    image.info.clear()
                    width, height = image.size
                    image.save(output, format=image_format, **({"quality": 95} if image_format in {"JPEG", "WEBP"} else {}))
                    content = output.getvalue()
                    if len(content) > BACKGROUND_MAX_BYTES:
                        raise DomainError("图片规范化后超过 12 MB，请降低分辨率后重试。", 400, "invalid_image")
    except DomainError:
        raise
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError, Image.DecompressionBombError, Image.DecompressionBombWarning) as error:
        raise DomainError("图片无法完整解码，请选择有效的 PNG、JPEG 或 WebP。", 400, "invalid_image") from error
    extension, mime = formats[image_format]
    return content, {"width": width, "height": height, "mime": mime, "size": len(content)}, extension


class Store:
    def __init__(self, database, seed_path, project_root):
        self.database = Path(database).resolve()
        self.project_root = Path(project_root).resolve()
        self.instance_dir = self.database.parent
        self.media_dir = self.instance_dir / "media"
        self.backup_dir = self.instance_dir / "backups"
        self.lock = threading.RLock()
        self.instance_dir.mkdir(parents=True, exist_ok=True)
        self.media_dir.mkdir(exist_ok=True)
        self.seed_path = Path(seed_path)
        self._initialize()

    def _connection(self):
        connection = sqlite3.connect(str(self.database), timeout=15)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA busy_timeout=15000")
        return connection

    @contextmanager
    def transaction(self, write=False):
        with self.lock:
            connection = self._connection()
            try:
                if write:
                    connection.execute("BEGIN IMMEDIATE")
                yield connection
                if write:
                    connection.commit()
            except Exception:
                connection.rollback()
                raise
            finally:
                connection.close()

    @staticmethod
    def _setting(connection, key, default=None):
        row = connection.execute("SELECT data FROM settings WHERE key=?", (key,)).fetchone()
        value = json.loads(row[0]) if row else copy.deepcopy(default)
        # Additive layout defaults are a read-time compatibility view. Opening
        # old data must not republish, rewrite content, or move live navigation.
        if key == "layouts" and value is not None:
            value = {orientation: normalize_layout(value.get(orientation, {}), orientation)
                     for orientation in DEFAULT_LAYOUTS}
        elif key == "layout_presets" and value is not None:
            value = normalize_layout_presets(value)
        elif key == "state" and value is not None:
            if value.get("snapshot"):
                snapshot = value["snapshot"]
                snapshot["layout"] = normalize_snapshot_layout(snapshot.get("layout", {}), snapshot["orientation"])
            normalize_page_state(value)
            normalize_saved_media_state(value)
        return value

    @staticmethod
    def _save_setting(connection, key, value):
        connection.execute("INSERT INTO settings(key,data) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
                           (key, encode(value)))

    @staticmethod
    def _category(connection, item):
        connection.execute("INSERT INTO categories(id,name_key,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name_key=excluded.name_key,data=excluded.data",
                           (item["id"], item["name"].casefold(), encode(item)))

    @staticmethod
    def _script(connection, item):
        connection.execute("INSERT INTO scripts(id,category_id,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET category_id=excluded.category_id,data=excluded.data",
                           (item["id"], item["category_id"], encode(item)))

    @staticmethod
    def _get(connection, table, item_id):
        assert table in {"categories", "scripts"}
        row = connection.execute(f"SELECT data FROM {table} WHERE id=?", (item_id,)).fetchone()
        if not row:
            raise DomainError("所选分组或条目已不存在，请刷新后重试。", 404, "not_found")
        return json.loads(row[0])

    def _initialize(self):
        with self.transaction(write=True) as connection:
            connection.executescript("""
                CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS categories(id TEXT PRIMARY KEY, name_key TEXT NOT NULL UNIQUE, data TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS scripts(id TEXT PRIMARY KEY, category_id TEXT NOT NULL REFERENCES categories(id), data TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, data TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS history(id TEXT PRIMARY KEY, script_id TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL);
            """)
            version = connection.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
            if version and int(version[0]) != SCHEMA_VERSION:
                raise DomainError("数据库版本不受支持，请先备份并使用匹配的程序。", 500)
            initialized = connection.execute("SELECT value FROM meta WHERE key='initialized'").fetchone()
            if not initialized:
                if not self.seed_path.is_file():
                    raise DomainError("缺少 data/seed.json，初始资料尚未准备完成。", 500, "seed_missing")
                with self.seed_path.open("r", encoding="utf-8-sig") as handle:
                    seed = json.load(handle)
                categories = [normalize_category(item) for item in seed.get("categories", [])]
                if any(item["id"] == UNCATEGORIZED for item in categories):
                    raise DomainError("初始分组不能占用系统未分组 ID。")
                categories.append(normalize_category({"id": UNCATEGORIZED, "name": UNCATEGORIZED_NAME, "sort_order": 1000000}))
                for item in categories:
                    self._category(connection, item)
                for item in seed.get("scripts", []):
                    self._script(connection, normalize_script(item, source_import=True))
                self._save_setting(connection, "layouts", DEFAULT_LAYOUTS)
                self._save_setting(connection, "queue", {"script_ids": []})
                self._save_setting(connection, "state", empty_state())
                connection.execute("INSERT OR REPLACE INTO meta VALUES('schema_version',?)", (str(SCHEMA_VERSION),))
                connection.execute("INSERT OR REPLACE INTO meta VALUES('initialized','1')")
            else:
                state = self._setting(connection, "state", empty_state())
                state.update(playing=False, revision=state["revision"] + 1,
                             seek_version=state["seek_version"] + 1, updated_at=now())
                self._save_setting(connection, "state", state)
            if self._setting(connection, "layout_presets") is None:
                self._save_setting(connection, "layout_presets", [])
            if self._setting(connection, "backgrounds") is None:
                source_categories = []
                if self.seed_path.is_file():
                    with self.seed_path.open("r", encoding="utf-8-sig") as handle:
                        source_categories = json.load(handle).get("categories", [])
                current_categories = [json.loads(row[0]) for row in connection.execute("SELECT data FROM categories")]
                backgrounds = legacy_backgrounds(source_categories + current_categories)
                for item in backgrounds:
                    file = self.resource_file(item["path"])
                    if file.is_file():
                        item["size"] = file.stat().st_size
                self._save_setting(connection, "backgrounds", backgrounds)

    def _library(self, connection):
        categories = [json.loads(row[0]) for row in connection.execute("SELECT data FROM categories")]
        categories.sort(key=lambda item: (item["sort_order"], item["name"], item["id"]))
        scripts = [json.loads(row[0]) for row in connection.execute("SELECT data FROM scripts ORDER BY rowid")]
        for item in categories:
            item["script_count"] = sum(script["category_id"] == item["id"] for script in scripts)
            item["visible_count"] = sum(script["category_id"] == item["id"] and script["visible"] for script in scripts)
        return {"categories": categories, "scripts": scripts,
                "backgrounds": self._setting(connection, "backgrounds", []),
                "default_layouts": copy.deepcopy(DEFAULT_LAYOUTS),
                "layout_presets": self._setting(connection, "layout_presets", []),
                "layouts": self._setting(connection, "layouts", DEFAULT_LAYOUTS),
                "queue": self._setting(connection, "queue", {"script_ids": []}),
                "state": self._setting(connection, "state", empty_state())}

    def library(self):
        with self.transaction() as connection:
            return self._library(connection)

    def state(self):
        with self.transaction() as connection:
            return self._setting(connection, "state", empty_state())

    def _assert_assets(self, value):
        for path in resources(value):
            if not self.resource_file(path).is_file():
                raise DomainError("本地资源不存在，请重新选择已有图片或上传媒体。")

    def resource_file(self, path):
        path = resource_path(path)
        if path.startswith("/media/"):
            candidate = self.media_dir / path.removeprefix("/media/")
            base = self.media_dir
        else:
            candidate = self.project_root / path.lstrip("/")
            base = self.project_root / "static" / "media"
        resolved = candidate.resolve()
        if not resolved.is_relative_to(base.resolve()):
            raise DomainError("图片路径超出项目资源目录。")
        return resolved

    @staticmethod
    def _write_new_resource(destination, content):
        # Mark ownership immediately after exclusive creation, before write or
        # close can fail. Never remove a file that existed before this attempt.
        created = False
        try:
            with destination.open("xb") as handle:
                created = True
                handle.write(content)
        except Exception as error:
            if created:
                destination.unlink(missing_ok=True)
            if isinstance(error, OSError):
                raise DomainError("图片保存失败，原资料未改变；请检查存储空间后重试。", 503, "resource_write_failed") from error
            raise

    def _background_entries(self, connection):
        entries = self._setting(connection, "backgrounds", [])
        exported = self._export(connection)
        for entry in entries:
            path = entry["path"]
            usage = {"categories": [item["name"] for item in exported["categories"] if path in resources(item)],
                     "scripts": [item["title"] for item in exported["scripts"] if path in resources(item)],
                     "live": path in resources(exported["settings"].get("state", {}).get("snapshot")),
                     "history": sum(path in resources(item["script"]) for item in exported["history"])}
            entry["usage"] = usage
            entry["can_delete"] = not entry["builtin"] and not any(usage.values())
        return entries

    def backgrounds(self):
        with self.transaction() as connection:
            return self._background_entries(connection)

    def upload_script_image(self, stream, filename):
        """Store a draft image without changing documents, history or live state."""
        try:
            content, details, extension = decode_background(
                stream.read(BACKGROUND_MAX_BYTES + 1), filename, sanitize=True, label="正文图片")
            digest = hashlib.sha256(content).hexdigest()
            path = "/media/" + digest + extension
            with self.lock:
                destination = self.resource_file(path)
                if destination.exists():
                    if destination.read_bytes() != content:
                        raise DomainError("本地同名图片校验失败，请联系维护者。", 409, "resource_conflict")
                else:
                    # Publish only the completed file; the same store lock also
                    # guards background deletion, script saves and backups.
                    temporary = self.media_dir / (".image-upload-" + uuid.uuid4().hex)
                    created = False
                    try:
                        self._write_new_resource(temporary, content)
                        created = True
                        temporary.rename(destination)
                    finally:
                        if created:
                            temporary.unlink(missing_ok=True)
            return {"path": path, "sha256": digest, **details}
        except OSError as error:
            raise DomainError("图片保存失败，原资料未改变；请检查存储空间后重试。", 503,
                              "resource_write_failed") from error

    def upload_background(self, stream, filename, name):
        name = text(name or Path(filename or "").stem, "素材名称", 80, True, True)
        content, details, extension = decode_background(stream.read(BACKGROUND_MAX_BYTES + 1), filename, sanitize=True)
        digest = hashlib.sha256(content).hexdigest()
        path = "/media/" + digest + extension
        item = normalize_background({"id": "bg-" + uuid.uuid4().hex, "name": name, "path": path,
                                     "builtin": False, "created_at": now(), **details})
        with self.lock:
            destination = self.resource_file(path)
            created = False
            try:
                with self.transaction(write=True) as connection:
                    entries = self._setting(connection, "backgrounds", [])
                    if any(entry["path"] == path for entry in entries):
                        raise DomainError("此图片已在背景素材库中，可直接选用或修改名称。", 409, "duplicate_background")
                    if len(entries) >= 1000:
                        raise DomainError("背景素材库已达到 1000 张上限，请先整理未使用素材。")
                    if destination.exists():
                        if destination.read_bytes() != content:
                            raise DomainError("本地同名图片校验失败，请联系维护者。", 409, "resource_conflict")
                    else:
                        self._write_new_resource(destination, content)
                        created = True
                    entries.append(item)
                    self._save_setting(connection, "backgrounds", entries)
                    result = next(entry for entry in self._background_entries(connection) if entry["id"] == item["id"])
            except Exception:
                if created:
                    destination.unlink(missing_ok=True)
                raise
        return result

    def rename_background(self, item_id, data):
        name = text(data.get("name"), "素材名称", 80, True, True)
        with self.transaction(write=True) as connection:
            entries = self._setting(connection, "backgrounds", [])
            item = next((entry for entry in entries if entry["id"] == item_id), None)
            if item is None:
                raise DomainError("背景素材已不存在，请刷新后重试。", 404, "not_found")
            item["name"] = name
            self._save_setting(connection, "backgrounds", entries)
            return next(entry for entry in self._background_entries(connection) if entry["id"] == item_id)

    def delete_background(self, item_id):
        with self.lock:
            staged = None
            destination = None
            try:
                with self.transaction(write=True) as connection:
                    entries = self._setting(connection, "backgrounds", [])
                    item = next((entry for entry in self._background_entries(connection) if entry["id"] == item_id), None)
                    if item is None:
                        raise DomainError("背景素材已不存在，请刷新后重试。", 404, "not_found")
                    if item["builtin"]:
                        raise DomainError("原始 PPT 背景保留为内置素材，不能删除；可以替换分组背景。", 409, "builtin_background")
                    if not item["can_delete"]:
                        reasons = []
                        if item["usage"]["categories"]:
                            reasons.append("分组：" + "、".join(item["usage"]["categories"]))
                        if item["usage"]["scripts"]:
                            reasons.append("正文：" + "、".join(item["usage"]["scripts"]))
                        if item["usage"]["live"]:
                            reasons.append("当前上屏快照")
                        if item["usage"]["history"]:
                            reasons.append("正文修改历史")
                        raise DomainError("素材仍被" + "；".join(reasons) + "引用，暂不能删除。历史引用会保留以便追溯。", 409, "background_in_use")
                    remaining = [entry for entry in entries if entry["id"] != item_id]
                    destination = self.resource_file(item["path"])
                    # Stage within the same protected media directory; rollback can
                    # put the file back if the database commit does not succeed.
                    if destination.is_file() and not any(entry["path"] == item["path"] for entry in remaining):
                        staged = self.media_dir / (".delete-" + uuid.uuid4().hex)
                        destination.rename(staged)
                    self._save_setting(connection, "backgrounds", remaining)
            except Exception:
                if staged is not None and staged.exists():
                    staged.rename(destination)
                raise
            if staged is not None:
                try:
                    staged.unlink()
                except OSError:
                    # A locked temporary file has no public asset URL or library
                    # entry; deletion can be retried by local maintenance later.
                    pass
            return {"deleted": item_id}

    def save_category(self, data, item_id=None):
        with self.transaction(write=True) as connection:
            previous = self._get(connection, "categories", item_id) if item_id else None
            if previous and previous["id"] == UNCATEGORIZED and ("name" in data or "visible" in data):
                if data.get("name", UNCATEGORIZED_NAME) != UNCATEGORIZED_NAME or data.get("visible", True) is not True:
                    raise DomainError("系统未分组不能改名或隐藏。")
            if not item_id and data.get("id") == UNCATEGORIZED:
                raise DomainError("不能创建系统未分组。")
            item = normalize_category(data, previous)
            if not item_id:
                item["sort_order"] = data.get("sort_order", len(connection.execute("SELECT id FROM categories").fetchall()))
                if connection.execute("SELECT 1 FROM categories WHERE id=?", (item["id"],)).fetchone():
                    raise DomainError("分组 ID 已存在。", 409)
            self._assert_assets(item)
            try:
                self._category(connection, item)
            except sqlite3.IntegrityError as error:
                raise DomainError("已有同名分组，请换一个名称。", 409, "duplicate_name") from error
            return item

    def delete_category(self, item_id, target_id=None):
        if item_id == UNCATEGORIZED:
            raise DomainError("系统未分组不可删除。")
        with self.transaction(write=True) as connection:
            self._get(connection, "categories", item_id)
            scripts = [json.loads(row[0]) for row in connection.execute("SELECT data FROM scripts WHERE category_id=?", (item_id,))]
            if scripts:
                if not target_id or target_id == item_id:
                    raise DomainError("请先选择接收这些条目的分组或未分组。", 409, "transfer_required")
                target = self._get(connection, "categories", identifier(target_id))
                if not target["visible"]:
                    raise DomainError("接收分组必须处于显示状态。")
                for script in scripts:
                    self._record_history(connection, script)
                    script["category_id"] = target_id
                    self._script(connection, script)
            connection.execute("DELETE FROM categories WHERE id=?", (item_id,))
            return {"deleted": item_id, "transferred": len(scripts), "target_id": target_id}

    def reorder_categories(self, values):
        ids = id_list(values, "分组顺序")
        with self.transaction(write=True) as connection:
            current = {row[0] for row in connection.execute("SELECT id FROM categories")}
            # The reserved fallback may be omitted by navigation-based editors.
            if set(ids) == current - {UNCATEGORIZED}:
                ids.append(UNCATEGORIZED)
            if set(ids) != current:
                raise DomainError("分组列表已变化，请刷新后重排。", 409, "stale_categories")
            for index, item_id in enumerate(ids):
                item = self._get(connection, "categories", item_id)
                item["sort_order"] = index
                self._category(connection, item)
            return self._library(connection)["categories"]

    @staticmethod
    def _record_history(connection, item):
        connection.execute("INSERT INTO history VALUES(?,?,?,?)", (uuid.uuid4().hex, item["id"], now(), encode(item)))

    def save_script(self, data, item_id=None):
        with self.transaction(write=True) as connection:
            previous = self._get(connection, "scripts", item_id) if item_id else None
            item = normalize_script(data, previous)
            self._get(connection, "categories", item["category_id"])
            self._assert_assets(item)
            if not item_id and connection.execute("SELECT 1 FROM scripts WHERE id=?", (item["id"],)).fetchone():
                raise DomainError("条目 ID 已存在。", 409)
            if previous:
                self._record_history(connection, previous)
            self._script(connection, item)
            return item

    def upload_script_media(self, item_id, stream, filename):
        name = text((filename or "").replace("\\", "/").rsplit("/", 1)[-1], "媒体名称", 255, True)
        extension = PurePosixPath(name).suffix.lower()
        if extension not in MEDIA_FORMATS:
            raise DomainError("仅支持 MP4、WebM、MP3、WAV、M4A 和 OGG 音视频。", 400, "invalid_media")
        with self.transaction() as connection:
            self._get(connection, "scripts", item_id)
        temporary = self.media_dir / (".upload-" + uuid.uuid4().hex)
        destination, created = None, False
        try:
            digest, size = hashlib.sha256(), 0
            with temporary.open("xb") as output:
                while chunk := stream.read(min(1024 * 1024, MEDIA_MAX_BYTES - size + 1)):
                    size += len(chunk)
                    if size > MEDIA_MAX_BYTES:
                        raise DomainError("媒体文件超过 200 MB，请压缩后再上传。", 413, "media_too_large")
                    digest.update(chunk)
                    output.write(chunk)
            with temporary.open("rb") as source:
                kind = validate_media_stream(source, extension, size)
            checksum = digest.hexdigest()
            destination = self.media_dir / (checksum + extension)
            with self.lock:
                try:
                    with self.transaction(write=True) as connection:
                        previous = self._get(connection, "scripts", item_id)
                        if destination.exists():
                            with destination.open("rb") as existing:
                                if destination.stat().st_size != size or hashlib.file_digest(existing, "sha256").hexdigest() != checksum:
                                    raise DomainError("已有同名媒体校验失败，原资料未改变。", 409, "invalid_media")
                        else:
                            temporary.rename(destination)
                            created = True
                        item = copy.deepcopy(previous)
                        item["media"] = normalize_media({"path": "/media/" + destination.name, "kind": kind,
                                                        "name": name, "size": size, "sha256": checksum,
                                                        "duration": None, "cues": []}, item["blocks"])
                        self._record_history(connection, previous)
                        self._script(connection, item)
                    return item
                except Exception:
                    if created:
                        destination.unlink(missing_ok=True)
                    raise
        except OSError as error:
            raise DomainError("媒体保存失败，原资料未改变；请检查存储空间后重试。", 503, "resource_write_failed") from error
        finally:
            temporary.unlink(missing_ok=True)

    def delete_script_media(self, item_id):
        with self.transaction(write=True) as connection:
            previous = self._get(connection, "scripts", item_id)
            item = copy.deepcopy(previous)
            if item.pop("media", None) is not None:
                self._record_history(connection, previous)
                self._script(connection, item)
            # Historical records and frozen live snapshots retain their files.
            return item

    def save_media_cues(self, item_id, data):
        with self.transaction(write=True) as connection:
            previous = self._get(connection, "scripts", item_id)
            if not previous.get("media"):
                raise DomainError("请先为条目上传音视频。", 409, "media_required")
            item = copy.deepcopy(previous)
            media = item["media"]
            media["duration"] = media_duration(data.get("duration", media.get("duration")))
            media["cues"] = normalize_cues(data.get("cues"), item["blocks"], media["duration"])
            self._record_history(connection, previous)
            self._script(connection, item)
            return item

    def history(self, item_id):
        with self.transaction() as connection:
            self._get(connection, "scripts", item_id)
            return [{"id": row["id"], "created_at": row["created_at"], "script": json.loads(row["data"])}
                    for row in connection.execute("SELECT * FROM history WHERE script_id=? ORDER BY created_at DESC", (item_id,))]

    def restore_history(self, item_id, history_id):
        identifier(history_id, "历史版本 ID")
        with self.transaction(write=True) as connection:
            previous = self._get(connection, "scripts", item_id)
            row = connection.execute("SELECT data FROM history WHERE id=? AND script_id=?", (history_id, item_id)).fetchone()
            if not row:
                raise DomainError("该历史版本不存在或不属于此条目。", 404, "history_not_found")
            candidate = json.loads(row[0])
            candidate["id"] = previous["id"]
            if not connection.execute("SELECT 1 FROM categories WHERE id=?", (candidate.get("category_id"),)).fetchone():
                candidate["category_id"] = UNCATEGORIZED
            item = normalize_script(candidate, source_import=True)
            self._assert_assets(item)
            if item.get("media"):
                path = self.resource_file(item["media"]["path"])
                if path.stat().st_size != item["media"]["size"] or hashlib.sha256(path.read_bytes()).hexdigest() != item["media"]["sha256"]:
                    raise DomainError("历史版本的媒体校验失败，请先修复资源。", 409, "invalid_media")
            self._record_history(connection, previous)
            self._script(connection, item)
            return item

    def save_queue(self, ids):
        ids = id_list(ids, "待展示列表")
        with self.transaction(write=True) as connection:
            for item_id in ids:
                self._get(connection, "scripts", item_id)
            queue = {"script_ids": ids}
            self._save_setting(connection, "queue", queue)
            return queue

    def layout_presets(self):
        with self.transaction() as connection:
            return {"layout_presets": self._setting(connection, "layout_presets", []),
                    "default_layouts": copy.deepcopy(DEFAULT_LAYOUTS)}

    def save_layout_preset(self, data, item_id=None):
        if not isinstance(data, dict) or not data or set(data) - {"name", "layouts"}:
            raise DomainError("预设请求只接受 name 和 layouts，至少提供一项。")
        with self.transaction(write=True) as connection:
            entries = self._setting(connection, "layout_presets", [])
            if item_id is not None:
                previous = next((entry for entry in entries if entry["id"] == item_id), None)
                if previous is None:
                    raise DomainError("自定义预设不存在；默认排版不能修改。", 404, "not_found")
                item = {**previous, **data, "id": item_id}
                candidate = [item if entry["id"] == item_id else entry for entry in entries]
            else:
                if len(entries) >= 10:
                    raise DomainError("自定义排版预设已达到 10 套，请先删除不再使用的预设。", 409, "preset_limit")
                item_id = "layout-" + uuid.uuid4().hex[:20]
                item = {**data, "id": item_id}
                candidate = [*entries, item]
            candidate = normalize_layout_presets(candidate)
            self._save_setting(connection, "layout_presets", candidate)
            return next(entry for entry in candidate if entry["id"] == item_id)

    def delete_layout_preset(self, item_id):
        with self.transaction(write=True) as connection:
            entries = self._setting(connection, "layout_presets", [])
            remaining = [entry for entry in entries if entry["id"] != item_id]
            if len(remaining) == len(entries):
                raise DomainError("自定义预设不存在；默认排版不能删除。", 404, "not_found")
            self._save_setting(connection, "layout_presets", remaining)
            return {"deleted": item_id}

    def save_layout(self, data):
        orientation = data.get("orientation")
        if not isinstance(orientation, str) or orientation not in DEFAULT_LAYOUTS:
            raise DomainError("请选择竖屏或横屏。")
        with self.transaction(write=True) as connection:
            layouts = self._setting(connection, "layouts", DEFAULT_LAYOUTS)
            layouts[orientation] = normalize_layout(data.get("layout", {}), orientation, layouts.get(orientation))
            self._save_setting(connection, "layouts", layouts)
            return layouts

    def _snapshot(self, connection, data):
        library = self._library(connection)
        mode = data.get("mode", "list")
        orientation = data.get("orientation", "portrait")
        level = data.get("directory_level", "scripts")
        focus = data.get("focus_category_id")
        if not isinstance(mode, str) or mode not in {"list", "script"} or not isinstance(orientation, str) or orientation not in DEFAULT_LAYOUTS:
            raise DomainError("展示模式或画幅无效。")
        if not isinstance(level, str) or level not in {"categories", "scripts"}:
            raise DomainError("目录层级无效。")
        if focus is not None:
            focus = identifier(focus, "当前分组")
        layout = normalize_layout(data.get("layout", {}), orientation, library["layouts"][orientation])
        visible_categories = [item for item in library["categories"] if item["visible"] and
                              (item["id"] != UNCATEGORIZED or item["visible_count"])]
        category_map = {item["id"]: item for item in visible_categories}
        if focus is not None and focus not in category_map:
            raise DomainError("当前分组已删除或隐藏，请重新选择。", 409, "unavailable_selection")
        available = {item["id"]: item for item in library["scripts"] if item["visible"] and item["category_id"] in category_map}
        if mode == "script":
            script_id = identifier(data.get("script_id"), "条目 ID")
            if script_id not in available:
                raise DomainError("该条目已隐藏或不在可用分组中，请重新选择。", 409, "unavailable_selection")
            scripts = [available[script_id]]
            actual_category = scripts[0]["category_id"]
            if focus is not None and focus != actual_category:
                raise DomainError("条目已不属于当前分组，请刷新预览。", 409, "unavailable_selection")
            level, focus = "scripts", actual_category
            categories = [category_map[actual_category]]
            selection = {"mode": mode, "script_id": script_id, "category_ids": [], "script_ids": []}
        else:
            category_ids = id_list(data.get("category_ids", []), "所选分组")
            script_ids = id_list(data.get("script_ids", []), "所选条目")
            if any(item_id not in category_map for item_id in category_ids):
                raise DomainError("所选分组已删除或隐藏，请刷新预览。", 409, "unavailable_selection")
            list_source = data.get("list_source", "queue" if "script_ids" in data else "categories")
            if not isinstance(list_source, str) or list_source not in {"queue", "categories"}:
                raise DomainError("目录来源无效。")
            if level == "categories":
                if focus is not None:
                    raise DomainError("分组总览不能同时指定当前分组。")
                categories = [item for item in visible_categories if not category_ids or item["id"] in category_ids]
            elif focus is not None:
                # The explicit focused category is authoritative at the second level.
                categories = [category_map[focus]]
            else:
                categories = [item for item in visible_categories if not category_ids or item["id"] in category_ids]
            selected_categories = {item["id"] for item in categories}
            ordered_ids = script_ids if list_source == "queue" else [item["id"] for item in library["scripts"]]
            scripts = [available[item_id] for item_id in ordered_ids
                       if item_id in available and available[item_id]["category_id"] in selected_categories]
            if level == "categories" and list_source == "queue":
                represented = {item["category_id"] for item in scripts}
                categories = [item for item in categories if item["id"] in represented]
            selection = {"mode": mode, "script_id": None, "category_ids": sorted(category_ids),
                         "script_ids": script_ids if list_source == "queue" else [], "list_source": list_source}
        selection.update(directory_level=level, focus_category_id=focus)
        if mode == "script" and layout["body_mode"] == "media":
            if not scripts[0].get("media"):
                raise DomainError("该条目尚未关联音视频，请先配本或选择纯正文模式。", 409, "media_required")
            scripts[0]["media"] = normalize_media(scripts[0]["media"], scripts[0]["blocks"])
            self._assert_assets(scripts[0]["media"])
            if self.resource_file(scripts[0]["media"]["path"]).stat().st_size != scripts[0]["media"]["size"]:
                raise DomainError("媒体文件大小已改变，请重新上传。", 409, "invalid_media")
        snapshot = {"id": uuid.uuid4().hex, "mode": mode, "orientation": orientation,
                    "directory_level": level, "focus_category_id": focus,
                    "categories": copy.deepcopy(categories), "scripts": copy.deepcopy(scripts),
                    "layout": layout, "selection": selection, "created_at": now()}
        content = {key: snapshot[key] for key in SNAPSHOT_CONTENT_KEYS}
        canonical = json.dumps(content, ensure_ascii=False, sort_keys=True,
                               separators=(",", ":"), allow_nan=False)
        snapshot["content_token"] = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
        return snapshot

    def preview(self, data):
        with self.transaction() as connection:
            return self._snapshot(connection, data)

    def editor_preview(self, data):
        orientation = data.get("orientation", "portrait")
        body_mode = data.get("body_mode", "pages")
        if not isinstance(orientation, str) or orientation not in DEFAULT_LAYOUTS or not isinstance(body_mode, str) or body_mode not in {"pages", "scroll"}:
            raise DomainError("编辑预览的画幅或阅读模式无效。")
        draft = data.get("draft")
        if not isinstance(draft, dict):
            raise DomainError("请提交完整编辑草稿。")
        with self.transaction() as connection:
            script_id = data.get("script_id")
            existing = self._get(connection, "scripts", identifier(script_id, "条目 ID")) if script_id is not None else None
            candidate = copy.deepcopy(draft)
            draft_title = text(candidate.get("title", ""), "剧名", 200)
            if not draft_title.strip():
                candidate["title"] = "未命名条目"
            item = normalize_script(candidate, existing)
            item.pop("media", None)
            category = self._get(connection, "categories", item["category_id"])
            self._assert_assets(item)
            layout = normalize_layout({"body_mode": body_mode}, orientation,
                                      self._setting(connection, "layouts", DEFAULT_LAYOUTS)[orientation])
            snapshot = {"id": "editor-" + uuid.uuid4().hex, "mode": "script", "orientation": orientation,
                        "directory_level": "scripts", "focus_category_id": item["category_id"],
                        "categories": [category], "scripts": [item], "layout": layout,
                        "selection": {"mode": "script", "script_id": item["id"], "category_ids": [],
                                      "script_ids": [], "directory_level": "scripts", "focus_category_id": item["category_id"]},
                        "created_at": now(), "editor_only": True}
            # Intentionally no apply token: an editor draft cannot enter live state.
            return {"snapshot": snapshot}

    def apply(self, data):
        realtime = data.get("realtime", False)
        playing = data.get("preview_playing", False)
        if type(realtime) is not bool or type(playing) is not bool:
            raise DomainError("realtime 和 preview_playing 必须为 true 或 false。")
        if (realtime or "preview_playing" in data or "preview_page_index" in data or "preview_media_state" in data) and "preview_token" not in data:
            raise DomainError("同步预览播放状态前，请先取得有效预览。", 400, "preview_required")
        with self.transaction(write=True) as connection:
            snapshot = self._snapshot(connection, data)
            if "preview_token" in data and data["preview_token"] != snapshot["content_token"]:
                raise DomainError("资料或排版已变更，请重新预览后再应用。", 409, "preview_stale")
            previous = self._setting(connection, "state", empty_state())
            paged = is_paged(snapshot)
            if "preview_page_index" in data:
                page_number(data["preview_page_index"])
                if not paged:
                    raise DomainError("页位置只能应用到分页正文。", 400, "invalid_page")
            if paged or (is_media(snapshot) and not realtime):
                playing = False
            positions = anchors(snapshot)
            if playing and not positions and not is_media(snapshot):
                raise DomainError("当前内容为空，无法开始滚动。", 400, "empty_display")
            old_snapshot = previous.get("snapshot")
            # A position/playback-only sync must not look like a new document to
            # display windows. Compare the complete frozen content as well as its
            # token so restored or older snapshots cannot reuse a stale identity.
            reuse_snapshot = bool(realtime and old_snapshot
                                  and old_snapshot.get("content_token") == snapshot["content_token"]
                                  and all(old_snapshot.get(key) == snapshot[key] for key in
                                          SNAPSHOT_CONTENT_KEYS))
            if reuse_snapshot:
                snapshot["id"] = old_snapshot["id"]
                snapshot["created_at"] = old_snapshot["created_at"]
            old_selection = copy.deepcopy(old_snapshot.get("selection", {})) if old_snapshot else None
            if old_selection is not None:
                # Snapshots written before directory levels existed used the same
                # flat list/script semantics and should retain their valid anchor.
                old_selection.setdefault("directory_level", "scripts")
                old_focus = (old_snapshot["scripts"][0]["category_id"]
                             if old_snapshot.get("mode") == "script" and old_snapshot.get("scripts") else None)
                old_selection.setdefault("focus_category_id", old_focus)
            same = old_selection == snapshot["selection"]
            retained = same and (previous["anchor"] is None or previous["anchor"] in positions)
            anchor = previous["anchor"] if retained else None
            notice = "原定位已不存在，已回到起始位置。" if same and previous["anchor"] and not retained else "已应用，当前暂停。"
            if "preview_anchor" in data:
                requested_anchor = data["preview_anchor"]
                if requested_anchor is not None and requested_anchor not in positions:
                    raise DomainError("预览定位不属于待上屏内容，请重新选择。", 409, "invalid_anchor")
                anchor = requested_anchor
                notice = "已应用预览位置，当前暂停。"
            if realtime and not notice.startswith("原定位已不存在"):
                notice = "已实时同步，正在滚动。" if playing else "已实时同步，当前暂停。"
            elif playing:
                notice = notice.replace("当前暂停", "正在滚动")
            page_index = None
            if paged:
                notice = "分页正文已应用，请使用上一页或下一页。"
                if "preview_page_index" in data:
                    page_index = data["preview_page_index"]
                elif not same:
                    page_index = 0 if anchor is None else None
                elif old_snapshot and (old_snapshot.get("layout") != snapshot["layout"] or anchor != previous["anchor"]):
                    page_index = None
                elif old_snapshot and old_snapshot.get("content_token") == snapshot["content_token"]:
                    page_index = previous.get("page_index")
                else:
                    page_index = 0 if anchor is None else None
            media_state = default_media_state()
            if "preview_media_state" in data:
                media_state = normalize_media_state(data["preview_media_state"], snapshot)
            elif is_media(snapshot):
                old_media = (old_snapshot["scripts"][0].get("media") if is_media(old_snapshot) else None)
                if same and old_media == snapshot["scripts"][0]["media"] and old_snapshot["scripts"][0]["blocks"] == snapshot["scripts"][0]["blocks"]:
                    media_state = normalize_media_state(previous.get("media_state", default_media_state()), snapshot)
            if is_media(snapshot):
                notice = "已实时同步媒体，正在播放。" if realtime and playing else "媒体已应用，当前暂停。"
                if playing:
                    notice = notice.replace("当前暂停", "正在播放")
            state = {"revision": previous["revision"] + 1, "seek_version": previous["seek_version"] + 1,
                     "mode": snapshot["mode"], "orientation": snapshot["orientation"], "playing": playing,
                     "speed": snapshot["layout"]["speed"], "anchor": anchor, "snapshot": snapshot,
                     "page_index": page_index, "media_state": media_state, "notice": notice, "updated_at": now()}
            if not reuse_snapshot:
                layouts = self._setting(connection, "layouts", DEFAULT_LAYOUTS)
                layouts[snapshot["orientation"]] = snapshot["layout"]
                self._save_setting(connection, "layouts", layouts)
            self._save_setting(connection, "state", state)
            return state

    def command(self, data):
        action = data.get("action")
        if not isinstance(action, str) or action not in {"play", "pause", "speed", "seek", "page", "media"}:
            raise DomainError("未知播控操作。")
        with self.transaction(write=True) as connection:
            state = self._setting(connection, "state", empty_state())
            if action == "play":
                if is_paged(state["snapshot"]):
                    raise DomainError("分页正文使用翻页操作，不启动自动滚动。", 400, "paged_display")
                if not anchors(state["snapshot"]) and not is_media(state["snapshot"]):
                    raise DomainError("请先应用包含内容的展示画面。")
                state["playing"] = True
            elif action == "pause":
                state["playing"] = False
                # A control page may only know an old checkpoint. Pause does not
                # replace the display's current position with that stale value.
            elif action == "speed":
                state["speed"] = number(data.get("speed"), "滚动速度", 5, 180)
            elif action == "media":
                if not is_media(state["snapshot"]):
                    raise DomainError("当前展示不是音视频正文。", 400, "invalid_media_state")
                if data.get("snapshot_id") != state["snapshot"]["id"]:
                    raise DomainError("展示内容已更新，请读取新画面后再操作媒体。", 409, "stale_snapshot")
                if "revision" in data:
                    revision = number(data["revision"], "状态版本", 0, 9007199254740991, True)
                    if revision != state["revision"]:
                        raise DomainError("状态已更新，请先读取新状态。", 409, "stale_revision")
                if type(data.get("playing")) is not bool:
                    raise DomainError("playing 必须为 true 或 false。")
                media_state = normalize_media_state(data.get("media_state"), state["snapshot"])
                state.update(media_state=media_state, playing=data["playing"], seek_version=state["seek_version"] + 1)
            elif action == "page":
                if not is_paged(state["snapshot"]):
                    raise DomainError("当前展示不是分页正文。", 400, "invalid_page")
                if data.get("snapshot_id") != state["snapshot"]["id"]:
                    raise DomainError("展示内容已更新，请读取新画面后再翻页。", 409, "stale_snapshot")
                page_index = page_number(data.get("page_index"))
                anchor = data.get("anchor")
                if "anchor" not in data or (anchor is not None and anchor not in anchors(state["snapshot"])):
                    raise DomainError("页定位不属于当前上屏内容。", 409, "invalid_anchor")
                state.update(anchor=anchor, page_index=page_index, playing=False, seek_version=state["seek_version"] + 1)
            else:
                anchor = data.get("anchor")
                if anchor is not None and anchor not in anchors(state["snapshot"]):
                    raise DomainError("该定位不属于当前上屏内容。", 409, "invalid_anchor")
                state["anchor"] = anchor
                state["page_index"] = None
                state["seek_version"] += 1
            state.update(revision=state["revision"] + 1, updated_at=now(), notice="")
            self._save_setting(connection, "state", state)
            return state

    def checkpoint(self, data):
        revision = number(data.get("revision"), "状态版本", 0, 9007199254740991, True)
        with self.transaction(write=True) as connection:
            state = self._setting(connection, "state", empty_state())
            if revision != state["revision"]:
                raise DomainError("状态已更新，请先读取新状态。", 409, "stale_revision")
            if "snapshot_id" in data and (not state["snapshot"] or data["snapshot_id"] != state["snapshot"]["id"]):
                raise DomainError("展示内容已更新，请先读取新画面。", 409, "stale_snapshot")
            if "media_state" in data:
                state["media_state"] = normalize_media_state(data["media_state"], state["snapshot"])
            anchor = data.get("anchor", state["anchor"])
            if anchor is not None and anchor not in anchors(state["snapshot"]):
                raise DomainError("该定位不属于当前上屏内容。", 409, "invalid_anchor")
            if "page_index" in data:
                if not is_paged(state["snapshot"]):
                    raise DomainError("只有分页正文可以保存页位置。", 400, "invalid_page")
                state["page_index"] = page_number(data["page_index"])
            elif anchor != state["anchor"]:
                state["page_index"] = None
            state.update(anchor=anchor, updated_at=now())
            self._save_setting(connection, "state", state)
            return state

    def display_connect(self):
        with self.transaction(write=True) as connection:
            state = self._setting(connection, "state", empty_state())
            state.update(playing=False, revision=state["revision"] + 1,
                         seek_version=state["seek_version"] + 1, updated_at=now(), notice="展示窗口已就绪，当前暂停。")
            self._save_setting(connection, "state", state)
            return state

    def _export(self, connection):
        return {"categories": [json.loads(row[0]) for row in connection.execute("SELECT data FROM categories")],
                "scripts": [json.loads(row[0]) for row in connection.execute("SELECT data FROM scripts ORDER BY rowid")],
                "settings": {row[0]: json.loads(row[1]) for row in connection.execute("SELECT key,data FROM settings")},
                "history": [{"id": row[0], "script_id": row[1], "created_at": row[2], "script": json.loads(row[3])}
                            for row in connection.execute("SELECT id,script_id,created_at,data FROM history")]}

    def backup(self):
        with self.lock, tempfile.TemporaryDirectory(prefix="backup-", dir=self.instance_dir) as temporary:
            database_copy = Path(temporary) / "database.sqlite3"
            with self.transaction() as connection:
                exported = self._export(connection)
                destination = sqlite3.connect(str(database_copy))
                try:
                    connection.backup(destination)
                finally:
                    destination.close()
            files = {"database.sqlite3": database_copy.read_bytes()}
            resource_map = {}
            total_size = len(files["database.sqlite3"])
            for resource in sorted(resources(exported)):
                file = self.resource_file(resource)
                if not file.is_file():
                    raise DomainError("备份未完成：存在缺失的本地图片或音视频，请先修复资源。", 409, "missing_resource")
                size = file.stat().st_size
                limit = MEDIA_MAX_BYTES if file.suffix.lower() in MEDIA_FORMATS else 40 * 1024 * 1024
                if size > limit:
                    raise DomainError("单个本地资源超过备份大小限制。")
                total_size += size
                if total_size > 512 * 1024 * 1024:
                    raise DomainError("备份超过 512 MB，请联系维护者整理资源。")
                archive_name = "assets/" + resource.lstrip("/")
                files[archive_name] = file.read_bytes()
                resource_map[resource] = archive_name
            for media in media_items(exported):
                content = files[resource_map[media["path"]]]
                if len(content) != media["size"] or hashlib.sha256(content).hexdigest() != media["sha256"]:
                    raise DomainError("备份未完成：音视频文件校验失败，请重新上传。", 409, "invalid_media")
            if sum(len(value) for value in files.values()) > 512 * 1024 * 1024:
                raise DomainError("备份超过 512 MB，请联系维护者整理资源。")
            manifest = {"format": BACKUP_FORMAT, "version": SCHEMA_VERSION, "created_at": now(),
                        "files": {name: {"sha256": hashlib.sha256(content).hexdigest(), "size": len(content)}
                                  for name, content in files.items()}, "resources": resource_map}
            stream = io.BytesIO()
            with zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as archive:
                archive.writestr("manifest.json", encode(manifest))
                for name, content in files.items():
                    archive.writestr(name, content)
            return stream.getvalue()

    def _validate_database(self, database):
        connection = sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True)
        try:
            connection.execute("PRAGMA trusted_schema=OFF")
            if connection.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise DomainError("备份数据库完整性检查失败。")
            objects = connection.execute("SELECT name,type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").fetchall()
            expected = {"meta", "categories", "scripts", "settings", "history"}
            if {name for name, kind in objects if kind == "table"} != expected or any(kind != "table" for _, kind in objects):
                raise DomainError("备份数据库结构不受支持。")
            version = connection.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
            if not version or version[0] != str(SCHEMA_VERSION):
                raise DomainError("备份版本不受支持。")
            if connection.execute("PRAGMA foreign_key_check").fetchone():
                raise DomainError("备份中的分组关联已损坏。")
            if any(connection.execute(f"SELECT count(*) FROM {table}").fetchone()[0] > maximum
                   for table, maximum in [("categories", 5000), ("scripts", 10000), ("history", 100000), ("settings", 10)]):
                raise DomainError("备份的数据量超过当前版本限制。")
            exported = self._export(connection)
            categories = [normalize_category(item) for item in exported["categories"]]
            category_ids = {item["id"] for item in categories}
            if len(category_ids) != len(categories) or UNCATEGORIZED not in category_ids:
                raise DomainError("备份分组记录无效。")
            if len({item["name"].casefold() for item in categories}) != len(categories):
                raise DomainError("备份包含同名分组。")
            scripts = [normalize_script(item, source_import=True) for item in exported["scripts"]]
            if len({item["id"] for item in scripts}) != len(scripts) or any(item["category_id"] not in category_ids for item in scripts):
                raise DomainError("备份条目关联无效。")
            settings = exported["settings"]
            if not {"layouts", "queue", "state"} <= set(settings) or set(settings) - {"layouts", "queue", "state", "backgrounds", "layout_presets"}:
                raise DomainError("备份缺少必要配置。")
            settings["layout_presets"] = normalize_layout_presets(settings.get("layout_presets", []))
            raw_backgrounds = settings.get("backgrounds", legacy_backgrounds(categories))
            if not isinstance(raw_backgrounds, list) or len(raw_backgrounds) > 1000:
                raise DomainError("备份背景素材库格式无效。")
            settings["backgrounds"] = [normalize_background(item) for item in raw_backgrounds]
            if len({item["id"] for item in settings["backgrounds"]}) != len(raw_backgrounds):
                raise DomainError("备份背景素材 ID 重复。")
            settings["layouts"] = {orientation: normalize_layout(settings["layouts"][orientation], orientation)
                                   for orientation in DEFAULT_LAYOUTS}
            settings["queue"] = {"script_ids": id_list(settings["queue"]["script_ids"], "待展示列表")}
            script_ids = {item["id"] for item in scripts}
            if any(item_id not in script_ids for item_id in settings["queue"]["script_ids"]):
                raise DomainError("备份待展示列表引用了不存在的条目。")
            state = settings["state"]
            for field in ["revision", "seek_version"]:
                state[field] = number(state[field], field, 0, 9007199254740990, True)
            state["speed"] = number(state["speed"], "滚动速度", 5, 180)
            state["playing"] = False
            snapshot = state.get("snapshot")
            if snapshot is not None:
                if snapshot["mode"] not in {"list", "script"} or snapshot["orientation"] not in DEFAULT_LAYOUTS:
                    raise DomainError("备份展示状态无效。")
                snapshot["id"] = identifier(snapshot["id"])
                snapshot["categories"] = [normalize_category(item) for item in snapshot["categories"]]
                snapshot["scripts"] = [normalize_script(item, source_import=True) for item in snapshot["scripts"]]
                snapshot["layout"] = normalize_snapshot_layout(snapshot["layout"], snapshot["orientation"])
                if snapshot["mode"] == "script" and len(snapshot["scripts"]) != 1:
                    raise DomainError("备份条目展示状态无效。")
                selection = snapshot.get("selection", {})
                if not isinstance(selection, dict):
                    raise DomainError("备份目录选择格式无效。")
                level = snapshot.get("directory_level", selection.get("directory_level", "scripts"))
                focus = snapshot.get("focus_category_id", selection.get("focus_category_id"))
                if not isinstance(level, str) or level not in {"categories", "scripts"}:
                    raise DomainError("备份目录层级无效。")
                if focus is not None:
                    focus = identifier(focus, "当前分组")
                frozen_categories = {item["id"] for item in snapshot["categories"]}
                if focus is not None and focus not in frozen_categories:
                    raise DomainError("备份当前分组不属于已保存的展示内容。")
                if snapshot["mode"] == "script":
                    level, focus = "scripts", snapshot["scripts"][0]["category_id"]
                elif level == "categories" and focus is not None:
                    raise DomainError("备份分组总览不能同时指定当前分组。")
                elif focus is not None and any(item["category_id"] != focus for item in snapshot["scripts"]):
                    raise DomainError("备份当前分组与目录内容不一致。")
                snapshot.update(directory_level=level, focus_category_id=focus)
                selection.update(directory_level=level, focus_category_id=focus)
                snapshot["selection"] = selection
                positions = anchors(snapshot)
                state["anchor"] = state.get("anchor") if state.get("anchor") in positions else None
                state["mode"], state["orientation"] = snapshot["mode"], snapshot["orientation"]
            else:
                state.update(anchor=None, mode="list", orientation="portrait")
            normalize_page_state(state)
            normalize_saved_media_state(state)
            history = []
            for item in exported["history"]:
                history.append({"id": identifier(item["id"]), "script_id": identifier(item["script_id"]),
                                "created_at": text(item["created_at"], "修改时间", 100),
                                "script": normalize_script(item["script"], source_import=True)})
            return {"categories": categories, "scripts": scripts, "settings": settings, "history": history}
        except (sqlite3.Error, KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
            raise DomainError("备份数据库或其中的资料无效，原资料未改变。") from error
        finally:
            connection.close()

    def _read_backup(self, uploaded):
        try:
            with zipfile.ZipFile(uploaded) as archive:
                entries = archive.infolist()
                names = [entry.filename for entry in entries]
                if len(entries) > 5000 or len(names) != len(set(names)):
                    raise DomainError("备份包含重复文件或文件数过多。")
                total = 0
                for entry in entries:
                    path = PurePosixPath(entry.filename)
                    if (path.is_absolute() or ".." in path.parts or "\\" in entry.filename or ":" in entry.filename
                            or entry.orig_filename != entry.filename or "\x00" in entry.orig_filename
                            or entry.is_dir() or stat.S_ISLNK(entry.external_attr >> 16) or entry.flag_bits & 1
                            or entry.compress_type not in {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}):
                        raise DomainError("备份包含不安全的文件路径或加密文件。")
                    total += entry.file_size
                    limit = (64 * 1024 * 1024 if entry.filename == "database.sqlite3" else
                             MEDIA_MAX_BYTES if path.suffix.lower() in MEDIA_FORMATS else 40 * 1024 * 1024)
                    if entry.file_size > limit or total > 512 * 1024 * 1024:
                        raise DomainError("备份解压后大小超过限制。")
                if "manifest.json" not in names or archive.getinfo("manifest.json").file_size > 1024 * 1024:
                    raise DomainError("缺少有效备份清单。")
                manifest = json.loads(archive.read("manifest.json"))
                if not isinstance(manifest, dict) or manifest.get("format") != BACKUP_FORMAT or manifest.get("version") != SCHEMA_VERSION:
                    raise DomainError("这不是当前工作台支持的备份。")
                if not isinstance(manifest.get("files"), dict) or not isinstance(manifest.get("resources"), dict):
                    raise DomainError("备份清单格式无效。")
                if set(names) != set(manifest["files"]) | {"manifest.json"} or "database.sqlite3" not in manifest["files"]:
                    raise DomainError("备份文件与清单不一致。")
                files = {}
                for name, expected in manifest["files"].items():
                    if not isinstance(expected, dict) or type(expected.get("size")) is not int or not isinstance(expected.get("sha256"), str):
                        raise DomainError("备份文件校验资料格式无效。")
                    content = archive.read(name)
                    if len(content) != expected["size"] or hashlib.sha256(content).hexdigest() != expected["sha256"]:
                        raise DomainError("备份校验失败，文件可能损坏。")
                    files[name] = content
                with tempfile.TemporaryDirectory(prefix="restore-") as temporary:
                    source_database = Path(temporary) / "database.sqlite3"
                    source_database.write_bytes(files["database.sqlite3"])
                    imported = self._validate_database(source_database)
                resource_map = manifest.get("resources", {})
                if set(resource_map) != resources(imported):
                    raise DomainError("备份资源引用与清单不一致。")
                if set(files) != {"database.sqlite3", *resource_map.values()}:
                    raise DomainError("备份包含未登记的资源文件。")
                verified_media = set()
                for item in media_items(imported):
                    content = files[resource_map[item["path"]]]
                    if len(content) != item["size"] or hashlib.sha256(content).hexdigest() != item["sha256"]:
                        raise DomainError("备份音视频与资料中的校验值不一致。", 400, "invalid_media")
                    if item["path"] not in verified_media:
                        validate_media_stream(io.BytesIO(content), PurePosixPath(item["path"]).suffix, len(content))
                        verified_media.add(item["path"])
                mapping, media = {}, {}
                for old, name in resource_map.items():
                    old = resource_path(old)
                    if name not in files or not name.startswith("assets/"):
                        raise DomainError("备份缺少本地资源。")
                    digest = hashlib.sha256(files[name]).hexdigest()
                    filename = digest + PurePosixPath(old).suffix.lower()
                    mapping[old] = "/media/" + filename
                    media[filename] = files[name]
                for item in imported["settings"]["backgrounds"]:
                    if not item["builtin"]:
                        content = files[resource_map[item["path"]]]
                        _, details, _ = decode_background(content, PurePosixPath(item["path"]).name)
                        item.update(details)
                imported = replace_resources(imported, mapping)
        except DomainError:
            raise
        except (zipfile.BadZipFile, RuntimeError, KeyError, TypeError, ValueError, OSError) as error:
            raise DomainError("无法读取备份，请选择由本工作台导出的完整 ZIP 文件。") from error
        return imported, media

    def restore(self, uploaded):
        imported, media = self._read_backup(uploaded)
        with self.lock:
            before = self.backup()
            self.backup_dir.mkdir(exist_ok=True)
            backup_name = "pre-restore-" + datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:8] + ".zip"
            backup_file = self.backup_dir / backup_name
            backup_file.write_bytes(before)
            # Content-addressed resources never overwrite an existing source file.
            # Commit the library only after every required resource is available.
            for filename, content in media.items():
                destination = self.media_dir / filename
                if destination.exists():
                    if hashlib.sha256(destination.read_bytes()).hexdigest() != Path(filename).stem:
                        raise DomainError("本地恢复资源校验失败，原资料未改变。", 409)
                else:
                    self._write_new_resource(destination, content)
            with self.transaction(write=True) as connection:
                current = self._setting(connection, "state", empty_state())
                for table in ["scripts", "categories", "history", "settings"]:
                    connection.execute(f"DELETE FROM {table}")
                for item in imported["categories"]:
                    self._category(connection, item)
                for item in imported["scripts"]:
                    self._script(connection, item)
                for item in imported["history"]:
                    connection.execute("INSERT INTO history VALUES(?,?,?,?)", (item["id"], item["script_id"], item["created_at"], encode(item["script"])))
                state = imported["settings"]["state"]
                state.update(revision=max(current["revision"], state["revision"]) + 1,
                             seek_version=max(current["seek_version"], state["seek_version"]) + 1,
                             playing=False, updated_at=now(), notice="备份已恢复，当前暂停。")
                for key, value in imported["settings"].items():
                    self._save_setting(connection, key, value)
            return {"restored": True, "backup": str(backup_file), "state": state}
