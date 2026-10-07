// 截图：AI 设置对话框（动态模型列表 + 刷新按钮）
const { chromium } = require("C:\\Users\\Lu\\AppData\\Local\\Temp\\pw-fix\\node_modules\\playwright-core");
const BASE = "http://127.0.0.1:8765";
(async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(BASE + "/manage", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2200);
  await page.click("#tab-ai");
  await page.waitForTimeout(700);
  await page.click("#open-ai-settings");
  await page.waitForTimeout(1200);
  const info = await page.evaluate(() => ({
    byteModels: [...document.querySelectorAll("#ai-byte-model option")].map((o) => o.textContent.slice(0, 30)),
    aliModels: [...document.querySelectorAll("#ai-ali-model option")].map((o) => o.textContent.slice(0, 30)),
  }));
  console.log("字节模型:", JSON.stringify(info.byteModels));
  console.log("阿里模型:", JSON.stringify(info.aliModels));
  await page.screenshot({ path: "C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\.qa\\ai-threshold\\18-AI设置-动态模型列表.png" });
  await browser.close();
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
