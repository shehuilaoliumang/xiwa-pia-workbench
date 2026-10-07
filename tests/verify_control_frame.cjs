// 播控台：preview iframe 内媒体播放器视频预载验证
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

  // 切模式 + 爱情公寓
  await page.evaluate(() => {
    const mode = document.getElementById("layout-body-mode");
    const sel = document.getElementById("control-script");
    const idx = [...mode.options].findIndex((o) => o.text.includes("音视频配本"));
    if (idx >= 0) { mode.selectedIndex = idx; mode.dispatchEvent(new Event("change", { bubbles: true })); }
    const sIdx = [...sel.options].findIndex((o) => o.text.includes("爱情公寓"));
    if (sIdx >= 0) { sel.selectedIndex = sIdx; sel.dispatchEvent(new Event("change", { bubbles: true })); }
  });
  await page.waitForTimeout(6000);

  // 找 preview iframe 并检查 video
  const frames = page.frames();
  console.log("FRAMES:", frames.map((f) => f.url()).join(" | "));
  const preview = frames.find((f) => f.url().includes("/display"));
  if (!preview) { console.log("no preview frame"); await browser.close(); return; }
  const state = await preview.evaluate(() => {
    const el = document.querySelector("video.pia-media-element, .pia-media-element, video");
    if (!el) return { noMedia: true, videos: document.querySelectorAll("video").length, text: document.body.innerText.slice(0, 120) };
    return { tag: el.tagName, cls: el.className, readyState: el.readyState, paused: el.paused, currentTime: el.currentTime, videoW: el.videoWidth || 0, videoH: el.videoHeight || 0, preload: el.preload, duration: el.duration };
  });
  console.log("PREVIEW:", JSON.stringify(state));
  await page.screenshot({ path: "C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\.qa\\ai-threshold\\08-播控台-视频预载.png" });
  await browser.close();
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
