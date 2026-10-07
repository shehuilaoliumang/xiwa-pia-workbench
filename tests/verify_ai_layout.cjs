// 验证 AI 设置对话框自适应布局（1440 宽 + 模拟第三平台 + 窄屏单列）
const { chromium } = require("C:\\Users\\Lu\\AppData\\Local\\Temp\\pw-fix\\node_modules\\playwright-core");
const BASE = "http://127.0.0.1:8765";
(async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });

  // ===== 1440 宽 =====
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(BASE + "/manage", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  // 打开 AI 设置对话框
  await page.evaluate(() => { const btn = document.getElementById("open-ai-settings"); if (btn) btn.click(); });
  await page.waitForTimeout(1200);
  const dialogOpen = await page.evaluate(() => { const d = document.getElementById("ai-settings-dialog"); return d ? d.open : false; });
  console.log("对话框打开:", dialogOpen);
  const layout = await page.evaluate(() => {
    const blocks = [...document.querySelectorAll("#ai-settings-dialog .ai-platform-block")];
    return {
      dialogW: document.getElementById("ai-settings-dialog").offsetWidth,
      blocks: blocks.map((b) => {
        const r = b.getBoundingClientRect();
        return { label: b.querySelector("strong") ? b.querySelector("strong").textContent.slice(0, 10) : "?", x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
      }),
    };
  });
  console.log("1440 布局:", JSON.stringify(layout));
  await page.screenshot({ path: "C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\.qa\\ai-threshold\\11-AI设置-两平台.png" });

  // 模拟第三个平台块 → auto-fit 自动重排
  const layout3 = await page.evaluate(() => {
    const fields = document.querySelector("#ai-settings-dialog .ai-platform-fields");
    const ref = document.querySelector("#ai-settings-dialog .ai-platform-block");
    const clone = ref.cloneNode(true);
    clone.querySelector("strong").textContent = "腾讯 · 测试平台（预留占位）";
    fields.append(clone);
    const blocks = [...fields.querySelectorAll(".ai-platform-block")];
    return blocks.map((b) => { const r = b.getBoundingClientRect(); return { label: b.querySelector("strong").textContent.slice(0, 8), x: Math.round(r.x), w: Math.round(r.width), y: Math.round(r.y) }; });
  });
  console.log("模拟3平台:", JSON.stringify(layout3));
  await page.screenshot({ path: "C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\.qa\\ai-threshold\\12-AI设置-三平台.png" });
  await context.close();

  // ===== 窄屏 420 宽（手机/小窗） =====
  const ctx2 = await browser.newContext({ viewport: { width: 420, height: 800 } });
  const page2 = await ctx2.newPage();
  await page2.goto(BASE + "/manage", { waitUntil: "domcontentloaded" });
  await page2.waitForTimeout(2200);
  await page2.evaluate(() => { document.getElementById("open-ai-settings").click(); });
  await page2.waitForTimeout(1000);
  const narrow = await page2.evaluate(() => {
    const blocks = [...document.querySelectorAll("#ai-settings-dialog .ai-platform-block")];
    const d = document.getElementById("ai-settings-dialog");
    return { dialogW: d.offsetWidth, blocks: blocks.map((b) => { const r = b.getBoundingClientRect(); return { x: Math.round(r.x), w: Math.round(r.width) }; }) };
  });
  console.log("420 窄屏:", JSON.stringify(narrow));
  await page2.screenshot({ path: "C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\.qa\\ai-threshold\\13-AI设置-窄屏单列.png" });
  await ctx2.close();

  await browser.close();
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
