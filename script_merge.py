"""Content-aware script import. Preview is read-only; a batch commits atomically."""
from __future__ import annotations

import copy
import hashlib
import json
import re
import uuid
from pathlib import PurePosixPath

from storage import DomainError, decode_background, encode, identifier, normalize_script, resources, replace_resources
from script_package import FORMAT, VERSION, PACKAGE_MAX_BYTES, _digest, _file_hash, invalid

FIELDS = {"title": "剧名", "author": "作者", "synopsis": "简介", "cast_note": "配音配置",
          "notes": "备注", "visible": "显示状态", "tags": "标签", "role_colors": "角色默认配色",
          "blocks": "正文及逐句配色", "media": "音视频与暂停时间点"}


def _local_hashes(store):
    cache = {}
    def resolve(ref):
        if ref not in cache:
            path = store.resource_file(ref)
            if not path.is_file():
                raise DomainError("当前剧本有缺失素材，请先修复后再合并。", 409, "missing_resource")
            cache[ref] = _file_hash(path)
        return cache[ref]
    return resolve


def _semantic(item, resolve):
    """IDs, resource locations and source provenance do not change authored content."""
    value = {field: copy.deepcopy(item.get(field, {} if field == "role_colors" else None))
             for field in FIELDS if field not in {"blocks", "media"}}
    value["role_colors"] = value["role_colors"] or {}
    value["blocks"] = []
    for block in item["blocks"]:
        body = {key: copy.deepcopy(block.get(key, "")) for key in ("kind", "text", "role", "color")}
        # An explicit single run is equivalent to the default paragraph style.
        runs = block.get("runs") or [{"text": block["text"], "color": block["color"], "bold": False}]
        body["runs"] = [{"text": run["text"], "color": run.get("color", block["color"]),
                         "bold": bool(run.get("bold", False))} for run in runs]
        if block["kind"] == "image":
            body["image_sha256"] = resolve(block["image_path"])
        value["blocks"].append(body)
    media = item.get("media")
    value["media"] = None
    if media:
        indices = {block["id"]: index for index, block in enumerate(item["blocks"])}
        value["media"] = {key: media.get(key) for key in ("kind", "name", "duration")}
        value["media"]["sha256"] = resolve(media["path"])
        value["media"]["cues"] = [{"at": cue["at"], "label": cue.get("label", ""),
                                     "block_indices": [indices[block_id] for block_id in cue["block_ids"]]}
                                    for cue in media["cues"]]
    return value


def _fingerprint(item, resolve):
    # Legacy rows may omit newly introduced fields such as role_colors. Both
    # preview and commit compare the same normalized representation.
    item = normalize_script(item, source_import=True)
    value = {"script": item, "assets": {ref: resolve(ref) for ref in sorted(resources(item))}}
    return hashlib.sha256(encode(value).encode("utf-8")).hexdigest()


def _preview(connection, item, resolve, local_resolve):
    incoming = _semantic(item, resolve)
    title = item["title"].strip().casefold()
    matches = []
    categories = {row[0]: json.loads(row[1])["name"] for row in connection.execute("SELECT id,data FROM categories")}
    for row in connection.execute("SELECT data FROM scripts ORDER BY rowid"):
        current = normalize_script(json.loads(row[0]), source_import=True)
        if current["title"].strip().casefold() != title:
            continue
        semantic = _semantic(current, local_resolve)
        changes = [{"field": field, "label": label} for field, label in FIELDS.items()
                   if incoming[field] != semantic[field]]
        matches.append({"id": current["id"], "title": current["title"], "category_id": current["category_id"],
                        "category_name": categories.get(current["category_id"], "未分类"),
                        "identical": not changes, "fingerprint": _fingerprint(current, local_resolve), "changes": changes})
    status = "duplicate" if any(match["identical"] for match in matches) else "conflict" if matches else "new"
    return {"status": status, "matches": matches, "default_action": "new" if status == "new" else "skip"}


def preview_single(store, package):
    item = package["script"]
    resolve = lambda ref: package["files"][package["mapping"][ref]]["sha256"]
    with store.transaction() as connection:
        comparison = _preview(connection, item, resolve, _local_hashes(store))
    warnings = []
    if not item["visible"]:
        warnings.append("原剧本处于隐藏状态，导入后仍隐藏；可在内容管理中改为显示。")
    if comparison["status"] == "duplicate":
        warnings.append("内容与现有剧本完全相同，将自动跳过，避免重复添加。")
    elif comparison["status"] == "conflict":
        warnings.append("已有同名剧本且内容不同，请选择覆盖目标或跳过；覆盖前会保存旧版本。")
    return {"format": FORMAT, "version": VERSION, "title": item["title"], "author": item["author"],
            "category_name": package["category_name"], "script": item, "visible": item["visible"],
            "text_blocks": sum(block["kind"] == "text" for block in item["blocks"]),
            "image_blocks": sum(block["kind"] == "image" for block in item["blocks"]),
            "has_media": bool(item.get("media")), "cue_count": len(item.get("media", {}).get("cues", [])),
            "duplicate_title_count": len(comparison["matches"]), "package_sha256": package["sha256"],
            "warnings": warnings, **comparison}


def _check_sha(actual, expected):
    if not isinstance(expected, str) or not re.fullmatch(r"[0-9a-f]{64}", expected):
        raise invalid("请先预览这份 ZIP，再确认导入。", 409, "script_package_preview_required")
    if expected != actual:
        raise invalid("ZIP 已变化，请重新预览后再导入。", 409, "script_package_changed")


def _identified(item, category_id, target_id=None):
    item = copy.deepcopy(item)
    item["id"] = target_id or "script-" + uuid.uuid4().hex
    item["category_id"] = identifier(category_id, "导入分类")
    mapping = {block["id"]: "block-" + uuid.uuid4().hex for block in item["blocks"]}
    for block in item["blocks"]:
        block["id"] = mapping[block["id"]]
    for cue in item.get("media", {}).get("cues", []):
        cue["id"] = "cue-" + uuid.uuid4().hex
        cue["block_ids"] = [mapping[old] for old in cue["block_ids"]]
    return normalize_script(item, source_import=True)


def _put_assets(store, item, content, created):
    for ref in sorted(resources(item)):
        data = content(ref)
        destination = store.resource_file(ref)
        digest = hashlib.sha256(data).hexdigest()
        if destination.exists():
            if destination.stat().st_size != len(data) or _file_hash(destination) != digest:
                raise invalid("本地同名素材校验失败，原资料未改变。", 409, "resource_conflict")
            continue
        temporary = store.media_dir / (".script-package-" + uuid.uuid4().hex)
        try:
            store._write_new_resource(temporary, data)
            temporary.rename(destination)
            created.append(destination)
        finally:
            temporary.unlink(missing_ok=True)
    store._assert_assets(item)


def _import_one(store, connection, item, decision, resolve, local_resolve, content, created):
    action = decision.get("action", "skip")
    if not isinstance(action, str) or action not in {"new", "skip", "overwrite"}:
        raise DomainError("导入操作只支持新增、跳过或覆盖。")
    if action == "skip":
        return {"action": "skip", "imported": False, "skipped": True, "overwritten": False,
                "reason": "user_skip", "script": None}
    comparison = _preview(connection, item, resolve, local_resolve)
    identical = next((match for match in comparison["matches"] if match["identical"]), None)
    if identical:
        return {"action": "skip", "imported": False, "skipped": True, "overwritten": False,
                "reason": "duplicate", "script": store._get(connection, "scripts", identical["id"])}
    previous = None
    if action == "new" and comparison["matches"]:
        raise DomainError("已出现同名剧本，请重新预览并选择覆盖或跳过。", 409, "import_conflict")
    if action == "overwrite":
        target_id = identifier(decision.get("target_id"), "覆盖目标")
        previous = store._get(connection, "scripts", target_id)
        expected = decision.get("expected_target_fingerprint")
        if not isinstance(expected, str) or expected != _fingerprint(previous, local_resolve):
            raise DomainError("覆盖目标已在预览后变化，请重新预览；当前资料未改变。", 409, "import_target_changed")
        if not any(match["id"] == target_id for match in comparison["matches"]):
            raise DomainError("只能覆盖预览中明确选定的同名剧本。", 409, "import_conflict")
    destination = _identified(item, decision.get("category_id"), previous["id"] if previous else None)
    store._get(connection, "categories", destination["category_id"])
    _put_assets(store, destination, content, created)
    if previous:
        store._record_history(connection, previous)
        store._script(connection, destination)
    else:
        connection.execute("INSERT INTO scripts(id,category_id,data) VALUES(?,?,?)",
                           (destination["id"], destination["category_id"], encode(destination)))
    return {"action": action, "imported": True, "skipped": False, "overwritten": bool(previous), "script": destination}


def _rollback_assets(created, error):
    for destination in created:
        destination.unlink(missing_ok=True)
    if isinstance(error, OSError):
        raise DomainError("导入保存失败，资料已回滚；请检查存储空间后重试。", 503, "resource_write_failed") from error


def import_single(store, package, category_id, expected_sha256, action, target_id, fingerprint):
    _check_sha(package["sha256"], expected_sha256)
    mapping = {old: "/media/" + PurePosixPath(member).name for old, member in package["mapping"].items()}
    item = replace_resources(package["script"], mapping)
    incoming = {mapping[old]: member for old, member in package["mapping"].items()}
    incoming_resolve = lambda ref: package["files"][incoming[ref]]["sha256"]
    content = lambda ref: package["paths"][incoming[ref]].read_bytes()
    created = []
    try:
        with store.transaction(write=True) as connection:
            return _import_one(store, connection, item,
                               {"action": action, "category_id": category_id, "target_id": target_id,
                                "expected_target_fingerprint": fingerprint},
                               incoming_resolve, _local_hashes(store), content, created)
    except Exception as error:
        _rollback_assets(created, error)
        raise


def _backup(store, uploaded):
    uploaded.seek(0, 2)
    if not 0 < uploaded.tell() <= PACKAGE_MAX_BYTES:
        raise DomainError("合并备份须为 512 MB 内的完整 ZIP。", 413, "backup_too_large")
    checksum = _digest(uploaded)
    imported, media = store._read_backup(uploaded)
    for item in imported["scripts"]:
        for block in item["blocks"]:
            if block["kind"] == "image":
                ref = block["image_path"]
                decode_background(media[PurePosixPath(ref).name], PurePosixPath(ref).name, label="剧本插图")
    return imported, media, checksum


def preview_backup(store, uploaded):
    imported, media, checksum = _backup(store, uploaded)
    resolve = lambda ref: hashlib.sha256(media[PurePosixPath(ref).name]).hexdigest()
    source_categories = {item["id"]: item["name"] for item in imported["categories"]}
    items, seen_names = [], set()
    with store.transaction() as connection:
        local_resolve = _local_hashes(store)
        local_categories = {json.loads(row[1])["name"].strip().casefold(): row[0]
                            for row in connection.execute("SELECT id,data FROM categories")}
        for item in imported["scripts"]:
            comparison = _preview(connection, item, resolve, local_resolve)
            name = item["title"].strip().casefold()
            repeated = name in seen_names
            seen_names.add(name)
            if repeated and comparison["status"] == "new":
                comparison["default_action"] = "skip"
            items.append({"source_id": item["id"], "title": item["title"], "author": item["author"],
                          "category_id": item["category_id"], "category_name": source_categories[item["category_id"]],
                          "text_blocks": sum(block["kind"] == "text" for block in item["blocks"]),
                          "image_blocks": sum(block["kind"] == "image" for block in item["blocks"]),
                          "has_media": bool(item.get("media")), "package_title_conflict": repeated, **comparison})
        categories = [{"id": item["id"], "name": item["name"],
                       "suggested_category_id": local_categories.get(item["name"].strip().casefold())}
                      for item in imported["categories"]]
    return {"package_sha256": checksum, "items": items, "categories": categories,
            "warnings": ["合并仅处理当前剧本；不会更改分类、展示设置、待播队列或正在直播的画面。"]}


def import_backup(store, uploaded, expected_sha256, decisions):
    imported, media, checksum = _backup(store, uploaded)
    _check_sha(checksum, expected_sha256)
    if not isinstance(decisions, list) or len(decisions) != len(imported["scripts"]):
        raise DomainError("请为备份中每篇剧本选择新增、跳过或覆盖。")
    decision_map = {}
    allowed = {"source_id", "action", "category_id", "target_id", "expected_target_fingerprint"}
    for decision in decisions:
        if not isinstance(decision, dict) or set(decision) - allowed:
            raise DomainError("合并剧本选择格式无效。")
        source_id = identifier(decision.get("source_id"), "来源剧本 ID")
        if source_id in decision_map:
            raise DomainError("同一来源剧本只能选择一次。")
        decision_map[source_id] = decision
    if set(decision_map) != {item["id"] for item in imported["scripts"]}:
        raise DomainError("合并选择与备份中的剧本不一致。")
    targets = [identifier(decision.get("target_id"), "覆盖目标") for decision in decisions if decision.get("action") == "overwrite"]
    if len(targets) != len(set(targets)):
        raise DomainError("每个现有剧本一次只能被一篇来源剧本覆盖。")
    content = lambda ref: media[PurePosixPath(ref).name]
    resolve = lambda ref: hashlib.sha256(content(ref)).hexdigest()
    created, results = [], []
    try:
        with store.transaction(write=True) as connection:
            local_resolve = _local_hashes(store)
            for item in imported["scripts"]:
                results.append(_import_one(store, connection, item, decision_map[item["id"]],
                                           resolve, local_resolve, content, created))
        return {"imported": True, "added": sum(item["action"] == "new" for item in results),
                "overwritten": sum(item["overwritten"] for item in results),
                "skipped": sum(item["skipped"] for item in results),
                "scripts": [item["script"] for item in results if item["imported"]], "results": results}
    except Exception as error:
        _rollback_assets(created, error)
        raise
