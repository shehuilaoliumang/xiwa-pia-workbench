// 恢复测试剧本媒体段落 + 验证播放后删除可用
const fs = require("fs");
const out = [];
const BASE = "http://127.0.0.1:8765";
const SCRIPT = "script-e38349b24872";
const MP4 = "C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\instance\\media\\0880f1a624369891671b84595b3291f01f4afef67a7afc67f5c85c18ec827cb1.mp4";
const MP3 = "C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\instance\\media\\89d66f958f5c0b6c4022c0b8fcd85f7e92e54ef60c2ec91cd61b18d17e613fd1.mp3";
const MOCK = "C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\instance\\ai_output\\mock_video_2c0e64aef89d49e4bb434868b1308a24.mp4";
async function insert(token, file, name, type, after) {
  const form = new FormData();
  form.append("file", new Blob([fs.readFileSync(file)], { type }), name);
  if (after) form.append("after_block_id", after);
  const r = await fetch(BASE + "/api/scripts/" + SCRIPT + "/blocks/media", { method: "POST", headers: { "X-CSRF-Token": token }, body: form });
  return r.status;
}
(async () => {
  const lib0 = await (await fetch(BASE + "/api/library", { cache: "no-store" })).json();
  const sc0 = lib0.scripts.find((s) => s.id === SCRIPT);
  const token = lib0.csrf_token;
  const lastText = sc0.blocks.filter((b) => b.kind === "text").slice(-1)[0].id;
  out.push("插入爱情公寓(第4段后): " + await insert(token, MP4, "爱情公寓.mp4", "video/mp4", lastText));
  out.push("插入AI视频(末尾): " + await insert(token, MOCK, "AI生成_演示.mp4", "video/mp4"));
  out.push("插入银临音频(末尾): " + await insert(token, MP3, "银临-不老梦_L.mp3", "audio/mpeg"));

  // 服务端确认
  const lib2 = await (await fetch(BASE + "/api/library", { cache: "no-store" })).json();
  const sc2 = lib2.scripts.find((s) => s.id === SCRIPT);
  out.push("恢复后 blocks: " + sc2.blocks.map((b) => b.kind).join(",") + " (" + sc2.blocks.length + ")");

  // 浏览器验证：播放后删除可用
  const { chromium } = require("C:\\Users\\Lu\\AppData\\Local\\Temp\\pw-fix\\node_modules\\playwright-core");
  const b = await chromium.launch({ channel: "msedge", headless: true });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  await p.goto(BASE + "/script/" + SCRIPT + "/media", { waitUntil: "domcontentloaded" });
  await p.waitForFunction(() => document.querySelectorAll("#media-block-choices .media-block-media").length > 0, { timeout: 15000 });
  await p.waitForTimeout(600);
  const card = await p.evaluateHandle(() => document.querySelectorAll("#media-block-choices .media-block-media")[0]);
  await card.scrollIntoViewIfNeeded();
  await p.waitForTimeout(300);
  await card.click();
  await p.waitForTimeout(1200);
  const afterPlay = await p.evaluate(() => {
    const cards = [...document.querySelectorAll("#media-block-choices .media-block-media")];
    const wrap = document.querySelector("#media-block-choices .media-block-player-wrap:not([hidden])");
    return {
      cardVisible: cards[0] && !cards[0].hidden,
      opsVisible: cards[0] ? [...cards[0].querySelectorAll(".media-block-op")].every((o) => !o.hidden && !o.disabled && o.offsetWidth > 0) : false,
      playerOpened: Boolean(wrap),
    };
  });
  out.push("播放后: " + JSON.stringify(afterPlay));
  // 播放后点「删」→ 确认框
  const del = await p.evaluateHandle(() => {
    const cards = [...document.querySelectorAll("#media-block-choices .media-block-media")];
    return cards[0].querySelector(".media-block-op.is-danger");
  });
  await del.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await p.waitForTimeout(400);
  await p.mouse.click(...(await del.evaluate((el) => { const r = el.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })));
  await p.waitForTimeout(600);
  const dlg = await p.evaluate(() => { const d = document.getElementById("media-confirm-dialog"); return { open: d.open, title: document.getElementById("media-confirm-title").textContent }; });
  out.push("删除确认: " + JSON.stringify(dlg));
  await p.evaluate(() => document.getElementById("media-confirm-yes").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
  await p.waitForTimeout(1500);
  const after = await p.evaluate(() => [...document.querySelectorAll("#media-block-choices .media-block-media .media-block-media-meta")].map((m) => m.textContent.split("·")[0].trim()));
  out.push("删除后媒体: " + JSON.stringify(after));
  await b.close();
  fs.writeFileSync("C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\tests\\_ui_result.txt", out.join("\n"), "utf8");
})().catch((e) => { out.push("FATAL " + (e && e.message)); fs.writeFileSync("C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\tests\\_ui_result.txt", out.join("\n"), "utf8"); process.exit(2); });
