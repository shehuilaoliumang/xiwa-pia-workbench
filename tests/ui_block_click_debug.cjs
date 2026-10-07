// Debug：点击上移按钮，监听 move 请求与命中元素
const { chromium } = require("C:\\Users\\Lu\\AppData\\Local\\Temp\\pw-fix\\node_modules\\playwright-core");
(async () => {
  const b = await chromium.launch({ channel: "msedge", headless: true });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const reqs = [];
  p.on("request", (r) => { if (r.url().includes("/blocks/")) reqs.push(r.method() + " " + r.url().split("/").slice(-2).join("/")); });
  await p.goto("http://127.0.0.1:8765/script/script-e38349b24872/media", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(2500);
  // 命中测试：elementsFromPoint 检查 (1256,449) 处是什么
  const hit = await p.evaluate(() => {
    const cards = [...document.querySelectorAll("#media-block-choices .media-block-media")];
    const card = cards[2];
    const up = card.querySelector('.media-block-op[title="上移"]');
    up.scrollIntoView({ block: "center" });
    const r = up.getBoundingClientRect();
    const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
    const at = document.elementsFromPoint(cx, cy).slice(0, 5).map((e) => e.className || e.tagName);
    return { cx, cy, rect: { x: r.x, y: r.y, w: r.width, h: r.height }, elementsAtPoint: at, disabled: up.disabled, ptr: getComputedStyle(up).pointerEvents };
  });
  console.log("HIT:", JSON.stringify(hit));
  await p.mouse.click(hit.cx, hit.cy);
  await p.waitForTimeout(1200);
  const err = await p.evaluate(() => document.getElementById("media-error") ? document.getElementById("media-error").textContent.trim() : "no-error-el");
  console.log("ERROR TEXT:", err);
  console.log("REQUESTS:", JSON.stringify(reqs));
  // 检查点击后卡片状态（是否被隐藏=播放展开）
  const cardState = await p.evaluate(() => {
    const cards = [...document.querySelectorAll("#media-block-choices .media-block-media")];
    return cards.map((c) => ({ hidden: c.hidden, file: (c.querySelector(".media-block-media-meta") || {}).textContent || "" }));
  });
  console.log("CARDS:", JSON.stringify(cardState));
  await b.close();
})().catch((e) => { console.error("ERR", e.message); process.exit(2); });
