// 复现诊断：插入媒体 → DELETE → 检查其他媒体是否保留
const fs = require("fs");
const out = [];
const BASE = "http://127.0.0.1:8765";
const SCRIPT = "script-e38349b24872";
(async () => {
  const lib0 = await (await fetch(BASE + "/api/library", { cache: "no-store" })).json();
  const sc0 = lib0.scripts.find((s) => s.id === SCRIPT);
  out.push("A. 当前 blocks: " + sc0.blocks.map((b) => b.kind).join(",") + " (" + sc0.blocks.length + ")");

  const mp4 = "C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\instance\\ai_output\\mock_video_2c0e64aef89d49e4bb434868b1308a24.mp4";
  out.push("B. 文件存在: " + fs.existsSync(mp4));
  const form = new FormData();
  form.append("file", new Blob([fs.readFileSync(mp4)], { type: "video/mp4" }), "诊断视频.mp4");
  const up = await fetch(BASE + "/api/scripts/" + SCRIPT + "/blocks/media", {
    method: "POST", headers: { "X-CSRF-Token": lib0.csrf_token }, body: form,
  });
  const upJson = await up.json();
  out.push("C. 插入: " + up.status + " " + (upJson.error || "ok"));
  const afterInsert = upJson.scripts ? upJson.scripts.find((s) => s.id === SCRIPT) : (upJson.script || upJson);
  out.push("D. 插入后 blocks: " + afterInsert.blocks.map((b) => b.kind).join(",") + " (" + afterInsert.blocks.length + ")");
  const insertedId = afterInsert.blocks.find((b) => b.kind === "video" && b.media_name.includes("诊断")).id;
  out.push("E. 插入的 id: " + insertedId);

  const del = await fetch(BASE + "/api/scripts/" + SCRIPT + "/blocks/" + insertedId, {
    method: "DELETE", headers: { "X-CSRF-Token": lib0.csrf_token },
  });
  const delJson = await del.json();
  out.push("F. 删除: " + del.status + " " + (delJson.error || "ok"));
  const afterDel = delJson.scripts ? delJson.scripts.find((s) => s.id === SCRIPT) : (delJson.script || delJson);
  out.push("G. 删除后 blocks: " + afterDel.blocks.map((b) => b.kind).join(",") + " (" + afterDel.blocks.length + ")");

  // 服务端再查（权威）
  const lib2 = await (await fetch(BASE + "/api/library", { cache: "no-store" })).json();
  const sc2 = lib2.scripts.find((s) => s.id === SCRIPT);
  out.push("H. 服务端 blocks: " + sc2.blocks.map((b) => b.kind).join(",") + " (" + sc2.blocks.length + ")");
  fs.writeFileSync("C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\tests\\_ui_result.txt", out.join("\n"), "utf8");
})().catch((e) => { out.push("FATAL " + (e && e.message)); fs.writeFileSync("C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\tests\\_ui_result.txt", out.join("\n"), "utf8"); process.exit(2); });
