// 播控台配本视频预加载验证（JS 直接切换剧本）
const { chromium } = require("C:\\Users\\Lu\\AppData\\Local\\Temp\\pw-fix\\node_modules\\playwright-core");
const BASE = "http://127.0.0.1:8765";
(async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  await page.goto(BASE + "/control", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);

  // 播控台默认选中「测试」剧本（live-anchor 曾显示其段落）→ 切到爱情公寓
  const switched = await page.evaluate(() => {
    const sel = document.getElementById("control-script");
    if (!sel) return { noSel: true };
    const idx = [...sel.options].findIndex((o) => o.text.includes("爱情公寓"));
    if (idx < 0) return { noOpt: [...sel.options].map((o) => o.text) };
    sel.selectedIndex = idx;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    return { idx, val: sel.value };
  });
  console.log("SWITCHED:", JSON.stringify(switched));

  // 等待媒体元素加载（配本视频）
  await page.waitForTimeout(5000);
  const ctl = await page.evaluate(() => {
    const el = document.querySelector("video.pia-media-element, .pia-media-element");
    if (!el) { const any = document.querySelector("video, audio"); return { noPia: true, any: any ? any.tagName + " " + (any.currentSrc || "") : null }; }
    return { tag: el.tagName, readyState: el.readyState, paused: el.paused, currentTime: el.currentTime, videoW: el.videoWidth || 0, videoH: el.videoHeight || 0, preload: el.preload, duration: el.duration };
  });
  console.log("CONTROL:", JSON.stringify(ctl));
  await page.screenshot({ path: "C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\.qa\\ai-threshold\\08-播控台-视频预载.png" });
  console.log("PAGE_ERRORS:", JSON.stringify(pageErrors));
  await browser.close();
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
