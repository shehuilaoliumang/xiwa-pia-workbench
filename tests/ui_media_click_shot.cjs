// 滚动到媒体段落卡片并截图
const { chromium } = require("C:\\Users\\Lu\\AppData\\Local\\Temp\\pw-fix\\node_modules\\playwright-core");
const BASE = "http://127.0.0.1:8765";
const SCRIPT = "script-e38349b24872";
const out = [];
(async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(BASE + "/script/" + SCRIPT + "/media", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  // 滚动到媒体卡片可见
  await page.evaluate(() => {
    const card = document.querySelector("#media-block-choices .media-block-media.is-video");
    if (card) card.scrollIntoView({ block: "center" });
  });
  await page.waitForTimeout(600);
  // 触发第一个视频卡片展开
  const state = await page.evaluate(() => {
    const card = document.querySelector("#media-block-choices .media-block-media.is-video");
    if (!card) return { found: false };
    card.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    return { found: true };
  });
  await page.waitForTimeout(1800);
  const info = await page.evaluate(() => {
    const cards = [...document.querySelectorAll("#media-block-choices .media-block-media")];
    const wrap = document.querySelector("#media-block-choices .media-block-player-wrap:not([hidden])");
    return {
      cards: cards.map((c) => c.textContent.replace(/\s+/g, " ").slice(0, 36)),
      wrapOpened: Boolean(wrap),
      videoReady: wrap && wrap.querySelector("video") ? wrap.querySelector("video").readyState : -1,
    };
  });
  out.push("卡片: " + JSON.stringify(info.cards));
  out.push("展开: " + JSON.stringify({ wrapOpened: info.wrapOpened, videoReady: info.videoReady }));
  await page.screenshot({ path: "C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\.qa\\ai-threshold\\20-配本页媒体播放预载.png" });
  await browser.close();
  require("fs").writeFileSync("C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\tests\\_ui_result.txt", out.join("\n"), "utf8");
})().catch((e) => { console.error("FATAL", e && e.message); process.exit(2); });
