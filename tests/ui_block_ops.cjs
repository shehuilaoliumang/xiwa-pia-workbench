// 真实坐标点击验证：上移/下移/删除 + 卡片播放
const { chromium } = require("C:\\Users\\Lu\\AppData\\Local\\Temp\\pw-fix\\node_modules\\playwright-core");
const BASE = "http://127.0.0.1:8765";
const SCRIPT = "script-e38349b24872";
const out = [];
(async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(BASE + "/script/" + SCRIPT + "/media", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);

  const meta = () => page.evaluate(() =>
    [...document.querySelectorAll("#media-block-choices .media-block-media .media-block-media-meta")].map((m) => m.textContent.split("·")[0].trim())
  );
  out.push("初始: " + JSON.stringify(await meta()));

  // 点击「上移」按钮（第 2 个媒体卡片——爱情公寓，前面有文本段，非边缘）
  const btn = await page.evaluate(() => {
    const cards = [...document.querySelectorAll("#media-block-choices .media-block-media")];
    const card = cards[1]; // 爱情公寓
    const up = card.querySelector(".media-block-op[title='上移']");
    up.scrollIntoView({ block: "center" });
    const r = up.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, file: card.querySelector(".media-block-media-meta").textContent.split("·")[0].trim() };
  });
  out.push("点击上移于: " + JSON.stringify(btn));
  await page.waitForTimeout(400);
  await page.mouse.click(btn.x, btn.y);
  await page.waitForTimeout(900);
  out.push("上移后: " + JSON.stringify(await meta()));

  // 点击「下移」恢复
  const btn2 = await page.evaluate(() => {
    const cards = [...document.querySelectorAll("#media-block-choices .media-block-media")];
    const card = cards[1];
    const down = card.querySelector(".media-block-op[title='下移']");
    down.scrollIntoView({ block: "center" });
    const r = down.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.waitForTimeout(400);
  await page.mouse.click(btn2.x, btn2.y);
  await page.waitForTimeout(900);
  out.push("下移后: " + JSON.stringify(await meta()));

  // 点击卡片非按钮区域 → 播放展开（不点 ops）
  const playArea = await page.evaluate(() => {
    const cards = [...document.querySelectorAll("#media-block-choices .media-block-media")];
    const card = cards[1];
    card.scrollIntoView({ block: "center" });
    const r = card.getBoundingClientRect();
    const ops = card.querySelector(".media-block-ops").getBoundingClientRect();
    return { x: Math.min(r.x + 60, ops.left - 10), y: r.y + r.height / 2, left: ops.left };
  });
  out.push("播放区 x=" + playArea.x + " ops起点 x=" + playArea.left);
  await page.waitForTimeout(400);
  await page.mouse.click(playArea.x, playArea.y);
  await page.waitForTimeout(1200);
  const playState = await page.evaluate(() => {
    const wrap = document.querySelector("#media-block-choices .media-block-player-wrap:not([hidden])");
    return { opened: Boolean(wrap), video: wrap && wrap.querySelector("video") ? true : false };
  });
  out.push("卡片点击播放: " + JSON.stringify(playState));

  await page.screenshot({ path: "C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\.qa\\ai-threshold\\25-段落媒体删除与移动.png" });
  await browser.close();
  require("fs").writeFileSync("C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\tests\\_ui_result.txt", out.join("\n"), "utf8");
})().catch((e) => { console.error("FATAL", e && e.message); process.exit(2); });
