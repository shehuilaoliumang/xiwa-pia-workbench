// 回归：配本模式（上传并关联）仍正常 + 清理临时剧本
const fs = require("fs");
const BASE = "http://127.0.0.1:8765";
const MP3 = "C:\\Users\\Lu\\Music\\银临 - 不老梦_L.mp3";
(async () => {
  const lib = await (await fetch(BASE + "/api/library", { cache: "no-store" })).json();
  const token = lib.csrf_token;
  const headers = { "X-CSRF-Token": token };
  const j = (r) => r.json();

  // 1) 回归：配本模式上传关联（用临时剧本 script-04c7323f09b4）
  const form = new FormData();
  form.append("file", new Blob([fs.readFileSync(MP3)], { type: "audio/mpeg" }), "regression.mp3");
  const up = await fetch(BASE + "/api/scripts/script-04c7323f09b4/media", { method: "POST", headers, body: form });
  const upJson = await j(up);
  console.log("配本上传:", up.status, "| media 关联:", Boolean(upJson.script && upJson.script.media && upJson.script.media.path));
  const del = await fetch(BASE + "/api/scripts/script-04c7323f09b4/media", { method: "DELETE", headers });
  const delJson = await j(del);
  console.log("解除关联:", del.status, "| media 移除:", !(delJson.script && delJson.script.media && delJson.script.media.path));

  // 2) 清理临时剧本：先隐藏再删除（走删除接口的强制流程）
  const tmpScripts = ["script-04c7323f09b4", "script-06feadd7bb90", "script-8257f2190171"];
  for (const id of tmpScripts) {
    const h = await fetch(BASE + "/api/scripts/" + encodeURIComponent(id), { method: "PATCH", headers: { "Content-Type": "application/json", "X-CSRF-Token": token }, body: JSON.stringify({ visible: false }) });
    const hJson = await j(h);
    console.log("隐藏:", id, h.status);
    const d = await fetch(BASE + "/api/scripts/" + encodeURIComponent(id), { method: "DELETE", headers });
    const dJson = await j(d);
    console.log("删除:", id, d.status);
  }

  // 3) 验证库里干净 + 媒体文件清理
  const lib2 = await (await fetch(BASE + "/api/library", { cache: "no-store" })).json();
  const left = lib2.scripts.filter((s) => tmpScripts.includes(s.id));
  console.log("残留临时剧本:", left.length);
  const fs2 = require("fs");
  const mp3path = "C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\instance\\media\\89d66f958f5c0b6c4022c0b";
  const glob = require("path").join("C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\instance\\media", "89d66f95*.mp3");
  const { execSync } = require("child_process");
  const remaining = execSync('cmd /c dir /b "C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\instance\\media\\89d66f95*.mp3" 2>nul').toString().trim();
  console.log("专属 mp3 残留:", remaining || "(无)");
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
