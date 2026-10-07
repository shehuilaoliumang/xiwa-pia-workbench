// 调试：点击媒体卡片后 wrap.hidden 是否变化 + console 错误
const { chromium } = require("C:\\Users\\Lu\\AppData\\Local\\Temp\\pw-fix\\node_modules\\playwright-core");
const BASE = "http://127.0.0.1:8765";
const SCRIPT = "script-e38349b24872";
const out = [];
(async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  await page.goto(BASE + "/script/" + SCRIPT + "/media", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  const debug = await page.evaluate(() => {
    const card = document.querySelector("#media-block-choices .media-block-media.is-video");
    if (!card) return { found: false };
    const group = card.parentElement;
    const wrap = group.querySelector(".media-block-player-wrap");
    const before = wrap ? wrap.hidden : "no-wrap";
    card.click();
    const after = wrap ? wrap.hidden : "no-wrap";
    return { found: true, before, after, cardHidden: card.hidden, wrapCount: group.querySelectorAll(".media-block-player-wrap").length, hasVideo: group.querySelector("video") ? true : false };
  });
  out.push("调试: " + JSON.stringify(debug));
  out.push("页面错误: " + JSON.stringify(errors.slice(0, 5)));
  await browser.close();
  require("fs").writeFileSync("C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\tests\\_ui_result.txt", out.join("\n"), "utf8");
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
