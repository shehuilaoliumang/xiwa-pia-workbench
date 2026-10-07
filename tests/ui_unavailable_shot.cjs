// 截角色库字节下拉「无可用模型」提示（最终状态）
const { chromium } = require("C:\\Users\\Lu\\AppData\\Local\\Temp\\pw-fix\\node_modules\\playwright-core");
(async () => {
  const b = await chromium.launch({ channel: "msedge", headless: true });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  await p.goto("http://127.0.0.1:8765/manage", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(1200);
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
  const txt = await p.evaluate(() => document.getElementById("ai-character-image-model").selectedOptions[0].textContent);
  console.log("占位提示:", txt);
  const box = await p.evaluate(() => {
    const d = document.getElementById("ai-characters-dialog");
    const r = d.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  await p.screenshot({ path: "C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\.qa\\ai-threshold\\28-无可用模型提示.png", clip: { x: Math.max(0, box.x - 20), y: Math.max(0, box.y - 20), width: Math.min(1440, box.w + 40), height: Math.min(900, box.h + 40) } });
  await b.close();
})().catch((e) => { console.error("ERR", e.message); process.exit(2); });
