// 8765 播控台：爱情公寓剧本级配本播放验证
const { chromium } = require("C:\\Users\\Lu\\AppData\\Local\\Temp\\pw-fix\\node_modules\\playwright-core");
const BASE = "http://127.0.0.1:8765";
(async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  await page.goto(BASE + "/control", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);

  // 播控台选择剧本的下拉/列表
  const state0 = await page.evaluate(() => {
    const selects = [...document.querySelectorAll("select")].map((s) => ({ id: s.id, opts: [...s.options].slice(0, 8).map((o) => o.text) }));
    return selects;
  });
  console.log("SELECTS:", JSON.stringify(state0));

  // 尝试选择爱情公寓
  const sel = page.locator("select").first();
  if (await sel.count()) {
    const opts = await sel.locator("option").allTextContents();
    const idx = opts.findIndex((t) => t.includes("爱情公寓"));
    if (idx >= 0) {
      await sel.selectOption({ index: idx });
      await page.waitForTimeout(1500);
      const media = await page.evaluate(() => {
        const el = document.querySelector("video, audio");
        if (!el) return { noMediaEl: true };
        return { tag: el.tagName, src: (el.src || "").slice(0, 100), preload: el.preload, readyState: el.readyState };
      });
      console.log("MEDIA:", JSON.stringify(media));

      // 点击播放按钮
      const playBtn = page.locator("button").filter({ hasText: /播放/ }).first();
      if (await playBtn.count()) {
        await playBtn.click();
        await page.waitForTimeout(2000);
        const playing = await page.evaluate(() => {
          const el = document.querySelector("video, audio");
          return el ? { paused: el.paused, currentTime: el.currentTime, duration: el.duration, readyState: el.readyState, err: el.error && el.error.message } : null;
        });
        console.log("PLAYING:", JSON.stringify(playing));
      }
    } else {
      console.log("no 爱情公寓 option:", JSON.stringify(opts.slice(0, 12)));
    }
  }
  console.log("PAGE_ERRORS:", JSON.stringify(pageErrors));
  await page.screenshot({ path: "C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\.qa\\ai-threshold\\06-播控台-播放.png" });
  await browser.close();
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
