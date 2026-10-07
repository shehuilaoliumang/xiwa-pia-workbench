const { chromium } = require("C:\\Users\\Lu\\AppData\\Local\\Temp\\pw-fix\\node_modules\\playwright-core");
(async () => {
  const b = await chromium.launch({ channel: "msedge", headless: true });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto("http://127.0.0.1:8765/script/script-e38349b24872/media", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(1800);
  const info = await p.evaluate(() => {
    const d = document.getElementById("pia-confirm-dialog");
    const toggle = document.getElementById("ai-task-float-toggle");
    const box = document.getElementById("ai-task-float");
    return { confirmInjected: !!d, toggle: !!toggle, floatCollapsed: box ? box.classList.contains("collapsed") : null };
  });
  console.log("媒体编辑器:", JSON.stringify(info));
  console.log("页面JS错误:", errors.length ? errors.join(" | ") : "(无)");
  await b.close();
})().catch((e) => { console.error("ERR", e.message); process.exit(2); });
