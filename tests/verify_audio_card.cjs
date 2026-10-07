// 复现：段落级音频卡片点击播放（reader + display）
const { chromium } = require("C:\\Users\\Lu\\AppData\\Local\\Temp\\pw-fix\\node_modules\\playwright-core");
const BASE = "http://127.0.0.1:8765";
(async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push("PAGEERROR: " + String(e)));
  page.on("console", (m) => { if (m.type() === "error") errs.push("CONSOLE: " + m.text()); });

  // reader 页「测试」剧本
  console.log("== reader audio card ==");
  await page.goto(BASE + "/script/" + encodeURIComponent("script-8aa496f45428"), { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  const pre = await page.evaluate(() => {
    const card = document.querySelector("figure.audio-block .media-card");
    const audio = document.querySelector("figure.audio-block audio");
    if (!card) return { noCard: true, figures: [...document.querySelectorAll("figure")].map((f) => f.className) };
    return { cardVisible: !card.hidden, audioHidden: audio ? audio.hidden : "no-audio", audioReady: audio ? audio.readyState : null };
  });
  console.log("PRE:", JSON.stringify(pre));

  // 点击音频卡片
  const clicked = await page.evaluate(() => {
    const card = document.querySelector("figure.audio-block .media-card");
    if (!card) return { noCard: true };
    card.click();
    return { cardHidden: card.hidden };
  });
  await page.waitForTimeout(3500);
  const post = await page.evaluate(() => {
    const audio = document.querySelector("figure.audio-block audio");
    if (!audio) return { noAudio: true };
    return { hidden: audio.hidden, paused: audio.paused, currentTime: audio.currentTime, duration: audio.duration, readyState: audio.readyState, err: audio.error ? audio.error.code + ":" + audio.error.message : null, networkState: audio.networkState, src: (audio.currentSrc || "").slice(0, 60) };
  });
  console.log("POST-CLICK:", JSON.stringify(post));
  console.log("ERRS:", JSON.stringify(errs));
  await browser.close();
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
