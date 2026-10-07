const { chromium } = require("C:\\Users\\Lu\\AppData\\Local\\Temp\\pw-fix\\node_modules\\playwright-core");
const fs = require("fs");
const out = [];
(async () => {
  const b = await chromium.launch({ channel: "msedge", headless: true });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  await p.goto("http://127.0.0.1:8765/manage", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(1200);
  await p.click("#tab-ai");
  await p.waitForTimeout(500);
  // 打开 AI 设置弹窗
  await p.click("#open-ai-settings");
  await p.waitForTimeout(1200);
  const v = await p.evaluate(() => {
    const sel = document.getElementById("ai-byte-model");
    if (!sel) return { missing: true };
    return { count: sel.options.length, all: [...sel.options].map((o) => o.value), selected: sel.value };
  });
  out.push("设置弹窗字节视频下拉: " + JSON.stringify(v));
  const ali = await p.evaluate(() => {
    const sel = document.getElementById("ai-ali-model");
    if (!sel) return { missing: true };
    return { count: sel.options.length, all: [...sel.options].map((o) => o.value), selected: sel.value };
  });
  out.push("设置弹窗阿里视频下拉: " + JSON.stringify(ali));
  await b.close();
  fs.writeFileSync("C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\tests\\_ui_result.txt", out.join("\n"), "utf8");
})().catch((e) => { out.push("FATAL " + (e && e.message)); fs.writeFileSync("C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\tests\\_ui_result.txt", out.join("\n"), "utf8"); process.exit(2); });
