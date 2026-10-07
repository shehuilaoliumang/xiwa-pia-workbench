// 验证：视频段落预加载首帧画面（reader/display/播控台）
const { chromium } = require("C:\\Users\\Lu\\AppData\\Local\\Temp\\pw-fix\\node_modules\\playwright-core");
const BASE = "http://127.0.0.1:8765";
(async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  // 1) reader 页「测试」剧本：视频段落直接显示 video 且已有画面
  console.log("== reader ==");
  await page.goto(BASE + "/script/" + encodeURIComponent("script-8aa496f45428"), { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);
  const reader = await page.evaluate(() => {
    const v = document.querySelector("figure.video-block video");
    const a = document.querySelector("figure.audio-block audio, figure.audio-block .media-card");
    if (!v) return { videoMissing: true };
    return { video: { readyState: v.readyState, paused: v.paused, currentTime: v.currentTime, duration: v.duration, controls: v.controls, preload: v.preload, hasVideo: v.videoWidth > 0 && v.videoHeight > 0, w: v.videoWidth, h: v.videoHeight }, audioCard: a ? a.className : null };
  });
  console.log("READER:", JSON.stringify(reader));
  await page.screenshot({ path: "C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\.qa\\ai-threshold\\07-reader-视频预载.png" });

  // 2) 播控台「爱情公寓」配本视频：预加载首帧
  console.log("== control ==");
  await page.goto(BASE + "/control", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await page.locator("#control-script").selectOption({ label: "爱情公寓" });
  await page.waitForTimeout(3500);
  const ctl = await page.evaluate(() => {
    const el = document.querySelector(".pia-media-element, #media-player, video");
    if (!el) return { noMediaEl: true };
    return { tag: el.tagName, readyState: el.readyState, paused: el.paused, currentTime: el.currentTime, videoW: el.videoWidth || 0, videoH: el.videoHeight || 0, preload: el.preload, playing: !el.paused };
  });
  console.log("CONTROL:", JSON.stringify(ctl));
  await page.screenshot({ path: "C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\.qa\\ai-threshold\\08-播控台-视频预载.png" });

  console.log("PAGE_ERRORS:", JSON.stringify(pageErrors));
  await browser.close();
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
