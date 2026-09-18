#!/usr/bin/env python3
"""Rebuild the source-derived seed without changing the archived PPTX files.

Uses only the Python standard library. Run from any directory:
    python tools/import_sources.py
No application database is read or written. Re-running replaces only generated
seed/extraction/audit files and writes content-addressed original image bytes.
"""
from __future__ import annotations

import argparse
from collections import Counter
from hashlib import sha256
import json
from pathlib import Path
import posixpath
import re
import xml.etree.ElementTree as ET
import zipfile

NS = {
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
}
RID = "{" + NS["r"] + "}"
CATALOG = "喜娃微pia剧场.pptx"
SCROLL = "直播间滚屏.pptx"
CATEGORIES = [
    ("cat-sweet", "甜本", "#B64C70"),
    ("cat-bitter", "苦本", "#426FA6"),
    ("cat-calm", "淡本", "#54756A"),
    ("cat-comedy", "搞笑本", "#B57422"),
    ("cat-suspense", "悬疑恐怖本", "#735A91"),
    ("cat-screen", "动漫影视本", "#5B64A2"),
]
# Metadata is transcribed from directory pages. Empty synopsis means no actual
# synopsis was supplied. Doubts are preserved, never silently corrected.
SCRIPTS = [
    dict(title="万有引力", category="甜本", author="紫熙", pages=(65,70), directory_page=1,
         synopsis="假面舞会上的相遇，让他对她一面倾心", cast_note="一男一女", tags=["民国本"],
         remark="小孩子不要选 民国本 一男一女  假面舞会上的相遇，让他对她一面倾心",
         issues="SRC-01：p70 疑似错序，未确认，保留 p65–70 原顺序。"),
    dict(title="老同", category="甜本", author="茶朔洵", pages=(71,75), directory_page=1,
         synopsis="旧时代两个女孩子的故事", cast_note="两女", tags=["旧时代"],
         remark="旧时代 两女  旧时代两个女孩子的故事",
         issues="SRC-02：另有旁白、路人、德音及温惠，原音效署名保留；未提供录音。SRC-06：收录片段从‘此后’开始。"),
    dict(title="吃花的女人", category="甜本", author="药点笔莲", pages=(13,17), directory_page=1,
         synopsis="一个女人结婚前的幻想", cast_note="两女", tags=["有点难度"],
         remark="有点难度 两女  一个女人结婚前的幻想", issues=""),
    dict(title="平凡人生", category="苦本", author="妖奈奈", pages=(56,60), directory_page=2,
         synopsis="重案组警察因为公事牵扯到孩子，导致孩子意外去世，现在面对妻子", cast_note="一男一女", tags=[],
         remark="一男一女 重案组警察因为公事牵扯到孩子，导致孩子意外去世，现在面对妻子", issues=""),
    dict(title="终于暮色", category="苦本", author="6598", pages=(50,55), directory_page=2,
         synopsis="救赎与被救赎的故事", cast_note="两女", tags=[], remark="两女 救赎与被救赎的故事", issues=""),
    dict(title="青春", category="苦本", author="十三", pages=(18,21), directory_page=2,
         synopsis="男主因为打架丢了安排好的工作，原因是看到了女朋友跟着老同学去了宾馆", cast_note="一男一女", tags=[],
         remark="一男一女 男主因为打架丢了安排好的工作，原因是看到了女朋友跟着老同学去了宾馆",
         issues="SRC-06：正文从‘我？我怎么了？’开始，仅声明 PPT 收录内容。"),
    dict(title="五毛钱的事", category="搞笑本", author="摘自（吵架发泄咆哮本）", pages=(61,64), directory_page=3,
         synopsis="因为五毛钱吵起来的故事", cast_note="不分性别，两男两女皆可走", tags=[],
         remark="因为五毛钱吵起来的故事 ， 不分性别，两男两女皆可走",
         issues="SRC-03：正文只有‘男’‘女’两角色，原人数备注有歧义，不自动转换为四人本。"),
    dict(title="爱情公寓", category="搞笑本", author="", pages=(28,30), directory_page=3,
         synopsis="", cast_note="一男一女", tags=["台湾腔"], remark="台湾腔 一男一女",
         issues="SRC-04：目录括注‘欧浩辰，迟早早’，正文为悠悠/张伟扮演欧皓辰/池早早，保留原写法。SRC-06：正文明确标‘节选’。7 张正文插图按原图保留，其中图中文字未另作 OCR 转写，不计入可编辑文字覆盖率。"),
    dict(title="远方", category="淡本", author="沈如深", pages=(35,39), directory_page=4,
         synopsis="", cast_note="一男一女", tags=[], remark="一男一女 自行理解", issues="未提供实质剧情简介；‘自行理解’保留为原备注。"),
    dict(title="不单是真实，不单是想象", category="淡本", author="天空没有之城", pages=(31,34), directory_page=4,
         synopsis="一个失聪一个失明的两个好朋友惺惺相惜的故事", cast_note="两女", tags=[],
         remark="两女一个失聪一个失明的两个好朋友惺惺相惜的故事",
         issues="SRC-02：p33 另有院长和新闻播报，不假定已经提供对应录音或演员分工。"),
    dict(title="执子之手", category="淡本", author="一尾鱼；摘自《如许年华似水》", pages=(22,27), directory_page=4,
         synopsis="民国时期的夫妻俩，面对错误的改革制度", cast_note="", tags=["近代"],
         remark="民国时期的夫妻俩，面对错误的改革制度",
         issues="目录未单列配音人数，不自动填充。SRC-06：p22 从【1:26】开始，保留提示，不把它视为演出总时长。"),
    dict(title="凶杀沉溺", category="悬疑恐怖本", author="糊涂荼", pages=(44,49), directory_page=5,
         synopsis="为了求生而谋害他人的两个亡命之徒", cast_note="两女", tags=[],
         remark="两女 为了求生而谋害他人的两个亡命之徒",
         issues="SRC-02：p44–46 还有王叔台词；‘两女’不等于全部发声角色数。"),
    dict(title="催眠大师", category="悬疑恐怖本", author="摘自我就是演员", pages=(40,43), directory_page=5,
         synopsis="心理治疗师和女病人之间发生的故事", cast_note="一男一女", tags=[],
         remark="一男一女 心理治疗师和女病人之间发生的故事",
         issues="SRC-05：目录简介与选段的治疗者关系有落差；p43‘七年前’与‘去年’并存，未经确认不改写。"),
    dict(title="鱼玄机与绿翘", category="悬疑恐怖本", author="佚名", pages=(7,12), directory_page=5,
         synopsis="鱼玄机相思成疾杀死侍女的故事", cast_note="两女", tags=["古风"],
         remark="古风 两女 鱼玄机相思成疾杀死侍女的故事",
         issues="SRC-08：网页使用独立剧本 ID，不复用目录中的遗留外部链接。"),
]


def file_hash(path):
    return sha256(path.read_bytes()).hexdigest()


def normalized(text):
    return "".join(text.split())


class Deck:
    def __init__(self, path, media_dir):
        self.path = path
        self.z = zipfile.ZipFile(path)
        self.media_dir = media_dir
        self.media = {}
        self.cache = {}
        self.media_records = []
        for part in self.z.namelist():
            if part.startswith("ppt/media/") and not part.endswith("/"):
                content = self.z.read(part)
                digest = sha256(content).hexdigest()
                suffix = Path(part).suffix.lower()
                filename = f"ppt-{digest[:16]}{suffix}"
                dest = media_dir / filename
                if dest.exists() and file_hash(dest) != digest:
                    raise ValueError(f"Media hash collision: {dest}")
                if not dest.exists():
                    dest.write_bytes(content)
                self.media[part] = "/static/media/" + filename
                self.media_records.append(dict(part=part, path=self.media[part], sha256=digest, bytes=len(content)))

    def xml(self, part):
        if part not in self.cache:
            self.cache[part] = ET.fromstring(self.z.read(part))
        return self.cache[part]

    def rels(self, part):
        relpart = posixpath.join(posixpath.dirname(part), "_rels", posixpath.basename(part) + ".rels")
        if relpart not in self.z.namelist():
            return {}
        result = {}
        for r in self.xml(relpart):
            info = dict(r.attrib)
            if info.get("TargetMode") != "External":
                info["part"] = posixpath.normpath(posixpath.join(posixpath.dirname(part), info["Target"]))
            result[info["Id"]] = info
        return result

    def related(self, part, kind):
        return next((r.get("part") for r in self.rels(part).values() if r["Type"].endswith("/" + kind)), None)

    def hierarchy(self, part):
        chain = [part]
        for kind in ("slideLayout", "slideMaster"):
            target = self.related(chain[-1], kind)
            if target:
                chain.append(target)
        return chain

    def color_context(self, part):
        chain = self.hierarchy(part)
        theme_part = next((self.related(p, "theme") for p in reversed(chain) if self.related(p, "theme")), None)
        theme = {}
        if theme_part:
            scheme = self.xml(theme_part).find("a:themeElements/a:clrScheme", NS)
            for slot in scheme if scheme is not None else []:
                c = next(iter(slot), None)
                if c is not None:
                    theme[slot.tag.rsplit("}", 1)[-1]] = c.get("val") if c.tag.endswith("srgbClr") else c.get("lastClr")
        cmap = {"bg1":"lt1", "tx1":"dk1", "bg2":"lt2", "tx2":"dk2"}
        for p in reversed(chain):
            root = self.xml(p)
            mapping = root.find("p:clrMap", NS)
            if mapping is None:
                mapping = root.find("p:clrMapOvr/a:overrideClrMapping", NS)
            if mapping is not None:
                cmap.update(mapping.attrib)
        return theme, cmap

    def color(self, props, context):
        if props is None:
            return "", None
        fill = props.find("a:solidFill", NS)
        if fill is None:
            return "", None
        node = next(iter(fill), None)
        if node is None:
            return "", None
        theme, cmap = context
        kind = node.tag.rsplit("}", 1)[-1]
        raw = dict(type=kind, **node.attrib)
        raw["transforms"] = [dict(type=c.tag.rsplit("}", 1)[-1], **c.attrib) for c in node]
        value = node.get("val")
        if kind == "schemeClr":
            value = theme.get(cmap.get(value, value))
        elif kind == "sysClr":
            value = node.get("lastClr")
        elif kind != "srgbClr":
            value = None
        if not value or not re.fullmatch(r"[0-9a-fA-F]{6}", value):
            return "", raw
        rgb = [int(value[i:i+2], 16) / 255 for i in (0,2,4)]
        # Preserve transform metadata even when the display approximation does
        # not implement a less common DrawingML transform.
        for t in node:
            name = t.tag.rsplit("}",1)[-1]
            v = int(t.get("val", "0")) / 100000
            if name == "tint":
                rgb = [x + (1-x)*v for x in rgb]
            elif name in ("shade", "lumMod"):
                rgb = [x*v for x in rgb]
            elif name == "lumOff":
                rgb = [x+v for x in rgb]
        return "#" + "".join(f"{max(0,min(255,round(x*255))):02X}" for x in rgb), raw

    def background(self, part):
        for owner in self.hierarchy(part):
            root = self.xml(owner)
            bg = root.find("p:cSld/p:bg", NS)
            if bg is None:
                continue
            blip = bg.find(".//a:blip", NS)
            result = dict(owner_part=owner, xml=ET.tostring(bg, encoding="unicode"), image_path="")
            if blip is not None:
                target = self.rels(owner).get(blip.get(RID + "embed"), {}).get("part")
                result["image_path"] = self.media.get(target, "")
                result["media_part"] = target
            return result
        return None

    def paragraphs(self, shape, context):
        tx = shape.find("p:txBody", NS)
        if tx is None:
            return []
        result = []
        for index, p in enumerate(tx.findall("a:p", NS), 1):
            default = p.find("a:pPr/a:defRPr", NS)
            fallback, fallback_raw = self.color(default, context)
            runs = []
            for child in p:
                local = child.tag.rsplit("}", 1)[-1]
                if local in ("r", "fld"):
                    text = "".join(t.text or "" for t in child.findall("a:t", NS))
                    color, raw = self.color(child.find("a:rPr", NS), context)
                    runs.append(dict(text=text, color=color or fallback, color_source=raw or fallback_raw,
                                     xml=ET.tostring(child, encoding="unicode")))
                elif local == "br":
                    runs.append(dict(text="\n", color=fallback, color_source=fallback_raw))
            result.append(dict(index=index, text="".join(r["text"] for r in runs), runs=runs,
                               xml=ET.tostring(p, encoding="unicode")))
        return result

    def extract(self):
        pres = self.xml("ppt/presentation.xml")
        rels = self.rels("ppt/presentation.xml")
        size = pres.find("p:sldSz", NS)
        pages = []
        for page, item in enumerate(pres.find("p:sldIdLst", NS), 1):
            part = rels[item.get(RID + "id")]["part"]
            root = self.xml(part)
            context = self.color_context(part)
            shapes = []
            tree = root.find("p:cSld/p:spTree", NS)
            for order, shape in enumerate(tree, 1):
                local = shape.tag.rsplit("}", 1)[-1]
                if local not in ("sp", "pic"):
                    if local in ("grpSp", "graphicFrame"):
                        raise ValueError(f"Unsupported content shape on {self.path.name} p{page}: {local}")
                    continue
                pr = shape.find(".//p:cNvPr", NS)
                shape_id = pr.get("id") if pr is not None else str(order)
                off = shape.find(".//a:xfrm/a:off", NS)
                ext = shape.find(".//a:xfrm/a:ext", NS)
                record = dict(id=shape_id, kind=local, order=order, name=pr.get("name", "") if pr is not None else "",
                              x=int(off.get("x", 0)) if off is not None else 0,
                              y=int(off.get("y", 0)) if off is not None else 0,
                              width=int(ext.get("cx", 0)) if ext is not None else 0,
                              height=int(ext.get("cy", 0)) if ext is not None else 0,
                              paragraphs=self.paragraphs(shape, context))
                if local == "pic":
                    blip = shape.find(".//a:blip", NS)
                    target = self.rels(part).get(blip.get(RID+"embed"), {}).get("part") if blip is not None else None
                    record.update(image_path=self.media.get(target, ""), media_part=target,
                                  xml=ET.tostring(shape, encoding="unicode"))
                shapes.append(record)
            # XML text coverage is checked independently of our paragraph walker.
            xml_text = "".join(t.text or "" for t in root.findall(".//a:t", NS))
            extracted_text = "".join(p["text"].replace("\n", "") for s in shapes for p in s["paragraphs"])
            if xml_text != extracted_text:
                raise ValueError(f"Text extraction mismatch on {self.path.name} p{page}")
            pages.append(dict(page=page, part=part, shapes=shapes, background=self.background(part),
                              text=xml_text, relationships=list(self.rels(part).values())))
        return dict(source_file=self.path.name, sha256=file_hash(self.path),
                    size_emu=dict(size.attrib) if size is not None else {},
                    slide_count=len(pages), media=self.media_records, pages=pages)


def infer_role(text):
    """Annotate a source label only; never change the original text."""
    s = text.strip().lstrip("☆★. ")
    s = re.sub(r"^[（(]音效[）)]\s*", "", s)
    match = re.match(r"^([^：:\n]{1,24})[：:]", s)
    if not match:
        return ""
    label = re.sub(r"[（(][^）)]*[）)]", "", match.group(1)).strip()
    if any(c in label for c in "【】《》"):
        return ""
    return label.replace(" ", "")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-root", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    root = args.project_root.resolve()
    media_dir = root / "static" / "media"
    media_dir.mkdir(parents=True, exist_ok=True)
    (root / "data").mkdir(exist_ok=True)
    sources = [root / "evidence" / "originals" / name for name in (CATALOG, SCROLL)]
    before = {p.name:file_hash(p) for p in sources}
    decks = [Deck(p, media_dir).extract() for p in sources]
    catalog, scroll = decks
    assert catalog["slide_count"] == 85 and scroll["slide_count"] == 6
    category_by_name = {name:cid for cid,name,_ in CATEGORIES}
    backgrounds = {}
    for page in scroll["pages"]:
        active = [s for s in page["shapes"] if s["x"] == 0 and "".join(p["text"] for p in s["paragraphs"]) in category_by_name]
        assert len(active) == 1
        name = "".join(p["text"] for p in active[0]["paragraphs"])
        backgrounds[name] = page["background"]["image_path"]
    categories = [dict(id=cid, name=name, description="", color=color,
                       background=backgrounds[name], sort_order=i, visible=1)
                  for i,(cid,name,color) in enumerate(CATEGORIES)]
    scripts, checks = [], []
    all_pages = []
    for i, spec in enumerate(SCRIPTS, 1):
        script_id = f"script-{i:02d}"
        source_pages = list(range(spec["pages"][0],spec["pages"][1]+1))
        directory = catalog["pages"][spec["directory_page"]-1]
        for snippet in (spec["title"], spec["synopsis"], spec["cast_note"], spec["remark"]):
            assert normalized(snippet) in normalized(directory["text"]), (spec["title"], snippet)
        blocks = []
        for page_no in source_pages:
            page = catalog["pages"][page_no-1]
            # Preserve textual XML order. Pictures follow the page's text in
            # visual top/left order; original geometry/order remains extracted.
            for shape in page["shapes"]:
                for paragraph in shape["paragraphs"]:
                    if not paragraph["text"].strip():
                        continue
                    runs = [dict(text=r["text"], color=r["color"]) for r in paragraph["runs"]]
                    color = next((r["color"] for r in runs if r["color"] and r["text"].strip()), "")
                    blocks.append(dict(id=f"{script_id}-p{page_no:03d}-s{shape['id']}-t{paragraph['index']}",
                                       kind="text", text=paragraph["text"], role=infer_role(paragraph["text"]),
                                       color=color, source_page=page_no, source_file=CATALOG, runs=runs))
            for shape in sorted((s for s in page["shapes"] if s["kind"]=="pic"),key=lambda s:(s["y"],s["x"],s["order"])):
                assert shape["image_path"]
                blocks.append(dict(id=f"{script_id}-p{page_no:03d}-s{shape['id']}-image", kind="image", text="",
                                   role="", color="", source_page=page_no, source_file=CATALOG,
                                   image_path=shape["image_path"]))
            imported = "".join(b["text"] for b in blocks if b["source_page"]==page_no and b["kind"]=="text")
            assert normalized(imported) == normalized(page["text"]), (spec["title"],page_no)
        notes = f"原目录 p{spec['directory_page']} 备注：{spec['remark']}"
        if spec["issues"]:
            notes += "\n待核对/来源说明：" + spec["issues"]
        notes += "\n收录范围为原 PPT 已有正文或选段；未提供配套音视频和可靠演出时长。"
        script = dict(id=script_id, title=spec["title"], category_id=category_by_name[spec["category"]],
                      source_category=spec["category"], author=spec["author"], synopsis=spec["synopsis"],
                      cast_note=spec["cast_note"], tags=spec["tags"], notes=notes,
                      source_pages=source_pages, blocks=blocks)
        scripts.append(script)
        all_pages.extend(source_pages)
        checks.append(dict(id=script_id, title=spec["title"], pages=source_pages,
                           text_blocks=sum(b["kind"]=="text" for b in blocks),
                           image_blocks=sum(b["kind"]=="image" for b in blocks),
                           nonwhitespace_characters=len(normalized("".join(b["text"] for b in blocks)))))
    assert sorted(all_pages)==list(range(7,76)) and len(all_pages)==len(set(all_pages))
    assert all(not p["text"].strip() for p in catalog["pages"][75:])
    assert len(scripts)==14 and len(backgrounds)==6
    ids=[b["id"] for s in scripts for b in s["blocks"]]
    assert len(ids)==len(set(ids))
    assert sum(c["image_blocks"] for c in checks)==7
    after = {p.name:file_hash(p) for p in sources}
    assert before==after, "Original source file changed during import"
    seed = dict(schema_version=1,categories=categories,scripts=scripts)
    audit = dict(schema_version=1, sources=decks, verification=dict(source_sha256_before=before,
                 source_sha256_after=after, sources_unchanged=before==after, body_pages=sorted(all_pages),
                 per_script=checks, normalized_text_matches_all_69_pages=True,
                 category_counts=dict(Counter(s["source_category"] for s in scripts)),
                 notes=["Blank-only paragraphs remain in raw extraction; nonblank text blocks preserve exact paragraph text.",
                        "Image text is retained as original image bytes, not OCR-transcribed.",
                        "Explicit paragraph breaks and run text/colors are preserved; unresolved inherited colors remain empty."]))
    for filename, data in (("seed.json",seed),("source_extraction.json",audit)):
        (root / "data" / filename).write_text(json.dumps(data,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    table="\n".join(f"| {c['id']} | {c['title']} | {c['pages'][0]}–{c['pages'][-1]} | {c['text_blocks']} | {c['image_blocks']} | {c['nonwhitespace_characters']} |" for c in checks)
    media_count=len({m["path"] for d in decks for m in d["media"]})
    text_count=sum(c["text_blocks"] for c in checks)
    report=f'''# 内容导入核对

状态：已生成首版种子数据与原始结构提取，未改动证据 PPT。

## 生成入口与产物

- [导入脚本](../tools/import_sources.py)：标准库实现，运行 `python tools/import_sources.py` 可重建内容产物；不读写应用数据库。
- [seed.json](../data/seed.json)：`schema_version: 1`，6 类、14 篇剧本、{text_count} 个非空文字块、7 个正文图片块。
- [source_extraction.json](../data/source_extraction.json)：两份 PPT 全部 91 页的原始段落、runs、颜色来源 XML、形状位置、背景继承与关系、媒体哈希，以及覆盖核对结果。
- 原始图像位于 `static/media/`，同一字节内容按 SHA-256 复用，共 {media_count} 个资源。网页 URL 为 `/static/media/ppt-<哈希前16位>.<原扩展名>`。所有图像直接提取原字节，没有重绘或压缩。

## 覆盖结果

| ID | 剧名 | 正文页码 | 非空文字块 | 正文图片 | 非空白字符数（含重复页标题） |
|---|---|---|---|---|---|
{table}

已核对第 7–75 页恰好覆盖一次，69 页无遗漏、无串本、无重复分配。每页导入文字与来源 XML 去空白后完全相同；同时逐页验证段落提取与原 XML 文字顺序一致。所有非空段落的原文字、行内换行和 runs 保留，不主动改字、调整页序或删除重复页标题。仅空白段落不生成展示块，但仍完整保留在原始提取文件中。

正文图片为《爱情公寓》p28 的 1 张、p29 的 2 张、p30 的 4 张，共 7 张。图片中的文字保留原图，未作未经核验的 OCR 转写；文字覆盖结论仅针对 PPT 可编辑文字。网页初始阅读流把每页插图按上/左顺序置于该页文字之后；原始坐标与对象顺序仍在提取文件，可供版式调整。

六类背景从《直播间滚屏》各页的背景关系与当前突出分类匹配，不把导航装饰图误作背景。滚屏页序为甜本、苦本、淡本、搞笑本、悬疑恐怖本、动漫影视本；剧场目录中搞笑与淡本页序不同，按名称对应。原背景的透明度与继承信息另存提取文件，网页主题颜色为界面配色配置，不声称是原背景的精确采样值。

## 元数据与未决问题

- 分类、作者/来源、人数原备注和剧情简介依据目录逐条转写。作者/来源字段允许记录‘摘自’来源；未提供编剧的《爱情公寓》留空，不写成佚名。
- 《爱情公寓》没有目录剧情简介，简介留空；《远方》‘自行理解’保留为备注，不伪造剧情简介。《执子之手》未单列人数，人数字段留空。
- 目录导航、原始空格和所有空白段落在原始提取中保存；seed 的 notes 保留目录备注与疑点。元数据展示字段只做必要的空格整理，不覆盖源文本。
- 《万有引力》保持 p65–70 原序；《五毛钱的事》保留有歧义的原配音备注；《爱情公寓》人名差异、《催眠大师》简介和年份差异均保留；未决项详见[来源内容核查](来源内容核查.md)。
- role 只是从段首发言标签推导的展示注记，不代表新增演员分工；原标签仍在 text/runs 中。配角、旁白、混响、动作、音效与署名全部保留，不把它们当执行指令。
- runs 保存原文片段及可解析的直接/段落默认颜色；没有可靠颜色值时为空，由 UI 提供可读配色。完整原始颜色 XML 留在提取文件，不能宣称已经像素级复刻所有母版字体继承。
- 没有嵌入音视频，不生成时长、配套音源、年龄等级或外部完整剧本声明。视频功能仍仅为后续结构预留。
- p76–85 无正文的背景占位页不成为剧本，空动漫影视本分类保留。

## 原件完整性

脚本运行前后分别计算两份归档原件 SHA-256，结果一致：

| 原件 | SHA-256 |
|---|---|
| {CATALOG} | `{before[CATALOG]}` |
| {SCROLL} | `{before[SCROLL]}` |

重建仅覆盖本管线的 JSON 与核对记录，并补齐以内容哈希命名的原图；不会重建或覆盖用户在应用数据库中的编辑。
'''
    (root / "docs" / "内容导入核对.md").write_text(report,encoding="utf-8")
    print(json.dumps(dict(scripts=len(scripts),body_pages=len(all_pages),text_blocks=text_count,
                          image_blocks=7,media_resources=media_count,sources_unchanged=True),ensure_ascii=False))


if __name__ == "__main__":
    main()
