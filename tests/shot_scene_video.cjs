// 截图：测试剧本配本页（AI 生成视频段落 + 完成反馈）
const { chromium } = require("C:\\Users\\Lu\\AppData\\Local\\Temp\\pw-fix\\node_modules\\playwright-core");
const BASE = "http://127.0.0.1:8765";
(async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(BASE + "/script/script-e38349b24872/media", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  const info = await page.evaluate(() => {
    const medias = [...document.querySelectorAll(".media-block-choice .media-block-media")];
    return { mediaRows: medias.map((m) => m.textContent.trim().slice(0, 40)) };
  });
  console.log("段落媒体行:", JSON.stringify(info.mediaRows));
  await page.screenshot({ path: "C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\.qa\\ai-threshold\\19-场面视频生成-已插入.png" });
  await browser.close();
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
