// 验证：第三平台 auto-fit 扩展 + 窄屏单列
const { chromium } = require("C:\\Users\\Lu\\AppData\\Local\\Temp\\pw-fix\\node_modules\\playwright-core");
const BASE = "http://127.0.0.1:8765";
(async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(BASE + "/manage", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2200);
  await page.click("#tab-ai");
  await page.waitForTimeout(700);
  await page.click("#open-ai-settings");
  await page.waitForTimeout(900);

  // 注入第三个平台块（模拟后续新增平台）
  const layout3 = await page.evaluate(() => {
    const fields = document.querySelector("#ai-settings-dialog .ai-platform-fields");
    const ref = document.querySelector("#ai-settings-dialog .ai-platform-block");
    const clone = ref.cloneNode(true);
    clone.querySelector("strong").textContent = "腾讯 · 混元（预留占位，后续接入）";
    fields.append(clone);
    return [...fields.querySelectorAll(".ai-platform-block")].map((b) => {
      const r = b.getBoundingClientRect();
      return { label: (b.querySelector("strong") || {}).textContent || "?", x: Math.round(r.x), w: Math.round(r.width), y: Math.round(r.y) };
    });
  });
  console.log("第三平台:", JSON.stringify(layout3));
  await page.screenshot({ path: "C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\.qa\\ai-threshold\\12-AI设置-三平台.png" });
  await context.close();

  // 窄屏 420
  const ctx2 = await browser.newContext({ viewport: { width: 420, height: 800 } });
  const page2 = await ctx2.newPage();
  await page2.goto(BASE + "/manage", { waitUntil: "domcontentloaded" });
  await page2.waitForTimeout(2000);
  await page2.click("#tab-ai");
  await page2.waitForTimeout(600);
  await page2.click("#open-ai-settings");
  await page2.waitForTimeout(800);
  const narrow = await page2.evaluate(() => {
    const d = document.getElementById("ai-settings-dialog");
    const blocks = [...d.querySelectorAll(".ai-platform-block")];
    return { dialogW: d.offsetWidth, viewportW: innerWidth, cols: getComputedStyle(d.querySelector(".ai-platform-fields")).gridTemplateColumns, blocks: blocks.map((b) => { const r = b.getBoundingClientRect(); return { x: Math.round(r.x), w: Math.round(r.width) }; }) };
  });
  console.log("窄屏:", JSON.stringify(narrow));
  await page2.screenshot({ path: "C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\.qa\\ai-threshold\\13-AI设置-窄屏单列.png" });
  await ctx2.close();
  await browser.close();
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
