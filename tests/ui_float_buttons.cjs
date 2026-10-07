// 验证：队列浮层清除/收起按钮文字渲染（headless 桌面视口）
const { chromium } = require("C:\\Users\\Lu\\AppData\\Local\\Temp\\pw-fix\\node_modules\\playwright-core");
const BASE = "http://127.0.0.1:8765";
const out = [];
(async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(BASE + "/manage", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  await page.click("#tab-ai");
  await page.waitForTimeout(1200);
  const state = await page.evaluate(() => {
    const clear = document.getElementById("ai-task-float-clear");
    const toggle = document.getElementById("ai-task-float-toggle");
    return {
      clearText: clear ? clear.textContent : "MISSING",
      clearVisible: clear ? getComputedStyle(clear).display !== "none" && clear.offsetWidth > 0 : false,
      toggleText: toggle ? toggle.textContent : "MISSING",
      toggleVisible: toggle ? getComputedStyle(toggle).display !== "none" && toggle.offsetWidth > 0 : false,
      headText: document.querySelector(".ai-task-float-head") ? document.querySelector(".ai-task-float-head").textContent.replace(/\s+/g, " ") : "",
    };
  });
  out.push("浮层头部按钮: " + JSON.stringify(state));
  await page.screenshot({ path: "C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\.qa\\ai-threshold\\24-队列按钮文字修复.png" });
  await browser.close();
  require("fs").writeFileSync("C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\tests\\_ui_result.txt", out.join("\n"), "utf8");
})().catch((e) => { console.error("FATAL", e && e.message); process.exit(2); });
