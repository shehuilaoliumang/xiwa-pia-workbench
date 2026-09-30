"""Fan-side single-script editor service.

Opens an anchor-exported xiwa-script-package v1 ZIP, lets the user edit the
script text/illustrations AND the media attachment (upload/remove a local
audio/video file, set duration, add/edit/delete cue points with linked
blocks), and re-exports a v1 ZIP the anchor workbench can import.

Workspaces are plain folders under <data_dir>/workspaces/<wsid>/:
  meta.json     import metadata (category name, opened time, source sha256)
  script.json   the full script item (refs kept as-is)
  refmap.json   {resource ref -> "files/<sha256>.<ext>"}
  files/        asset files named by their SHA-256 content hash
"""
from __future__ import annotations

import copy
import hashlib
import io
import json
import re
import tempfile
import uuid
import zipfile
from pathlib import Path, PurePosixPath

from flask import Flask, abort, jsonify, render_template, request, send_file

import script_package as package
import import_parser
from storage import (DomainError, MEDIA_FORMATS, MEDIA_MAX_BYTES, color, decode_background, encode, media_duration,
                     identifier, normalize_cues, normalize_media, normalize_script, now, resources, validate_media_stream)

PROJECT_ROOT = Path(__file__).resolve().parent
MAX_UPLOAD_BYTES = 520 * 1024 * 1024      # 512 MB package + multipart overhead
MAX_WORKSPACES = 200
ASSET_NAME_RE = re.compile(r"[0-9a-f]{64}\.(?:png|jpg|jpeg|webp|mp4|webm|mp3|wav|m4a|ogg)\Z")
IMAGE_MIME = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp"}
MEDIA_MIME = {extension: mime for extension, (_kind, mime) in MEDIA_FORMATS.items()}


def _domain_error(message, status=400, code="validation_error"):
    return DomainError(message, status, code)


def _workspace_dir(data_dir, wsid):
    if not isinstance(wsid, str) or not re.fullmatch(r"ws-[0-9a-f]{32}", wsid or ""):
        raise _domain_error("工作区标识无效。", 400, "invalid_workspace")
    root = (data_dir / "workspaces").resolve()
    ws_dir = (root / wsid).resolve()
    if not ws_dir.is_relative_to(root) or not ws_dir.is_dir():
        raise _domain_error("工作区不存在。", 404, "workspace_missing")
    return ws_dir


def _read_json(path, label):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise _domain_error(f"{label}读取失败，请重新打开这份剧本包。", 500, "workspace_read_failed") from error


def _script_path(ws_dir):
    return ws_dir / "script.json"


def _summary(wsid, item, meta):
    return {
        "id": wsid,
        "title": item["title"],
        "author": item["author"],
        "category_name": meta.get("category_name", ""),
        "opened_at": meta.get("opened_at", ""),
        "text_blocks": sum(block["kind"] == "text" for block in item["blocks"]),
        "image_blocks": sum(block["kind"] == "image" for block in item["blocks"]),
        "has_media": bool(item.get("media")),
        "cue_count": len(item.get("media", {}).get("cues", [])),
    }


def open_package(data_dir, uploaded):
    """Validate an anchor-exported v1 ZIP and expand it into a new workspace."""
    workspaces = data_dir / "workspaces"
    existing = [child for child in workspaces.iterdir() if child.is_dir()] if workspaces.is_dir() else []
    if len(existing) >= MAX_WORKSPACES:
        raise _domain_error("工作区数量已达上限，请先导出并删除不再需要的剧本。", 409, "workspace_limit")
    with package._validated(uploaded) as pkg:
        item = pkg["script"]
        wsid = "ws-" + uuid.uuid4().hex
        ws_dir = workspaces / wsid
        files_dir = ws_dir / "files"
        files_dir.mkdir(parents=True, exist_ok=True)
        refmap = {}
        for old, member in pkg["mapping"].items():
            filename = PurePosixPath(member).name          # "<sha256>.<ext>"
            destination = files_dir / filename
            if not destination.exists():
                destination.write_bytes(pkg["paths"][member].read_bytes())
            refmap[old] = "files/" + filename
        (ws_dir / "refmap.json").write_text(json.dumps(refmap, ensure_ascii=False), encoding="utf-8")
        (ws_dir / "meta.json").write_text(json.dumps(
            {"category_name": pkg["category_name"], "opened_at": now(), "source_sha256": pkg["sha256"]},
            ensure_ascii=False), encoding="utf-8")
        (ws_dir / "script.json").write_text(encode(item), encoding="utf-8")
        return _summary(wsid, item, _read_json(ws_dir / "meta.json", "工作区信息"))


def preview_import_text(data_dir, payload):
    """Parse pasted text or an uploaded TXT/DOCX into a candidate script
    (mirrors the anchor workbench's /api/import-preview; nothing is written)."""
    if not isinstance(payload, dict):
        raise _domain_error("导入预览请求无效。")
    return import_parser.parse_text(payload.get("text") or "", payload.get("filename") or "")


def preview_import_upload(data_dir, upload, filename):
    return import_parser.parse_upload(upload.stream, filename)


def create_workspace(data_dir, payload):
    """Create a brand-new script workspace from scratch (blank or from a
    parsed candidate), exactly as the anchor workbench creates scripts.
    Blocks are optional; the user fills them in the editor afterwards."""
    if not isinstance(payload, dict):
        raise _domain_error("新建剧本请求无效。")
    workspaces = data_dir / "workspaces"
    existing = [child for child in workspaces.iterdir() if child.is_dir()] if workspaces.is_dir() else []
    if len(existing) >= MAX_WORKSPACES:
        raise _domain_error("工作区数量已达上限，请先导出并删除不再需要的剧本。", 409, "workspace_limit")
    blocks = payload.get("blocks")
    if blocks is not None and (not isinstance(blocks, list) or len(blocks) > 20000):
        raise _domain_error("正文段落数量无效。")
    title = payload.get("title")
    if not isinstance(title, str) or not title.strip():
        title = "未命名剧本"
    item = package._normalize({
        "id": "script-" + uuid.uuid4().hex[:12],
        "title": title,
        "author": payload.get("author", ""),
        "synopsis": payload.get("synopsis", ""),
        "cast_note": payload.get("cast_note", ""),
        "notes": payload.get("notes", ""),
        "category_id": "category-fan",
        "visible": payload.get("visible", True),
        "tags": payload.get("tags", []),
        "role_colors": payload.get("role_colors", {}),
        "blocks": blocks if blocks is not None else [],
        "media": None,
    })
    wsid = "ws-" + uuid.uuid4().hex
    ws_dir = workspaces / wsid
    (ws_dir / "files").mkdir(parents=True, exist_ok=True)
    (ws_dir / "refmap.json").write_text("{}", encoding="utf-8")
    meta = {"category_name": payload.get("category_name") or "新建剧本", "opened_at": now(), "source_sha256": None}
    (ws_dir / "meta.json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
    (ws_dir / "script.json").write_text(encode(item), encoding="utf-8")
    return _summary(wsid, item, meta)


def list_workspaces(data_dir):
    root = data_dir / "workspaces"
    if not root.is_dir():
        return []
    result = []
    for ws_dir in sorted(root.iterdir(), key=lambda child: child.stat().st_mtime, reverse=True):
        if not ws_dir.is_dir():
            continue
        wsid = ws_dir.name
        try:
            item = _read_json(_script_path(ws_dir), "剧本数据")
            meta = _read_json(ws_dir / "meta.json", "工作区信息")
            result.append(_summary(wsid, item, meta))
        except DomainError:
            continue
    return result


def get_workspace(data_dir, wsid):
    ws_dir = _workspace_dir(data_dir, wsid)
    item = _read_json(_script_path(ws_dir), "剧本数据")
    meta = _read_json(ws_dir / "meta.json", "工作区信息")
    return {"script": item, "category_name": meta.get("category_name", "")}


def save_workspace(data_dir, wsid, payload):
    """Merge editable fields, validate retained cue references, and persist."""
    if not isinstance(payload, dict):
        raise _domain_error("保存内容无效。")
    ws_dir = _workspace_dir(data_dir, wsid)
    stored = _read_json(_script_path(ws_dir), "剧本数据")
    merged = copy.deepcopy(stored)
    for field in ("title", "author", "synopsis", "cast_note", "notes", "tags", "visible", "role_colors"):
        if field in payload:
            merged[field] = payload[field]
    # Media metadata (file/duration/cues) is edited through the dedicated
    # media endpoints; a normal save keeps the stored copy. package._normalize
    # then validates cues against the new blocks, so deleting a block that a
    # cue references fails with the same error as the anchor workbench:
    # "删除正文前请先调整相关时间点".
    merged["media"] = stored.get("media")
    if "blocks" in payload:
        blocks = payload["blocks"]
        if not isinstance(blocks, list) or len(blocks) > 20000:
            raise _domain_error("正文段落数量无效。")
        merged["blocks"] = copy.deepcopy(blocks)
        previous_blocks = {block["id"]: block for block in stored["blocks"]}
        for block in merged["blocks"]:
            if not isinstance(block, dict):
                raise _domain_error("正文段落格式无效。")
            if "id" in block:
                identifier(block["id"], "段落 ID")
            previous = previous_blocks.get(block.get("id"))
            if not previous or block.get("kind", "text") != "text":
                continue
            # Older fan clients change the color picker without clearing PPT
            # runs. A changed paragraph color must reach the anchor display.
            if color(block.get("color"), "#343b37") != previous["color"] and block.get("runs") == previous.get("runs"):
                block["runs"] = [{"text": block.get("text", ""), "color": color(block.get("color"), "#343b37"), "bold": False}]
    # A save is an edit of the stored source, not a second source import.
    # Preserve original provenance; changed text cannot retain stale PPT runs.
    item = package._normalize(normalize_script(merged, stored))
    refmap = _read_json(ws_dir / "refmap.json", "素材清单")
    files_dir = ws_dir / "files"
    for ref in sorted(resources(item)):
        member = refmap.get(ref)
        if not member or not (files_dir / PurePosixPath(member).name).is_file():
            raise _domain_error("缺少素材文件，请重新打开这份剧本包后再编辑。", 409, "missing_resource")
    (ws_dir / "script.json").write_text(encode(item), encoding="utf-8")
    return {"ok": True, "script": item}


def add_image(data_dir, wsid, upload):
    """Validate and store a new illustration; returns the resource ref."""
    ws_dir = _workspace_dir(data_dir, wsid)
    raw = upload.read()
    try:
        content, details, extension = decode_background(raw, None, sanitize=True, label="剧本插图")
    except DomainError as error:
        raise _domain_error(error.args[0] if error.args else "插图无效。", error.status, error.code) from error
    digest = hashlib.sha256(content).hexdigest()
    filename = digest + extension
    files_dir = ws_dir / "files"
    files_dir.mkdir(parents=True, exist_ok=True)
    destination = files_dir / filename
    if not destination.exists():
        destination.write_bytes(content)
    ref = "/static/media/" + filename
    refmap = _read_json(ws_dir / "refmap.json", "素材清单")
    refmap[ref] = "files/" + filename
    (ws_dir / "refmap.json").write_text(json.dumps(refmap, ensure_ascii=False), encoding="utf-8")
    return {"ref": ref, "filename": filename, "width": details["width"], "height": details["height"], "size": details["size"]}


def upload_media(data_dir, wsid, upload, filename):
    """Validate a local audio/video file and attach it as the script's media.

    Mirrors the anchor workbench's upload_script_media: container signature
    check, sha-256 naming, duration starts unknown (None) and is set by the
    user when saving cue points.
    """
    name = (filename or "").replace("\\", "/").rsplit("/", 1)[-1].strip()
    if not name:
        raise _domain_error("请选择要关联的本地音视频文件。")
    if len(name) > 255:
        raise _domain_error("媒体名称过长。")
    extension = PurePosixPath(name).suffix.lower()
    if extension not in MEDIA_FORMATS:
        raise _domain_error("仅支持 MP4、WebM、MP3、WAV、M4A 和 OGG 音视频。", 400, "invalid_media")
    ws_dir = _workspace_dir(data_dir, wsid)
    files_dir = ws_dir / "files"
    files_dir.mkdir(parents=True, exist_ok=True)
    temporary = ws_dir / (".upload-" + uuid.uuid4().hex)
    destination, created = None, False
    try:
        digest, size = hashlib.sha256(), 0
        with temporary.open("xb") as output:
            while chunk := upload.read(min(1024 * 1024, MEDIA_MAX_BYTES - size + 1)):
                size += len(chunk)
                if size > MEDIA_MAX_BYTES:
                    raise _domain_error("媒体文件超过 200 MB，请压缩后再上传。", 413, "media_too_large")
                digest.update(chunk)
                output.write(chunk)
        if size == 0:
            raise _domain_error("上传的媒体文件为空。", 400, "invalid_media")
        with temporary.open("rb") as source:
            kind = validate_media_stream(source, extension, size)
        checksum = digest.hexdigest()
        destination = files_dir / (checksum + extension)
        if destination.exists():
            with destination.open("rb") as existing:
                if destination.stat().st_size != size or hashlib.file_digest(existing, "sha256").hexdigest() != checksum:
                    raise _domain_error("已有同名媒体校验失败，原资料未改变。", 409, "invalid_media")
        else:
            temporary.rename(destination)
            created = True
        item = _read_json(_script_path(ws_dir), "剧本数据")
        media = normalize_media({"path": "/media/" + destination.name, "kind": kind, "name": name,
                                 "size": size, "sha256": checksum, "duration": None, "cues": []},
                                item["blocks"])
        item["media"] = media
        refmap = _read_json(ws_dir / "refmap.json", "素材清单")
        refmap[media["path"]] = "files/" + destination.name
        (ws_dir / "refmap.json").write_text(json.dumps(refmap, ensure_ascii=False), encoding="utf-8")
        (ws_dir / "script.json").write_text(encode(item), encoding="utf-8")
        return media
    except OSError as error:
        raise _domain_error("媒体保存失败，原资料未改变；请检查存储空间后重试。", 503, "resource_write_failed") from error
    except Exception:
        if created and destination is not None:
            destination.unlink(missing_ok=True)
        raise
    finally:
        temporary.unlink(missing_ok=True)


def save_media(data_dir, wsid, payload):
    """Set media duration and cue points (mirrors save_media_cues)."""
    if not isinstance(payload, dict):
        raise _domain_error("时间点保存内容无效。")
    ws_dir = _workspace_dir(data_dir, wsid)
    item = _read_json(_script_path(ws_dir), "剧本数据")
    if not item.get("media"):
        raise _domain_error("请先为剧本上传音视频。", 409, "media_required")
    media = item["media"]
    media["duration"] = media_duration(payload.get("duration", media.get("duration")))
    media["cues"] = normalize_cues(payload.get("cues"), item["blocks"], media["duration"])
    (ws_dir / "script.json").write_text(encode(item), encoding="utf-8")
    return media


def delete_media(data_dir, wsid):
    """Remove the attached media (mirrors delete_script_media)."""
    ws_dir = _workspace_dir(data_dir, wsid)
    item = _read_json(_script_path(ws_dir), "剧本数据")
    media = item.pop("media", None)
    if media is not None:
        refmap = _read_json(ws_dir / "refmap.json", "素材清单")
        member = refmap.pop(media["path"], None)
        (ws_dir / "refmap.json").write_text(json.dumps(refmap, ensure_ascii=False), encoding="utf-8")
        (ws_dir / "script.json").write_text(encode(item), encoding="utf-8")
        if member:
            try:
                (ws_dir / "files" / PurePosixPath(member).name).unlink(missing_ok=True)
            except OSError:
                pass
    return {"ok": True, "script": item}


def delete_workspace(data_dir, wsid):
    ws_dir = _workspace_dir(data_dir, wsid)
    try:
        for child in ws_dir.iterdir():
            if child.is_dir():
                for sub in child.iterdir():
                    sub.unlink()
                child.rmdir()
            else:
                child.unlink()
        ws_dir.rmdir()
    except OSError as error:
        raise _domain_error("删除工作区失败，请重试。", 500, "workspace_delete_failed") from error
    return {"ok": True}


def export_workspace(data_dir, wsid):
    """Re-export a v1 ZIP exactly as the anchor workbench expects on import."""
    ws_dir = _workspace_dir(data_dir, wsid)
    item = package._normalize(_read_json(_script_path(ws_dir), "剧本数据"))
    refs = sorted(resources(item))
    if len(refs) > package.MAX_ASSETS:
        raise package.invalid("单篇剧本素材数量超过 1000 项，请先整理。")
    content = encode(item).encode("utf-8")
    if len(content) > package.SCRIPT_MAX_BYTES:
        raise package.invalid("单篇剧本资料超过导出限制。")
    meta = _read_json(ws_dir / "meta.json", "工作区信息")
    category_name = meta.get("category_name") or item.get("source_category") or "未命名"
    refmap = _read_json(ws_dir / "refmap.json", "素材清单")
    files_dir = ws_dir / "files"

    output = tempfile.SpooledTemporaryFile(max_size=8 * 1024 * 1024)
    files = {"script.json": {"size": len(content), "sha256": hashlib.sha256(content).hexdigest(), "mime": "application/json"}}
    mapping, total = {}, len(content)
    try:
        with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
            archive.writestr("script.json", content)
            for ref in refs:
                member = refmap.get(ref)
                if not member:
                    raise package.invalid("剧本导出未完成：缺少本地插图或音视频。", 409, "missing_resource")
                path = files_dir / PurePosixPath(member).name
                extension = path.suffix.lower()
                if not path.is_file() or extension not in package.MIMES or not 0 < path.stat().st_size <= package._asset_limit(path.name):
                    raise package.invalid("导出插图须为 12 MB 内 PNG、JPEG、WebP；音视频须在 200 MB 内。")
                checksum = hashlib.sha256(path.read_bytes()).hexdigest()
                member_name = "assets/" + checksum + extension
                mapping[ref] = member_name
                if member_name in files:
                    continue
                package._validate_asset(path, member_name, package.MIMES[extension])
                size = path.stat().st_size
                total += size
                if total > package.PACKAGE_MAX_BYTES:
                    raise package.invalid("单篇剧本包超过 512 MB。", 413, "script_package_too_large")
                files[member_name] = {"size": size, "sha256": checksum, "mime": package.MIMES[extension]}
                archive.write(path, member_name)
            if item.get("media"):
                media = item["media"]
                expected = files[mapping[media["path"]]]
                if media["size"] != expected["size"] or media["sha256"] != expected["sha256"]:
                    raise package.invalid("剧本音视频校验失败，请重新打开这份剧本包。", 409, "invalid_media")
            manifest = encode({"format": package.FORMAT, "version": package.VERSION, "created_at": now(),
                               "category_name": category_name, "files": files, "resources": mapping}).encode("utf-8")
            if len(manifest) > package.MANIFEST_MAX_BYTES or total + len(manifest) > package.PACKAGE_MAX_BYTES:
                raise package.invalid("单篇剧本包超过大小限制。", 413, "script_package_too_large")
            archive.writestr("manifest.json", manifest)
        if output.tell() > package.PACKAGE_MAX_BYTES:
            raise package.invalid("单篇剧本 ZIP 超过 512 MB。", 413, "script_package_too_large")
    except Exception:
        output.close()
        raise
    title = re.sub(r'[\\/:*?"<>|\x00-\x1f]', '_', item["title"]).strip(' .')[:70] or "未命名"
    output.seek(0)
    return output, "喜娃剧本-" + title + ".zip"


def create_app(data_dir):
    data_dir = Path(data_dir).resolve()
    app = Flask(__name__, template_folder=str(PROJECT_ROOT / "templates"))
    app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_BYTES
    csrf_token = uuid.uuid4().hex
    app.extensions["csrf_token"] = csrf_token

    @app.after_request
    def response_headers(response):
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "same-origin"
        response.headers["X-Frame-Options"] = "SAMEORIGIN"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; "
            "base-uri 'self'; frame-ancestors 'self'"
        )
        if request.path.startswith("/api/") or response.mimetype == "text/html":
            response.headers["Cache-Control"] = "no-store"
        return response

    @app.before_request
    def guard_csrf():
        if request.method in {"POST", "PUT", "PATCH", "DELETE"} and request.path.startswith("/api/"):
            if not (request.headers.get("X-CSRF-Token") or "").strip() or \
               request.headers.get("X-CSRF-Token") != csrf_token:
                abort(403)

    @app.get("/")
    def index():
        return render_template("editor.html", csrf_token=csrf_token)

    @app.get("/api/health")
    def health():
        return jsonify(app="xiwa-fan-editor", ok=True, version="0.2.1", data_dir=str(data_dir))

    @app.get("/api/workspaces")
    def workspaces():
        return jsonify({"workspaces": list_workspaces(data_dir)})

    @app.post("/api/workspaces")
    def open_workspace():
        uploaded = request.files.get("package")
        if uploaded is None or not uploaded.filename:
            raise _domain_error("请选择一份由主播工作台导出的单篇剧本 ZIP。")
        item = open_package(data_dir, uploaded.stream)
        return jsonify({"ok": True, "workspace": item})

    @app.post("/api/workspaces/new")
    def workspace_new():
        payload = request.get_json(silent=True)
        item = create_workspace(data_dir, payload)
        return jsonify({"ok": True, "workspace": item}), 201

    @app.route("/api/import-preview", methods=["POST"])
    def import_preview():
        if request.is_json:
            payload = request.get_json(silent=True) or {}
            result = preview_import_text(data_dir, payload)
        else:
            uploaded = request.files.get("file")
            if uploaded is None or not uploaded.filename:
                raise _domain_error("请粘贴正文或选择 TXT、DOCX 文件。", 400, "invalid_import")
            result = preview_import_upload(data_dir, uploaded, uploaded.filename)
        return jsonify(result)

    @app.get("/api/workspaces/<wsid>")
    def workspace_detail(wsid):
        result = get_workspace(data_dir, wsid)
        return jsonify(result)

    @app.put("/api/workspaces/<wsid>")
    def workspace_save(wsid):
        payload = request.get_json(silent=True)
        result = save_workspace(data_dir, wsid, payload)
        return jsonify(result)

    @app.post("/api/workspaces/<wsid>/images")
    def workspace_image(wsid):
        upload = request.files.get("image")
        if upload is None or not upload.filename:
            raise _domain_error("请选择一张图片。")
        result = add_image(data_dir, wsid, upload.stream)
        return jsonify({"ok": True, **result})

    @app.get("/api/workspaces/<wsid>/assets/<filename>")
    def workspace_asset(wsid, filename):
        if not ASSET_NAME_RE.fullmatch(filename or ""):
            abort(404)
        ws_dir = _workspace_dir(data_dir, wsid)
        path = ws_dir / "files" / filename
        if not path.is_file():
            abort(404)
        extension = PurePosixPath(filename).suffix.lower()
        mimetype = IMAGE_MIME.get(extension) or MEDIA_MIME.get(extension)
        if mimetype is None:
            abort(404)
        # conditional=True gives HTML5 players HTTP range support.
        return send_file(path, mimetype=mimetype, max_age=0, conditional=True)

    @app.post("/api/workspaces/<wsid>/media")
    def workspace_media_upload(wsid):
        request.max_content_length = 201 * 1024 * 1024
        uploaded = request.files.get("file")
        if uploaded is None:
            raise _domain_error("请选择要关联的本地音视频文件。")
        media = upload_media(data_dir, wsid, uploaded.stream, uploaded.filename or "")
        return jsonify({"ok": True, "media": media})

    @app.put("/api/workspaces/<wsid>/media")
    def workspace_media_save(wsid):
        payload = request.get_json(silent=True)
        media = save_media(data_dir, wsid, payload)
        return jsonify({"ok": True, "media": media})

    @app.delete("/api/workspaces/<wsid>/media")
    def workspace_media_delete(wsid):
        return jsonify(delete_media(data_dir, wsid))

    @app.post("/api/workspaces/<wsid>/export")
    def workspace_export(wsid):
        output, filename = export_workspace(data_dir, wsid)
        return send_file(output, mimetype="application/zip", as_attachment=True,
                         download_name=filename, max_age=0)

    @app.delete("/api/workspaces/<wsid>")
    def workspace_delete(wsid):
        return jsonify(delete_workspace(data_dir, wsid))

    @app.errorhandler(DomainError)
    def handle_domain(error):
        return jsonify({"error": str(error), "code": error.code}), error.status

    @app.errorhandler(403)
    @app.errorhandler(404)
    @app.errorhandler(405)
    @app.errorhandler(413)
    def handle_http(error):
        messages = {403: "页面凭据已失效，请刷新页面后重试。", 404: "页面或资源不存在。",
                    405: "不支持此请求方法。", 413: "请求内容过大，请压缩后再试。"}
        return jsonify({"error": messages.get(error.code, "请求无法完成。"), "code": "http_error"}), error.code

    @app.errorhandler(500)
    def handle_internal(error):
        return jsonify({"error": "服务内部错误，请重启工具后重试。", "code": "internal_error"}), 500

    return app
