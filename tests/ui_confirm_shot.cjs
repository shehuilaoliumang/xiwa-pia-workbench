const { chromium } = require("C:\\Users\\Lu\\AppData\\Local\\Temp\\pw-fix\\node_modules\\playwright-core");
(async () => {
  const b = await chromium.launch({ channel: "msedge", headless: true });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  await p.goto("http://127.0.0.1:8765/manage", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(1300);
  await p.click("#tab-ai");
  await p.waitForTimeout(700);
  // 若浮层收起则展开
  await p.evaluate(() => {
    const box = document.getElementById("ai-task-float");
    if (box && box.classList.contains("collapsed")) {
      const t = document.getElementById("ai-task-float-toggle");
      if (t) t.click();
    }
  });
  await p.waitForTimeout(400);
  await p.click("#ai-task-float-clear");
  await p.waitForTimeout(500);
  const d = await p.evaluate(() => {
    const r = document.getElementById("pia-confirm-dialog").getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  await p.screenshot({ path: "C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\.qa\\ai-threshold\\31-自定义确认框.png", clip: { x: Math.max(0, d.x - 30), y: Math.max(0, d.y - 30), width: Math.min(1440, d.w + 60), height: Math.min(900, d.h + 60) } });
  await b.close();
  console.log("ok");
})().catch((e) => { console.error("ERR", e.message); process.exit(2); });
