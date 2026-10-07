// 截图：AI 队列失败任务卡片 → 重试按钮横排美观
const { chromium } = require("C:\\Users\\Lu\\AppData\\Local\\Temp\\pw-fix\\node_modules\\playwright-core");
(async () => {
  const b = await chromium.launch({ channel: "msedge", headless: true });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  await p.goto("http://127.0.0.1:8765/manage", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(1500);
  await p.click("#tab-ai");
  await p.waitForTimeout(600);
  // 展开 AI 队列浮层（若收起）
  await p.evaluate(() => {
    const toggle = document.getElementById("ai-float-toggle") || [...document.querySelectorAll("button")].find((x) => x.textContent === "▸" || x.textContent === "▾");
    const float = document.getElementById("ai-task-float");
    if (toggle && float && float.classList.contains("collapsed")) toggle.click();
  });
  await p.waitForTimeout(800);
  // 定位重试按钮并检查布局
  const retryInfo = await p.evaluate(() => {
    const btn = document.querySelector(".ai-task-item-actions .task-retry-button");
    if (!btn) return { missing: true };
    const r = btn.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), text: btn.textContent.trim(), childSvg: !!btn.querySelector("svg") };
  });
  console.log("重试按钮:", JSON.stringify(retryInfo));
  // 截图队列区域
  const float = await p.evaluate(() => {
    const el = document.getElementById("ai-task-float") || document.querySelector(".ai-task-float");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  if (float) {
    await p.screenshot({ path: "C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\.qa\\ai-threshold\\30-重试按钮美化.png", clip: { x: Math.max(0, float.x - 20), y: Math.max(0, float.y - 20), width: Math.min(1440 - float.x + 40, float.w + 40), height: Math.min(900 - float.y + 40, float.h + 40) } });
  }
  await b.close();
})().catch((e) => { console.error("ERR", e.message); process.exit(2); });
