// 验证：分页 clone 是否导致音频卡片 handler 丢失（对比 连续滚动 模式）
const { chromium } = require("C:\\Users\\Lu\\AppData\\Local\\Temp\\pw-fix\\node_modules\\playwright-core");
const BASE = "http://127.0.0.1:8765";
(async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  async function setup(modeValue) {
    await page.goto(BASE + "/control", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    await page.evaluate(() => { document.querySelector('[data-mode="script"]').click(); });
    await page.waitForTimeout(800);
    await page.evaluate((mv) => {
      const sel = document.getElementById("control-script");
      const sIdx = [...sel.options].findIndex((o) => o.text.includes("测试"));
      if (sIdx >= 0) { sel.selectedIndex = sIdx; sel.dispatchEvent(new Event("change", { bubbles: true })); }
      const mode = document.getElementById("layout-body-mode");
      const idx = [...mode.options].findIndex((o) => o.value === mv);
      if (idx >= 0) { mode.selectedIndex = idx; mode.dispatchEvent(new Event("change", { bubbles: true })); }
    }, modeValue);
    await page.waitForTimeout(6000);
    const preview = page.frames().find((f) => f.url().includes("/display"));
    if (!preview) return null;
    return preview;
  }

  for (const mode of ["pages", "scroll"]) {
    const preview = await setup(mode);
    const r = await preview.evaluate(() => {
      const out = {};
      const cards = [...document.querySelectorAll(".media-card")];
      out.mode = document.body.dataset.mode || "?";
      out.cardCount = cards.length;
      // 给所有卡片绑探针再点第一个，看 handler 是否有效
      const card = cards[0];
      if (!card) return { ...out, noCard: true };
      window.__hits = 0;
      card.addEventListener("click", () => { window.__hits += 1; });
      card.click();
      out.hits = window.__hits;
      const fig = card.closest("figure.audio-block");
      const audio = fig && fig.querySelector("audio");
      out.cardHiddenAfter = card.hidden;
      out.audioHiddenAfter = audio ? audio.hidden : "no-audio";
      // clone 检查：卡片是否在分页 clone 容器中
      out.closestIds = [];
      let n = card;
      while (n && n !== document.body) { if (n.id) out.closestIds.push(n.id); n = n.parentElement; }
      return out;
    });
    console.log("MODE " + mode + ":", JSON.stringify(r));
  }
  await browser.close();
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
