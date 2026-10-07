// 恢复后只读验收：16 篇展示 + AI 设置对话框 + 音视频配本页 + reader 页，均不写库
const { chromium } = require("C:\\Users\\Lu\\AppData\\Local\\Temp\\pw-fix\\node_modules\\playwright-core");
const BASE = "http://127.0.0.1:8878";
const out = {};
(async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  async function record(name, fn) {
    try { out[name] = await fn(); console.log("PASS " + name); }
    catch (e) { out[name] = "ERR: " + e.message.split("\n")[0]; console.log("FAIL " + name + ": " + e.message.split("\n")[0]); }
  }

  // 1) manage 页：16 篇
  await record("manage-script-count", async () => {
    await page.goto(BASE + "/manage", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1800);
    const count = await page.evaluate(() => {
      const el = document.querySelector(".library-count, #library-count, [data-script-count]");
      return el ? el.textContent : null;
    });
    return count || (await page.locator("#tab-scripts").count() ? "tab exists" : "?");
  });

  // 2) AI 设置对话框
  await record("ai-settings-dialog", async () => {
    await page.locator("#tab-ai").first().click();
    await page.waitForTimeout(500);
    await page.locator("#open-ai-settings").first().click();
    await page.waitForTimeout(900);
    const visible = await page.locator("#ai-settings-dialog").isVisible();
    const modelOpts = await page.locator("#ai-byte-model option").allTextContents();
    return { visible, modelOpts, pageErrors: pageErrors.slice() };
  });

  // 3) 关闭设置 → 打开内容管理剧本列表（不改库）
  await record("ai-close", async () => {
    await page.evaluate(() => document.getElementById("ai-settings-dialog").close());
    await page.waitForTimeout(300);
    return true;
  });

  // 4) 取第一个剧本打开 reader 页
  await record("reader-page", async () => {
    const lib = await (await context.request.get(BASE + "/api/library")).json();
    const s = lib.scripts[0];
    await page.goto(BASE + "/script/" + encodeURIComponent(s.id), { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    return { title: await page.locator("#reader-title").innerText(), blocks: (s.blocks || []).length, pageErrors: pageErrors.slice() };
  });

  // 5) 音视频配本页
  await record("media-editor-page", async () => {
    const lib = await (await context.request.get(BASE + "/api/library")).json();
    const s = lib.scripts[0];
    await page.goto(BASE + "/script/" + encodeURIComponent(s.id) + "/media", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1800);
    const state = await page.locator("#media-save-state").innerText().catch(() => "");
    const err = await page.locator("#media-editor-error").innerText().catch(() => "");
    return { state, err, hasPlayer: await page.locator("#media-player").count() > 0, pageErrors: pageErrors.slice() };
  });

  await page.screenshot({ path: "C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\.qa\\ai-threshold\\03-恢复后-manage.png" });
  console.log("RESULT " + JSON.stringify(out, null, 2));
  console.log("PAGE_ERRORS " + JSON.stringify(pageErrors));
  await browser.close();
})().catch((e) => { console.error("FATAL " + e); process.exit(2); });
