// 播控台完整链：剧本正文模式 + 爱情公寓 + 音视频配本 → preview iframe 视频预载
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

  // 1) 点击「剧本正文」模式
  await page.evaluate(() => {
    const btn = document.querySelector('[data-mode="script"]');
    if (btn) btn.click();
  });
  await page.waitForTimeout(1500);

  // 2) 选爱情公寓 + 音视频配本模式
  await page.evaluate(() => {
    const sel = document.getElementById("control-script");
    const sIdx = [...sel.options].findIndex((o) => o.text.includes("爱情公寓"));
    if (sIdx >= 0) { sel.selectedIndex = sIdx; sel.dispatchEvent(new Event("change", { bubbles: true })); }
    const mode = document.getElementById("layout-body-mode");
    const idx = [...mode.options].findIndex((o) => o.text.includes("音视频配本"));
    if (idx >= 0) { mode.selectedIndex = idx; mode.dispatchEvent(new Event("change", { bubbles: true })); }
  });
  await page.waitForTimeout(8000);

  const frames = page.frames();
  const preview = frames.find((f) => f.url().includes("/display"));
  const state = preview ? await preview.evaluate(() => {
    const el = document.querySelector("video.pia-media-element, .pia-media-element");
    if (!el) return { noMedia: true, videos: document.querySelectorAll("video").length, text: document.body.innerText.slice(0, 80) };
    return { readyState: el.readyState, paused: el.paused, currentTime: el.currentTime, videoW: el.videoWidth || 0, videoH: el.videoHeight || 0, preload: el.preload, duration: el.duration };
  }) : null;
  console.log("PREVIEW:", JSON.stringify(state));
  console.log("PAGE_ERRORS:", JSON.stringify(pageErrors));
  await page.screenshot({ path: "C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\.qa\\ai-threshold\\08-播控台-视频预载.png" });
  await browser.close();
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
