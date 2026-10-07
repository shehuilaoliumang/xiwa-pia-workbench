// 最终验证：播控台（默认分页模式）点击音频卡片实际播放 + 视频预载保持
const { chromium } = require("C:\\Users\\Lu\\AppData\\Local\\Temp\\pw-fix\\node_modules\\playwright-core");
const BASE = "http://127.0.0.1:8765";
(async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("PAGEERROR:", String(e)));

  await page.goto(BASE + "/control", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await page.evaluate(() => { document.querySelector('[data-mode="script"]').click(); });
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    const sel = document.getElementById("control-script");
    const sIdx = [...sel.options].findIndex((o) => o.text.includes("测试"));
    if (sIdx >= 0) { sel.selectedIndex = sIdx; sel.dispatchEvent(new Event("change", { bubbles: true })); }
  });
  await page.waitForTimeout(6000);

  const preview = page.frames().find((f) => f.url().includes("/display"));
  if (!preview) { console.log("NO PREVIEW"); await browser.close(); return; }

  // 点击音频卡片（分页模式下）
  const clicked = await preview.evaluate(() => {
    const card = document.querySelector("figure.audio-block .media-card");
    if (!card) return { noCard: true };
    card.click();
    return { ok: true };
  });
  await page.waitForTimeout(3500);
  const audioState = await preview.evaluate(() => {
    const audio = document.querySelector("figure.audio-block audio");
    if (!audio) return { noAudio: true };
    return { hidden: audio.hidden, paused: audio.paused, currentTime: audio.currentTime, duration: audio.duration, readyState: audio.readyState, err: audio.error ? audio.error.code : null, preload: audio.preload };
  });
  console.log("CLICKED:", JSON.stringify(clicked));
  console.log("AUDIO:", JSON.stringify(audioState));

  // 视频段落预载状态（同一页面）
  const videoState = await preview.evaluate(() => {
    const v = document.querySelector("figure.video-block video");
    if (!v) return { noVideo: true };
    return { readyState: v.readyState, currentTime: v.currentTime, w: v.videoWidth, h: v.videoHeight, paused: v.paused };
  });
  console.log("VIDEO:", JSON.stringify(videoState));
  await page.screenshot({ path: "C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\.qa\\ai-threshold\\09-播控台-音频播放.png" });
  await browser.close();
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
