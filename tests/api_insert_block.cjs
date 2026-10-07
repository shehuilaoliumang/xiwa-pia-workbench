// API 验证：上传本地音视频 → 插入正文指定段落后
const fs = require("fs");
const path = require("path");
const BASE = "http://127.0.0.1:8765";
(async () => {
  const lib = await (await fetch(BASE + "/api/library", { cache: "no-store" })).json();
  const token = lib.csrf_token;

  // 1) 创建临时剧本
  const created = await (await fetch(BASE + "/api/scripts", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
    body: JSON.stringify({ title: "插入测试临时本", category_id: "cat-sweet", blocks: [
      { kind: "text", text: "第一段开头", role: "甲", color: "#343b37" },
      { kind: "text", text: "第二段过渡", role: "乙", color: "#343b37" },
      { kind: "text", text: "第三段结尾", role: "甲", color: "#343b37" },
    ], visible: true }),
  })).json();
  console.log("临时剧本:", created.id, "| blocks:", created.blocks.length);
  const block2 = created.blocks[1].id;

  // 2) 上传本地 mp3 插入到第 2 段后
  const mp3 = "C:\\Users\\Lu\\Music\\银临 - 不老梦_L.mp3";
  if (!fs.existsSync(mp3)) { console.log("测试音频不存在:", mp3); return; }
  console.log("测试音频:", path.basename(mp3), fs.statSync(mp3).size, "bytes");
  const form = new FormData();
  form.append("file", new Blob([fs.readFileSync(mp3)], { type: "audio/mpeg" }), path.basename(mp3));
  form.append("after_block_id", block2);
  const ins = await fetch(BASE + "/api/scripts/" + encodeURIComponent(created.id) + "/blocks/media", {
    method: "POST",
    headers: { "X-CSRF-Token": token },
    body: form,
  });
  const insJson = await ins.json();
  console.log("插入:", ins.status, "| 响应:", JSON.stringify(insJson).slice(0, 300));
  if (!insJson.blocks) return;
  console.log("blocks:", insJson.blocks.length);
  const kinds = insJson.blocks.map((b) => b.kind === "text" ? "text:" + (b.text || "").slice(0, 6) : b.kind + ":" + (b.media_name || "").slice(0, 14));
  console.log("段落序列:", JSON.stringify(kinds));
  const inserted = insJson.blocks.find((b) => b.kind === "audio");
  console.log("插入块:", inserted ? JSON.stringify({ id: inserted.id.slice(0, 14), kind: inserted.kind, media_name: inserted.media_name, media_path: (inserted.media_path || "").slice(0, 30) }) : "未找到 audio 块");

  // 记录临时剧本 id 供后续清理
  fs.writeFileSync("C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\tests\\_tmp_insert_id.txt", created.id);
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
