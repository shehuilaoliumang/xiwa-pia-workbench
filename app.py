"""One local Flask service for the library, editor, controller and display."""

from __future__ import annotations

import io
import secrets
import sqlite3
from datetime import datetime
from pathlib import Path
from urllib.parse import urlsplit

from flask import Flask, jsonify, render_template, request, send_file, send_from_directory
from werkzeug.exceptions import HTTPException

from storage import DomainError, Store, MEDIA_FORMATS, BACKGROUND_MAX_BYTES
from import_parser import parse_text, parse_upload
from script_package import export_package, preview_package, import_package, PACKAGE_MAX_BYTES
from script_merge import preview_backup, import_backup
from template_config import (APP_ID, APP_VERSION, BACKUP_PREFIX, DEFAULT_GROUPS,
                             TERMS, template_globals)


def create_app(test_config=None):
    root = Path(__file__).resolve().parent
    instance_path = Path((test_config or {}).get("INSTANCE_PATH", root / "instance")).resolve()
    application = Flask(__name__, instance_path=str(instance_path))
    application.config.from_mapping(
        DATABASE=str(instance_path / "workbench.sqlite3"),
        INSTANCE_PATH=str(instance_path),
        SEED_PATH=str(root / "data" / "seed.json"),
        PROJECT_ROOT=str(root),
        MAX_CONTENT_LENGTH=520 * 1024 * 1024,
        ALLOWED_HOSTS={"127.0.0.1", "localhost", "::1"},
        CSRF_ENABLED=True,
        TEMPLATES_AUTO_RELOAD=True,
    )
    if test_config:
        application.config.update(test_config)
    application.json.ensure_ascii = False
    application.jinja_env.globals.update(template_globals())
    store = Store(application.config["DATABASE"], application.config["SEED_PATH"], application.config["PROJECT_ROOT"])
    application.extensions["store"] = store
    application.extensions["csrf_token"] = secrets.token_urlsafe(32)

    @application.before_request
    def local_request_guard():
        try:
            hostname = urlsplit("http://" + request.host).hostname
        except ValueError:
            hostname = None
        if hostname not in application.config["ALLOWED_HOSTS"]:
            raise DomainError("此版本仅允许本机访问。", 403, "invalid_host")
        if request.method not in {"GET", "HEAD", "OPTIONS"}:
            origin = request.headers.get("Origin")
            if origin:
                try:
                    parsed = urlsplit(origin)
                except ValueError:
                    raise DomainError("请求来源无效。", 403, "invalid_origin") from None
                if parsed.scheme != request.scheme or parsed.netloc.lower() != request.host.lower():
                    raise DomainError("请求来源不匹配，请在本机工作台操作。", 403, "invalid_origin")
            if request.headers.get("Sec-Fetch-Site") == "cross-site":
                raise DomainError("不接受跨站写入请求。", 403, "invalid_origin")
            token = request.headers.get("X-CSRF-Token", "")
            if application.config["CSRF_ENABLED"] and not secrets.compare_digest(token.encode("utf-8"), application.extensions["csrf_token"].encode("ascii")):
                raise DomainError("页面凭据已失效，请刷新页面后重试。", 403, "csrf_failed")

    @application.after_request
    def response_headers(response):
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "same-origin"
        response.headers["X-Frame-Options"] = "SAMEORIGIN"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'"
        )
        if request.path.startswith("/api/") or response.mimetype == "text/html":
            response.headers["Cache-Control"] = "no-store"
        return response

    @application.errorhandler(DomainError)
    def domain_error(error):
        return jsonify(error=str(error), code=error.code), error.status

    @application.errorhandler(HTTPException)
    def http_error(error):
        if error.code == 413 and request.path == "/api/script-images":
            return jsonify(error="正文图片须为不超过 12 MB 的 PNG、JPEG 或 WebP。", code="invalid_image"), 413
        if error.code == 413 and request.path.startswith("/api/script-packages/"):
            return jsonify(error="单篇条目 ZIP 须在 512 MB 内（插图单张 12 MB；音视频 200 MB）。", code="script_package_too_large"), 413
        messages = {404: "页面或资源不存在。", 413: "文件超过上传限制（音视频 200 MB；备份解压总量 512 MB）。", 400: "请求格式无效。", 405: "不支持此请求方法。"}
        return jsonify(error=messages.get(error.code, "请求无法完成。"), code="http_error"), error.code

    @application.errorhandler(sqlite3.Error)
    def database_error(error):
        application.logger.exception("SQLite operation failed")
        return jsonify(error="本地资料操作未完成，数据已回滚；请稍后重试。", code="database_error"), 503

    def body():
        payload = request.get_json(silent=False)
        if not isinstance(payload, dict):
            raise DomainError("请提交 JSON 对象。")
        return payload

    def bootstrap():
        result = store.library()
        result["csrf_token"] = application.extensions["csrf_token"]
        return result

    @application.get("/")
    def catalog():
        return render_template("catalog.html", bootstrap=bootstrap(), page="catalog")

    @application.get("/script/<script_id>")
    def reader(script_id):
        data = bootstrap()
        script = next((item for item in data["scripts"] if item["id"] == script_id), None)
        if not script:
            raise DomainError("条目不存在。", 404, "not_found")
        return render_template("reader.html", bootstrap=data, script=script, script_id=script_id, page="reader")

    @application.get("/script/<script_id>/media")
    def media_editor(script_id):
        data = bootstrap()
        script = next((item for item in data["scripts"] if item["id"] == script_id), None)
        if not script:
            raise DomainError("条目不存在。", 404, "not_found")
        return render_template("media_editor.html", bootstrap=data, script=script, script_id=script_id, page="media-editor")

    @application.get("/control")
    def control():
        return render_template("control.html", bootstrap=bootstrap(), page="control")

    @application.get("/display")
    def display():
        # GET stays read-only. The display browser explicitly connects once its
        # controller is ready, so an operation-page refresh cannot pause playback.
        return render_template("display.html", bootstrap=bootstrap(), page="display")

    @application.get("/manage")
    def manage():
        return render_template("manage.html", bootstrap=bootstrap(), page="manage")

    @application.get("/api/health")
    def health():
        return jsonify(ok=True, app=APP_ID, version=APP_VERSION, schema_version=1, data_dir=str(store.instance_dir))

    @application.get("/api/library")
    def library():
        return jsonify(bootstrap())

    @application.get("/api/backgrounds")
    def backgrounds():
        return jsonify(backgrounds=store.backgrounds())

    @application.post("/api/backgrounds")
    def upload_background():
        uploaded = request.files.get("file")
        if not uploaded or not uploaded.filename:
            raise DomainError("请选择背景图片。")
        return jsonify(store.upload_background(uploaded.stream, uploaded.filename, request.form.get("name"))), 201

    @application.patch("/api/backgrounds/<item_id>")
    def rename_background(item_id):
        return jsonify(store.rename_background(item_id, body()))

    @application.delete("/api/backgrounds/<item_id>")
    def delete_background(item_id):
        return jsonify(store.delete_background(item_id))

    @application.post("/api/categories")
    def create_category():
        return jsonify(store.save_category(body())), 201

    @application.patch("/api/categories/<item_id>")
    def update_category(item_id):
        return jsonify(store.save_category(body(), item_id))

    @application.delete("/api/categories/<item_id>")
    def delete_category(item_id):
        payload = request.get_json(silent=True) or {}
        if not isinstance(payload, dict):
            raise DomainError("删除请求格式无效。")
        return jsonify(store.delete_category(item_id, payload.get("target_id")))

    @application.post("/api/categories/reorder")
    def reorder_categories():
        return jsonify(categories=store.reorder_categories(body().get("ids")))

    @application.post("/api/script-images")
    def upload_script_image():
        request.max_content_length = BACKGROUND_MAX_BYTES + 1024 * 1024
        uploaded = request.files.get("file")
        if not uploaded or not uploaded.filename:
            raise DomainError("请选择要添加到正文的图片。", 400, "invalid_image")
        return jsonify(store.upload_script_image(uploaded.stream, uploaded.filename)), 201

    @application.post("/api/scripts")
    def create_script():
        return jsonify(store.save_script(body())), 201

    @application.patch("/api/scripts/<item_id>")
    def update_script(item_id):
        return jsonify(store.save_script(body(), item_id))

    @application.get("/api/scripts/<item_id>/export")
    def export_script_package(item_id):
        stream, filename = export_package(store, item_id)
        response = send_file(stream, mimetype="application/zip", as_attachment=True, download_name=filename)
        response.call_on_close(stream.close)
        return response

    def script_package_upload():
        request.max_content_length = PACKAGE_MAX_BYTES + 1024 * 1024
        uploaded = request.files.get("file")
        if not uploaded or not uploaded.filename or Path(uploaded.filename).suffix.lower() != ".zip":
            raise DomainError("请选择由工作台导出的单篇条目 ZIP 文件。", 400, "invalid_script_package")
        return uploaded

    @application.post("/api/script-packages/preview")
    def preview_script_package():
        uploaded = script_package_upload()
        return jsonify(preview_package(store, uploaded.stream))

    @application.post("/api/script-packages/import")
    def import_script_package():
        uploaded = script_package_upload()
        return jsonify(import_package(store, uploaded.stream, request.form.get("category_id"),
                                      request.form.get("expected_sha256"), request.form.get("action", "skip"),
                                      request.form.get("target_id"), request.form.get("expected_target_fingerprint"))), 201

    @application.post("/api/library-merge/preview")
    def preview_library_merge():
        uploaded = script_package_upload()
        return jsonify(preview_backup(store, uploaded.stream))

    @application.post("/api/library-merge/import")
    def import_library_merge():
        uploaded = script_package_upload()
        import json
        try:
            decisions = json.loads(request.form.get("decisions", "null"))
        except (ValueError, RecursionError):
            raise DomainError("合并选择格式无效，请重新预览后确认。") from None
        return jsonify(import_backup(store, uploaded.stream, request.form.get("expected_sha256"), decisions))

    @application.post("/api/scripts/<item_id>/media")
    def upload_script_media(item_id):
        request.max_content_length = 201 * 1024 * 1024
        uploaded = request.files.get("file")
        if not uploaded or not uploaded.filename:
            raise DomainError("请选择要关联的本地音视频文件。")
        return jsonify(store.upload_script_media(item_id, uploaded.stream, uploaded.filename)), 201

    @application.delete("/api/scripts/<item_id>/media")
    def delete_script_media(item_id):
        return jsonify(store.delete_script_media(item_id))

    @application.put("/api/scripts/<item_id>/media/cues")
    def save_media_cues(item_id):
        return jsonify(store.save_media_cues(item_id, body()))

    @application.get("/api/scripts/<item_id>/history")
    def script_history(item_id):
        return jsonify(history=store.history(item_id))

    @application.post("/api/scripts/<item_id>/history/<history_id>/restore")
    def restore_script_history(item_id, history_id):
        return jsonify(store.restore_history(item_id, history_id))

    @application.route("/api/queue", methods=["GET", "PUT", "POST"])
    def queue():
        return jsonify(store.library()["queue"] if request.method == "GET" else store.save_queue(body().get("script_ids")))

    @application.route("/api/layouts", methods=["GET", "PATCH", "POST"])
    def layouts():
        return jsonify(store.library()["layouts"] if request.method == "GET" else store.save_layout(body()))

    @application.get("/api/layout-presets")
    def layout_presets():
        return jsonify(store.layout_presets())

    @application.post("/api/layout-presets")
    def create_layout_preset():
        return jsonify(store.save_layout_preset(body())), 201

    @application.patch("/api/layout-presets/<item_id>")
    def update_layout_preset(item_id):
        return jsonify(store.save_layout_preset(body(), item_id))

    @application.delete("/api/layout-presets/<item_id>")
    def delete_layout_preset(item_id):
        return jsonify(store.delete_layout_preset(item_id))

    @application.post("/api/import-preview")
    def import_preview():
        if request.is_json:
            payload = body()
            return jsonify(parse_text(payload.get("text"), payload.get("filename", "")))
        uploaded = request.files.get("file")
        if not uploaded or not uploaded.filename:
            raise DomainError("请粘贴正文或选择 TXT、DOCX 文件。", 400, "invalid_import")
        return jsonify(parse_upload(uploaded.stream, uploaded.filename))

    @application.get("/api/state")
    def state():
        return jsonify(store.state())

    @application.post("/api/preview")
    def preview():
        return jsonify(store.preview(body()))

    @application.post("/api/editor-preview")
    def editor_preview():
        return jsonify(store.editor_preview(body()))

    @application.post("/api/apply")
    def apply():
        return jsonify(store.apply(body()))

    @application.post("/api/command")
    def command():
        return jsonify(store.command(body()))

    @application.post("/api/checkpoint")
    def checkpoint():
        return jsonify(store.checkpoint(body()))

    @application.post("/api/display/connect")
    def connect_display():
        return jsonify(store.display_connect())

    @application.get("/media/<path:filename>")
    def restored_media(filename):
        file = store.resource_file("/media/" + filename)
        mime = MEDIA_FORMATS.get(file.suffix.lower(), (None, None))[1]
        return send_from_directory(file.parent, file.name, mimetype=mime, conditional=True)

    @application.get("/api/backup")
    def backup():
        return send_file(io.BytesIO(store.backup()), mimetype="application/zip", as_attachment=True,
                         download_name=BACKUP_PREFIX + datetime.now().strftime("%Y%m%d-%H%M%S") + ".zip")

    @application.post("/api/restore")
    def restore():
        uploaded = request.files.get("file")
        if not uploaded:
            raise DomainError("请选择备份 ZIP 文件。")
        return jsonify(store.restore(uploaded.stream))

    return application
