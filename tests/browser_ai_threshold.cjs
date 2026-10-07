// AI 平台降门槛 浏览器验收：设置对话框模型下拉 / 测试连接 / 角色库平台下拉 / 引导向导
const { chromium } = require("playwright-core");

(async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const out = {};
  const errors = [];

  async function step(name, fn) {
    try {
      const result = await fn();
      out[name] = result === undefined ? true : result;
      console.log(`PASS ${name}`);
    } catch (e) {
      out[name] = false;
      errors.push(`${name}: ${e.message.split("\n")[0]}`);
      console.log(`FAIL ${name}: ${e.message.split("\n")[0]}`);
    }
  }

  await page.goto("http://127.0.0.1:8878/manage", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);

  // 进入内容管理 → AI 生成 tab
  await step("open-manage", async () => {
    const tab = page.locator(".tabs button, .tab-bar button, #tab-ai, [data-tab='ai']").first();
    await tab.waitFor({ state: "visible", timeout: 8000 });
    await tab.click();
    await page.waitForTimeout(600);
    return true;
  });

  // 打开 AI 设置对话框
  await step("open-ai-settings", async () => {
    const btn = page.locator("#open-ai-settings, #ai-open-settings, button:has-text('AI 生成设置')").first();
    await btn.waitFor({ state: "visible", timeout: 8000 });
    await btn.click();
    await page.waitForTimeout(800);
    const dialog = page.locator("#ai-settings-dialog");
    await dialog.waitFor({ state: "visible", timeout: 5000 });
    return dialog.isVisible();
  });

  // 字节模型下拉：含默认推荐 seedance-2.0-pro（即梦同源标注）
  await step("byte-model-dropdown", async () => {
    const opts = await page.locator("#ai-byte-model option").allTextContents();
    return { options: opts, hasDefault: opts.some((t) => t.includes("Seedance 2.0 Pro")), defaultSelected: await page.locator("#ai-byte-model").inputValue() };
  });

  // 阿里模型下拉：含 wanx 默认
  await step("ali-model-dropdown", async () => {
    const opts = await page.locator("#ai-ali-model option").allTextContents();
    return { options: opts, hasWanx: opts.some((t) => t.includes("万相")), defaultSelected: await page.locator("#ai-ali-model").inputValue() };
  });

  // 引导向导 details 存在（字节/阿里各一个）
  await step("key-guides", async () => {
    const byteGuide = await page.locator(".ai-platform-block").nth(0).locator("details.ai-key-guide").isVisible();
    const aliGuide = await page.locator(".ai-platform-block").nth(1).locator("details.ai-key-guide").isVisible();
    const byteText = await page.locator(".ai-platform-block").nth(0).locator(".ai-key-guide").innerText();
    return { byteGuide, aliGuide, hasConsoleLink: byteText.includes("console.volcengine.com/ark") };
  });

  // 测试连接按钮存在
  await step("test-buttons", async () => {
    return {
      byte: await page.locator("#ai-byte-test").isVisible(),
      ali: await page.locator("#ai-ali-test").isVisible(),
    };
  });

  // mock 平台测试连接 → 点击字节测试（无 key，应显示引导而非报错）
  await step("byte-test-no-key", async () => {
    await page.locator("#ai-byte-test").click();
    await page.waitForTimeout(1200);
    const status = await page.locator("#ai-byte-test-status").innerText();
    const visible = await page.locator("#ai-byte-test-status").isVisible();
    return { status, visible };
  });

  // 关闭设置，打开角色库对话框
  await step("close-settings", async () => {
    await page.evaluate(() => document.getElementById("ai-settings-dialog").close());
    await page.waitForTimeout(300);
    return true;
  });

  await step("open-character-library", async () => {
    const btn = page.locator("#open-ai-characters, #ai-open-characters, button:has-text('角色形象库')").first();
    await btn.waitFor({ state: "visible", timeout: 8000 });
    await btn.click();
    await page.waitForTimeout(800);
    return page.locator("#ai-characters-dialog").isVisible();
  });

  // 角色卡生成平台下拉
  await step("character-image-platform", async () => {
    const opts = await page.locator("#ai-character-image-platform option").allTextContents();
    return { options: opts, visible: await page.locator("#ai-character-image-platform").isVisible() };
  });

  await page.screenshot({ path: "C:\\Users\\Lu\\Documents\\ChatGPT\\选本网页\\.qa\\ai-threshold\\01-ai-settings-guide.png", fullPage: false });
  await browser.close();

  console.log("RESULT " + JSON.stringify(out, null, 2));
  if (errors.length) { console.log("ERRORS " + JSON.stringify(errors)); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(2); });
