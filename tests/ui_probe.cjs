// 排查：管理页隐藏剧本行 HTML
const { chromium } = require("C:\\Users\\Lu\\AppData\\Local\\Temp\\pw-fix\\node_modules\\playwright-core");
const BASE = "http://127.0.0.1:8765";
(async () => {
  const lib = await (await fetch(BASE + "/api/library", { cache: "no-store" })).json();
  const token = lib.csrf_token;
  const test = lib.scripts.find((s) => s.title === "UI删除测试");
  console.log("UI删除测试存在:", Boolean(test), "| visible:", test ? test.visible : "-");

  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(BASE + "/manage", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);

  const state = await page.evaluate(() => {
    const out = {};
    out.filterExists = Boolean(document.getElementById("manage-visible-filter"));
    out.filterValue = document.getElementById("manage-visible-filter") ? document.getElementById("manage-visible-filter").value : null;
    out.rows = [...document.querySelectorAll(".manage-script-row")].slice(0, 20).map((r) => {
      const t = r.querySelector("h3") ? r.querySelector("h3").textContent : "";
      return { title: t, hasDelete: Boolean(r.querySelector("[data-delete-script]")), visibility: r.querySelector(".visibility") ? r.querySelector(".visibility").textContent : "" };
    });
    out.delButtons = document.querySelectorAll("[data-delete-script]").length;
    return out;
  });
  console.log("STATE:", JSON.stringify(state));
  await page.screenshot({ path: "C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\.qa\\ai-threshold\\10-删除按钮.png" });
  // 清理测试剧本
  await fetch(BASE + "/api/scripts/" + encodeURIComponent(test.id), { method: "DELETE", headers: { "X-CSRF-Token": token } });
  await browser.close();
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
