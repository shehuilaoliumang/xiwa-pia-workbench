// 完整闭环：插入音频段落 → 真实点击删除按钮 → 确认 → 删除成功
const { chromium } = require("C:\\Users\\Lu\\AppData\\Local\\Temp\\pw-fix\\node_modules\\playwright-core");
const fs = require("fs");
const out = [];
const BASE = "http://127.0.0.1:8765";
const SCRIPT = "script-e38349b24872";
(async () => {
  // 插入音频段落
  const lib = await (await fetch(BASE + "/api/library", { cache: "no-store" })).json();
  const mp3 = "C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\instance\\media\\89d66f958f5c0b6c4022c0b8fcd85f7e92e54ef60c2ec91cd61b18d17e613fd1.mp3";
  const form = new FormData();
  form.append("file", new Blob([fs.readFileSync(mp3)], { type: "audio/mpeg" }), "银临-不老梦_L.mp3");
  const up = await fetch(BASE + "/api/scripts/" + SCRIPT + "/blocks/media", {
    method: "POST", headers: { "X-CSRF-Token": lib.csrf_token }, body: form,
  });
  out.push("插入音频: " + up.status);

  const b = await chromium.launch({ channel: "msedge", headless: true });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const reqs = [];
  p.on("request", (r) => { if (r.url().includes("/blocks/")) reqs.push(r.method() + " " + r.url().split("/").slice(-2).join("/")); });
  await p.goto(BASE + "/script/" + SCRIPT + "/media", { waitUntil: "domcontentloaded" });
  await p.waitForFunction(() => document.querySelectorAll("#media-block-choices .media-block-media").length > 0, { timeout: 15000 });
  await p.waitForTimeout(800);
  const meta = () => p.evaluate(() => [...document.querySelectorAll("#media-block-choices .media-block-media .media-block-media-meta")].map((m) => m.textContent.split("·")[0].trim()));
  const before = await meta();
  out.push("BEFORE: " + JSON.stringify(before));
  // 真实点击银临卡片的删除按钮
  const del = await p.evaluateHandle(() => {
    const cards = [...document.querySelectorAll("#media-block-choices .media-block-media")];
    const card = cards.find((c) => c.textContent.includes("银临"));
    return card ? card.querySelector(".media-block-op.is-danger") : null;
  });
  const kind = await del.evaluate((el) => (el ? "button" : "null"));
  out.push("删除按钮: " + kind);
  await del.evaluate((el) => el && el.scrollIntoView({ block: "center" }));
  await p.waitForTimeout(400);
  const pos = await del.evaluate((el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, disabled: el.disabled };
  });
  out.push("按钮位置: " + JSON.stringify(pos));
  await p.mouse.click(pos.x, pos.y);
  await p.waitForTimeout(600);
  const dlg = await p.evaluate(() => {
    const d = document.getElementById("media-confirm-dialog");
    return { open: d.open, title: document.getElementById("media-confirm-title").textContent };
  });
  out.push("DIALOG: " + JSON.stringify(dlg));
  await p.evaluate(() => document.getElementById("media-confirm-yes").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
  await p.waitForTimeout(1200);
  const after = await meta();
  out.push("AFTER : " + JSON.stringify(after));
  out.push("DELETED: " + String(before.length - after.length === 1));
  out.push("REQUESTS: " + JSON.stringify(reqs));
  await b.close();
  fs.writeFileSync("C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\tests\\_ui_result.txt", out.join("\n"), "utf8");
})().catch((e) => { out.push("FATAL " + (e && e.message)); fs.writeFileSync("C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\tests\\_ui_result.txt", out.join("\n"), "utf8"); process.exit(2); });
