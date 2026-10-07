// UI 验证：管理页隐藏剧本显示删除按钮 + 确认弹窗流程
const { chromium } = require("C:\\Users\\Lu\\AppData\\Local\\Temp\\pw-fix\\node_modules\\playwright-core");
const BASE = "http://127.0.0.1:8765";
(async () => {
  const lib = await (await fetch(BASE + "/api/library", { cache: "no-store" })).json();
  const token = lib.csrf_token;
  // 创建并隐藏一个 UI 测试剧本
  const created = await (await fetch(BASE + "/api/scripts", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
    body: JSON.stringify({ title: "UI删除测试", category_id: "cat-sweet", blocks: [{ kind: "text", text: "x", role: "", color: "#343b37" }], visible: true }),
  })).json();
  await fetch(BASE + "/api/scripts/" + encodeURIComponent(created.id), {
    method: "PATCH", headers: { "Content-Type": "application/json", "X-CSRF-Token": token }, body: JSON.stringify({ visible: false }),
  });
  console.log("创建+隐藏:", created.id);

  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("PAGEERROR:", String(e)));
  await page.goto(BASE + "/manage", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3500);

  // 已隐藏过滤
  await page.evaluate(() => {
    const f = document.getElementById("manage-visible-filter");
    if (f) { f.value = "hidden"; f.dispatchEvent(new Event("change", { bubbles: true })); }
  });
  await page.waitForTimeout(1500);

  const row = page.locator('[data-delete-script]').filter({ hasText: "UI删除测试" });
  const count = await row.count();
  console.log("隐藏剧本行删除按钮:", count > 0 ? "存在" : "不存在");
  if (count === 0) {
    await page.screenshot({ path: "C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\.qa\\ai-threshold\\10-删除按钮.png" });
    // 清理
    await fetch(BASE + "/api/scripts/" + encodeURIComponent(created.id), { method: "DELETE", headers: { "X-CSRF-Token": token } });
    await browser.close();
    return;
  }

  // 点击删除 → 确认弹窗
  await row.first().click();
  await page.waitForTimeout(800);
  const dialogVisible = await page.evaluate(() => {
    const d = document.getElementById("confirm-dialog");
    return d ? d.open : false;
  });
  console.log("确认弹窗弹出:", dialogVisible);
  await page.screenshot({ path: "C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\.qa\\ai-threshold\\10-删除确认.png" });

  // 确认删除
  if (dialogVisible) {
    await page.evaluate(() => { document.getElementById("confirm-yes").click(); });
    await page.waitForTimeout(2000);
    const lib2 = await (await fetch(BASE + "/api/library", { cache: "no-store" })).json();
    console.log("确认后 UI 剧本已删:", !lib2.scripts.some((s) => s.id === created.id), "| 剧本总数:", lib2.scripts.length);
  }
  await browser.close();
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
