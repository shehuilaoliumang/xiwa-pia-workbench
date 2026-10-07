// 8765 主库「测试」剧本段落音视频播放验证
const { chromium } = require("C:\\Users\\Lu\\AppData\\Local\\Temp\\pw-fix\\node_modules\\playwright-core");
const BASE = "http://127.0.0.1:8765";
(async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  const failed = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("requestfailed", (r) => failed.push(r.url() + " :: " + (r.failure() || "")));

  const lib = await (await context.request.get(BASE + "/api/library")).json();
  const test = lib.scripts.find((s) => s.title === "测试");
  if (!test) { console.log("NO 测试 script"); await browser.close(); return; }
  console.log("target:", test.id, "blocks:", (test.blocks || []).length);
  for (const b of test.blocks || []) {
    if (b.kind === "video" || b.kind === "audio") console.log("  block:", b.kind, b.media_path, b.media_name);
  }

  // reader 页
  await page.goto(BASE + "/script/" + encodeURIComponent(test.id), { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  const cards = await page.locator(".media-card, .script-media-card, [data-media-block]").count();
  console.log("reader media cards:", cards);

  // 尝试点击第一个媒体卡播放
  const card = page.locator(".media-card, .script-media-card").first();
  if (await card.count()) {
    await card.click();
    await page.waitForTimeout(1200);
    const mediaState = await page.evaluate(() => {
      const el = document.querySelector("video, audio");
      if (!el) return { noEl: true };
      return { tag: el.tagName, readyState: el.readyState, currentTime: el.currentTime, duration: el.duration, src: (el.currentSrc || el.src || "").slice(0, 120), networkState: el.networkState };
    });
    console.log("PLAY state:", JSON.stringify(mediaState));
  } else {
    console.log("no media card found on reader");
  }

  console.log("PAGE_ERRORS:", JSON.stringify(pageErrors));
  console.log("REQ_FAILED:", JSON.stringify(failed));
  await page.screenshot({ path: "C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\.qa\\ai-threshold\\05-测试剧本-reader.png" });
  await browser.close();
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
