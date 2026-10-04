"""Bounded, offline TXT/DOCX import previews; this module never writes files."""
from __future__ import annotations

import io
import re
import stat
import uuid
import zipfile
import zlib
from pathlib import PurePosixPath
from xml.etree import ElementTree as ET

from storage import DomainError

MAX_TEXT = 300_000
MAX_PARAGRAPHS = 10_000
MAX_TXT_BYTES = 2 * 1024 * 1024
MAX_DOCX_BYTES = 10 * 1024 * 1024
MAX_DOCX_EXPANDED = 30 * 1024 * 1024
MAX_DOCX_ENTRIES = 512
MAX_DOCUMENT_XML = 8 * 1024 * 1024
WORD_NAMESPACES = {"http://schemas.openxmlformats.org/wordprocessingml/2006/main",
                   "http://purl.oclc.org/ooxml/wordprocessingml/main"}
TITLE_HEAD = re.compile(r"^\s*(?:剧名|标题|题目|名称)\s*[:：]\s*(.+?)\s*$")
AUTHOR_HEAD = re.compile(r"^\s*(?:作者|编剧|原著|文)\s*[:：]\s*(.+?)\s*$")
ROLE_HEAD = re.compile(r"^\s*([A-Za-z0-9_\u3400-\u9fff·•. \-]{1,24})\s*[:：]")
NON_ROLES = {"剧名", "标题", "题目", "名称", "作者", "编剧", "原著", "文", "角色", "人物", "人物介绍",
             "角色介绍", "时间", "地点", "场景", "类型", "字数", "出品", "简介", "备注", "说明", "音效", "音乐", "BGM"}


def error(message):
    return DomainError(message, 400, "invalid_import")


def clean_filename(value):
    if value is None:
        return ""
    if not isinstance(value, str) or len(value) > 500 or "\x00" in value:
        raise error("导入文件名称无效。")
    return value.replace("\\", "/").rsplit("/", 1)[-1]


def parse_text(source, filename="", encoding="粘贴文本", warnings=None):
    if not isinstance(source, str) or "\x00" in source or len(source) > MAX_TEXT:
        raise error("导入文字须为不超过 30 万字符的有效文本。")
    if not source.strip():
        raise error("导入内容为空，请粘贴正文或选择含文字的文件。")
    filename = clean_filename(filename)
    lines = source.splitlines(keepends=True)
    if len(lines) > MAX_PARAGRAPHS or any(len(line) > 200_000 for line in lines):
        raise error("导入内容不能超过 10000 行，单行不能超过 20 万字符。")
    title, author = "", ""
    nonempty = [line.strip() for line in lines if line.strip()]
    identified_header = False
    for line in nonempty[:10]:
        title_match, author_match = TITLE_HEAD.fullmatch(line), AUTHOR_HEAD.fullmatch(line)
        if title_match and not title:
            title = title_match.group(1)[:200]
            identified_header = True
        if author_match and not author:
            author = author_match.group(1)[:500]
            identified_header = True
    if not title:
        first = nonempty[0]
        book = re.fullmatch(r"《(.{1,198})》", first)
        if book:
            title = book.group(1)
            identified_header = True
        elif len(first) <= 80 and not re.search(r"[:：。！？!?]", first) and not first.startswith(("（", "(", "【", "[")):
            title = first
            identified_header = True
    if not title:
        title = PurePosixPath(filename).stem[:200] if filename else "未命名条目"
    blocks, roles = [], []
    skipped_blank_lines = 0
    for line in lines:
        if not line.strip():
            skipped_blank_lines += 1
            continue
        matched = ROLE_HEAD.match(line)
        role = matched.group(1).strip() if matched else ""
        if role in NON_ROLES or role.isdigit():
            role = ""
        if role and role not in roles:
            roles.append(role)
        blocks.append({"id": "block-" + uuid.uuid4().hex, "kind": "text", "text": line,
                       "role": role, "color": "#343b37"})
    notes = list(warnings or [])
    if skipped_blank_lines:
        notes.append(f"已跳过 {skipped_blank_lines} 个纯空行，不计入导入段落；完整原文仍保留在原文对照中。")
    if identified_header:
        notes.append("已识别标题或作者；原始标题、作者行仍保留在正文中，请核对后自行调整。")
    if not roles:
        notes.append("未发现明确的“角色名：台词”标记；非空正文角色暂未指定，完整原文保留在原文对照中。")
    else:
        notes.append("角色仅按冒号前的文字作规则识别；未明确标注的非空段落保持原文和未指定角色，请核对。")
    return {"candidate": {"title": title, "author": author, "blocks": blocks, "source_text": source},
            "roles": roles, "warnings": notes, "encoding": encoding, "filename": filename}


def _word_name(tag):
    if not isinstance(tag, str) or not tag.startswith("{"):
        return ""
    namespace, name = tag[1:].split("}", 1)
    return name if namespace in WORD_NAMESPACES else ""


def _paragraph_text(paragraph):
    parts = []
    def visit(node):
        name = _word_name(node.tag)
        if node is not paragraph and name in {"p", "drawing", "pict", "object"}:
            return
        if name in {"t", "delText"}:
            parts.append(node.text or "")
        elif name == "tab":
            parts.append("\t")
        elif name in {"br", "cr"}:
            parts.append("\n")
        for child in node:
            visit(child)
    visit(paragraph)
    return "".join(parts)


def extract_docx(content):
    if len(content) > MAX_DOCX_BYTES:
        raise error("DOCX 文件不能超过 10 MB。")
    try:
        with zipfile.ZipFile(io.BytesIO(content)) as archive:
            entries = archive.infolist()
            names = [entry.filename for entry in entries]
            if len(entries) > MAX_DOCX_ENTRIES or len(set(names)) != len(names):
                raise error("DOCX 包含过多或重复文件。")
            total = 0
            for entry in entries:
                raw_name = entry.orig_filename
                path = PurePosixPath(raw_name)
                if (path.is_absolute() or ".." in path.parts or "\\" in raw_name or ":" in raw_name or "\x00" in raw_name
                        or stat.S_ISLNK(entry.external_attr >> 16) or entry.flag_bits & 1
                        or entry.compress_type not in {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}):
                    raise error("DOCX 包含不安全路径、加密内容或不支持的压缩方式。")
                total += entry.file_size
                if total > MAX_DOCX_EXPANDED:
                    raise error("DOCX 解压后内容不能超过 30 MB。")
                if entry.filename.lower().endswith((".xml", ".rels")):
                    if entry.file_size > MAX_DOCUMENT_XML:
                        raise error("DOCX 单个 XML 内容不能超过 8 MB。")
                    xml = archive.read(entry)
                    if re.search(br"<!\s*(?:DOCTYPE|ENTITY)\b", xml.replace(b"\x00", b""), re.I):
                        raise error("DOCX 不允许 XML 实体或文档类型声明。")
            if "word/document.xml" not in names:
                raise error("DOCX 缺少正文文档。")
            root = ET.fromstring(archive.read("word/document.xml"))
            body = next((node for node in root if _word_name(node.tag) == "body"), None)
            if _word_name(root.tag) != "document" or body is None:
                raise error("DOCX 正文结构无效。")
            paragraphs = []
            total_chars = 0
            def visit(node):
                nonlocal total_chars
                name = _word_name(node.tag)
                if name == "p":
                    paragraph = _paragraph_text(node)
                    paragraphs.append(paragraph)
                    total_chars += len(paragraph) + 1
                    if len(paragraphs) > MAX_PARAGRAPHS or total_chars > MAX_TEXT + 1:
                        raise error("DOCX 正文超过 10000 段或 30 万字符。")
                    return
                if name in {"drawing", "pict", "object"}:
                    return
                for child in node:
                    visit(child)
            visit(body)
            warnings = []
            if any(_word_name(node.tag) in {"del", "ins", "delText"} for node in body.iter()):
                warnings.append("检测到修订标记：新增和删除的文字均保留供核对，未自动接受或拒绝修订。")
            if any(_word_name(node.tag) in {"sym", "altChunk"} for node in body.iter()):
                warnings.append("检测到特殊字体符号或嵌入内容：该部分无法按普通段落完整提取，请对照原文核对。")
            if any(name.startswith("word/media/") and not name.endswith("/") for name in names) or any(_word_name(node.tag) in {"drawing", "pict", "object"} for node in body.iter()):
                warnings.append("检测到图片或嵌入对象：本次仅导入文字，未导入图片，也未进行 OCR。")
            if any(name.startswith(("word/header", "word/footer", "word/footnotes", "word/endnotes", "word/comments")) for name in names):
                warnings.append("仅提取正文段落与表格文字；页眉、页脚、批注和脚注等附属内容未导入。")
            return "\n".join(paragraphs), warnings
    except DomainError:
        raise
    except (zipfile.BadZipFile, NotImplementedError, RuntimeError, OSError, ValueError, LookupError, RecursionError, zlib.error, ET.ParseError) as problem:
        raise error("无法读取 DOCX，请选择未加密且结构完整的 Word .docx 文件。") from problem


def parse_upload(stream, filename):
    filename = clean_filename(filename)
    suffix = PurePosixPath(filename).suffix.lower()
    if suffix not in {".txt", ".docx"}:
        raise error("导入仅支持 TXT 或 DOCX 文件。")
    maximum = MAX_TXT_BYTES if suffix == ".txt" else MAX_DOCX_BYTES
    content = stream.read(maximum + 1)
    if len(content) > maximum:
        raise error("TXT 文件不能超过 2 MB。" if suffix == ".txt" else "DOCX 文件不能超过 10 MB。")
    if suffix == ".docx":
        source, warnings = extract_docx(content)
        return parse_text(source, filename, "DOCX", warnings)
    warnings = []
    try:
        source = content.decode("utf-8-sig")
        encoding = "UTF-8 BOM" if content.startswith(b"\xef\xbb\xbf") else "UTF-8"
    except UnicodeDecodeError:
        try:
            source = content.decode("gb18030")
        except UnicodeDecodeError as problem:
            raise error("TXT 编码无法识别，请另存为 UTF-8 后重试。") from problem
        encoding = "GB18030"
        warnings.append("UTF-8 解码失败，已按 GB18030 解码；请核对是否存在乱码。")
    return parse_text(source, filename, encoding, warnings)
