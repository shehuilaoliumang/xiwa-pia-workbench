// 分步：AI 设置对话框打开与布局
const { chromium } = require("C:\\Users\\Lu\\AppData\\Local\\Temp\\pw-fix\\node_modules\\playwright-core");
const BASE = "http://127.0.0.1:8765";
(async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("PAGEERROR:", String(e)));
  page.on("console", (m) => { if (m.type() === "error") console.log("CONSOLE:", m.text().slice(0, 150)); });
  const resp = await page.goto(BASE + "/manage", { waitUntil: "domcontentloaded" });
  console.log("页面状态:", resp.status());
  await page.waitForTimeout(2500);
  console.log("open-ai-settings 存在:", Boolean(await page.$("#open-ai-settings")));
  await page.click("#tab-ai");
  await page.waitForTimeout(800);
  console.log("切到 AI tab 后可见:", await page.evaluate(() => { const b = document.getElementById("open-ai-settings"); const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; }));
  await page.click("#open-ai-settings");
  await page.waitForTimeout(1200);
  const info = await page.evaluate(() => {
    const d = document.getElementById("ai-settings-dialog");
    if (!d) return { noDialog: true };
    const blocks = [...d.querySelectorAll(".ai-platform-block")];
    return {
      open: d.open,
      dialogW: d.offsetWidth,
      blockCount: blocks.length,
      blocks: blocks.map((b) => { const r = b.getBoundingClientRect(); return { t: (b.querySelector("strong") || {}).textContent || "?", x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; }),
      fieldsCols: getComputedStyle(d.querySelector(".ai-platform-fields")).gridTemplateColumns,
    };
  });
  console.log("INFO:", JSON.stringify(info));
  await page.screenshot({ path: "C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\.qa\\ai-threshold\\11-AI设置-两平台.png" });
  await browser.close();
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
