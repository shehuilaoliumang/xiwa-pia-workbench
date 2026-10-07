// 验证：角色图下拉隐藏 7 个未开通 + 视频下拉隐藏 2-0-260128
const { chromium } = require("C:\\Users\\Lu\\AppData\\Local\\Temp\\pw-fix\\node_modules\\playwright-core");
const fs = require("fs");
const out = [];
(async () => {
  const st = await (await fetch("http://127.0.0.1:8765/api/ai/status", { cache: "no-store" })).json();
  out.push("status 字节 unavailable: " + JSON.stringify((st.platforms.byte || {}).unavailable_models));
  const b = await chromium.launch({ channel: "msedge", headless: true });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  await p.goto("http://127.0.0.1:8765/manage", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(1200);
  // 角色库 → 字节图像下拉
  await p.click("#tab-ai");
  await p.waitForTimeout(500);
  await p.click("#open-ai-characters");
  await p.waitForTimeout(1000);
  await p.evaluate(() => {
    const sel = document.getElementById("ai-character-image-platform");
    sel.value = "byte";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await p.waitForTimeout(400);
  const imgState = await p.evaluate(() => {
    const sel = document.getElementById("ai-character-image-model");
    return { count: sel.options.length, all: [...sel.options].map((o) => o.value), selected: sel.value };
  });
  out.push("角色图字节下拉: " + JSON.stringify(imgState));
  await b.close();
  fs.writeFileSync("C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\tests\\_ui_result.txt", out.join("\n"), "utf8");
})().catch((e) => { out.push("FATAL " + (e && e.message)); fs.writeFileSync("C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\tests\\_ui_result.txt", out.join("\n"), "utf8"); process.exit(2); });
