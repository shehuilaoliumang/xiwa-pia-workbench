// 验证：角色库「形象卡模型」下拉填充 + 默认选择 + 免费标注
const { chromium } = require("C:\\Users\\Lu\\AppData\\Local\\Temp\\pw-fix\\node_modules\\playwright-core");
const fs = require("fs");
const out = [];
(async () => {
  const b = await chromium.launch({ channel: "msedge", headless: true });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  await p.goto("http://127.0.0.1:8765/manage", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(1500);
  // 打开 AI tab + 角色库
  await p.click("#tab-ai");
  await p.waitForTimeout(800);
  await p.click("#open-ai-characters");
  await p.waitForTimeout(1500);
  const state = await p.evaluate(() => {
    const sel = document.getElementById("ai-character-image-model");
    if (!sel) return { missing: true };
    const options = [...sel.options].map((o) => ({ v: o.value, t: o.textContent }));
    return {
      count: options.length,
      selected: sel.value,
      first: options[0],
      freeTag: options.filter((o) => o.t.includes("⭐")).map((o) => o.v),
      html: options.slice(0, 3).map((o) => o.t),
    };
  });
  out.push("字节下拉: " + JSON.stringify(state));
  // 切阿里
  await p.evaluate(() => {
    const sel = document.getElementById("ai-character-image-platform");
    sel.value = "ali";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await p.waitForTimeout(400);
  const aliState = await p.evaluate(() => {
    const sel = document.getElementById("ai-character-image-model");
    return { count: sel.options.length, selected: sel.value, first: sel.options[0] && sel.options[0].textContent };
  });
  out.push("阿里下拉: " + JSON.stringify(aliState));
  // 切字节
  await p.evaluate(() => {
    const sel = document.getElementById("ai-character-image-platform");
    sel.value = "byte";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await p.waitForTimeout(400);
  const byteState = await p.evaluate(() => {
    const sel = document.getElementById("ai-character-image-model");
    return {
      count: sel.options.length,
      selected: sel.value,
      free: [...sel.options].filter((o) => o.textContent.includes("⭐")).map((o) => o.value),
      all: [...sel.options].map((o) => o.value),
    };
  });
  out.push("字节下拉: " + JSON.stringify(byteState));
  await b.close();
  fs.writeFileSync("C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\tests\\_ui_result.txt", out.join("\n"), "utf8");
})().catch((e) => { out.push("FATAL " + (e && e.message)); fs.writeFileSync("C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\tests\\_ui_result.txt", out.join("\n"), "utf8"); process.exit(2); });
