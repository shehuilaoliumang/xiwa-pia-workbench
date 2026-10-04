"""Single-document exchange, separate from full-library backup/restore.

A v1 ZIP has manifest.json, script.json and only the referenced assets/<sha>.<ext>.
Preview validates in OS temporary storage. Imports compare content before adding
or explicitly replacing a selected same-name script. Replacements preserve the
script ID and archive its previous version; queue, layout and live stay frozen.
"""
from __future__ import annotations

import copy
import hashlib
import io
import json
import re
import stat
import tempfile
import uuid
import zipfile
import zlib
from contextlib import contextmanager

from template_config import (PACKAGE_EXPORT_PREFIX, PACKAGE_FORMAT,
                             PACKAGE_TEMP_PREFIX)
from pathlib import Path, PurePosixPath

from storage import (BACKGROUND_MAX_BYTES, MEDIA_FORMATS, MEDIA_MAX_BYTES, DomainError,
                     decode_background, encode, identifier, normalize_script, now,
                     replace_resources, resources, text, validate_media_stream)

FORMAT = PACKAGE_FORMAT
VERSION = 1
PACKAGE_MAX_BYTES = 512 * 1024 * 1024
SCRIPT_MAX_BYTES = 32 * 1024 * 1024
MANIFEST_MAX_BYTES = 1024 * 1024
MAX_ASSETS = 1000
IMAGE_MIMES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp"}
MIMES = {**IMAGE_MIMES, **{ext: value[1] for ext, value in MEDIA_FORMATS.items()}}
ASSET_RE = re.compile(r"assets/[0-9a-f]{64}\.(?:png|jpg|jpeg|webp|mp4|webm|mp3|wav|m4a|ogg)\Z")
SCRIPT_FIELDS = {"id", "title", "author", "synopsis", "cast_note", "notes", "category_id", "visible", "tags",
                 "source_category", "source_pages", "blocks", "media", "role_colors"}
BLOCK_FIELDS = {"id", "kind", "text", "role", "color", "source_page", "source_file", "original_text", "runs", "image_path"}


def invalid(message="请使用工作台导出的单篇条目 ZIP；全库备份请到备份恢复页面操作。", status=400, code="invalid_script_package"):
    return DomainError(message, status, code)


def _digest(stream):
    stream.seek(0)
    digest = hashlib.sha256()
    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
        digest.update(chunk)
    stream.seek(0)
    return digest.hexdigest()


def _file_hash(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def _pairs(values):
    result = {}
    for key, value in values:
        if key in result:
            raise invalid("条目包 JSON 包含重复字段。")
        result[key] = value
    return result


def _json(content):
    def constant(_):
        raise invalid("条目包包含无效数字。")
    try:
        value = json.loads(content.decode("utf-8"), object_pairs_hook=_pairs, parse_constant=constant)
        # Escaped lone surrogates parse as JSON but cannot be saved/returned as UTF-8.
        pending = [value]
        while pending:
            item = pending.pop()
            if isinstance(item, str):
                item.encode("utf-8")
            elif isinstance(item, dict):
                pending.extend(item.keys()); pending.extend(item.values())
            elif isinstance(item, list):
                pending.extend(item)
        return value
    except (UnicodeError, ValueError, RecursionError) as error:
        raise invalid("条目包 JSON 格式无效。") from error


def _keys(value, allowed, required=()):
    if not isinstance(value, dict) or not set(required) <= set(value) or not set(value) <= allowed:
        raise invalid("条目包结构无效或包含此版本不支持的资料。")


def _normalize(value):
    _keys(value, SCRIPT_FIELDS, {"id", "title", "category_id", "blocks"})
    identifier(value["id"])
    if "visible" in value and type(value["visible"]) is not bool:
        raise invalid("条目显示状态须为 true 或 false。")
    if not isinstance(value["blocks"], list) or len(value["blocks"]) > 20000:
        raise invalid("条目正文段落数量无效。")
    for block in value["blocks"]:
        _keys(block, BLOCK_FIELDS, {"id", "kind", "text"})
        identifier(block["id"], "段落 ID")
        if block.get("kind") != "image" and "image_path" in block:
            raise invalid("文字段落不能附带未使用的图片资源。")
        if "runs" in block:
            if not isinstance(block["runs"], list):
                raise invalid("正文颜色片段格式无效。")
            for run in block["runs"]:
                _keys(run, {"text", "color", "bold"}, {"text"})
                if "bold" in run and type(run["bold"]) is not bool:
                    raise invalid("正文颜色片段的加粗状态无效。")
    if value.get("media") is not None:
        _keys(value["media"], {"path", "kind", "name", "size", "sha256", "duration", "cues"},
              {"path", "kind", "name", "size", "sha256", "cues"})
        if not isinstance(value["media"]["cues"], list):
            raise invalid("时间点格式无效。")
        for cue in value["media"]["cues"]:
            _keys(cue, {"id", "at", "label", "block_ids"}, {"id", "at", "block_ids"})
    return normalize_script(value, source_import=True)


def _asset_limit(name):
    extension = PurePosixPath(name).suffix.lower()
    return MEDIA_MAX_BYTES if extension in MEDIA_FORMATS else BACKGROUND_MAX_BYTES


def _validate_asset(path, name, mime):
    extension = PurePosixPath(name).suffix.lower()
    if extension not in MIMES or mime != MIMES[extension]:
        raise invalid("素材扩展名与清单格式不一致。")
    if extension in IMAGE_MIMES:
        _, details, _ = decode_background(path.read_bytes(), name, label="条目插图")
        if details["mime"] != mime:
            raise invalid("插图实际格式与清单不一致。")
    else:
        with path.open("rb") as stream:
            validate_media_stream(stream, extension, path.stat().st_size)


@contextmanager
def _validated(uploaded):
    """Bound every member before extraction; never extract paths from an archive."""
    try:
        uploaded.seek(0, 2)
        upload_size = uploaded.tell()
        if upload_size <= 0:
            raise invalid("收到的条目包为空，请重新选择完整 ZIP 文件。")
        if upload_size > PACKAGE_MAX_BYTES:
            raise invalid("单篇条目包不能超过 512 MB。", 413, "script_package_too_large")
        checksum = _digest(uploaded)
        with tempfile.TemporaryDirectory(prefix=PACKAGE_TEMP_PREFIX) as folder, zipfile.ZipFile(uploaded) as archive:
            entries = archive.infolist()
            names = [entry.filename for entry in entries]
            if not 2 <= len(entries) <= MAX_ASSETS + 2 or len(names) != len(set(name.casefold() for name in names)):
                raise invalid("条目包文件数量无效或包含重复文件。")
            total = 0
            for entry in entries:
                name = entry.filename
                mode = entry.external_attr >> 16
                if (entry.orig_filename != name or "\x00" in entry.orig_filename or entry.is_dir()
                        or stat.S_IFMT(mode) not in {0, stat.S_IFREG}
                        or entry.flag_bits & 1 or entry.compress_type not in {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}
                        or name not in {"manifest.json", "script.json"} and not ASSET_RE.fullmatch(name)):
                    raise invalid("条目包包含不安全路径、未登记文件或不支持的压缩方式。")
                limit = MANIFEST_MAX_BYTES if name == "manifest.json" else SCRIPT_MAX_BYTES if name == "script.json" else _asset_limit(name)
                total += entry.file_size
                if not 0 < entry.file_size <= limit or total > PACKAGE_MAX_BYTES:
                    raise invalid("条目包解压后超过大小限制。", 413, "script_package_too_large")
            if not {"manifest.json", "script.json"} <= set(names):
                raise invalid()
            manifest = _json(archive.read("manifest.json"))
            _keys(manifest, {"format", "version", "created_at", "category_name", "files", "resources"},
                  {"format", "version", "category_name", "files", "resources"})
            if manifest["format"] != FORMAT or type(manifest["version"]) is not int or manifest["version"] != VERSION:
                raise invalid()
            category_name = text(manifest["category_name"], "源分组名称", 80, True)
            if "created_at" in manifest:
                text(manifest["created_at"], "导出时间", 100)
            files, mapping = manifest["files"], manifest["resources"]
            if not isinstance(files, dict) or not isinstance(mapping, dict) or len(mapping) > 20001:
                raise invalid("条目包清单无效。")
            if set(files) != set(names) - {"manifest.json"}:
                raise invalid("条目包文件与清单不一致。")
            paths = {}
            for index, (name, expected) in enumerate(files.items()):
                _keys(expected, {"size", "sha256", "mime"}, {"size", "sha256", "mime"})
                if (type(expected["size"]) is not int or expected["size"] != archive.getinfo(name).file_size
                        or not isinstance(expected["sha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", expected["sha256"])
                        or expected["mime"] != ("application/json" if name == "script.json" else MIMES[PurePosixPath(name).suffix])):
                    raise invalid("条目包文件校验信息无效。")
                destination = Path(folder) / str(index)
                digest, size = hashlib.sha256(), 0
                with archive.open(name) as source, destination.open("xb") as target:
                    while chunk := source.read(min(1024 * 1024, expected["size"] - size + 1)):
                        size += len(chunk)
                        if size > expected["size"]:
                            raise invalid("条目包素材展开大小不一致。")
                        digest.update(chunk)
                        target.write(chunk)
                if size != expected["size"] or digest.hexdigest() != expected["sha256"]:
                    raise invalid("条目包文件校验失败，文件可能损坏。")
                if name != "script.json":
                    if PurePosixPath(name).stem != digest.hexdigest():
                        raise invalid("条目包素材名称与内容校验值不一致。")
                    _validate_asset(destination, name, expected["mime"])
                paths[name] = destination
            item = _normalize(_json(paths["script.json"].read_bytes()))
            refs = resources(item)
            if set(mapping) != refs or any(not isinstance(value, str) or value not in paths or value == "script.json" for value in mapping.values()):
                raise invalid("条目包资源引用与清单不一致。")
            if set(paths) != {"script.json", *mapping.values()}:
                raise invalid("条目包包含未使用或缺失的资源。")
            for old, member in mapping.items():
                if PurePosixPath(old).suffix.lower() != PurePosixPath(member).suffix:
                    raise invalid("条目资源路径与包内素材扩展名不一致。")
            if item.get("media"):
                media = item["media"]
                expected = files[mapping[media["path"]]]
                if media["size"] != expected["size"] or media["sha256"] != expected["sha256"]:
                    raise invalid("条目音视频信息与实际文件不一致。")
            yield {"script": item, "category_name": category_name, "sha256": checksum,
                   "mapping": mapping, "files": files, "paths": paths}
    except DomainError:
        raise
    except (zipfile.BadZipFile, zipfile.LargeZipFile, zlib.error, RuntimeError, EOFError, KeyError, TypeError,
            ValueError, RecursionError, OSError) as error:
        raise invalid("无法读取单篇条目包，请选择由工作台导出的完整 ZIP 文件。") from error


def preview_package(store, uploaded):
    from script_merge import preview_single
    with _validated(uploaded) as package:
        return preview_single(store, package)


def import_package(store, uploaded, category_id, expected_sha256, action="skip", target_id=None,
                   expected_target_fingerprint=None):
    from script_merge import import_single
    with _validated(uploaded) as package:
        return import_single(store, package, category_id, expected_sha256, action, target_id,
                             expected_target_fingerprint)


def export_package(store, item_id):
    identifier(item_id, "条目 ID")
    output = tempfile.SpooledTemporaryFile(max_size=8 * 1024 * 1024)
    try:
        with store.lock, store.transaction() as connection:
            item = _normalize(store._get(connection, "scripts", item_id))
            category = store._get(connection, "categories", item["category_id"])
            refs = sorted(resources(item))
            if len(refs) > MAX_ASSETS:
                raise invalid("单篇条目素材数量超过 1000 项，请先整理。")
            content = encode(item).encode("utf-8")
            if len(content) > SCRIPT_MAX_BYTES:
                raise invalid("单篇条目资料超过导出限制。")
            files = {"script.json": {"size": len(content), "sha256": hashlib.sha256(content).hexdigest(), "mime": "application/json"}}
            mapping, total = {}, len(content)
            with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
                archive.writestr("script.json", content)
                for ref in refs:
                    path = store.resource_file(ref)
                    extension = path.suffix.lower()
                    if not path.is_file():
                        raise invalid("条目导出未完成：缺少本地插图或音视频。", 409, "missing_resource")
                    if extension not in MIMES or not 0 < path.stat().st_size <= _asset_limit(path.name):
                        raise invalid("导出插图须为 12 MB 内 PNG、JPEG、WebP；音视频须在 200 MB 内。")
                    checksum = _file_hash(path)
                    member = "assets/" + checksum + extension
                    mapping[ref] = member
                    if member in files:
                        continue
                    _validate_asset(path, member, MIMES[extension])
                    size = path.stat().st_size
                    total += size
                    if total > PACKAGE_MAX_BYTES:
                        raise invalid("单篇条目包超过 512 MB。", 413, "script_package_too_large")
                    files[member] = {"size": size, "sha256": checksum, "mime": MIMES[extension]}
                    archive.write(path, member)
                if item.get("media"):
                    media = item["media"]
                    expected = files[mapping[media["path"]]]
                    if media["size"] != expected["size"] or media["sha256"] != expected["sha256"]:
                        raise invalid("条目音视频校验失败，请先重新上传媒体。", 409, "invalid_media")
                manifest = encode({"format": FORMAT, "version": VERSION, "created_at": now(),
                                   "category_name": category["name"], "files": files, "resources": mapping}).encode("utf-8")
                if len(manifest) > MANIFEST_MAX_BYTES or total + len(manifest) > PACKAGE_MAX_BYTES:
                    raise invalid("单篇条目包超过大小限制。", 413, "script_package_too_large")
                archive.writestr("manifest.json", manifest)
            if output.tell() > PACKAGE_MAX_BYTES:
                raise invalid("单篇条目 ZIP 超过 512 MB。", 413, "script_package_too_large")
        title = re.sub(r'[\\/:*?"<>|\x00-\x1f]', '_', item["title"]).strip(' .')[:70] or "未命名"
        output.seek(0)
        return output, PACKAGE_EXPORT_PREFIX + title + ".zip"
    except Exception:
        output.close()
        raise
