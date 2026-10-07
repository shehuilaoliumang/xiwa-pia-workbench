// 验证：无剧本级音视频时段落操作按钮可用 + 上移生效
const { chromium } = require("C:\\Users\\Lu\\AppData\\Local\\Temp\\pw-fix\\node_modules\\playwright-core");
(async () => {
  const b = await chromium.launch({ channel: "msedge", headless: true });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const reqs = [];
  p.on("request", (r) => { if (r.url().includes("/blocks/")) reqs.push(r.method() + " " + r.url().split("/").slice(-2).join("/")); });
  await p.goto("http://127.0.0.1:8765/script/script-e38349b24872/media", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(2500);
  const meta = () => p.evaluate(() => [...document.querySelectorAll("#media-block-choices .media-block-media .media-block-media-meta")].map((m) => m.textContent.split("·")[0].trim()));
  const before = await meta();
  // 检查按钮 disabled 状态（无媒体状态）
  const states = await p.evaluate(() => {
    const cards = [...document.querySelectorAll("#media-block-choices .media-block-media")];
    return {
      fieldsetDisabled: document.getElementById("media-cue-fields").disabled,
      opsDisabled: cards.map((c) => [...c.querySelectorAll(".media-block-op")].map((o) => o.disabled)),
      hasMedia: Boolean(document.getElementById("media-control-link") && !document.getElementById("media-control-link").hidden),
    };
  });
  // 点击第 3 个媒体卡片（AI生成_task_0f5）的上移（元素级点击）
  const card = await p.evaluateHandle(() => {
    const cards = [...document.querySelectorAll("#media-block-choices .media-block-media")];
    return cards[2].querySelector('.media-block-op[title="上移"]');
  });
  await card.scrollIntoViewIfNeeded();
  await p.waitForTimeout(300);
  await card.click();
  await p.waitForTimeout(1000);
  const after = await meta();
  console.log("BEFORE:", JSON.stringify(before));
  console.log("AFTER :", JSON.stringify(after));
  console.log("CHANGED:", JSON.stringify(before) !== JSON.stringify(after));
  console.log("STATES:", JSON.stringify(states));
  console.log("REQUESTS:", JSON.stringify(reqs));
  await b.close();
})().catch((e) => { console.error("ERR", e.message); process.exit(2); });
