// 诊断：页面加载后段落列表未渲染的原因
const { chromium } = require("C:\\Users\\Lu\\AppData\\Local\\Temp\\pw-fix\\node_modules\\playwright-core");
const fs = require("fs");
const out = [];
(async () => {
  const b = await chromium.launch({ channel: "msedge", headless: true });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const consoleMsgs = [];
  p.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") consoleMsgs.push(m.type() + ": " + m.text().slice(0, 250)); });
  p.on("pageerror", (e) => consoleMsgs.push("PAGEERROR: " + String(e).slice(0, 400)));
  await p.goto("http://127.0.0.1:8765/script/script-e38349b24872/media", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(4000);
  const st = await p.evaluate(() => ({
    cards: document.querySelectorAll("#media-block-choices .media-block-media").length,
    choicesChildren: document.getElementById("media-block-choices").children.length,
    error: (() => { const e = document.getElementById("media-editor-error"); return e && !e.hidden ? e.textContent.trim() : ""; })(),
    bodyLen: document.body.innerHTML.length,
  }));
  out.push("STATE: " + JSON.stringify(st));
  out.push("CONSOLE: " + JSON.stringify(consoleMsgs.slice(0, 10)));
  await b.close();
  fs.writeFileSync("C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\tests\\_ui_result.txt", out.join("\n"), "utf8");
})().catch((e) => { out.push("FATAL " + (e && e.message)); fs.writeFileSync("C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\tests\\_ui_result.txt", out.join("\n"), "utf8"); process.exit(2); });
