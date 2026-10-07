// 播控台 → 测试剧本正文 → preview iframe 音频卡片点击
const { chromium } = require("C:\\Users\\Lu\\AppData\\Local\\Temp\\pw-fix\\node_modules\\playwright-core");
const BASE = "http://127.0.0.1:8765";
(async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push("PAGEERROR: " + String(e)));

  await page.goto(BASE + "/control", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);

  // 剧本正文模式 + 测试剧本
  await page.evaluate(() => {
    document.querySelector('[data-mode="script"]').click();
  });
  await page.waitForTimeout(1000);
  await page.evaluate(() => {
    const sel = document.getElementById("control-script");
    const sIdx = [...sel.options].findIndex((o) => o.text.includes("测试"));
    if (sIdx >= 0) { sel.selectedIndex = sIdx; sel.dispatchEvent(new Event("change", { bubbles: true })); }
  });
  await page.waitForTimeout(6000);

  const frames = page.frames();
  const preview = frames.find((f) => f.url().includes("/display"));
  if (!preview) { console.log("NO PREVIEW FRAME"); await browser.close(); return; }

  const pre = await preview.evaluate(() => {
    const card = document.querySelector("figure.audio-block .media-card");
    if (!card) return { noCard: true, html: document.body.innerText.slice(0, 150) };
    const audio = document.querySelector("figure.audio-block audio");
    return { card: true, audioHidden: audio ? audio.hidden : "no-audio", audioReady: audio ? audio.readyState : null };
  });
  console.log("PRE:", JSON.stringify(pre));

  if (pre.card) {
    await preview.evaluate(() => {
      const card = document.querySelector("figure.audio-block .media-card");
      card.click();
    });
    await page.waitForTimeout(3500);
    const post = await preview.evaluate(() => {
      const audio = document.querySelector("figure.audio-block audio");
      if (!audio) return { noAudio: true };
      return { hidden: audio.hidden, paused: audio.paused, currentTime: audio.currentTime, duration: audio.duration, readyState: audio.readyState, err: audio.error ? audio.error.code + ":" + audio.error.message : null };
    });
    console.log("POST-CLICK:", JSON.stringify(post));
  }
  console.log("ERRS:", JSON.stringify(errs));
  await page.screenshot({ path: "C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\.qa\\ai-threshold\\09-播控台-音频卡片.png" });
  await browser.close();
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
