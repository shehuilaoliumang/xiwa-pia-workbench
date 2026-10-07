// 截图：播放后操作按钮可见状态
const { chromium } = require("C:\\Users\\Lu\\AppData\\Local\\Temp\\pw-fix\\node_modules\\playwright-core");
(async () => {
  const b = await chromium.launch({ channel: "msedge", headless: true });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  await p.goto("http://127.0.0.1:8765/script/script-e38349b24872/media", { waitUntil: "domcontentloaded" });
  await p.waitForFunction(() => document.querySelectorAll("#media-block-choices .media-block-media").length > 0, { timeout: 15000 });
  await p.waitForTimeout(600);
  await p.evaluate(() => {
    const c = document.querySelector("#media-block-choices .media-block-media");
    if (c) c.scrollIntoView({ block: "center" });
  });
  await p.waitForTimeout(400);
  await p.screenshot({ path: "C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\.qa\\ai-threshold\\25-段落媒体删除与移动.png" });
  await b.close();
})().catch((e) => { console.error("ERR", e.message); process.exit(2); });
