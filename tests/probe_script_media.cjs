// 实测：爱情公寓配本页 → 剧本级播放器状态
const { chromium } = require("C:\\Users\\Lu\\AppData\\Local\\Temp\\pw-fix\\node_modules\\playwright-core");
const BASE = "http://127.0.0.1:8765";
const out = [];
(async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(BASE + "/script/script-08/media", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  const state = await page.evaluate(() => {
    const player = document.getElementById("media-player");
    const wrap = document.getElementById("media-player-wrap");
    const empty = document.querySelector(".media-player-empty");
    return {
      hasPlayer: Boolean(player),
      tag: player ? player.tagName : null,
      src: player ? player.src.slice(-20) : null,
      preload: player ? player.preload : null,
      readyState: player ? player.readyState : -1,
      duration: player && Number.isFinite(player.duration) ? player.duration.toFixed(1) : null,
      currentTime: player ? player.currentTime.toFixed(2) : null,
      wrapChildren: wrap ? wrap.childElementCount : 0,
      emptyVisible: empty ? !empty.hidden : false,
      error: player ? (player.error ? player.error.code : null) : null,
    };
  });
  out.push("剧本级播放器: " + JSON.stringify(state));
  await page.screenshot({ path: "C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\.qa\\ai-threshold\\22-配本页剧本级播放器.png" });
  await browser.close();
  require("fs").writeFileSync("C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\tests\\_ui_result.txt", out.join("\n"), "utf8");
})().catch((e) => { console.error("FATAL", e && e.message); process.exit(2); });
