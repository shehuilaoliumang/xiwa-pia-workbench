// 探针：display 预览页音频卡片 handler 是否触发、play 是否失败
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

  const probe = await preview.evaluate(() => {
    const out = { cards: document.querySelectorAll(".media-card").length, audioBlocks: document.querySelectorAll("figure.audio-block").length };
    const card = document.querySelector("figure.audio-block .media-card");
    if (!card) return out;
    // 加探针 listener
    window.__cardHit = 0;
    card.addEventListener("click", () => { window.__cardHit += 1; });
    card.click();
    out.hitAfterClick = window.__cardHit;
    out.cardHiddenAfter = card.hidden;
    const audio = document.querySelector("figure.audio-block audio");
    if (audio) {
      out.audioHiddenAfter = audio.hidden;
      out.audioReady = audio.readyState;
      // 手动模拟 handler 逻辑
      audio.hidden = false;
      const p = audio.play().then(
        () => { out.playResolved = true; },
        (e) => { out.playRejected = String(e); }
      );
      out.playPromise = true;
      return new Promise((resolve) => setTimeout(() => { out.audioPlaying = !audio.paused; out.audioTime = audio.currentTime; out.audioReady2 = audio.readyState; resolve(out); }, 2500));
    }
    return out;
  });
  console.log("PROBE:", JSON.stringify(probe));
  await browser.close();
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
