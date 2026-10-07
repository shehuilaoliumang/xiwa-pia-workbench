// UI 完整验证 v2：创建→隐藏→管理页→删除按钮→确认弹窗→确认删除
const { chromium } = require("C:\\Users\\Lu\\AppData\\Local\\Temp\\pw-fix\\node_modules\\playwright-core");
const BASE = "http://127.0.0.1:8765";
(async () => {
  const lib = await (await fetch(BASE + "/api/library", { cache: "no-store" })).json();
  const token = lib.csrf_token;
  const created = await (await fetch(BASE + "/api/scripts", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
    body: JSON.stringify({ title: "UI删除测试2", category_id: "cat-sweet", blocks: [{ kind: "text", text: "x", role: "", color: "#343b37" }], visible: true }),
  })).json();
  await fetch(BASE + "/api/scripts/" + encodeURIComponent(created.id), {
    method: "PATCH", headers: { "Content-Type": "application/json", "X-CSRF-Token": token }, body: JSON.stringify({ visible: false }),
  });
  console.log("已创建并隐藏:", created.id);

  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("PAGEERROR:", String(e)));
  page.on("console", (m) => { if (m.type() === "error") console.log("CONSOLE:", m.text().slice(0, 200)); });
  await page.goto(BASE + "/manage", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);

  // dump 所有行（不过滤）
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll(".manage-script-row")].map((r) => ({
      title: r.querySelector("h3") ? r.querySelector("h3").textContent : "",
      hasDelete: Boolean(r.querySelector("[data-delete-script]")),
      hasToggle: Boolean(r.querySelector("[data-toggle-script]")),
      vis: r.querySelector(".visibility") ? r.querySelector(".visibility").textContent.trim() : "",
    }))
  );
  const target = rows.find((r) => r.title === "UI删除测试2");
  console.log("目标行:", JSON.stringify(target));
  console.log("总行数:", rows.length, "| 删除按钮总数:", rows.filter((r) => r.hasDelete).length);

  if (target && target.hasDelete) {
    // 点击删除按钮 → 确认弹窗
    await page.evaluate(() => {
      const row = [...document.querySelectorAll(".manage-script-row")].find((r) => r.querySelector("h3") && r.querySelector("h3").textContent === "UI删除测试2");
      row.querySelector("[data-delete-script]").click();
    });
    await page.waitForTimeout(800);
    const dialog = await page.evaluate(() => {
      const d = document.getElementById("confirm-dialog");
      return d ? { open: d.open, title: document.getElementById("confirm-title") ? document.getElementById("confirm-title").textContent : "" } : null;
    });
    console.log("确认弹窗:", JSON.stringify(dialog));
    await page.screenshot({ path: "C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\.qa\\ai-threshold\\10-删除确认.png" });

    // 确认
    await page.evaluate(() => { document.getElementById("confirm-yes").click(); });
    await page.waitForTimeout(2500);
    const lib2 = await (await fetch(BASE + "/api/library", { cache: "no-store" })).json();
    console.log("确认后已删:", !lib2.scripts.some((s) => s.id === created.id), "| 剧本总数:", lib2.scripts.length);
  } else {
    console.log("未找到目标行或没有删除按钮，跳过确认流程");
    await page.screenshot({ path: "C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\.qa\\ai-threshold\\10-删除按钮.png" });
    await fetch(BASE + "/api/scripts/" + encodeURIComponent(created.id), { method: "DELETE", headers: { "X-CSRF-Token": token } });
  }
  await browser.close();
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
