// 播控台：切到「音视频配本·时间点暂停」模式验证视频预载
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

  const r1 = await page.evaluate(() => {
    const mode = document.getElementById("layout-body-mode");
    const sel = document.getElementById("control-script");
    return { modeVal: mode ? mode.value : null, modeOpts: mode ? [...mode.options].map((o) => o.text) : null, script: sel ? sel.value : null };
  });
  console.log("STATE1:", JSON.stringify(r1));

  // 切到音视频配本模式 + 爱情公寓
  const r2 = await page.evaluate(() => {
    const mode = document.getElementById("layout-body-mode");
    const sel = document.getElementById("control-script");
    const idx = [...mode.options].findIndex((o) => o.text.includes("音视频配本"));
    if (idx >= 0) { mode.selectedIndex = idx; mode.dispatchEvent(new Event("change", { bubbles: true })); }
    const sIdx = [...sel.options].findIndex((o) => o.text.includes("爱情公寓"));
    if (sIdx >= 0) { sel.selectedIndex = sIdx; sel.dispatchEvent(new Event("change", { bubbles: true })); }
    return { modeIdx: idx, scriptIdx: sIdx };
  });
  console.log("SWITCHED:", JSON.stringify(r2));
  await page.waitForTimeout(6000);

  const ctl = await page.evaluate(() => {
    const el = document.querySelector("video.pia-media-element");
    if (!el) return { noPia: true, videos: document.querySelectorAll("video").length };
    return { readyState: el.readyState, paused: el.paused, currentTime: el.currentTime, videoW: el.videoWidth || 0, videoH: el.videoHeight || 0, preload: el.preload, duration: el.duration };
  });
  console.log("CONTROL:", JSON.stringify(ctl));
  await page.screenshot({ path: "C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\.qa\\ai-threshold\\08-播控台-视频预载.png" });
  console.log("PAGE_ERRORS:", JSON.stringify(pageErrors));
  await browser.close();
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
